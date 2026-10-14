/**
 * Plugins: how Lumovi shows the kinds of a tool it has no pages of its own for (Flux,
 * cert-manager…), written as data. A plugin is one file: its place in the sidebar, where it
 * has one (a label and the kinds under it), and its views, each saying how a kind is shown
 * (its columns, status, details, related objects and actions).
 *
 * Lumovi comes with plugins for popular tools (plugins/) and reads the user's own from
 * ~/.lumovi/plugins; a user's view of a kind is used before Lumovi's, and their plugin's
 * place in the sidebar replaces Lumovi's of the same name. A plugin can't run code: its views
 * read fields with JSONPath and change objects only with the patches they spell out.
 * The format: https://docs.lumovi.dev/reference/plugin-format.
 */
import type { Health } from '@shared/health'
import { jsonPath } from '@shared/jsonpath'
import {
  EXPRESSION,
  INPUT_PATH,
  MANAGING_MARK,
  OBJECT_PATH,
  ONLY_PLACEHOLDER,
  PLACEHOLDER,
  clashes,
  namedKinds,
  parsePlugin,
  type Condition,
  type Added,
  type InputValues,
  type ListedPlugin,
  type Plugin,
  type Scalar,
  type View,
  type ViewAction,
  type ViewField,
  type ViewInput,
  type Harm,
} from '@shared/plugins'
import { harmsIn, quieted } from '@shared/plugin-changes'
import { apiGroupOf, apiKindOf, type ResourceKind } from '@shared/resources'
import { offersPages } from './code-pages'
import type { Status } from './health'

export * from '@shared/plugins'

// ——— Using ———

const shipped = new Map<ResourceKind, View>()
let local = new Map<ResourceKind, View>()
const shippedPlugins = new Map<string, Plugin>()
let localPlugins = new Map<string, Plugin>()
let ownKinds: ResourceKind[] = []

function byKind(views: View[]): Map<ResourceKind, View> {
  return new Map(views.flatMap((view) => view.kinds.map((kind) => [kind, view] as const)))
}

/**
 * Lumovi's own: the plugins it comes with, and the views it keeps for Kubernetes' kinds that
 * have no page (`own`: written as a plugin's file is, and no plugin of anyone's: never counted
 * or listed). Returns anything wrong with them (there should be nothing). `allowed`: whether a
 * plugin may be there at all, by its name, as the organization's policy says (one that may not
 * isn't: none of its views, no place).
 */
export function loadShippedPlugins(
  files: Record<string, string>,
  own: Record<string, string> = {},
  allowed: (name: string, version: string) => boolean = () => true,
): string[] {
  shipped.clear()
  shippedPlugins.clear()
  const problems: string[] = []
  const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
  ownKinds = []
  for (const [path, text] of Object.entries(own)) {
    const parsed = parsePlugin(text, fileName(path), { ownViews: true })
    for (const view of parsed.plugin?.views ?? []) {
      for (const kind of view.kinds) shipped.set(kind, { ...view, source: 'Lumovi' })
      ownKinds.push(...view.kinds)
    }
    problems.push(...parsed.problems)
  }
  // A kind is one plugin's, among Lumovi's as among anyone's.
  const read: Plugin[] = []
  for (const [path, text] of Object.entries(files)) {
    // (Lumovi's own: the ones whose files may carry code.)
    const parsed = parsePlugin(text, fileName(path), { lumovisOwn: ownKinds, carriesCode: true })
    if (parsed.plugin && allowed(parsed.plugin.name, parsed.plugin.version)) {
      read.push(parsed.plugin)
    }
    problems.push(...parsed.problems)
  }
  const lost = clashes(read)
  for (const plugin of read) {
    if (lost.has(plugin)) {
      problems.push(`${plugin.source}: ${lost.get(plugin)}`)
      continue
    }
    const views = plugin.views.map((view) => ({ ...view, source: 'Lumovi' }))
    for (const [kind, view] of byKind(views)) shipped.set(kind, view)
    shippedPlugins.set(plugin.name, { ...plugin, source: 'Lumovi', views })
  }
  return problems
}

/** The kinds of Kubernetes' own that Lumovi itself shows: no plugin's to show. */
export function lumovisOwnKinds(): readonly ResourceKind[] {
  return ownKinds
}

/** Replaces the user's plugins. */
export function setLocalPlugins(plugins: Plugin[]): void {
  local = byKind(plugins.flatMap((plugin) => plugin.views))
  localPlugins = new Map(plugins.map((plugin) => [plugin.name, plugin]))
}

/** `*.constraints.gatekeeper.sh`: how a view or a plugin names every kind of a group. */
export function everyKindOf(kind: ResourceKind): ResourceKind {
  return `*.${apiGroupOf(kind)}`
}

/**
 * The view for a kind: the user's plugin's if one shows it, else Lumovi's; one for the kind
 * itself before one for every kind of its group.
 */
export function viewFor(kind: ResourceKind): View | undefined {
  const every = everyKindOf(kind)
  // A plugin of the user's that has one of Lumovi's plugins' name is in its place, all of it:
  // none of that plugin's views is used, for the kinds theirs doesn't show either.
  const lumovis = (key: ResourceKind) => {
    const view = shipped.get(key)
    return view && shippedPlugins.has(view.plugin) && localPlugins.has(view.plugin)
      ? undefined
      : view
  }
  return local.get(kind) ?? local.get(every) ?? lumovis(kind) ?? lumovis(every)
}

/**
 * What shows a kind, as a person knows it: the plugin's name as its place in the sidebar has it
 * (Flux), or its own; the file's name for one of the user's; "Lumovi" for Lumovi's own views of
 * Kubernetes' kinds, which are no plugin.
 */
export function shownBy(view: View): string {
  if (view.source !== 'Lumovi') return view.source
  const plugin = shippedPlugins.get(view.plugin)
  return plugin ? (plugin.place?.label ?? plugin.name) : 'Lumovi'
}

/** The kinds whose objects manage others, each with the view in use for it that says how. */
export function managingKinds(): { kind: ResourceKind; view: View }[] {
  const kinds = new Set([...local.keys(), ...shipped.keys()])
  return [...kinds].flatMap((kind) => {
    const view = viewFor(kind)
    return view?.manages ? [{ kind, view }] : []
  })
}

/** The plugin in use by a name: the user's, or Lumovi's. */
export function pluginNamed(name: string): Plugin | undefined {
  return localPlugins.get(name) ?? shippedPlugins.get(name)
}

/** The plugins Lumovi comes with. */
export function includedPlugins(): Plugin[] {
  return [...shippedPlugins.values()]
}

/** What a plugin adds to nothing: a plugin whose pages aren't offered here. */
const NOTHING: Added = { pages: [], tabs: [], commands: [] }

/**
 * Every plugin with a place in the sidebar: the user's, and Lumovi's that none of theirs is in
 * the place of (one of theirs with its name is, whether or not theirs has a place itself).
 */
export function listedPlugins(): ListedPlugin[] {
  const listed = (plugins: Iterable<Plugin>) =>
    [...plugins].flatMap((plugin) => {
      const { name, source, version, place, added, opens, links, logs, changes } = plugin
      return place
        ? [
            {
              name,
              source,
              version,
              ...place,
              named: namedKinds(plugin),
              opens,
              links,
              changes,
              ...(logs ? { logs } : {}),
              // (Its pages, tabs and commands are drawn by the door, and offered where Lumovi offers
              // code pages: only for a plugin whose code is part of this Lumovi, never a page that
              // couldn't start.)
              added: offersPages(name) ? added : NOTHING,
            },
          ]
        : []
    })
  return [
    ...listed(localPlugins.values()),
    ...listed([...shippedPlugins.values()].filter((plugin) => !localPlugins.has(plugin.name))),
  ]
}

function same(a: unknown, b: Scalar): boolean {
  // YAML reads True as a boolean, where Kubernetes writes "True": compare loosely.
  return a === b || (a !== undefined && String(a).toLowerCase() === String(b).toLowerCase())
}

export function holds(condition: Condition, object: unknown): boolean {
  if ('all' in condition) return condition.all.every((c) => holds(c, object))
  if ('any' in condition) return condition.any.some((c) => holds(c, object))
  const [value] = jsonPath(object, condition.path)
  if (condition.exists !== undefined)
    return (value !== undefined && value !== null) === condition.exists
  if (condition.equals !== undefined) return same(value, condition.equals)
  if (condition.notEquals !== undefined) return !same(value, condition.notEquals)
  if (condition.in) return condition.in.some((option) => same(value, option))
  if (condition.matches !== undefined) {
    return new RegExp(condition.matches, 'i').test(value === undefined ? '' : String(value))
  }
  return Boolean(value)
}

/** What `path` finds, as text: lists joined, objects as JSON. */
function text(values: unknown[]): string | undefined {
  if (values.length === 0 || values[0] === null) return undefined
  return values.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ')
}

/** An object as a manager's templates name it: `{{ object.kind }}` and the rest. */
export interface ManagedObject {
  /** '' for Kubernetes' core kinds. */
  group: string
  kind: string
  /** '' for an object of no namespace. */
  namespace: string
  name: string
}

/**
 * A template filled in from `object`, and whether every placeholder found something (or had a
 * fallback that did, or a text of its own).
 */
function filled(
  template: string,
  object: unknown,
  now: number,
  inputs: InputValues,
  managed?: ManagedObject,
): { text: string; whole: boolean } {
  // An action's inputs are `input.name`; empty ones count as missing. A manager's object is
  // `object.kind` and the rest; and a manager's own text that's empty, or holds the mark its
  // object's name is found by, says nothing (it would match what it doesn't say).
  const lookup = (path: string) => {
    if (OBJECT_PATH.test(path))
      return managed?.[path.slice('object.'.length) as keyof ManagedObject]
    if (!INPUT_PATH.test(path)) {
      const found = text(jsonPath(object, path))
      return managed && (found === '' || found?.includes(MANAGING_MARK)) ? undefined : found
    }
    const value = inputs[path.slice('input.'.length)]
    // (In a longer text, a choice's value that's an object or a list is its JSON.)
    if (value === '' || value === undefined) return undefined
    return typeof value === 'object' ? JSON.stringify(value) : String(value)
  }
  let whole = true
  const out = template.replace(PLACEHOLDER, (_, expression: string) => {
    const [, path, literal, fallback] = EXPRESSION.exec(expression)!
    if (path === 'now') return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const found = lookup(path!) ?? (fallback ? lookup(fallback) : literal)
    if (found === undefined) whole = false
    return found ?? ''
  })
  return { text: out, whole }
}

/** A template with its {{ }} placeholders filled in from `object`. */
export function render(
  template: string,
  object: unknown,
  now = Date.now(),
  inputs: InputValues = {},
): string {
  return filled(template, object, now, inputs).text
}

/**
 * A manager's template for `managed`, filled in from the manager: nothing where a placeholder
 * finds nothing, or it all comes to nothing, so that no manager is taken for one by what it hasn't.
 */
export function renderManaging(
  template: string,
  manager: unknown,
  managed: ManagedObject,
): string | undefined {
  const { text, whole } = filled(template, manager, 0, {}, managed)
  return whole && text !== '' ? text : undefined
}

/**
 * Fills in the templates in a patch (or an object to create). A placeholder
 * that's a whole value stands for the value itself, not its text: a number,
 * a list, an object to copy, and nothing at all (the field is left out) when
 * it finds nothing. Labels and annotations are always text.
 */
export function renderPatch<T>(patch: T, object: unknown, now: number, inputs: InputValues): T {
  const found = (path: string): unknown => {
    if (INPUT_PATH.test(path)) {
      const value = inputs[path.slice('input.'.length)]!
      return value === '' ? undefined : value
    }
    const values = jsonPath(object, path)
    return values.length > 1 ? values : values[0]
  }
  const valueOf = (expression: string): unknown => {
    const [, path, literal, fallback] = EXPRESSION.exec(expression)!
    return found(path!) ?? (fallback ? found(fallback) : literal)
  }
  const fill = (value: unknown, text: boolean): unknown => {
    if (typeof value === 'string') {
      const only = ONLY_PLACEHOLDER.exec(value)
      return !only || text || only[1] === 'now'
        ? render(value, object, now, inputs)
        : valueOf(only[1]!)
    }
    if (Array.isArray(value)) {
      return value.map((item) => fill(item, text)).filter((item) => item !== undefined)
    }
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, fill(item, text || key === 'labels' || key === 'annotations')])
        .filter(([, item]) => item !== undefined),
    )
  }
  return fill(patch, false) as T
}

/** The options of a choice: its own, or what its path finds in the object. */
/**
 * What a view's action is busy with on `object`: the first of its busy states that holds, with
 * when that started where its file says (a time Lumovi can read), or nothing.
 */
export function actionBusy(
  action: ViewAction,
  object: unknown,
): { word: string; since?: number } | undefined {
  const state = action.busy?.find((busy) => holds(busy.when, object))
  if (!state) return undefined
  const [at] = state.since ? jsonPath(object, state.since) : []
  const since = typeof at === 'string' ? Date.parse(at) : NaN
  return { word: state.word, ...(Number.isFinite(since) ? { since } : {}) }
}

/**
 * How a view's action's work ended on `object`, as its file's `ends` says it: the word and level
 * of the value at its path, and the message beside it (cut at 500 characters). Nothing while one
 * of its busy states holds, where its file says no end, or where the value is none it names.
 */
export function actionEnded(
  action: ViewAction,
  object: unknown,
): { word: string; level: Health; message?: string } | undefined {
  if (!action.ends || actionBusy(action, object)) return undefined
  const [value] = jsonPath(object, action.ends.path)
  const found = action.ends.values.find((each) => each.value === value)
  if (!found) return undefined
  const [message] = action.ends.message ? jsonPath(object, action.ends.message) : []
  return {
    word: found.word,
    level: found.level,
    ...(typeof message === 'string' && message !== '' ? { message: message.slice(0, 500) } : {}),
  }
}

export function inputOptions(input: ViewInput, object: unknown): string[] {
  const values = input.options ?? jsonPath(object, input.from!).flat()
  return values.filter((v) => ['string', 'number', 'boolean'].includes(typeof v)).map(String)
}

/** The status a view gives an object, or null when none of its rules apply. */
export function viewStatus(view: View, object: unknown): Status | null {
  const rule = view.status?.find((r) => !r.when || holds(r.when, object))
  if (!rule) return null
  const detail = rule.detail ? render(rule.detail, object) : ''
  return {
    health: rule.health,
    label: render(rule.label, object) || rule.health,
    ...(detail ? { detail } : {}),
  }
}

/** A field's value: text to show, something to sort by, and, for dates, the time. */
export function fieldValue(
  field: ViewField,
  object: unknown,
): { text?: string; sort: string | number; time?: string } {
  const values = jsonPath(object, field.path)
  if (field.type === 'count') {
    const [only] = values
    const count = values.length === 1 && Array.isArray(only) ? only.length : values.length
    return { text: String(count), sort: count }
  }
  const shown = text(values)
  if (shown === undefined)
    return { text: field.default, sort: field.type === 'number' ? -Infinity : '' }
  switch (field.type) {
    case 'number':
      return { text: shown, sort: Number(values[0]) }
    case 'date':
      return { text: shown, sort: Date.parse(String(values[0])), time: String(values[0]) }
    case 'boolean':
      return { text: values[0] ? 'Yes' : 'No', sort: values[0] ? 1 : 0 }
    default:
      return { text: shown, sort: shown }
  }
}

/** The objects a view links an object to, with the templates filled in. */
export function viewLinks(
  view: View,
  object: { metadata: { namespace?: string } },
  namespaced: (kind: ResourceKind) => boolean | undefined,
): { name: string; kind: ResourceKind; objectName: string; namespace?: string }[] {
  return (view.links ?? []).flatMap((link) => {
    const kind = render(link.kind, object)
    const objectName = render(link.objectName, object)
    if (!kind || !objectName) return []
    // Unless it says otherwise, a link stays in the object's namespace (if its kind has them).
    const namespace =
      (link.namespace && render(link.namespace, object)) ||
      (namespaced(kind) === false ? undefined : object.metadata.namespace)
    return [{ name: link.name, kind, objectName, namespace }]
  })
}

/** How to find what a view relates an object to, with the templates filled in. */
export interface RelatedQuery {
  name: string
  kind: ResourceKind
  labelSelector?: string
  fieldSelector?: string
  /** `null` for every namespace. */
  namespace: string | null
}

/**
 * The lists a view relates an object to. One whose templates find nothing
 * is left out: it would find the wrong objects.
 */
export function viewRelated(
  view: View,
  object: { metadata: { namespace?: string } },
  namespaced: (kind: ResourceKind) => boolean | undefined,
): RelatedQuery[] {
  return (view.related ?? []).flatMap((related) => {
    const kind = render(related.kind, object)
    const labels = Object.entries(related.labels ?? {}).map(
      ([key, value]) => [key, render(value, object)] as const,
    )
    const fieldSelector = related.fieldSelector && render(related.fieldSelector, object)
    const blank =
      labels.some(([, value]) => !value) ||
      fieldSelector?.split(',').some((term) => term.endsWith('='))
    if (!kind || blank) return []
    // Like a link's, unless it says otherwise.
    const namespace =
      (related.namespace && render(related.namespace, object)) ||
      (namespaced(kind) === false ? null : (object.metadata.namespace ?? null))
    return [
      {
        name: related.name,
        kind,
        ...(labels.length ? { labelSelector: labels.map((l) => l.join('=')).join(',') } : {}),
        ...(fieldSelector ? { fieldSelector } : {}),
        namespace,
      },
    ]
  })
}

/**
 * What a kind's change does harm, as the file of the plugin whose view shows it says
 * (`spec.changes[].harm`): drawn wherever a change of that file's is asked, its views' actions
 * as its pages' proposals.
 */
export function harmsFor(kind: ResourceKind): readonly Harm[] {
  const view = viewFor(kind)
  const plugin = view && pluginNamed(view.plugin)
  const named = `${apiGroupOf(kind)}/${apiKindOf(kind)}`
  return plugin?.changes?.find((each) => each.kind === named)?.harm ?? []
}

/** A JSON patch's operations as what they write: an object, so a harm's path is judged in it. */
function written(body: unknown): unknown {
  if (!Array.isArray(body)) return body
  const out: Record<string, unknown> = {}
  for (const op of body as { op?: unknown; path?: unknown; value?: unknown }[]) {
    if ((op.op !== 'add' && op.op !== 'replace') || typeof op.path !== 'string') continue
    const names = op.path
      .split('/')
      .slice(1)
      .map((name) => name.replace(/~1/g, '/').replace(/~0/g, '~'))
    let at = out
    for (const name of names.slice(0, -1)) {
      if (typeof at[name] !== 'object' || at[name] === null) at[name] = {}
      at = at[name] as Record<string, unknown>
    }
    if (names.length) at[names.at(-1)!] = op.value
  }
  return out
}

/**
 * The harms a view's action does as it's sent (`body`, its patch filled in), by its kind's file's
 * `harms`. An `unless` quiets one only where the person set what it names: the action's patch has,
 * at just that path, a switch input whole that the person is asked (`asked`), never a value of
 * the file's own, one read off the object, or a default filled where it isn't asked.
 */
export function actionHarms(
  action: ViewAction,
  body: unknown,
  harms: readonly Harm[],
  asked: (input: ViewInput) => boolean,
): Harm[] {
  const template = written(action.patch)
  const quietable = (path: string) => {
    let at: unknown = template
    for (const name of path.split('.')) {
      if (typeof at !== 'object' || at === null || Array.isArray(at) || !Object.hasOwn(at, name)) {
        return false
      }
      at = (at as Record<string, unknown>)[name]
    }
    const only = typeof at === 'string' ? ONLY_PLACEHOLDER.exec(at) : null
    if (!only || !INPUT_PATH.test(only[1]!)) return false
    const input = action.inputs?.find((each) => `input.${each.name}` === only[1])
    return input !== undefined && input.type === 'switch' && asked(input)
  }
  if (!Array.isArray(body)) return harmsIn(body, harms, quietable)
  // A JSON patch: judged as what its additions and replacements write, and, failing closed, any
  // operation that lands on a harm's path or inside it (a copy, a move, a list's new item)
  // harms, whatever it carries, unless what the person set quiets it.
  const asWritten = written(body)
  const fired = new Set(harmsIn(asWritten, harms, quietable))
  return harms.filter(
    (harm) =>
      fired.has(harm) ||
      (!quieted(asWritten, harm, quietable) &&
        (body as { op?: unknown; path?: unknown }[]).some((op) => lands(op, harm.path))),
  )
}

/**
 * Whether a JSON patch's operation writes at `path` (names with dots), or inside what's there; a
 * copy or a move onto what holds it, too.
 */
function lands(op: { op?: unknown; path?: unknown }, path: string): boolean {
  if (op.op === 'remove' || op.op === 'test' || typeof op.path !== 'string') return false
  const at = op.path
    .split('/')
    .slice(1)
    .map((name) => name.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join('.')
  // (A copy or a move onto what holds it brings in what it can't see: it lands there too.)
  const blind = op.op === 'copy' || op.op === 'move'
  return at === path || at.startsWith(`${path}.`) || (blind && path.startsWith(`${at}.`))
}

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
import { jsonPath } from '@shared/jsonpath'
import {
  EXPRESSION,
  INPUT_PATH,
  ONLY_PLACEHOLDER,
  PLACEHOLDER,
  clashes,
  parsePlugin,
  type Condition,
  type InputValues,
  type ListedPlugin,
  type Plugin,
  type Scalar,
  type View,
  type ViewField,
  type ViewInput,
} from '@shared/plugins'
import { apiGroupOf, type ResourceKind } from '@shared/resources'
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
 * or listed). Returns anything wrong with them (there should be nothing).
 */
export function loadShippedPlugins(
  files: Record<string, string>,
  own: Record<string, string> = {},
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
    const parsed = parsePlugin(text, fileName(path), { lumovisOwn: ownKinds })
    if (parsed.plugin) read.push(parsed.plugin)
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

/** The plugins Lumovi comes with. */
export function includedPlugins(): Plugin[] {
  return [...shippedPlugins.values()]
}

/**
 * Every plugin with a place in the sidebar: the user's, and Lumovi's that none of theirs is in
 * the place of (one of theirs with its name is, whether or not theirs has a place itself).
 */
export function listedPlugins(): ListedPlugin[] {
  const listed = (plugins: Iterable<Plugin>) =>
    [...plugins].flatMap(({ name, source, place }) => (place ? [{ name, source, ...place }] : []))
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

/** A template with its {{ }} placeholders filled in from `object`. */
export function render(
  template: string,
  object: unknown,
  now = Date.now(),
  inputs: InputValues = {},
): string {
  // An action's inputs are `input.name`; empty ones count as missing.
  const lookup = (path: string) => {
    if (!INPUT_PATH.test(path)) return text(jsonPath(object, path))
    const value = inputs[path.slice('input.'.length)]!
    return value === '' ? undefined : String(value)
  }
  return template.replace(PLACEHOLDER, (_, expression: string) => {
    const [, path, literal = '', fallback] = EXPRESSION.exec(expression)!
    if (path === 'now') return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z')
    return lookup(path!) ?? (fallback ? lookup(fallback) : literal) ?? ''
  })
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

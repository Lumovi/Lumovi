/**
 * Views: how KubeStacks shows a kind it has no page of its own for (its
 * columns, status, details, related objects and actions), written as data.
 * Add-ons gather the kinds of one tool (Flux, cert-manager…) under one entry
 * in the sidebar.
 *
 * KubeStacks ships views and add-ons for popular operators
 * (src/renderer/src/views) and reads the user's own from ~/.kubestacks/views;
 * a user's view of a kind replaces the shipped one, and their add-on one of
 * the same name. Views can't run code: they read fields with JSONPath and
 * change objects only with the patches they spell out.
 * The format: https://docs.kubestacks.com/reference/view-format.
 */
import { parseAllDocuments } from 'yaml'
import { checkPath, jsonPath } from '@shared/jsonpath'
import {
  apiGroupOf,
  isBuiltinKind,
  kindFor,
  type ResourceCategory,
  type ResourceKind,
} from '@shared/resources'
import type { Health, Status } from './health'

export const VIEW_API_VERSION = 'kubestacks.dev/v1alpha1'

/** Icons a view can pick, by their Lucide names. */
export const VIEW_ICON_NAMES = [
  'activity',
  'archive',
  'bell',
  'box',
  'boxes',
  'bug',
  'camera',
  'cloud',
  'database',
  'file-check',
  'flame',
  'gauge',
  'git-branch',
  'git-merge',
  'globe',
  'hexagon',
  'key-round',
  'layers',
  'lock',
  'network',
  'package',
  'play',
  'puzzle',
  'radar',
  'refresh-cw',
  'rocket',
  'route',
  'scaling',
  'server',
  'server-cog',
  'shield-check',
  'signpost',
  'timer',
  'waves',
  'waypoints',
  'workflow',
] as const

export type ViewIconName = (typeof VIEW_ICON_NAMES)[number]

export type ValueType = 'string' | 'number' | 'date' | 'boolean' | 'count'

type Scalar = string | number | boolean | null

/** A value read from objects: a list column, or a fact in the details. */
export interface ViewField {
  name: string
  path: string
  type: ValueType
  /** Shown when the path finds nothing. */
  default?: string
}

export type Condition =
  | {
      path: string
      equals?: Scalar
      notEquals?: Scalar
      in?: Scalar[]
      exists?: boolean
      matches?: string
    }
  | { all: Condition[] }
  | { any: Condition[] }

export interface StatusRule {
  /** Applies when this holds; a rule without one always applies. */
  when?: Condition
  health: Health
  /** Templates: text with {{ .path }} values in it. */
  label: string
  detail?: string
}

export interface ViewLink {
  name: string
  /** Templates naming the related object: "Secret", "{{ .spec.issuerRef.kind }}.cert-manager.io"… */
  kind: string
  objectName: string
  /** The object's own namespace unless set (and none for cluster-wide kinds). */
  namespace?: string
}

/** Objects of another kind that belong to an object, listed in a tab of its own. */
export interface ViewRelated {
  /** The tab's name: "Instances", "Nodes"… */
  name: string
  /** A template naming their kind: "Pod", "NodeClaim.karpenter.sh"… */
  kind: string
  /** The labels they have, each a template: `cnpg.io/cluster: '{{ .metadata.name }}'`. */
  labels?: Record<string, string>
  /** A template: "spec.nodeName={{ .status.nodeName }}". */
  fieldSelector?: string
  /** Where they are: the object's own namespace unless set (every one, for cluster-wide objects). */
  namespace?: string
}

/** What an action's inputs were given: numbers for number inputs, and text ('' when left empty). */
export type InputValues = Record<string, string | number>

/** A value an action asks for before it runs, filled in where its templates say `{{ input.name }}`. */
export interface ViewInput {
  name: string
  label: string
  /** `text` (the default), a `number`, or a `choice` of `options`, or of what `from` finds. */
  type: 'text' | 'number' | 'choice'
  options?: Scalar[]
  from?: string
  /** A template for the value it starts with. */
  default?: string
}

export interface ViewAction {
  name: string
  icon?: ViewIconName
  when?: Condition
  /** What it asks for first; it always asks when it has inputs. */
  inputs?: ViewInput[]
  /** The change it makes: a patch of the object, or another object to create. */
  patch?: Record<string, unknown> | Record<string, unknown>[]
  /** An object to create (templates and all), shown before it's created. */
  create?: Record<string, unknown>
  /** `merge` (the default) or `json` (a list of operations). */
  type: 'merge' | 'json'
  /** Patches the object's status instead. */
  subresource?: 'status'
  /** The patch that takes it back, offered as Undo. */
  undo?: Record<string, unknown> | Record<string, unknown>[]
  /** Asks first, with this text; otherwise it runs at once. */
  confirm?: string
  /** What happened, for the notification: "Suspended {{ .metadata.name }}". */
  done?: string
  primary?: boolean
  danger?: boolean
}

export interface View {
  name: string
  /** Where it came from: "KubeStacks", or the user's file. */
  source: string
  kinds: ResourceKind[]
  icon?: ViewIconName
  columns?: ViewField[]
  status?: StatusRule[]
  details?: ViewField[]
  links?: ViewLink[]
  related?: ViewRelated[]
  actions?: ViewAction[]
}

/** The sidebar's sections for Kubernetes' own kinds, which an add-on can sit in. */
export const ADD_ON_CATEGORIES = ['cluster', 'network', 'config', 'storage'] as const

/** A tool's kinds, under one entry in the sidebar that leads to a page with a tab for each. */
export interface AddOn {
  name: string
  /** Where it came from: "KubeStacks", or the user's file. */
  source: string
  label: string
  icon?: ViewIconName
  /** A section of Kubernetes' own kinds to sit in, instead of Add-ons. */
  category?: Exclude<ResourceCategory, 'workloads'>
  /** In the order of their tabs. */
  kinds: ResourceKind[]
}

// ——— Checking ———

/** What a part of a view must look like; checked against the YAML before it's used. */
type Shape =
  | 'string'
  | 'boolean'
  | 'scalar'
  | 'path'
  | 'template'
  | 'regex'
  | 'patch'
  | { oneOf: readonly string[] }
  | { list: Shape; nonEmpty?: boolean }
  /** Any keys, each value a `Shape`. */
  | { map: Shape }
  | {
      fields: Record<string, Shape | { shape: Shape; required: true }>
      /** A last check of the whole object, once its fields are fine. */
      refine?: (value: Record<string, unknown>) => string | undefined
    }

const HEALTHS = ['healthy', 'progressing', 'warning', 'critical', 'neutral'] as const

/** A view's kinds as KubeStacks names them: "Certificate.cert-manager.io", "Secret". */
const kindId = ({ group, kind }: { group?: string; kind: string }) =>
  kindFor(group ? `${group}/v1` : 'v1', kind)

const conditionShape: Shape = {
  fields: {
    path: 'path',
    equals: 'scalar',
    notEquals: 'scalar',
    in: { list: 'scalar', nonEmpty: true },
    exists: 'boolean',
    matches: 'regex',
    get all() {
      return { list: conditionShape, nonEmpty: true }
    },
    get any() {
      return { list: conditionShape, nonEmpty: true }
    },
  },
  refine: (c) =>
    [c.path, c.all, c.any].filter((v) => v !== undefined).length === 1
      ? undefined
      : 'needs exactly one of path, all or any',
}

/** A kind, or every kind of a group (`kind: '*'`), like the constraints Gatekeeper's templates make. */
const kindsShape: Shape = {
  list: {
    fields: { group: 'string', kind: { shape: 'string', required: true } },
    refine: (k) =>
      k.kind === '*' && !k.group ? 'every kind (*) is of a group: name it' : undefined,
  },
  nonEmpty: true,
}

const fieldShape: Shape = {
  fields: {
    name: { shape: 'string', required: true },
    path: { shape: 'path', required: true },
    type: { oneOf: ['string', 'number', 'date', 'boolean', 'count'] },
    default: 'string',
  },
}

const INPUT_NAME = /^[A-Za-z_]\w*$/

const inputShape: Shape = {
  fields: {
    name: { shape: 'string', required: true },
    label: { shape: 'string', required: true },
    type: { oneOf: ['text', 'number', 'choice'] },
    options: { list: 'scalar', nonEmpty: true },
    from: 'path',
    default: 'template',
  },
  refine: (input) => {
    if (!INPUT_NAME.test(input.name as string)) {
      return `${JSON.stringify(input.name)} should be letters, digits and _, like replicas`
    }
    const choice = input.type === 'choice'
    const given = [input.options, input.from].filter((v) => v !== undefined).length
    if (choice && given !== 1) return 'a choice needs options, or a path to read them from'
    return !choice && given > 0 ? 'only a choice has options' : undefined
  },
}

/** What's wrong with an action as a whole, once its fields are fine. */
function actionProblem(a: Record<string, unknown>): string | undefined {
  if ((a.patch === undefined) === (a.create === undefined)) {
    return 'needs a patch, or an object to create (not both)'
  }
  if (a.create !== undefined) {
    const { apiVersion, kind, metadata } = a.create as Record<string, unknown>
    const { name, generateName } = (metadata ?? {}) as Record<string, unknown>
    if (typeof apiVersion !== 'string' || typeof kind !== 'string' || !(name || generateName)) {
      return 'what it creates needs an apiVersion, a kind, and a metadata.name or generateName'
    }
    if (a.undo !== undefined) return 'can’t undo creating something'
  }
  if (
    ![a.patch, a.undo].every((p) => p === undefined || Array.isArray(p) === (a.type === 'json'))
  ) {
    return 'patches are an object for type merge, and a list for type json'
  }
  const inputs = new Set(((a.inputs ?? []) as { name: string }[]).map((input) => input.name))
  const used = JSON.stringify([a.patch, a.create, a.confirm, a.done]).matchAll(INPUT_PLACEHOLDER)
  const unknown = [...used].find(([, name]) => !inputs.has(name!))
  return unknown && `{{ input.${unknown[1]} }} isn’t one of its inputs`
}

const VIEW_SHAPE: Shape = {
  fields: {
    kinds: { shape: kindsShape, required: true },
    icon: { oneOf: VIEW_ICON_NAMES },
    columns: { list: fieldShape },
    status: {
      list: {
        fields: {
          when: conditionShape,
          health: { shape: { oneOf: HEALTHS }, required: true },
          label: { shape: 'template', required: true },
          detail: 'template',
        },
      },
    },
    details: { list: fieldShape },
    links: {
      list: {
        fields: {
          name: { shape: 'string', required: true },
          kind: { shape: 'template', required: true },
          objectName: { shape: 'template', required: true },
          namespace: 'template',
        },
      },
    },
    related: {
      list: {
        fields: {
          name: { shape: 'string', required: true },
          kind: { shape: 'template', required: true },
          labels: { map: 'template' },
          fieldSelector: 'template',
          namespace: 'template',
        },
        // Without a selector, they'd be every object of the kind.
        refine: (r) =>
          r.labels || r.fieldSelector ? undefined : 'needs labels or a fieldSelector to find them',
      },
    },
    actions: {
      list: {
        fields: {
          name: { shape: 'string', required: true },
          icon: { oneOf: VIEW_ICON_NAMES },
          when: conditionShape,
          inputs: { list: inputShape, nonEmpty: true },
          patch: 'patch',
          create: 'patch',
          type: { oneOf: ['merge', 'json'] },
          subresource: { oneOf: ['status'] },
          undo: 'patch',
          confirm: 'template',
          done: 'template',
          primary: 'boolean',
          danger: 'boolean',
        },
        refine: actionProblem,
      },
    },
  },
}

const ADD_ON_SHAPE: Shape = {
  fields: {
    label: { shape: 'string', required: true },
    icon: { oneOf: VIEW_ICON_NAMES },
    category: { oneOf: ADD_ON_CATEGORIES },
    kinds: { shape: kindsShape, required: true },
  },
  // Kubernetes' own kinds have their pages, each in its place in the sidebar.
  refine: (spec) =>
    (spec.kinds as { group?: string; kind: string }[])
      .map(kindId)
      .filter(isBuiltinKind)
      .map((kind) => `${kind} has a page of its own, so it can’t be in an add-on`)[0],
}

/**
 * `{{ .path }}` in a template, with a fallback for when it finds nothing:
 * `{{ .path ?? "text" }}` or `{{ .path ?? .other.path }}`. `{{ now }}` is the time.
 */
export const PLACEHOLDER = /\{\{\s*(.*?)\s*\}\}/g
export const EXPRESSION = /^(\S+?)(?:\s*\?\?\s*(?:"([^"]*)"|(\.\S*)))?$/
/** `{{ input.name }}`: an action's input, wherever it is in a template. */
const INPUT_PLACEHOLDER = /\{\{\s*input\.(\w+)/g
/** A template that's one placeholder and nothing else: a value of its own. */
const ONLY_PLACEHOLDER = /^\{\{\s*([^{}]*?)\s*\}\}$/
/** An input's value as a path in a template. */
const INPUT_PATH = /^input\.\w+$/

function templateProblem(template: string): string | undefined {
  for (const [, expression] of template.matchAll(PLACEHOLDER)) {
    const [, path, , fallback] = EXPRESSION.exec(expression!) ?? []
    if (!path) return `{{ ${expression} }} should be a path, maybe with ?? "a fallback"`
    try {
      for (const p of [path, fallback]) if (p && p !== 'now' && !INPUT_PATH.test(p)) checkPath(p)
    } catch (error) {
      return (error as Error).message
    }
  }
  return undefined
}

const describe = (value: unknown) =>
  value === null ? 'null' : Array.isArray(value) ? 'a list' : `a ${typeof value}`

/** Problems with `value` as `shape`, each prefixed with where it is; `noun` is what it's part of. */
function check(value: unknown, shape: Shape, where: string, noun: string): string[] {
  const fail = (message: string) => [`${where}: ${message}`]
  if (typeof shape === 'string') {
    switch (shape) {
      case 'boolean':
        return typeof value === 'boolean'
          ? []
          : fail(`should be true or false, not ${describe(value)}`)
      case 'scalar':
        return ['string', 'number', 'boolean'].includes(typeof value) || value === null
          ? []
          : fail(`should be a single value, not ${describe(value)}`)
      case 'patch':
        return typeof value === 'object' && value !== null
          ? []
          : fail(`should be a patch (an object or a list), not ${describe(value)}`)
      default: {
        if (typeof value !== 'string') return fail(`should be text, not ${describe(value)}`)
        try {
          if (shape === 'path') checkPath(value)
          if (shape === 'regex') new RegExp(value)
        } catch (error) {
          return fail((error as Error).message)
        }
        const problem = shape === 'template' ? templateProblem(value) : undefined
        return problem ? fail(problem) : []
      }
    }
  }
  if ('oneOf' in shape) {
    return shape.oneOf.includes(value as string)
      ? []
      : fail(`should be one of ${shape.oneOf.join(', ')}, not ${JSON.stringify(value)}`)
  }
  if ('list' in shape) {
    if (!Array.isArray(value)) return fail(`should be a list, not ${describe(value)}`)
    if (shape.nonEmpty && value.length === 0) return fail('should not be empty')
    return value.flatMap((item, i) => check(item, shape.list, `${where}[${i}]`, noun))
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(`should be a map of fields, not ${describe(value)}`)
  }
  if ('map' in shape) {
    return Object.entries(value).flatMap(([key, item]) =>
      check(item, shape.map, `${where}.${key}`, noun),
    )
  }
  const fields = value as Record<string, unknown>
  const problems = Object.keys(fields)
    .filter((key) => !(key in shape.fields))
    .map((key) => `${where}.${key}: isn’t something ${noun} has`)
  for (const [key, rule] of Object.entries(shape.fields)) {
    const { shape: inner, required } =
      typeof rule === 'object' && 'required' in rule ? rule : { shape: rule, required: false }
    if (fields[key] === undefined) {
      if (required) problems.push(`${where}.${key}: is required`)
    } else {
      problems.push(...check(fields[key], inner, `${where}.${key}`, noun))
    }
  }
  const refined = problems.length === 0 ? shape.refine?.(fields) : undefined
  return refined ? [...problems, `${where}: ${refined}`] : problems
}

/**
 * The views and add-ons in a file (YAML, one per document), and what's wrong
 * with the others: one with problems isn't used.
 */
export function parseViews(
  text: string,
  source: string,
): { views: View[]; addOns: AddOn[]; problems: string[] } {
  const views: View[] = []
  const addOns: AddOn[] = []
  const problems: string[] = []
  for (const [i, document] of parseAllDocuments(text).entries()) {
    const at = `${source}${i > 0 ? ` (document ${i + 1})` : ''}`
    if (document.errors.length) {
      problems.push(`${at}: ${document.errors[0]!.message}`)
      continue
    }
    const doc = document.toJS() as Record<string, unknown> | null
    if (doc === null) continue
    if (
      typeof doc !== 'object' ||
      doc.apiVersion !== VIEW_API_VERSION ||
      (doc.kind !== 'View' && doc.kind !== 'AddOn')
    ) {
      problems.push(
        `${at}: should start with apiVersion: ${VIEW_API_VERSION} and kind: View or AddOn`,
      )
      continue
    }
    const name = (doc.metadata as { name?: unknown } | undefined)?.name
    if (typeof name !== 'string' || !name) {
      problems.push(`${at}: needs metadata.name`)
      continue
    }
    const addOn = doc.kind === 'AddOn'
    const found = addOn
      ? check(doc.spec, ADD_ON_SHAPE, `${at}: ${name}: spec`, 'an add-on')
      : check(doc.spec, VIEW_SHAPE, `${at}: ${name}: spec`, 'a view')
    if (found.length) {
      problems.push(...found)
      continue
    }
    if (addOn) {
      const spec = doc.spec as Omit<AddOn, 'name' | 'source' | 'kinds'> & {
        kinds: { group?: string; kind: string }[]
      }
      addOns.push({ ...spec, name, source, kinds: spec.kinds.map(kindId) })
      continue
    }
    const spec = doc.spec as Omit<View, 'name' | 'source' | 'kinds'> & {
      kinds: { group?: string; kind: string }[]
    }
    const withType = (fields?: ViewField[]) =>
      fields?.map((f) => ({ ...f, type: f.type ?? 'string' }))
    views.push({
      ...spec,
      name,
      source,
      kinds: spec.kinds.map(kindId),
      columns: withType(spec.columns),
      details: withType(spec.details),
      actions: spec.actions?.map((a) => ({
        ...a,
        type: a.type ?? 'merge',
        inputs: a.inputs?.map((input) => ({ ...input, type: input.type ?? 'text' })),
      })),
    })
  }
  return { views, addOns, problems }
}

// ——— Using ———

const shipped = new Map<ResourceKind, View>()
let local = new Map<ResourceKind, View>()
const shippedAddOns = new Map<string, AddOn>()
let localAddOns = new Map<string, AddOn>()

function byKind(views: View[]): Map<ResourceKind, View> {
  return new Map(views.flatMap((view) => view.kinds.map((kind) => [kind, view] as const)))
}

const byName = (addOns: AddOn[]) => new Map(addOns.map((addOn) => [addOn.name, addOn]))

/** KubeStacks' own views and add-ons, and anything wrong with them (there should be nothing). */
export function loadShippedViews(files: Record<string, string>): string[] {
  const problems: string[] = []
  for (const [path, text] of Object.entries(files)) {
    const parsed = parseViews(text, path.slice(path.lastIndexOf('/') + 1))
    const views = parsed.views.map((view) => ({ ...view, source: 'KubeStacks' }))
    for (const [kind, view] of byKind(views)) shipped.set(kind, view)
    for (const addOn of parsed.addOns)
      shippedAddOns.set(addOn.name, { ...addOn, source: 'KubeStacks' })
    problems.push(...parsed.problems)
  }
  return problems
}

/** Replaces the user's views and add-ons. */
export function setLocalViews(views: View[], addOns: AddOn[]): void {
  local = byKind(views)
  localAddOns = byName(addOns)
}

/** The view for a kind: the user's if they have one, else KubeStacks'. */
/** `*.constraints.gatekeeper.sh`: how a view or an add-on names every kind of a group. */
export function everyKindOf(kind: ResourceKind): ResourceKind {
  return `*.${apiGroupOf(kind)}`
}

/**
 * The view for a kind: the user's if they have one, else KubeStacks'; one
 * for the kind itself before one for every kind of its group.
 */
export function viewFor(kind: ResourceKind): View | undefined {
  const every = everyKindOf(kind)
  return local.get(kind) ?? local.get(every) ?? shipped.get(kind) ?? shipped.get(every)
}

export function shippedViews(): View[] {
  return [...new Set(shipped.values())]
}

/** Every add-on: the user's, and KubeStacks' that none of theirs replaces. */
export function allAddOns(): AddOn[] {
  return [
    ...localAddOns.values(),
    ...[...shippedAddOns.values()].filter((addOn) => !localAddOns.has(addOn.name)),
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

/**
 * Views: how KubeStacks shows a kind it has no page of its own for (its
 * columns, status, details, related objects and actions), written as data.
 *
 * KubeStacks ships views for popular operators (src/renderer/src/views) and
 * reads the user's own from ~/.kubestacks/views; a user's view of a kind
 * replaces the shipped one. Views can't run code: they read fields with
 * JSONPath and change objects only with the patches they spell out.
 * docs/views.md describes the format.
 */
import { parseAllDocuments } from 'yaml'
import { checkPath, jsonPath } from '@shared/jsonpath'
import { kindFor, type ResourceKind } from '@shared/resources'
import type { Health, Status } from './health'

export const VIEW_API_VERSION = 'kubestacks.dev/v1alpha1'

/** Icons a view can pick, by their Lucide names. */
export const VIEW_ICON_NAMES = [
  'activity',
  'archive',
  'bell',
  'box',
  'boxes',
  'cloud',
  'database',
  'gauge',
  'git-branch',
  'globe',
  'key-round',
  'layers',
  'lock',
  'network',
  'package',
  'puzzle',
  'radar',
  'refresh-cw',
  'rocket',
  'route',
  'server',
  'shield-check',
  'timer',
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

export interface ViewAction {
  name: string
  icon?: ViewIconName
  when?: Condition
  patch: Record<string, unknown> | Record<string, unknown>[]
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
  actions?: ViewAction[]
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
  | {
      fields: Record<string, Shape | { shape: Shape; required: true }>
      /** A last check of the whole object, once its fields are fine. */
      refine?: (value: Record<string, unknown>) => string | undefined
    }

const HEALTHS = ['healthy', 'progressing', 'warning', 'critical', 'neutral'] as const

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

const fieldShape: Shape = {
  fields: {
    name: { shape: 'string', required: true },
    path: { shape: 'path', required: true },
    type: { oneOf: ['string', 'number', 'date', 'boolean', 'count'] },
    default: 'string',
  },
}

const VIEW_SHAPE: Shape = {
  fields: {
    kinds: {
      shape: {
        list: { fields: { group: 'string', kind: { shape: 'string', required: true } } },
        nonEmpty: true,
      },
      required: true,
    },
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
    actions: {
      list: {
        fields: {
          name: { shape: 'string', required: true },
          icon: { oneOf: VIEW_ICON_NAMES },
          when: conditionShape,
          patch: { shape: 'patch', required: true },
          type: { oneOf: ['merge', 'json'] },
          subresource: { oneOf: ['status'] },
          undo: 'patch',
          confirm: 'template',
          done: 'template',
          primary: 'boolean',
          danger: 'boolean',
        },
        refine: (a) =>
          [a.patch, a.undo].every(
            (p) => p === undefined || Array.isArray(p) === ((a.type ?? 'merge') === 'json'),
          )
            ? undefined
            : 'patches are an object for type merge, and a list for type json',
      },
    },
  },
}

/**
 * `{{ .path }}` in a template, with a fallback for when it finds nothing:
 * `{{ .path ?? "text" }}` or `{{ .path ?? .other.path }}`. `{{ now }}` is the time.
 */
const PLACEHOLDER = /\{\{\s*(.*?)\s*\}\}/g
const EXPRESSION = /^(\S+?)(?:\s*\?\?\s*(?:"([^"]*)"|(\.\S*)))?$/

function templateProblem(template: string): string | undefined {
  for (const [, expression] of template.matchAll(PLACEHOLDER)) {
    const [, path, , fallback] = EXPRESSION.exec(expression!) ?? []
    if (!path) return `{{ ${expression} }} should be a path, maybe with ?? "a fallback"`
    try {
      for (const p of [path, fallback]) if (p && p !== 'now') checkPath(p)
    } catch (error) {
      return (error as Error).message
    }
  }
  return undefined
}

const describe = (value: unknown) =>
  value === null ? 'null' : Array.isArray(value) ? 'a list' : `a ${typeof value}`

/** Problems with `value` as `shape`, each prefixed with where it is. */
function check(value: unknown, shape: Shape, where: string): string[] {
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
    return value.flatMap((item, i) => check(item, shape.list, `${where}[${i}]`))
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(`should be a map of fields, not ${describe(value)}`)
  }
  const fields = value as Record<string, unknown>
  const problems = Object.keys(fields)
    .filter((key) => !(key in shape.fields))
    .map((key) => `${where}.${key}: isn’t something a view has`)
  for (const [key, rule] of Object.entries(shape.fields)) {
    const { shape: inner, required } =
      typeof rule === 'object' && 'required' in rule ? rule : { shape: rule, required: false }
    if (fields[key] === undefined) {
      if (required) problems.push(`${where}.${key}: is required`)
    } else {
      problems.push(...check(fields[key], inner, `${where}.${key}`))
    }
  }
  const refined = problems.length === 0 ? shape.refine?.(fields) : undefined
  return refined ? [...problems, `${where}: ${refined}`] : problems
}

/** A view's kinds as KubeStacks names them: "Certificate.cert-manager.io", "Secret". */
const kindId = ({ group, kind }: { group?: string; kind: string }) =>
  kindFor(group ? `${group}/v1` : 'v1', kind)

/**
 * The views in a file (YAML, one view per document), and what's wrong with
 * the others: a view with problems isn't used.
 */
export function parseViews(text: string, source: string): { views: View[]; problems: string[] } {
  const views: View[] = []
  const problems: string[] = []
  for (const [i, document] of parseAllDocuments(text).entries()) {
    const at = `${source}${i > 0 ? ` (document ${i + 1})` : ''}`
    if (document.errors.length) {
      problems.push(`${at}: ${document.errors[0]!.message}`)
      continue
    }
    const doc = document.toJS() as Record<string, unknown> | null
    if (doc === null) continue
    if (typeof doc !== 'object' || doc.apiVersion !== VIEW_API_VERSION || doc.kind !== 'View') {
      problems.push(`${at}: should start with apiVersion: ${VIEW_API_VERSION} and kind: View`)
      continue
    }
    const name = (doc.metadata as { name?: unknown } | undefined)?.name
    if (typeof name !== 'string' || !name) {
      problems.push(`${at}: needs metadata.name`)
      continue
    }
    const found = check(doc.spec, VIEW_SHAPE, `${at}: ${name}: spec`)
    if (found.length) {
      problems.push(...found)
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
      actions: spec.actions?.map((a) => ({ ...a, type: a.type ?? 'merge' })),
    })
  }
  return { views, problems }
}

// ——— Using ———

const shipped = new Map<ResourceKind, View>()
let local = new Map<ResourceKind, View>()

function byKind(views: View[]): Map<ResourceKind, View> {
  return new Map(views.flatMap((view) => view.kinds.map((kind) => [kind, view] as const)))
}

/** KubeStacks' own views, and anything wrong with them (there should be nothing). */
export function loadShippedViews(files: Record<string, string>): string[] {
  const problems: string[] = []
  for (const [path, text] of Object.entries(files)) {
    const parsed = parseViews(text, path.slice(path.lastIndexOf('/') + 1))
    const views = parsed.views.map((view) => ({ ...view, source: 'KubeStacks' }))
    for (const [kind, view] of byKind(views)) shipped.set(kind, view)
    problems.push(...parsed.problems)
  }
  return problems
}

/** Replaces the user's views. */
export function setLocalViews(views: View[]): void {
  local = byKind(views)
}

/** The view for a kind: the user's if they have one, else KubeStacks'. */
export function viewFor(kind: ResourceKind): View | undefined {
  return local.get(kind) ?? shipped.get(kind)
}

export function shippedViews(): View[] {
  return [...new Set(shipped.values())]
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
export function render(template: string, object: unknown, now = Date.now()): string {
  return template.replace(PLACEHOLDER, (_, expression: string) => {
    const [, path, literal = '', fallback] = EXPRESSION.exec(expression)!
    if (path === 'now') return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z')
    return (
      text(jsonPath(object, path!)) ?? (fallback ? text(jsonPath(object, fallback)) : literal) ?? ''
    )
  })
}

/** Fills in the templates in a patch's text. */
export function renderPatch<T>(patch: T, object: unknown, now = Date.now()): T {
  return JSON.parse(
    JSON.stringify(patch, (_key, value: unknown) =>
      typeof value === 'string' ? render(value, object, now) : value,
    ),
  ) as T
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

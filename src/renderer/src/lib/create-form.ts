/**
 * Create's form, as it reads and writes the YAML beside it. The YAML's text is the one truth:
 * the form holds no object of its own. What its fields show is read out of the text each time
 * it changes, and what's typed in one is an edit of the text (`yaml-edit`), which leaves the
 * rest as it was written.
 *
 * Each kind says which paths its fields own. From that:
 * - the form fits, or it steps back and says why: the text doesn't parse, isn't one object of
 *   its kind, or has something where a field is that the field can't show (two containers);
 * - what the YAML sets that no field owns is kept, and named, at the highest key that's so.
 */
import { parseAllDocuments } from 'yaml'
import type { KubeErrorCause } from '@shared/api'
import { elsewhere, linesAt, pathText, removeAt, setAt, type Path } from './yaml-edit'

export type FormKindName = 'Deployment'

/** Where a new key goes among its map's own, for every map the form writes in. */
const ORDER = [
  'apiVersion',
  'kind',
  'metadata',
  'name',
  'namespace',
  'spec',
  'replicas',
  'selector',
  'matchLabels',
  'template',
  'labels',
  'containers',
  'image',
  'command',
  'ports',
  'containerPort',
  'env',
  'value',
  'resources',
  'requests',
  'limits',
  'cpu',
  'memory',
]

const set = (text: string, path: Path, value: unknown) => setAt(text, path, value, ORDER)

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const dig = (value: unknown, path: Path): unknown =>
  path.reduce<unknown>(
    (at, part) => (at as Record<string | number, unknown> | null | undefined)?.[part],
    value,
  )

/** A single value as a field shows it: nothing, for none. */
const shown = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value as string | number | boolean)

// ——— Whether the form can show the YAML ———

export type Read =
  | { fits: true; object: Json }
  /** `why` is said to whoever wrote it; `lines` are the ones that are why, where that's lines. */
  | { fits: false; why: string; lines?: [number, number] }

const COUNT = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
const count = (n: number) => COUNT[n] ?? String(n)

/** A path as it's said in a sentence. */
const said = (path: Path) => pathText(path)

/** What a path must be for the form to show it: `maps` and `lists` may also be absent. */
interface Shape {
  maps: Path[]
  lists: Path[]
  /** Lists whose every item is a map. */
  listsOfMaps: Path[]
  /** Single values (or nothing): what the fields edit. */
  values: Path[]
}

function misshapen(object: Json, shape: Shape): string | undefined {
  for (const path of shape.maps) {
    const value = dig(object, path)
    if (value !== undefined && value !== null && !isObject(value)) {
      return `${said(path)} isn’t a group of keys, which the form expects there.`
    }
  }
  for (const path of [...shape.lists, ...shape.listsOfMaps]) {
    const value = dig(object, path)
    if (value !== undefined && value !== null && !Array.isArray(value)) {
      return `${said(path)} isn’t a list, which the form expects there.`
    }
  }
  for (const path of shape.listsOfMaps) {
    const value = (dig(object, path) ?? []) as unknown[]
    const odd = value.findIndex((item) => !isObject(item))
    if (odd >= 0)
      return `${said([...path, odd])} isn’t a group of keys, which the form expects there.`
  }
  for (const path of shape.values) {
    const value = dig(object, path)
    if (typeof value === 'object' && value !== null) {
      return `${said(path)} holds more than one value, and the form’s field there takes one.`
    }
  }
  return undefined
}

/** The one object the text holds, if it's of `kind` and nothing in it is beyond the form. */
export function read(text: string, form: FormKind): Read {
  const documents = parseAllDocuments(text)
  for (const document of documents) {
    const error = document.errors[0]
    if (error) {
      const line = error.linePos?.[0].line
      return {
        fits: false,
        // The parser's own words, which say where: "… at line 5, column 3".
        why: `It isn’t YAML as it stands: ${error.message.split('\n')[0]!.replace(/:$/, '')}.`,
        ...(line ? { lines: [line, line] as [number, number] } : {}),
      }
    }
  }
  const objects = documents.map((d) => d.toJS() as unknown).filter((o) => o !== null)
  if (objects.length !== 1) {
    return {
      fits: false,
      why:
        objects.length === 0
          ? 'It’s empty, and the form needs an object to show.'
          : `It has ${count(objects.length)} objects, and the form edits one.`,
    }
  }
  if (documents.length !== 1) {
    return { fits: false, why: 'It has more than one document, and the form edits one.' }
  }
  const object = objects[0]
  if (!isObject(object)) {
    return { fits: false, why: 'It isn’t an object with keys, as every Kubernetes object is.' }
  }
  if (object.kind !== form.kind || object.apiVersion !== form.apiVersion) {
    const kind = typeof object.kind === 'string' ? object.kind : undefined
    return {
      fits: false,
      why:
        kind && kind !== form.kind
          ? `It’s a ${kind}, and this is the form for a ${form.kind}.`
          : `Its apiVersion and kind aren’t ${form.apiVersion} and ${form.kind}, which this form writes.`,
      lines: linesAt(text, kind && kind !== form.kind ? ['kind'] : ['apiVersion']),
    }
  }
  const why = form.cannotShow(object) ?? misshapen(object, form.shape)
  if (why) return { fits: false, why: typeof why === 'string' ? why : why.why, ...lined(text, why) }
  // A value that's repeated from elsewhere, or for elsewhere, isn't one the form can edit.
  for (const path of form.shape.values) {
    const how = dig(object, path) === undefined ? undefined : elsewhere(text, path)
    if (how) {
      return {
        fits: false,
        why:
          how === 'merge'
            ? `${said(path)} comes through a merge key (<<), so it isn’t written in one place for the form to edit.`
            : `${said(path)} is ${how === 'alias' ? 'an alias of a value' : 'anchored, to be repeated'} elsewhere in the YAML, so the form can’t edit it alone.`,
        lines: linesAt(text, path),
      }
    }
  }
  return { fits: true, object }
}

type Why = string | { why: string; at: Path }
const lined = (text: string, why: Why) =>
  typeof why === 'string' ? {} : { lines: linesAt(text, why.at) }

// ——— What the YAML sets that the form has no field for ———

/** A path with `*` for any index: what a field owns, or the form writes by rule. */
type Pattern = readonly (string | number)[]

const matches = (pattern: Pattern, path: Path, whole: boolean) =>
  (whole ? pattern.length === path.length : pattern.length >= path.length) &&
  path.every((part, i) => pattern[i] === part || (pattern[i] === '*' && typeof part === 'number'))

/**
 * The paths the object sets that no field owns, each at the highest key that's so
 * (`spec.strategy`, not `spec.strategy.type`), in the order they're written.
 */
export function unowned(object: Json, form: FormKind): Path[] {
  const found: Path[] = []
  const walk = (value: unknown, path: Path) => {
    if (form.owns.some((pattern) => matches(pattern, path, true))) return
    // On the way to something owned: what's beside it is looked at, each on its own.
    const within = form.owns.some((pattern) => matches(pattern, path, false))
    if (!within || typeof value !== 'object' || value === null) {
      // (A key with nothing set says nothing.)
      if (value !== undefined && value !== null) found.push(path)
      return
    }
    if (Array.isArray(value)) value.forEach((item, i) => walk(item, [...path, i]))
    else for (const [key, item] of Object.entries(value)) walk(item, [...path, key])
  }
  for (const [key, value] of Object.entries(object)) walk(value, [key])
  return found
}

// ——— A kind's form ———

export interface FormKind {
  kind: FormKindName
  apiVersion: string
  /** The YAML a new one starts as: what it must have, with nothing said yet. */
  blank(namespace: string): string
  shape: Shape
  owns: Pattern[]
  /** Why the form can't show it, beyond its shape (two containers). */
  cannotShow(object: Json): Why | undefined
}

const C = ['spec', 'template', 'spec', 'containers', 0] as const
const C_ANY = ['spec', 'template', 'spec', 'containers', 0]

export const DEPLOYMENT: FormKind = {
  kind: 'Deployment',
  apiVersion: 'apps/v1',
  blank: (namespace) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name:
  namespace: ${namespace}
spec:
  replicas: 1
  selector:
    matchLabels:
      app:
  template:
    metadata:
      labels:
        app:
    spec:
      containers:
        - name:
          image:
`,
  shape: {
    maps: [
      ['metadata'],
      ['spec'],
      ['spec', 'selector'],
      ['spec', 'selector', 'matchLabels'],
      ['spec', 'template'],
      ['spec', 'template', 'metadata'],
      ['spec', 'template', 'metadata', 'labels'],
      ['spec', 'template', 'spec'],
      [...C, 'resources'],
      [...C, 'resources', 'requests'],
      [...C, 'resources', 'limits'],
    ],
    lists: [],
    listsOfMaps: [
      ['spec', 'template', 'spec', 'containers'],
      [...C, 'ports'],
      [...C, 'env'],
    ],
    values: [
      ['metadata', 'name'],
      ['metadata', 'namespace'],
      ['spec', 'replicas'],
      ['spec', 'selector', 'matchLabels', 'app'],
      ['spec', 'template', 'metadata', 'labels', 'app'],
      [...C, 'name'],
      [...C, 'image'],
      [...C, 'ports', 0, 'containerPort'],
      [...C, 'resources', 'requests', 'cpu'],
      [...C, 'resources', 'requests', 'memory'],
      [...C, 'resources', 'limits', 'cpu'],
      [...C, 'resources', 'limits', 'memory'],
    ],
  },
  owns: [
    ['apiVersion'],
    ['kind'],
    ['metadata', 'name'],
    ['metadata', 'namespace'],
    ['spec', 'replicas'],
    ['spec', 'selector', 'matchLabels', 'app'],
    ['spec', 'template', 'metadata', 'labels', 'app'],
    [...C_ANY, 'name'],
    [...C_ANY, 'image'],
    [...C_ANY, 'ports', 0, 'containerPort'],
    // A variable is a row of the form's, whether its value is said or comes from elsewhere.
    [...C_ANY, 'env', '*'],
    [...C_ANY, 'resources', 'requests', 'cpu'],
    [...C_ANY, 'resources', 'requests', 'memory'],
    [...C_ANY, 'resources', 'limits', 'cpu'],
    [...C_ANY, 'resources', 'limits', 'memory'],
  ],
  cannotShow(object) {
    const containers = dig(object, ['spec', 'template', 'spec', 'containers'])
    if (Array.isArray(containers) && containers.length > 1) {
      return {
        why: `It has ${count(containers.length)} containers, and the form edits one.`,
        at: ['spec', 'template', 'spec', 'containers', 1],
      }
    }
    return undefined
  },
}

export const FORM_KINDS: Record<FormKindName, FormKind> = { Deployment: DEPLOYMENT }

// ——— A workload's fields: what they show ———

/** One of a container's variables, as its row shows it. */
export interface Variable {
  name: string
  /** What it's set to, where the YAML says. */
  value?: string
  /** Where its value comes from, where it isn't said here: "Secret payments, key api-key". */
  from?: string
}

export interface Resources {
  cpuRequest: string
  memoryRequest: string
  cpuLimit: string
  memoryLimit: string
}

export interface WorkloadValues {
  name: string
  namespace: string
  replicas: string
  image: string
  port: string
  env: Variable[]
  resources: Resources
}

/** Where a variable's value comes from, said: "Secret payments, key api-key". */
function source(valueFrom: unknown): string {
  const from = Object(valueFrom) as Record<string, Record<string, unknown> | undefined>
  const ref = (kind: string, of: Record<string, unknown>) =>
    `${kind} ${shown(of.name) || '…'}, key ${shown(of.key) || '…'}`
  if (isObject(from.secretKeyRef)) return ref('Secret', from.secretKeyRef)
  if (isObject(from.configMapKeyRef)) return ref('ConfigMap', from.configMapKeyRef)
  if (isObject(from.fieldRef)) return `the pod’s field ${shown(from.fieldRef.fieldPath) || '…'}`
  if (isObject(from.resourceFieldRef)) {
    return `the container’s ${shown(from.resourceFieldRef.resource) || '…'}`
  }
  return 'elsewhere, as the YAML says'
}

export function workloadValues(object: Json): WorkloadValues {
  const text = (path: Path) => shown(dig(object, path))
  const env = (dig(object, [...C, 'env']) ?? []) as Json[]
  return {
    name: text(['metadata', 'name']),
    namespace: text(['metadata', 'namespace']),
    replicas: text(['spec', 'replicas']),
    image: text([...C, 'image']),
    port: text([...C, 'ports', 0, 'containerPort']),
    env: env.map((variable) => ({
      name: shown(variable.name),
      ...('valueFrom' in variable && variable.valueFrom !== null && variable.valueFrom !== undefined
        ? { from: source(variable.valueFrom) }
        : { value: shown(variable.value) }),
    })),
    resources: {
      cpuRequest: text([...C, 'resources', 'requests', 'cpu']),
      memoryRequest: text([...C, 'resources', 'requests', 'memory']),
      cpuLimit: text([...C, 'resources', 'limits', 'cpu']),
      memoryLimit: text([...C, 'resources', 'limits', 'memory']),
    },
  }
}

// ——— A workload's fields: where each writes ———

/** A field of the form: its name on the page, and the path it writes. */
export type FieldId = 'name' | 'namespace' | 'replicas' | 'image' | 'port' | 'env' | 'resources'

export const RESOURCE_PATHS: Record<keyof Resources, Path> = {
  cpuRequest: [...C, 'resources', 'requests', 'cpu'],
  memoryRequest: [...C, 'resources', 'requests', 'memory'],
  cpuLimit: [...C, 'resources', 'limits', 'cpu'],
  memoryLimit: [...C, 'resources', 'limits', 'memory'],
}

/** The path each field writes, and (for a group of fields) the start of theirs. */
export const FIELD_PATHS: Record<FieldId, Path> = {
  name: ['metadata', 'name'],
  namespace: ['metadata', 'namespace'],
  replicas: ['spec', 'replicas'],
  image: [...C, 'image'],
  port: [...C, 'ports', 0, 'containerPort'],
  env: [...C, 'env'],
  resources: [...C, 'resources'],
}

export const CONTAINER_PATH: Path = C

/** What follows a workload's name while it's the same: its container's, and its app label. */
const FOLLOWS_NAME: Path[] = [
  [...C, 'name'],
  ['spec', 'selector', 'matchLabels', 'app'],
  ['spec', 'template', 'metadata', 'labels', 'app'],
]

/** The lines (from 1) a field's value is on, wherever it's written: its own, and what follows it. */
export function fieldLines(text: string, object: Json, field: FieldId, part?: Path): number[] {
  const paths: Path[] = part ? [part] : [FIELD_PATHS[field]]
  if (field === 'name') {
    const name = dig(object, FIELD_PATHS.name)
    paths.push(...FOLLOWS_NAME.filter((path) => dig(object, path) === name))
  }
  const lines = new Set<number>()
  for (const path of paths) {
    const span = linesAt(text, path)
    if (span) for (let line = span[0]; line <= span[1]; line++) lines.add(line)
  }
  return [...lines].sort((a, b) => a - b)
}

/** A value as it's written: a whole number as a number, anything else as it was typed. */
const numbered = (typed: string): string | number =>
  /^\d{1,9}$/.test(typed) ? Number(typed) : typed

/** Sets a single value, or leaves its key with nothing where nothing was typed. */
const put = (text: string, path: Path, typed: string | number) =>
  typed === '' ? set(text, path, null) : set(text, path, typed)

export const write = {
  /** The name, and with it whatever was the same as the name before. */
  name(text: string, object: Json, name: string): string {
    const old = dig(object, FIELD_PATHS.name)
    const follows = FOLLOWS_NAME.filter((path) => {
      const value = dig(object, path)
      return value === undefined || value === null || value === old
    })
    return [FIELD_PATHS.name, ...follows].reduce((next, path) => put(next, path, name), text)
  },
  namespace: (text: string, namespace: string) => put(text, FIELD_PATHS.namespace, namespace),
  replicas: (text: string, typed: string) => put(text, FIELD_PATHS.replicas, numbered(typed)),
  image: (text: string, image: string) => put(text, FIELD_PATHS.image, image),
  /** The port, or none: its list goes with the last of what it held. */
  port: (text: string, typed: string) =>
    typed === ''
      ? removeAt(text, FIELD_PATHS.port, C.length)
      : set(text, FIELD_PATHS.port, numbered(typed)),
  /** One more variable, by its name: its value is said when one is typed. */
  addVariable: (text: string, object: Json, name: string, value: string) => {
    const at = ((dig(object, FIELD_PATHS.env) ?? []) as unknown[]).length
    return set(text, [...FIELD_PATHS.env, at], value === '' ? { name } : { name, value })
  },
  variableName: (text: string, index: number, name: string) =>
    put(text, [...FIELD_PATHS.env, index, 'name'], name),
  /** A variable's value: always text, whatever it looks like. */
  variableValue: (text: string, index: number, value: string) =>
    value === ''
      ? removeAt(text, [...FIELD_PATHS.env, index, 'value'], C.length + 2)
      : set(text, [...FIELD_PATHS.env, index, 'value'], value),
  removeVariable: (text: string, index: number) =>
    removeAt(text, [...FIELD_PATHS.env, index], C.length),
  /** A request or a limit, or none: what's left empty above it goes too. */
  resource: (text: string, which: keyof Resources, typed: string) =>
    typed === ''
      ? removeAt(text, RESOURCE_PATHS[which], C.length)
      : set(text, RESOURCE_PATHS[which], typed),
}

// ——— What's wrong with a field, as it's typed ———

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
/** A quantity as Kubernetes reads one: 250m, 0.5, 128Mi, 1e3. */
const QUANTITY = /^[+-]?(\d+(\.\d*)?|\.\d+)(m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei|[eE][+-]?\d+)?$/
const ENV_NAME = /^[-._a-zA-Z][-._a-zA-Z0-9]*$/

export interface Problem {
  field: FieldId
  message: string
  /** The path that's wrong, where it's one of several the field writes. */
  path?: Path
}

/** What must be said before it can be created, and isn't yet: "Name", "Image". */
export function missing(values: WorkloadValues): string[] {
  return [
    ...(values.name === '' ? ['Name'] : []),
    ...(values.namespace === '' ? ['Namespace'] : []),
    ...(values.image === '' ? ['Image'] : []),
  ]
}

/** What's wrong with what's typed, field by field: what the cluster would refuse, said sooner. */
export function problems(values: WorkloadValues): Problem[] {
  const found: Problem[] = []
  if (values.name !== '' && (!DNS_LABEL.test(values.name) || values.name.length > 63)) {
    found.push({
      field: 'name',
      message:
        values.name.length > 63 && DNS_LABEL.test(values.name)
          ? 'At most 63 characters: the container and the app label take the same name.'
          : 'Lowercase letters, digits and “-”, starting and ending with a letter or digit. The container takes the same name.',
    })
  }
  if (values.namespace !== '' && !DNS_LABEL.test(values.namespace)) {
    found.push({
      field: 'namespace',
      message: 'A namespace’s name: lowercase letters, digits and “-”.',
    })
  }
  if (values.replicas !== '' && !/^\d{1,9}$/.test(values.replicas)) {
    found.push({ field: 'replicas', message: 'A whole number, 0 or more.' })
  }
  if (/\s/.test(values.image)) {
    found.push({ field: 'image', message: 'An image’s name has no spaces in it.' })
  }
  if (
    values.port !== '' &&
    !(/^\d{1,5}$/.test(values.port) && +values.port >= 1 && +values.port <= 65535)
  ) {
    found.push({ field: 'port', message: 'A port is a number from 1 to 65535.' })
  }
  const names = values.env.map((variable) => variable.name)
  values.env.forEach((variable, index) => {
    const path = [...FIELD_PATHS.env, index]
    if (variable.name === '') {
      found.push({ field: 'env', path, message: 'A variable needs a name.' })
    } else if (!ENV_NAME.test(variable.name)) {
      found.push({
        field: 'env',
        path,
        message: `${variable.name} can’t be a variable’s name: letters, digits, “_”, “-” and “.”, not starting with a digit.`,
      })
    } else if (names.indexOf(variable.name) !== index) {
      found.push({
        field: 'env',
        path,
        message: `${variable.name} is set twice: the last one wins.`,
      })
    }
  })
  for (const [which, label] of [
    ['cpuRequest', 'CPU request'],
    ['memoryRequest', 'memory request'],
    ['cpuLimit', 'CPU limit'],
    ['memoryLimit', 'memory limit'],
  ] as const) {
    const typed = values.resources[which]
    if (typed !== '' && !QUANTITY.test(typed)) {
      found.push({
        field: 'resources',
        path: RESOURCE_PATHS[which],
        message: `The ${label} isn’t an amount Kubernetes reads: like ${which.startsWith('cpu') ? '250m or 0.5' : '128Mi or 1Gi'}.`,
      })
    }
  }
  return found
}

// ——— What the cluster said, by the field it names ———

/** `spec.template.spec.containers[0].image` as a path. */
export function pathOf(field: string): Path {
  const path: (string | number)[] = []
  for (const part of field.split('.')) {
    const found = /^([^[\]]*)((\[\d+\])*)$/.exec(part)
    if (!found) return [field]
    if (found[1]) path.push(found[1])
    for (const index of found[2]!.matchAll(/\[(\d+)\]/g)) path.push(Number(index[1]))
  }
  return path
}

const startsWith = (path: Path, start: Path) =>
  start.length <= path.length && start.every((part, i) => path[i] === part)

/**
 * The cluster's causes, each under the field it names: the API often names the parent of
 * what's wrong (`…resources.requests`, for the memory request), so a cause is a field's if
 * either path starts the other. One that names no field of the form's is nobody's.
 */
export function refusals(causes: KubeErrorCause[] | undefined): (Problem & { path: Path })[] {
  const found: (Problem & { path: Path })[] = []
  for (const cause of causes ?? []) {
    if (!cause.field) continue
    const path = pathOf(cause.field)
    const field = (Object.keys(FIELD_PATHS) as FieldId[])
      // The longest path first: a container's image before the container.
      .sort((a, b) => FIELD_PATHS[b].length - FIELD_PATHS[a].length)
      .find((id) => startsWith(path, FIELD_PATHS[id]) || startsWith(FIELD_PATHS[id], path))
    if (field) found.push({ field, path, message: `The cluster refused it: ${cause.message}` })
  }
  return found
}

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
import { isMap, isScalar, parseAllDocuments, visit } from 'yaml'
import type { KubeErrorCause } from '@shared/api'
import { scheduleWords } from './cron-words'
import { elsewhere, linesAt, pathText, removeAt, renameAt, setAt, type Path } from './yaml-edit'

export type FormKindName =
  | 'Deployment'
  | 'StatefulSet'
  | 'DaemonSet'
  | 'Job'
  | 'CronJob'
  | 'Service'
  | 'ConfigMap'
  | 'Secret'
  | 'PersistentVolumeClaim'

/** Where a new key goes among its map's own, for every map the form writes in. */
const ORDER = [
  'apiVersion',
  'kind',
  'metadata',
  'name',
  'namespace',
  'spec',
  'type',
  'data',
  'stringData',
  'serviceName',
  'replicas',
  'schedule',
  'concurrencyPolicy',
  'backoffLimit',
  'jobTemplate',
  'selector',
  'matchLabels',
  'template',
  'labels',
  'restartPolicy',
  'containers',
  'image',
  'command',
  'ports',
  'containerPort',
  'env',
  'value',
  'resources',
  'volumeMounts',
  'mountPath',
  'volumeClaimTemplates',
  'accessModes',
  'storageClassName',
  'requests',
  'limits',
  'cpu',
  'memory',
]

/** A text, or `null` once an edit of it couldn't be made (see `yaml-edit`): nothing follows that. */
type Edited = string | null

const set = (text: Edited, path: Path, value: unknown, order: readonly string[] = ORDER): Edited =>
  text === null ? null : setAt(text, path, value, order)
const remove = (text: Edited, path: Path, upTo: number): Edited =>
  text === null ? null : removeAt(text, path, upTo)

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const dig = (value: unknown, path: Path): unknown =>
  path.reduce<unknown>(
    (at, part) => (at as Record<string | number, unknown> | null | undefined)?.[part],
    value,
  )

/** A single value as a field shows it: nothing, for none. */
export const shown = (value: unknown): string =>
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

/**
 * A path with `*` for any index and `?` for any key: what a field owns, or the form writes
 * by rule.
 */
type Pattern = readonly (string | number)[]

const matches = (pattern: Pattern, path: Path, whole: boolean) =>
  (whole ? pattern.length === path.length : pattern.length >= path.length) &&
  path.every(
    (part, i) =>
      pattern[i] === part ||
      (pattern[i] === '*' && typeof part === 'number') ||
      (pattern[i] === '?' && typeof part === 'string'),
  )

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

/** A field of the form. Which a kind has, and where each writes, is the kind's to say. */
export type FieldId =
  | 'name'
  | 'namespace'
  | 'replicas'
  | 'serviceName'
  | 'backoffLimit'
  | 'schedule'
  | 'concurrencyPolicy'
  | 'restartPolicy'
  | 'image'
  | 'command'
  | 'port'
  | 'storage'
  | 'env'
  | 'resources'
  | 'type'
  | 'selector'
  | 'ports'
  | 'data'
  | 'size'
  | 'storageClass'
  | 'accessMode'

export interface FormKind {
  kind: FormKindName
  apiVersion: string
  /** Which fields it's drawn with: a workload's, a Service's, keys and values, or a claim's. */
  family: 'workload' | 'service' | 'data' | 'claim'
  /** The YAML a new one starts as: what it must have, with nothing said yet. */
  blank(namespace: string): string
  shape: Shape
  owns: Pattern[]
  /** Why the form can't show it, beyond its shape (two containers). */
  cannotShow(object: Json): Why | undefined
  /** Its fields, in the order they're asked, and the path each writes (or a group's start). */
  fields: FieldId[]
  paths: Partial<Record<FieldId, Path>>
  /** Its one container; no path, for a kind that has none. */
  container: Path
  /** What takes the workload's name while it's the same: its container's, and its app label. */
  follows: Path[]
}

/** The claim a StatefulSet's pods each get, and where their container mounts it. */
const CLAIM = ['spec', 'volumeClaimTemplates', 0] as const

interface Workload {
  kind: FormKindName
  apiVersion: string
  /** Where its pods' spec is. */
  pod: readonly string[]
  /** Its own fields, before the container's. */
  own: Partial<Record<FieldId, Path>>
  /** The container's fields it asks. */
  asks: FieldId[]
  /** Whether its selector and its pods' labels are `app=<name>`. */
  labelled: boolean
  blank(namespace: string): string
}

/** A kind that runs one container in pods: its form, from what's particular to it. */
function workload(w: Workload): FormKind {
  const container = [...w.pod, 'containers', 0]
  const template = w.pod.slice(0, -1)
  const follows: Path[] = [
    [...container, 'name'],
    ...(w.labelled
      ? [
          ['spec', 'selector', 'matchLabels', 'app'],
          [...template, 'metadata', 'labels', 'app'],
        ]
      : []),
  ]
  const paths: Partial<Record<FieldId, Path>> = {
    name: ['metadata', 'name'],
    namespace: ['metadata', 'namespace'],
    ...w.own,
    image: [...container, 'image'],
    command: [...container, 'command'],
    port: [...container, 'ports', 0, 'containerPort'],
    env: [...container, 'env'],
    resources: [...container, 'resources'],
    restartPolicy: [...w.pod, 'restartPolicy'],
    storage: CLAIM,
  }
  const fields: FieldId[] = ['name', 'namespace', ...(Object.keys(w.own) as FieldId[]), ...w.asks]
  const has = (field: FieldId) => fields.includes(field)
  const amounts = (['requests', 'limits'] as const).flatMap((kind) =>
    (['cpu', 'memory'] as const).map((of): Path => [...container, 'resources', kind, of]),
  )
  const storage: Path[] = [
    [...CLAIM, 'metadata', 'name'],
    [...CLAIM, 'spec', 'storageClassName'],
    [...CLAIM, 'spec', 'resources', 'requests', 'storage'],
    [...container, 'volumeMounts', 0, 'name'],
    [...container, 'volumeMounts', 0, 'mountPath'],
  ]
  // Every map on the way to a value is a map, or isn't there.
  const values: Path[] = [
    paths.name!,
    paths.namespace!,
    ...follows,
    ...(Object.keys(w.own) as FieldId[]).map((field) => paths[field]!),
    paths.image!,
    ...(has('port') ? [paths.port!] : []),
    ...(has('resources') ? amounts : []),
    ...(has('restartPolicy') ? [paths.restartPolicy!] : []),
    ...(has('storage') ? storage : []),
  ]
  const lists: Path[] = [
    [...w.pod, 'containers'],
    ...(has('port') ? [[...container, 'ports']] : []),
    [...container, 'env'],
    ...(has('storage')
      ? [
          ['spec', 'volumeClaimTemplates'],
          [...container, 'volumeMounts'],
        ]
      : []),
  ]
  const maps = new Map<string, Path>()
  for (const path of [...values, ...lists]) {
    for (let depth = 1; depth < path.length; depth++) {
      // (An index is into a list, whose items are maps: said with the lists.)
      if (typeof path[depth] === 'number' || typeof path[depth - 1] === 'number') continue
      maps.set(pathText(path.slice(0, depth)), path.slice(0, depth))
    }
  }
  return {
    kind: w.kind,
    apiVersion: w.apiVersion,
    family: 'workload',
    blank: w.blank,
    fields,
    paths,
    container,
    follows,
    shape: {
      maps: [...maps.values()],
      lists: has('command') ? [paths.command!] : [],
      listsOfMaps: lists,
      values,
    },
    owns: [
      ['apiVersion'],
      ['kind'],
      ...values,
      // A variable is a row of the form's, whether its value is said or comes from elsewhere.
      [...container, 'env', '*'],
      ...(has('command') ? [paths.command!] : []),
      ...(has('storage') ? [[...CLAIM, 'spec', 'accessModes'] as Path] : []),
    ],
    cannotShow(object) {
      const containers = dig(object, [...w.pod, 'containers'])
      if (Array.isArray(containers) && containers.length > 1) {
        return {
          why: `It has ${count(containers.length)} containers, and the form edits one.`,
          at: [...w.pod, 'containers', 1],
        }
      }
      // A command the form didn't write isn't one its field can show: it writes `sh -c`.
      const command = dig(object, paths.command!)
      if (
        has('command') &&
        command !== undefined &&
        command !== null &&
        shellCommand(command) === undefined
      ) {
        return {
          why: 'Its container’s command isn’t run as sh -c, which is how the form’s field writes one.',
          at: paths.command!,
        }
      }
      if (has('storage')) {
        const claims = dig(object, ['spec', 'volumeClaimTemplates'])
        if (Array.isArray(claims) && claims.length > 1) {
          return {
            why: `It has ${count(claims.length)} claims for each pod, and the form edits one.`,
            at: ['spec', 'volumeClaimTemplates', 1],
          }
        }
        // The claim and where it's mounted go by one name: a mount of something else isn't it.
        const claim = dig(object, [...CLAIM, 'metadata', 'name'])
        const mount = dig(object, [...container, 'volumeMounts', 0, 'name'])
        if (mount !== undefined && mount !== null && mount !== claim) {
          return {
            why: 'Its container’s first mount isn’t of its pods’ claim, which is the one the form’s field edits.',
            at: [...container, 'volumeMounts', 0],
          }
        }
      }
      return undefined
    },
  }
}

/** What a command the form wrote runs: `sh -c <this>`. Undefined for any other command. */
function shellCommand(command: unknown): string | undefined {
  return Array.isArray(command) &&
    command.length === 3 &&
    command[0] === 'sh' &&
    command[1] === '-c' &&
    typeof command[2] === 'string'
    ? command[2]
    : undefined
}

const POD = ['spec', 'template', 'spec']

/** A workload with pods labelled `app=<name>`, new: what it must have, with nothing said yet. */
const labelledBlank = (kind: string, namespace: string, spec: string) => `apiVersion: apps/v1
kind: ${kind}
metadata:
  name:
  namespace: ${namespace}
spec:
${spec}  selector:
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
`

export const DEPLOYMENT = workload({
  kind: 'Deployment',
  apiVersion: 'apps/v1',
  pod: POD,
  own: { replicas: ['spec', 'replicas'] },
  asks: ['image', 'port', 'env', 'resources'],
  labelled: true,
  blank: (namespace) => labelledBlank('Deployment', namespace, '  replicas: 1\n'),
})

const STATEFUL_SET = workload({
  kind: 'StatefulSet',
  apiVersion: 'apps/v1',
  pod: POD,
  own: { replicas: ['spec', 'replicas'], serviceName: ['spec', 'serviceName'] },
  asks: ['image', 'port', 'storage', 'env'],
  labelled: true,
  blank: (namespace) => labelledBlank('StatefulSet', namespace, '  serviceName:\n  replicas: 1\n'),
})

const DAEMON_SET = workload({
  kind: 'DaemonSet',
  apiVersion: 'apps/v1',
  pod: POD,
  own: {},
  asks: ['image', 'port', 'env', 'resources'],
  labelled: true,
  blank: (namespace) => labelledBlank('DaemonSet', namespace, ''),
})

const JOB = workload({
  kind: 'Job',
  apiVersion: 'batch/v1',
  pod: POD,
  own: { backoffLimit: ['spec', 'backoffLimit'] },
  asks: ['restartPolicy', 'image', 'command', 'env'],
  labelled: false,
  blank: (namespace) => `apiVersion: batch/v1
kind: Job
metadata:
  name:
  namespace: ${namespace}
spec:
  backoffLimit: 6
  template:
    spec:
      restartPolicy: Never
      containers:
        - name:
          image:
`,
})

const CRON_JOB = workload({
  kind: 'CronJob',
  apiVersion: 'batch/v1',
  pod: ['spec', 'jobTemplate', 'spec', 'template', 'spec'],
  own: {
    schedule: ['spec', 'schedule'],
    concurrencyPolicy: ['spec', 'concurrencyPolicy'],
  },
  asks: ['restartPolicy', 'image', 'command', 'env'],
  labelled: false,
  blank: (namespace) => `apiVersion: batch/v1
kind: CronJob
metadata:
  name:
  namespace: ${namespace}
spec:
  schedule:
  concurrencyPolicy: Allow
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name:
              image:
`,
})

// ——— The kinds that run nothing: a Service, keys and values, a claim ———

const WHO = { name: ['metadata', 'name'], namespace: ['metadata', 'namespace'] } as const

/** A kind with no container: its form, from its own fields. */
function plain(p: {
  kind: FormKindName
  apiVersion: string
  family: FormKind['family']
  /** Its fields after the name and the namespace, and where each writes. */
  own: Partial<Record<FieldId, Path>>
  shape: Shape
  owns: Pattern[]
  cannotShow: FormKind['cannotShow']
  blank(namespace: string): string
}): FormKind {
  return {
    kind: p.kind,
    apiVersion: p.apiVersion,
    family: p.family,
    blank: p.blank,
    fields: ['name', 'namespace', ...(Object.keys(p.own) as FieldId[])],
    paths: { ...WHO, ...p.own },
    container: [],
    follows: [],
    shape: {
      ...p.shape,
      maps: [['metadata'], ...p.shape.maps],
      values: [WHO.name, WHO.namespace, ...p.shape.values],
    },
    owns: [['apiVersion'], ['kind'], WHO.name, WHO.namespace, ...p.owns],
    cannotShow: p.cannotShow,
  }
}

/** How a Service is reached, by its `type`. */
export const SERVICE_TYPES = {
  ClusterIP: 'Reached from inside the cluster only.',
  NodePort: 'Reached on a port of every node, and from inside the cluster.',
  LoadBalancer: 'Reached from outside, through a load balancer the cluster’s provider makes.',
} as const

export const PROTOCOLS = ['TCP', 'UDP', 'SCTP'] as const

const SELECTOR = ['spec', 'selector'] as const
const PORTS = ['spec', 'ports'] as const
/** What the form's row for a port edits. */
const PORT_KEYS = ['port', 'name', 'targetPort', 'protocol'] as const

/** The first of a map's values that isn't one value: what a row of a key and a value can't show. */
function nested(object: Json, base: Path): Why | undefined {
  const map = dig(object, base)
  if (!isObject(map)) return undefined
  const key = Object.keys(map).find((name) => typeof map[name] === 'object' && map[name] !== null)
  return key === undefined
    ? undefined
    : {
        why: `${said([...base, key])} holds more than one value, and the form’s field there takes one.`,
        at: [...base, key],
      }
}

const SERVICE = plain({
  kind: 'Service',
  apiVersion: 'v1',
  family: 'service',
  own: { type: ['spec', 'type'], selector: SELECTOR, ports: PORTS },
  shape: {
    maps: [['spec'], SELECTOR],
    lists: [],
    listsOfMaps: [PORTS],
    values: [['spec', 'type']],
  },
  owns: [['spec', 'type'], [...SELECTOR, '?'], ...PORT_KEYS.map((key) => [...PORTS, '*', key])],
  cannotShow(object) {
    const type = dig(object, ['spec', 'type'])
    if (typeof type === 'string' && !(type in SERVICE_TYPES)) {
      return {
        why: `Its type is ${type}, and the form’s are ClusterIP, NodePort and LoadBalancer.`,
        at: ['spec', 'type'],
      }
    }
    const ports = (dig(object, PORTS) ?? []) as Json[]
    for (const [index, port] of ports.entries()) {
      const key = PORT_KEYS.find((name) => typeof port[name] === 'object' && port[name] !== null)
      if (key) {
        return {
          why: `${said([...PORTS, index, key])} holds more than one value, and the form’s field there takes one.`,
          at: [...PORTS, index, key],
        }
      }
    }
    return nested(object, SELECTOR)
  },
  blank: (namespace) => `apiVersion: v1
kind: Service
metadata:
  name:
  namespace: ${namespace}
spec:
  type: ClusterIP
  selector:
  ports:
    - port:
      protocol: TCP
`,
})

const CONFIG_MAP = plain({
  kind: 'ConfigMap',
  apiVersion: 'v1',
  family: 'data',
  own: { data: ['data'] },
  shape: { maps: [['data']], lists: [], listsOfMaps: [], values: [] },
  owns: [['data', '?']],
  cannotShow: (object) => nested(object, ['data']),
  blank: (namespace) => `apiVersion: v1
kind: ConfigMap
metadata:
  name:
  namespace: ${namespace}
data:
`,
})

const SECRET = plain({
  kind: 'Secret',
  apiVersion: 'v1',
  family: 'data',
  // (Its values as text, which the cluster encodes: `data` holds them encoded already, and is
  // the YAML's to say.)
  own: { type: ['type'], data: ['stringData'] },
  shape: { maps: [['stringData']], lists: [], listsOfMaps: [], values: [['type']] },
  owns: [['type'], ['stringData', '?']],
  cannotShow(object) {
    const type = object.type
    if (type !== undefined && type !== null && type !== 'Opaque') {
      return {
        why: `Its type is ${shown(type)}, and the form is for an Opaque one: keys and values of your own.`,
        at: ['type'],
      }
    }
    return nested(object, ['stringData'])
  },
  blank: (namespace) => `apiVersion: v1
kind: Secret
metadata:
  name:
  namespace: ${namespace}
type: Opaque
stringData:
`,
})

/** Who can mount a claim, by the one of `accessModes` it asks for. */
export const ACCESS_MODES = {
  ReadWriteOnce: 'One node, to read and write',
  ReadOnlyMany: 'Many nodes, to read only',
  ReadWriteMany: 'Many nodes, to read and write',
  ReadWriteOncePod: 'One pod, to read and write',
} as const

const CLAIMED = {
  size: ['spec', 'resources', 'requests', 'storage'],
  storageClass: ['spec', 'storageClassName'],
  accessMode: ['spec', 'accessModes', 0],
} as const

const VOLUME_CLAIM = plain({
  kind: 'PersistentVolumeClaim',
  apiVersion: 'v1',
  family: 'claim',
  own: CLAIMED,
  shape: {
    maps: [['spec'], ['spec', 'resources'], ['spec', 'resources', 'requests']],
    lists: [['spec', 'accessModes']],
    listsOfMaps: [],
    values: Object.values(CLAIMED),
  },
  owns: Object.values(CLAIMED),
  cannotShow(object) {
    const modes = dig(object, ['spec', 'accessModes'])
    return Array.isArray(modes) && modes.length > 1
      ? {
          why: `It asks for ${count(modes.length)} ways to be mounted, and the form’s field takes one.`,
          at: ['spec', 'accessModes', 1],
        }
      : undefined
  },
  blank: (namespace) => `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name:
  namespace: ${namespace}
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage:
`,
})

/** The kinds the form knows, in the order of the sidebar's groups. */
export const FORM_KINDS: Record<FormKindName, FormKind> = {
  Deployment: DEPLOYMENT,
  StatefulSet: STATEFUL_SET,
  DaemonSet: DAEMON_SET,
  Job: JOB,
  CronJob: CRON_JOB,
  Service: SERVICE,
  ConfigMap: CONFIG_MAP,
  Secret: SECRET,
  PersistentVolumeClaim: VOLUME_CLAIM,
}

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

/** The claim each of a StatefulSet's pods gets. */
export interface Storage {
  /** Its size, as it's written: `20Gi`. */
  size: string
  /** Its class; none for the cluster's default. */
  storageClass: string
  mountPath: string
}

/** What a kind's fields show. A field the kind doesn't ask is empty, and isn't shown. */
export interface WorkloadValues {
  name: string
  namespace: string
  replicas: string
  serviceName: string
  backoffLimit: string
  schedule: string
  concurrencyPolicy: string
  restartPolicy: string
  image: string
  /** What `sh -c` runs. */
  command: string
  port: string
  storage: Storage
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

export const resourcePaths = (form: FormKind): Record<keyof Resources, Path> => ({
  cpuRequest: [...form.container, 'resources', 'requests', 'cpu'],
  memoryRequest: [...form.container, 'resources', 'requests', 'memory'],
  cpuLimit: [...form.container, 'resources', 'limits', 'cpu'],
  memoryLimit: [...form.container, 'resources', 'limits', 'memory'],
})

export const storagePaths = (form: FormKind): Record<keyof Storage, Path> => ({
  size: [...CLAIM, 'spec', 'resources', 'requests', 'storage'],
  storageClass: [...CLAIM, 'spec', 'storageClassName'],
  mountPath: [...form.container, 'volumeMounts', 0, 'mountPath'],
})

export function workloadValues(object: Json, form: FormKind): WorkloadValues {
  const text = (path: Path | undefined) => (path ? shown(dig(object, path)) : '')
  const at = (field: FieldId) => text(form.paths[field])
  const env = (dig(object, form.paths.env!) ?? []) as Json[]
  const amounts = resourcePaths(form)
  const storage = storagePaths(form)
  return {
    name: at('name'),
    namespace: at('namespace'),
    replicas: at('replicas'),
    serviceName: at('serviceName'),
    backoffLimit: at('backoffLimit'),
    schedule: at('schedule'),
    concurrencyPolicy: at('concurrencyPolicy'),
    restartPolicy: at('restartPolicy'),
    image: at('image'),
    command: shellCommand(dig(object, form.paths.command!)) ?? '',
    port: at('port'),
    storage: {
      size: text(storage.size),
      storageClass: text(storage.storageClass),
      mountPath: text(storage.mountPath),
    },
    env: env.map((variable) => ({
      name: shown(variable.name),
      ...('valueFrom' in variable && variable.valueFrom !== null && variable.valueFrom !== undefined
        ? { from: source(variable.valueFrom) }
        : { value: shown(variable.value) }),
    })),
    resources: {
      cpuRequest: text(amounts.cpuRequest),
      memoryRequest: text(amounts.memoryRequest),
      cpuLimit: text(amounts.cpuLimit),
      memoryLimit: text(amounts.memoryLimit),
    },
  }
}

// ——— A workload's fields: where each writes ———

/** The lines (from 1) a field's value is on, wherever it's written: its own, and what follows it. */
export function fieldLines(
  text: string,
  object: Json,
  form: FormKind,
  field: FieldId,
  part?: Path,
): number[] {
  const paths: Path[] = part ? [part] : form.paths[field] ? [form.paths[field]] : []
  if (field === 'name') {
    const name = dig(object, form.paths.name!)
    paths.push(...form.follows.filter((path) => dig(object, path) === name))
  }
  if (field === 'storage' && !part) paths.push([...form.container, 'volumeMounts', 0])
  const lines = new Set<number>()
  for (const path of paths) {
    const span = linesAt(text, path)
    if (span) for (let line = span[0]; line <= span[1]; line++) lines.add(line)
  }
  return [...lines].sort((a, b) => a - b)
}

/**
 * The lines a name that can't be one is wrong on: the object's, and its container's while
 * that's the same. (Its app labels take the name too, and are lit with it; but what can't be
 * a name can still be a label's value, so those lines aren't wrong.)
 */
export function nameLines(text: string, object: Json, form: FormKind): number[] {
  const name = dig(object, form.paths.name!)
  const lines: number[] = []
  const named = form.container.length > 0 ? [[...form.container, 'name']] : []
  for (const path of [form.paths.name!, ...named]) {
    const span = dig(object, path) === name ? linesAt(text, path) : undefined
    if (span) for (let line = span[0]; line <= span[1]; line++) lines.push(line)
  }
  return lines
}

/** A value as it's written: a whole number as a number, anything else as it was typed. */
const numbered = (typed: string): string | number =>
  /^\d{1,9}$/.test(typed) ? Number(typed) : typed

/** Sets a single value, or leaves its key with nothing where nothing was typed. */
const put = (text: Edited, path: Path, typed: string | number): Edited =>
  typed === '' ? set(text, path, null) : set(text, path, typed)

/** The name a StatefulSet's claim and its mount go by. */
const CLAIM_NAME = 'data'

/** A kind's edits of the text: each field's, as `yaml-edit` makes them. */
export function writer(form: FormKind) {
  const { paths, container } = form
  const depth = container.length
  const amounts = resourcePaths(form)
  const storage = storagePaths(form)
  /** A field's one value, set; or its key left with nothing. */
  const value = (field: FieldId) => (text: string, typed: string) => put(text, paths[field]!, typed)
  /** A whole number, written as one. */
  const amount = (field: FieldId) => (text: string, typed: string) =>
    put(text, paths[field]!, numbered(typed))
  return {
    /** The name, and with it whatever was the same as the name before. */
    name(text: string, object: Json, name: string): Edited {
      const old = dig(object, paths.name!)
      const follows = form.follows.filter((path) => {
        const was = dig(object, path)
        return was === undefined || was === null || was === old
      })
      return [paths.name!, ...follows].reduce<Edited>((next, path) => put(next, path, name), text)
    },
    namespace: value('namespace'),
    replicas: amount('replicas'),
    serviceName: value('serviceName'),
    backoffLimit: amount('backoffLimit'),
    schedule: value('schedule'),
    concurrencyPolicy: value('concurrencyPolicy'),
    restartPolicy: value('restartPolicy'),
    image: value('image'),
    /** What `sh -c` runs; or no command, for the image's own. */
    command: (text: string, typed: string) =>
      typed === ''
        ? remove(text, paths.command!, depth)
        : set(text, paths.command!, ['sh', '-c', typed]),
    /** The port, or none: its list goes with the last of what it held. */
    port: (text: string, typed: string) =>
      typed === '' ? remove(text, paths.port!, depth) : set(text, paths.port!, numbered(typed)),
    /** One more variable, by its name: its value is said when one is typed. */
    addVariable: (text: string, object: Json, name: string) => {
      const at = ((dig(object, paths.env!) ?? []) as unknown[]).length
      return set(text, [...paths.env!, at], { name })
    },
    variableName: (text: string, index: number, name: string) =>
      put(text, [...paths.env!, index, 'name'], name),
    /** A variable's value: always text, whatever it looks like. */
    variableValue: (text: string, index: number, typed: string) =>
      typed === ''
        ? remove(text, [...paths.env!, index, 'value'], depth + 2)
        : set(text, [...paths.env!, index, 'value'], typed),
    removeVariable: (text: string, index: number) => remove(text, [...paths.env!, index], depth),
    /** A request or a limit, or none: what's left empty above it goes too. */
    resource: (text: string, which: keyof Resources, typed: string) =>
      typed === '' ? remove(text, amounts[which], depth) : set(text, amounts[which], typed),
    /** A claim for each pod, mounted in the container: made whole, with a size to start from. */
    addStorage: (text: string): Edited => {
      const claimed = set(text, CLAIM, {
        metadata: { name: CLAIM_NAME },
        spec: {
          accessModes: ['ReadWriteOnce'],
          resources: { requests: { storage: '1Gi' } },
        },
      })
      return set(claimed, [...container, 'volumeMounts', 0], {
        name: CLAIM_NAME,
        mountPath: '/data',
      })
    },
    /** No claim: it goes, and its mount with it. */
    removeStorage: (text: string): Edited =>
      remove(remove(text, [...container, 'volumeMounts', 0], depth), CLAIM, 1),
    /** The claim's size, its class (none, for the cluster's default), or where it's mounted. */
    storage: (text: string, object: Json, which: keyof Storage, typed: string): Edited => {
      if (which === 'storageClass') {
        return typed === ''
          ? remove(text, storage.storageClass, CLAIM.length + 1)
          : // (Among a claim's own keys: its class comes before how much it asks for.)
            set(text, storage.storageClass, typed, ['accessModes', 'storageClassName', 'resources'])
      }
      if (which === 'size') return put(text, storage.size, typed)
      // A mount is of something: where there's none yet, or one that names nothing, it's
      // written with the claim's name, which the cluster asks of it.
      const mount = [...container, 'volumeMounts', 0]
      const claim = dig(object, [...CLAIM, 'metadata', 'name']) ?? CLAIM_NAME
      const there = dig(object, mount)
      if (!isObject(there)) return set(text, mount, { name: claim, mountPath: typed })
      const named = there.name === undefined || there.name === null
      return put(named ? set(text, [...mount, 'name'], claim) : text, storage.mountPath, typed)
    },
  }
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

/** What a field is called, where it's said to be empty. */
const LABELS: Partial<Record<FieldId, string>> = {
  name: 'Name',
  namespace: 'Namespace',
  serviceName: 'Service',
  schedule: 'Schedule',
  image: 'Image',
}

/** What must be said before it can be created, and isn't yet: "Name", "Image". */
export function missing(values: WorkloadValues, form: FormKind): string[] {
  return (['name', 'namespace', 'serviceName', 'schedule', 'image'] as const)
    .filter((field) => form.fields.includes(field) && values[field] === '')
    .map((field) => LABELS[field]!)
}

/** What a failed pod's job does next, by what `restartPolicy` says. */
export const RESTART_POLICIES = {
  Never: 'Start a new pod',
  OnFailure: 'Restart it in the same pod',
} as const

/** What happens when a run is due and the last is still going, by `concurrencyPolicy`. */
export const CONCURRENCY_POLICIES = {
  Allow: 'Start this one too',
  Forbid: 'Skip this one',
  Replace: 'Stop the last run, and start this one',
} as const

/** What's wrong with what's typed, field by field: what the cluster would refuse, said sooner. */
export function problems(values: WorkloadValues, form: FormKind, object: Json = {}): Problem[] {
  const found: Problem[] = []
  const has = (field: FieldId) => form.fields.includes(field)
  const whole = (field: 'replicas' | 'backoffLimit') => {
    if (has(field) && values[field] !== '' && !/^\d{1,9}$/.test(values[field])) {
      found.push({ field, message: 'A whole number, 0 or more.' })
    }
  }
  if (values.name !== '' && (!DNS_LABEL.test(values.name) || values.name.length > 63)) {
    const also =
      form.follows.length > 1 ? 'the container and the app label take' : 'the container takes'
    found.push({
      field: 'name',
      message:
        values.name.length > 63 && DNS_LABEL.test(values.name)
          ? `At most 63 characters: ${also} the same name.`
          : 'Lowercase letters, digits and “-”, starting and ending with a letter or digit. The container takes the same name.',
    })
  }
  if (values.namespace !== '' && !DNS_LABEL.test(values.namespace)) {
    found.push({
      field: 'namespace',
      message: 'A namespace’s name: lowercase letters, digits and “-”.',
    })
  }
  whole('replicas')
  if (has('serviceName') && values.serviceName !== '' && !DNS_LABEL.test(values.serviceName)) {
    found.push({
      field: 'serviceName',
      message: 'A Service’s name: lowercase letters, digits and “-”.',
    })
  }
  whole('backoffLimit')
  if (has('schedule') && values.schedule !== '') {
    const read = scheduleWords(values.schedule)
    if (!read.ok) found.push({ field: 'schedule', message: read.why })
  }
  if (
    has('concurrencyPolicy') &&
    values.concurrencyPolicy !== '' &&
    !(values.concurrencyPolicy in CONCURRENCY_POLICIES)
  ) {
    found.push({
      field: 'concurrencyPolicy',
      message: `${values.concurrencyPolicy} isn’t one of Allow, Forbid and Replace.`,
    })
  }
  if (
    has('restartPolicy') &&
    values.restartPolicy !== '' &&
    !(values.restartPolicy in RESTART_POLICIES)
  ) {
    found.push({
      field: 'restartPolicy',
      message: `A ${form.kind}’s pods restart Never or OnFailure, not ${values.restartPolicy}.`,
    })
  }
  if (/\s/.test(values.image)) {
    found.push({ field: 'image', message: 'An image’s name has no spaces in it.' })
  }
  if (
    has('port') &&
    values.port !== '' &&
    !(/^\d{1,5}$/.test(values.port) && +values.port >= 1 && +values.port <= 65535)
  ) {
    found.push({ field: 'port', message: 'A port is a number from 1 to 65535.' })
  }
  if (has('storage')) {
    const storage = storagePaths(form)
    const { size, mountPath } = values.storage
    // While there's a claim, it has a size and is mounted somewhere: the cluster asks both.
    const claimed = dig(object, CLAIM) !== undefined && dig(object, CLAIM) !== null
    if (claimed && size === '') {
      found.push({
        field: 'storage',
        path: storage.size,
        message: 'The size is still to say: like 20Gi.',
      })
    } else if (
      size !== '' &&
      !(QUANTITY.test(size) && !size.startsWith('-') && parseFloat(size) !== 0)
    ) {
      found.push({
        field: 'storage',
        path: storage.size,
        message: 'The size isn’t an amount of storage Kubernetes reads: like 20Gi.',
      })
    }
    if (claimed && mountPath === '') {
      found.push({
        field: 'storage',
        path: storage.mountPath,
        message: 'Where it’s mounted is still to say: a path in the container, like /data.',
      })
    } else if (mountPath !== '' && !mountPath.startsWith('/')) {
      found.push({
        field: 'storage',
        path: storage.mountPath,
        message: 'Where it’s mounted is a path in the container, from /: like /data.',
      })
    }
  }
  const names = values.env.map((variable) => variable.name)
  values.env.forEach((variable, index) => {
    const path = [...form.paths.env!, index]
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
  if (has('resources')) {
    const amounts = resourcePaths(form)
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
          path: amounts[which],
          message: `The ${label} isn’t an amount Kubernetes reads: like ${which.startsWith('cpu') ? '250m or 0.5' : '128Mi or 1Gi'}.`,
        })
      }
    }
  }
  return found
}

// ——— The other kinds' fields: what they show, where they write, what's wrong ———

/** A key and its value, as a row shows them. */
export interface Pair {
  key: string
  value: string
  /** What the value is, where the YAML has it as something other than text: "a number". */
  odd?: string
}

/** A map's keys and values, in the order they're written. */
export function pairsAt(object: Json, base: Path): Pair[] {
  const map = dig(object, base)
  if (!isObject(map)) return []
  return Object.entries(map).map(([key, value]) => ({
    key,
    value: shown(value),
    ...(typeof value === 'number'
      ? { odd: 'a number' }
      : typeof value === 'boolean'
        ? { odd: value ? 'true' : 'false' }
        : {}),
  }))
}

/** One of a Service's ports, as its row shows it. */
export interface ServicePort {
  name: string
  port: string
  targetPort: string
  /** What the YAML says; none is TCP. */
  protocol: string
}

export interface ServiceValues {
  /** What the YAML says; none is ClusterIP. */
  type: string
  selector: Pair[]
  ports: ServicePort[]
}

export function serviceValues(object: Json): ServiceValues {
  const ports = (dig(object, PORTS) ?? []) as Json[]
  return {
    type: shown(dig(object, ['spec', 'type'])),
    selector: pairsAt(object, SELECTOR),
    ports: ports.map((port) => ({
      name: shown(port.name),
      port: shown(port.port),
      targetPort: shown(port.targetPort),
      protocol: shown(port.protocol),
    })),
  }
}

export interface ClaimValues {
  size: string
  storageClass: string
  accessMode: string
}

export const claimValues = (object: Json): ClaimValues => ({
  size: shown(dig(object, CLAIMED.size)),
  storageClass: shown(dig(object, CLAIMED.storageClass)),
  accessMode: shown(dig(object, CLAIMED.accessMode)),
})

/** The edits of a kind that runs nothing: each field's, as `yaml-edit` makes them. */
export function plainWriter(form: FormKind) {
  const { paths } = form
  const port = (index: number, key: (typeof PORT_KEYS)[number]): Path => [...PORTS, index, key]
  return {
    name: (text: string, typed: string) => put(text, paths.name!, typed),
    namespace: (text: string, typed: string) => put(text, paths.namespace!, typed),
    type: (text: string, typed: string) => set(text, ['spec', 'type'], typed),
    /** One more key, with nothing for its value yet. */
    addPair: (text: string, base: Path, key: string) => set(text, [...base, key], ''),
    /** A key by another name, where it is; `null` if a key has that name already. */
    renamePair: (text: string, base: Path, old: string, key: string): Edited =>
      renameAt(text, [...base, old], key),
    /** A key's value: always text, whatever it looks like. */
    pairValue: (text: string, base: Path, key: string, value: string) =>
      set(text, [...base, key], value),
    /** A key gone; the map it was in stays, with what's left. */
    removePair: (text: string, base: Path, key: string) =>
      remove(text, [...base, key], base.length),
    /** One more port, by its number. */
    addPort: (text: string, object: Json, typed: string) => {
      const at = ((dig(object, PORTS) ?? []) as unknown[]).length
      return set(text, [...PORTS, at], { port: numbered(typed), protocol: 'TCP' })
    },
    port: (text: string, index: number, typed: string) =>
      put(text, port(index, 'port'), numbered(typed)),
    /** The pod's port, by number or by name; none is the same as the Service's. */
    targetPort: (text: string, index: number, typed: string) =>
      typed === ''
        ? remove(text, port(index, 'targetPort'), PORTS.length + 1)
        : set(text, port(index, 'targetPort'), numbered(typed), PORT_KEYS),
    protocol: (text: string, index: number, typed: string) =>
      set(text, port(index, 'protocol'), typed, PORT_KEYS),
    /** A port's name, which each has where there's more than one. */
    portName: (text: string, index: number, typed: string) =>
      typed === ''
        ? remove(text, port(index, 'name'), PORTS.length + 1)
        : set(text, port(index, 'name'), typed, PORT_KEYS),
    removePort: (text: string, index: number) => remove(text, [...PORTS, index], PORTS.length),
    /** A claim's size, or its key left with nothing. */
    size: (text: string, typed: string) => put(text, CLAIMED.size, typed),
    /** Its class; none, for the cluster's default. */
    storageClass: (text: string, typed: string) =>
      typed === ''
        ? remove(text, CLAIMED.storageClass, 1)
        : set(text, CLAIMED.storageClass, typed, ['storageClassName', 'accessModes', 'resources']),
    accessMode: (text: string, typed: string) =>
      set(text, CLAIMED.accessMode, typed, ['storageClassName', 'accessModes', 'resources']),
  }
}

/** A name as most kinds take one: a DNS subdomain. */
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/
/** A Service's: a DNS label that starts with a letter. */
const SERVICE_NAME = /^[a-z]([-a-z0-9]*[a-z0-9])?$/
/** A label's key, after its prefix, and a label's value. */
const LABEL_NAME = /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/
/** A port by name: letters, digits and "-", with a letter in it, 15 at most. */
const PORT_NAME = /^(?=.*[a-z])[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const DATA_KEY = /^[-._a-zA-Z0-9]+$/

const isPort = (typed: string) => /^\d{1,5}$/.test(typed) && +typed >= 1 && +typed <= 65535

function labelKeyProblem(key: string): string | undefined {
  const [first, second, ...more] = key.split('/')
  const [prefix, name] = second === undefined ? [undefined, first!] : [first!, second]
  const fine =
    more.length === 0 &&
    LABEL_NAME.test(name) &&
    name.length <= 63 &&
    (prefix === undefined || (DNS_SUBDOMAIN.test(prefix) && prefix.length <= 253))
  return fine
    ? undefined
    : `${key} can’t be a label’s key: letters, digits, “-”, “_” and “.”, starting and ending with a letter or digit, 63 at most.`
}

function serviceProblems(object: Json): Problem[] {
  const found: Problem[] = []
  const values = serviceValues(object)
  if (values.type !== '' && !(values.type in SERVICE_TYPES)) {
    found.push({ field: 'type', message: `${values.type} isn’t a type the form has.` })
  }
  for (const { key, value, odd } of values.selector) {
    const path = [...SELECTOR, key]
    const keyed = labelKeyProblem(key)
    if (keyed) found.push({ field: 'selector', path, message: keyed })
    else if (odd) {
      found.push({
        field: 'selector',
        path,
        message: `${key} is ${odd} in the YAML, and a label’s value is text: put it in quotes.`,
      })
    } else if (value === '') {
      found.push({ field: 'selector', path, message: `${key} needs a value to match.` })
    } else if (!LABEL_NAME.test(value) || value.length > 63) {
      found.push({
        field: 'selector',
        path,
        message: `${value} can’t be a label’s value: letters, digits, “-”, “_” and “.”, starting and ending with a letter or digit, 63 at most.`,
      })
    }
  }
  const names = values.ports.map((port) => port.name)
  values.ports.forEach((port, index) => {
    const at = (key: string): Path => [...PORTS, index, key]
    if (port.port !== '' && !isPort(port.port)) {
      found.push({
        field: 'ports',
        path: at('port'),
        message: 'A port is a number from 1 to 65535.',
      })
    }
    if (
      port.targetPort !== '' &&
      !isPort(port.targetPort) &&
      !(PORT_NAME.test(port.targetPort) && port.targetPort.length <= 15)
    ) {
      found.push({
        field: 'ports',
        path: at('targetPort'),
        message:
          'The pod’s port is a number from 1 to 65535, or the name the pod gives it: lowercase letters, digits and “-”, 15 at most.',
      })
    }
    if (port.protocol !== '' && !(PROTOCOLS as readonly string[]).includes(port.protocol)) {
      found.push({
        field: 'ports',
        path: at('protocol'),
        message: `${port.protocol} isn’t one of TCP, UDP and SCTP.`,
      })
    }
    if (port.name === '') {
      if (values.ports.length > 1) {
        found.push({
          field: 'ports',
          path: at('name'),
          message: 'With more than one port, each needs a name.',
        })
      }
    } else if (!DNS_LABEL.test(port.name) || port.name.length > 63) {
      found.push({
        field: 'ports',
        path: at('name'),
        message: `${port.name} can’t be a port’s name: lowercase letters, digits and “-”.`,
      })
    } else if (names.indexOf(port.name) !== index) {
      found.push({
        field: 'ports',
        path: at('name'),
        message: `Two ports are named ${port.name}, and each needs its own.`,
      })
    }
  })
  return found
}

function dataProblems(object: Json, form: FormKind): Problem[] {
  const base = form.paths.data!
  const found: Problem[] = []
  for (const { key, odd } of pairsAt(object, base)) {
    const path = [...base, key]
    if (!DATA_KEY.test(key) || key.length > 253) {
      found.push({
        field: 'data',
        path,
        message: `${key || 'An empty key'} can’t be a key: letters, digits, “-”, “_” and “.”.`,
      })
    } else if (odd) {
      // (The cluster refuses it: said here, with what puts it right.)
      found.push({
        field: 'data',
        path,
        message: `${key} is ${odd} in the YAML, and a ${form.kind}’s values are text: put it in quotes.`,
      })
    }
  }
  return found
}

function claimProblems(object: Json): Problem[] {
  const found: Problem[] = []
  const { size, accessMode } = claimValues(object)
  if (size !== '' && !(QUANTITY.test(size) && !size.startsWith('-') && parseFloat(size) !== 0)) {
    found.push({
      field: 'size',
      message: 'The size isn’t an amount of storage Kubernetes reads: like 20Gi.',
    })
  }
  if (accessMode !== '' && !(accessMode in ACCESS_MODES)) {
    found.push({
      field: 'accessMode',
      message: `${accessMode} isn’t a way a claim is mounted: ${Object.keys(ACCESS_MODES).join(', ')}.`,
    })
  }
  return found
}

/**
 * What's still to say before it can be created, and what's wrong with what's said: for any
 * kind, from the object its YAML reads as.
 */
export function check(object: Json, form: FormKind): { missing: string[]; problems: Problem[] } {
  if (form.family === 'workload') {
    const values = workloadValues(object, form)
    return { missing: missing(values, form), problems: problems(values, form, object) }
  }
  const name = shown(dig(object, WHO.name))
  const namespace = shown(dig(object, WHO.namespace))
  const empty = [...(name === '' ? ['Name'] : []), ...(namespace === '' ? ['Namespace'] : [])]
  const found: Problem[] = []
  const rule = form.family === 'service' ? SERVICE_NAME : DNS_SUBDOMAIN
  const most = form.family === 'service' ? 63 : 253
  if (name !== '' && (!rule.test(name) || name.length > most)) {
    found.push({
      field: 'name',
      message:
        form.family === 'service'
          ? 'Lowercase letters, digits and “-”, starting with a letter and ending with a letter or digit, 63 at most.'
          : 'Lowercase letters, digits, “-” and “.”, starting and ending with a letter or digit.',
    })
  }
  if (namespace !== '' && !DNS_LABEL.test(namespace)) {
    found.push({
      field: 'namespace',
      message: 'A namespace’s name: lowercase letters, digits and “-”.',
    })
  }
  if (form.family === 'service') {
    const { ports } = serviceValues(object)
    if (ports.length === 0 || ports.some((port) => port.port === '')) empty.push('Port')
    found.push(...serviceProblems(object))
  } else if (form.family === 'data') {
    found.push(...dataProblems(object, form))
  } else {
    if (claimValues(object).size === '') empty.push('Size')
    found.push(...claimProblems(object))
  }
  return { missing: empty, problems: found }
}

// ——— A Secret's values, hidden ———

/** What stands for a value that's hidden, whatever its length. */
export const HIDDEN = '••••••••'

/**
 * Where every Secret's values are in the text, and what they are: wherever a Secret is
 * written (the document itself, or one of a List's items), whatever its `data` and its
 * `stringData` hold. Undefined where the text can't be read well enough to say.
 */
function secrets(text: string): { cuts: [number, number][]; values: string[] } | undefined {
  let documents
  try {
    documents = parseAllDocuments(text)
  } catch {
    return undefined
  }
  const cuts: [number, number][] = []
  const values: string[] = []
  for (const document of documents) {
    if (document.errors.length > 0) return undefined
    visit(document, {
      Map(_key, map) {
        if ((map.get('kind') as unknown) !== 'Secret') return undefined
        for (const held of ['data', 'stringData']) {
          const under = map.get(held, true) as unknown
          if (under === undefined || under === null) continue
          // Whatever is there in place of keys and values is hidden whole.
          const nodes: unknown[] = isMap(under) ? under.items.map((pair) => pair.value) : [under]
          for (const node of nodes) {
            const range = (node as { range?: [number, number, number] } | null)?.range
            if (!range || (isScalar(node) && node.value === null)) continue
            const [from, to] = [range[0], Math.max(range[0], range[1])]
            cuts.push([from, to])
            // As it's written, and as it's read: the cluster may quote either.
            values.push(text.slice(from, to).trim())
            if (isScalar(node)) values.push(String(node.value).trim())
          }
        }
        return visit.SKIP
      },
    })
  }
  return { cuts, values: [...new Set(values)].filter((value) => value !== '') }
}

/**
 * The text with every Secret's values replaced by `HIDDEN`: what's shown while they're hidden.
 * It's a text of its own, with nothing of a value in it. `null` where the text can't be read
 * well enough to say which characters are values.
 */
export function masked(text: string): string | null {
  const found = secrets(text)
  if (!found) return null
  let next = text
  for (const [from, to] of found.cuts.sort((a, b) => b[0] - a[0])) {
    // (A value written as a block ends with its last line's end, which stays.)
    const tail = /(\r?\n)$/.exec(text.slice(from, to))?.[1] ?? ''
    next = next.slice(0, from) + HIDDEN + tail + next.slice(to)
  }
  // Read again: it's shown only if it still reads, and holds no value.
  const again = secrets(next)
  return again && again.values.every((value) => value === HIDDEN) ? next : null
}

/**
 * What the cluster said of the YAML in `text`, with none of a Secret's values in it, should
 * it quote one. Nothing of it, where the text can't be read to know what its values are.
 */
export function unquoted(message: string, text: string): string {
  const found = secrets(text)
  if (!found) return 'The cluster refused it. Show values to read what it said.'
  return found.values
    .sort((a, b) => b.length - a.length)
    .reduce((said, value) => said.split(value).join(HIDDEN), message)
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
export function refusals(
  causes: KubeErrorCause[] | undefined,
  form: FormKind,
): (Problem & { path: Path })[] {
  const found: (Problem & { path: Path })[] = []
  // The longest path first: a container's image before the container.
  const fields = form.fields
    .filter((field) => form.paths[field])
    .sort((a, b) => form.paths[b]!.length - form.paths[a]!.length)
  // (Storage is a claim and, apart from it, where the container mounts it.)
  const mount = [...form.container, 'volumeMounts', 0]
  for (const cause of causes ?? []) {
    if (!cause.field) continue
    const path = pathOf(cause.field)
    const field =
      form.fields.includes('storage') && startsWith(path, mount)
        ? 'storage'
        : fields.find(
            (id) => startsWith(path, form.paths[id]!) || startsWith(form.paths[id]!, path),
          )
    if (field) found.push({ field, path, message: `The cluster refused it: ${cause.message}` })
  }
  return found
}

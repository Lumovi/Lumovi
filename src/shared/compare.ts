/**
 * Two objects of a kind, made ready to compare (Compare with…): their fields in one order, so
 * that only what differs reads as a difference; what the cluster sets and how the object is (its
 * status) left out unless asked; and, of a workload, the ConfigMaps and Secrets each side
 * references, paired by where they're referenced.
 */
import type { KubeObject } from './api'
import { withhold } from './withheld'

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** What every object's metadata has that the cluster set: never a difference worth a line. */
const SET_METADATA = [
  'uid',
  'resourceVersion',
  'generation',
  'creationTimestamp',
  'deletionTimestamp',
  'deletionGracePeriodSeconds',
  'managedFields',
  'ownerReferences',
  'selfLink',
  // (Which namespace each side is in is said above the comparison, by whoever chose them.)
  'namespace',
]

/** Annotations the cluster or kubectl keeps for itself. */
const SET_ANNOTATIONS = [
  'kubectl.kubernetes.io/last-applied-configuration',
  'deployment.kubernetes.io/revision',
  'deprecated.daemonset.template.generation',
]

/** Labels a controller adds to what it makes. */
const SET_LABELS = [
  'pod-template-hash',
  'controller-revision-hash',
  'controller-uid',
  'batch.kubernetes.io/controller-uid',
  'job-name',
  'batch.kubernetes.io/job-name',
]

/** Of a kind's spec, what the cluster set: an address, a node, a volume it bound. */
const SET_SPEC: Record<string, readonly string[]> = {
  Service: ['clusterIP', 'clusterIPs', 'healthCheckNodePort'],
  PersistentVolumeClaim: ['volumeName'],
  Pod: ['nodeName'],
}

/** `value` without `keys` (as pairs: never `value[key] =`), or nothing where that leaves none. */
function without(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!isMap(value)) return undefined
  const left = Object.entries(value).filter(([key]) => !keys.includes(key))
  return left.length > 0 ? Object.fromEntries(left) : undefined
}

/** A map's or a list's value with every map's keys in order; a list keeps its own. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (!isMap(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  )
}

/** Metadata without what the cluster set, where a pod template's is too. */
function setLeftOut(metadata: unknown, whole: boolean): Record<string, unknown> | undefined {
  if (!isMap(metadata)) return undefined
  const kept = whole ? without(metadata, SET_METADATA) : metadata
  if (!kept) return undefined
  const annotations = without(kept.annotations, SET_ANNOTATIONS)
  const labels = without(kept.labels, SET_LABELS)
  return without(
    { ...kept, ...(annotations ? { annotations } : {}), ...(labels ? { labels } : {}) },
    [...(annotations ? [] : ['annotations']), ...(labels ? [] : ['labels'])],
  )
}

/**
 * `object` as it's compared: every map's keys in order. Without `noise`, its status and what the
 * cluster set are left out: its metadata's own (uid, versions, times, managed fields, owners,
 * namespace), kubectl's and controllers' annotations and labels (a pod template's too), and of a
 * kind, what it was given (a Service's address, a claim's volume, a pod's node). What either side
 * withholds (`withheld`) is taken out, and marked where what holds it is (`markWithheld`).
 */
export function comparable(
  read: KubeObject,
  {
    noise = false,
    withheld = [],
  }: { noise?: boolean; withheld?: readonly { keys: readonly string[] }[] } = {},
): Record<string, unknown> {
  const object = markWithheld(read, withheld)
  if (noise) return sorted(object) as Record<string, unknown>
  const { status: _status, metadata, ...rest } = object as Record<string, unknown>
  const spec = isMap(rest.spec) ? rest.spec : undefined
  const template = spec && isMap(spec.template) ? spec.template : undefined
  const cleanSpec =
    spec &&
    without(
      template
        ? { ...spec, template: { ...template, metadata: setLeftOut(template.metadata, false) } }
        : spec,
      SET_SPEC[String(object.kind)] ?? [],
    )
  const meta = setLeftOut(metadata, true)
  return sorted({
    ...rest,
    ...(meta ? { metadata: meta } : {}),
    ...(spec ? (cleanSpec ? { spec: cleanSpec } : {}) : {}),
  }) as Record<string, unknown>
}

/** What a withheld field reads as, on both sides of a comparison: never its value. */
export const WITHHELD_MARK = '(withheld)'

/** `value` with each field `keys` leads to marked withheld, where what holds it is. */
function mark(value: unknown, keys: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => mark(item, keys))
  if (!isMap(value)) return value
  const [key, ...rest] = keys
  if (key === undefined) return value
  if (rest.length === 0) {
    return Object.fromEntries([
      ...Object.entries(value).filter(([k]) => k !== key),
      [key, WITHHELD_MARK],
    ])
  }
  if (!Object.hasOwn(value, key)) return value
  return Object.fromEntries(
    Object.entries(value).map(([k, held]) => [k, k === key ? mark(held, rest) : held]),
  )
}

/**
 * `object` as a side of a comparison has it, where either side withholds `fields`: without them
 * (one side's cluster may not withhold what the other's does), and each marked `WITHHELD_MARK`
 * wherever what holds it is, so it's never a difference, nor added or removed.
 */
export function markWithheld(
  object: KubeObject,
  fields: readonly { keys: readonly string[] }[],
): KubeObject {
  if (fields.length === 0) return object
  let left: unknown = withhold(object, fields)
  for (const { keys } of fields) left = mark(left, keys)
  return left as KubeObject
}

/** Where a workload references a ConfigMap or a Secret: by what in its pod's spec. */
export interface ConfigRef {
  kind: 'ConfigMap' | 'Secret'
  name: string
  /** Where, as a key the other side's is paired by. */
  place: string
  /** Where, said: "env DB_PASSWORD, container api". */
  said: string
}

interface Container {
  name?: string
  env?: {
    name?: string
    valueFrom?: { configMapKeyRef?: { name?: string }; secretKeyRef?: { name?: string } }
  }[]
  envFrom?: { configMapRef?: { name?: string }; secretRef?: { name?: string } }[]
  volumeMounts?: { name?: string }[]
}

interface PodSpec {
  containers?: Container[]
  initContainers?: Container[]
  volumes?: {
    name?: string
    configMap?: { name?: string }
    secret?: { secretName?: string }
    projected?: { sources?: { configMap?: { name?: string }; secret?: { name?: string } }[] }
  }[]
  imagePullSecrets?: { name?: string }[]
}

/** A workload's pod spec, where it has one. */
function podSpecOf(object: KubeObject): PodSpec | undefined {
  const spec = object.spec as Record<string, unknown> | undefined
  if (!isMap(spec)) return undefined
  if (object.kind === 'Pod') return spec as PodSpec
  const template =
    object.kind === 'CronJob'
      ? (spec.jobTemplate as { spec?: { template?: { spec?: PodSpec } } } | undefined)?.spec
          ?.template
      : (spec.template as { spec?: PodSpec } | undefined)
  return isMap(template?.spec) ? template.spec : undefined
}

/** The ConfigMaps and Secrets a workload references, each where it's referenced. */
export function configRefs(object: KubeObject): ConfigRef[] {
  const pod = podSpecOf(object)
  if (!pod) return []
  const refs: ConfigRef[] = []
  const add = (kind: ConfigRef['kind'], name: unknown, place: string, said: string) => {
    if (typeof name === 'string' && name) refs.push({ kind, name, place, said })
  }
  const containers = [...(pod.initContainers ?? []), ...(pod.containers ?? [])]
  for (const volume of pod.volumes ?? []) {
    const mounting = containers
      .filter((c) => c.volumeMounts?.some((mount) => mount.name === volume.name))
      .map((c) => c.name)
    const where = `volume ${volume.name}${mounting.length ? `, container ${mounting.join(', ')}` : ''}`
    add('ConfigMap', volume.configMap?.name, `volume/${volume.name}`, where)
    add('Secret', volume.secret?.secretName, `volume/${volume.name}`, where)
    ;(volume.projected?.sources ?? []).forEach((source, i) => {
      add('ConfigMap', source.configMap?.name, `volume/${volume.name}/${i}`, where)
      add('Secret', source.secret?.name, `volume/${volume.name}/${i}`, where)
    })
  }
  for (const container of containers) {
    for (const env of container.env ?? []) {
      const place = `env/${container.name}/${env.name}`
      const said = `env ${env.name}, container ${container.name}`
      add('ConfigMap', env.valueFrom?.configMapKeyRef?.name, place, said)
      add('Secret', env.valueFrom?.secretKeyRef?.name, place, said)
    }
    // (A container's envFrom, each kind in its own order: the first ConfigMap beside the first.)
    const seen = { ConfigMap: 0, Secret: 0 }
    for (const from of container.envFrom ?? []) {
      const said = `envFrom, container ${container.name}`
      if (from.configMapRef) {
        add(
          'ConfigMap',
          from.configMapRef.name,
          `envFrom/${container.name}/ConfigMap/${seen.ConfigMap++}`,
          said,
        )
      }
      if (from.secretRef) {
        add(
          'Secret',
          from.secretRef.name,
          `envFrom/${container.name}/Secret/${seen.Secret++}`,
          said,
        )
      }
    }
  }
  ;(pod.imagePullSecrets ?? []).forEach(({ name }, i) =>
    add('Secret', name, `imagePullSecrets/${i}`, 'image pull secret'),
  )
  return refs
}

/** Two sides' references to one kind at one place: an object on each side, or on one alone. */
export interface ConfigPair {
  kind: ConfigRef['kind']
  left?: string
  right?: string
  /** Where, said: each place it's referenced, the left's first. */
  said: string[]
}

/**
 * The config two workloads reference, paired by where it's referenced (not by its name, which
 * often differs between where they run): one pair for each two objects (or one alone) of a kind,
 * with every place they're referenced.
 */
export function configPairs(left: KubeObject, right: KubeObject): ConfigPair[] {
  const leftRefs = configRefs(left)
  const rightRefs = configRefs(right)
  const key = (ref: ConfigRef) => `${ref.kind}\u0000${ref.place}`
  const pairs = new Map<string, ConfigPair>()
  const pairOf = (kind: ConfigRef['kind'], l?: string, r?: string) => {
    const id = `${kind}\u0000${l ?? ''}\u0000${r ?? ''}`
    let pair = pairs.get(id)
    if (!pair) {
      pair = { kind, ...(l ? { left: l } : {}), ...(r ? { right: r } : {}), said: [] }
      pairs.set(id, pair)
    }
    return pair
  }
  const rights = new Map(rightRefs.map((ref) => [key(ref), ref]))
  for (const ref of leftRefs) {
    const other = rights.get(key(ref))
    rights.delete(key(ref))
    const pair = pairOf(ref.kind, ref.name, other?.name)
    if (!pair.said.includes(ref.said)) pair.said.push(ref.said)
  }
  for (const ref of rights.values()) {
    const pair = pairOf(ref.kind, undefined, ref.name)
    if (!pair.said.includes(ref.said)) pair.said.push(ref.said)
  }
  return [...pairs.values()]
}

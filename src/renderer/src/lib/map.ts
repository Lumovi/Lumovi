/**
 * The map: how an object is connected to the rest of the cluster. What
 * routes to it, selects, owns, scales and guards it, and what it runs on,
 * uses and mounts, followed both ways from the object, a few steps out. Pods
 * of one controller (or one revision of a Deployment) are one node, so a
 * thousand replicas are one card; references to objects that don't exist
 * are nodes too, missing ones.
 */
import type { KubeObject } from '@shared/api'
import { kindFor, kindOf, type ResourceKind } from '@shared/resources'
import { HEALTH_RANK, statusFor, type Health, type Status } from './health'

/** How one object relates to another: the edge reads "from <relation> to". */
export type Relation =
  | 'routes'
  | 'selects'
  | 'owns'
  | 'scales'
  | 'guards'
  | 'applies'
  | 'uses'
  | 'mounts'
  | 'runs'
  | 'binds'
  | 'class'
  | 'related'

/** Relations drawn dashed: what an object uses, rather than what traffic or ownership does. */
export const USES: ReadonlySet<Relation> = new Set(['uses', 'mounts', 'binds', 'class'])

export const RELATION_NAMES: Record<Relation, string> = {
  routes: 'Routes to',
  selects: 'Selects',
  owns: 'Owns',
  scales: 'Scales',
  guards: 'Guards',
  applies: 'Applies to',
  uses: 'Uses',
  mounts: 'Mounts',
  runs: 'Runs on',
  binds: 'Bound to',
  class: 'Class',
  related: 'Related',
}

export interface MapNode {
  id: string
  kind: ResourceKind
  name: string
  namespace?: string
  /** Undefined when it's referred to but isn't there (or can't be read). */
  object?: KubeObject
  /** Referred to, and its kind was listed, but it isn't there. */
  missing?: boolean
  /** Pods shown as one: a controller's, or one revision's. */
  pods?: KubeObject[]
  /** A Deployment's revision its grouped pods are of. */
  revision?: string
  /** A pod of a group that's been opened: its row shows all of them. */
  unfolded?: boolean
  /** The pods a Service selects. */
  selected?: KubeObject[]
}

export interface MapEdge {
  from: string
  to: string
  relation: Relation
}

export interface MapGraph {
  nodes: Map<string, MapNode>
  edges: MapEdge[]
  focus: string
}

/** A node's id: its object's reference, as `?open=` takes it (`Kind/namespace/name`). */
export const idOf = (kind: ResourceKind, name: string, namespace = '') =>
  `${kind}/${namespace}/${name}`

const objectId = (object: KubeObject) =>
  idOf(kindOf(object), object.metadata.name, object.metadata.namespace)

// ——— Selectors ———

interface Requirement {
  key: string
  operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist'
  values?: string[]
}

export interface LabelSelector {
  matchLabels?: Record<string, string>
  matchExpressions?: Requirement[]
}

/** Whether `labels` match a label selector; an empty one matches everything. */
export function selects(selector: LabelSelector, labels: Record<string, string> = {}): boolean {
  const plain = Object.entries(selector.matchLabels ?? {}).every(([k, v]) => labels[k] === v)
  return (
    plain &&
    (selector.matchExpressions ?? []).every(({ key, operator, values = [] }) => {
      const has = key in labels
      switch (operator) {
        case 'In':
          return has && values.includes(labels[key]!)
        case 'NotIn':
          return !has || !values.includes(labels[key]!)
        case 'Exists':
          return has
        default:
          return !has
      }
    })
  )
}

// ——— What objects refer to ———

const WORKLOADS = new Set<ResourceKind>([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'Job',
  'CronJob',
])

/** A workload's pod template. */
function templateOf(object: KubeObject): { metadata?: KubeObject['metadata']; spec: PodSpec } {
  return object.kind === 'CronJob' ? object.spec.jobTemplate.spec.template : object.spec.template
}

interface PodSpec {
  volumes?: Record<string, any>[] // eslint-disable-line @typescript-eslint/no-explicit-any
  containers: Container[]
  initContainers?: Container[]
  imagePullSecrets?: { name: string }[]
  serviceAccountName?: string
  nodeName?: string
}

interface Container {
  env?: { valueFrom?: { configMapKeyRef?: { name: string }; secretKeyRef?: { name: string } } }[]
  envFrom?: { configMapRef?: { name: string }; secretRef?: { name: string } }[]
}

/** The ConfigMaps, Secrets, claims and service account a pod spec refers to. */
export function specRefs(
  spec: PodSpec,
): { kind: ResourceKind; name: string; relation: Relation }[] {
  const refs: { kind: ResourceKind; name: string; relation: Relation }[] = []
  for (const volume of spec.volumes ?? []) {
    // Kubernetes gives every pod its service account's token and the cluster's CA this way.
    if (volume.name?.startsWith('kube-api-access-')) continue
    if (volume.configMap)
      refs.push({ kind: 'ConfigMap', name: volume.configMap.name, relation: 'mounts' })
    if (volume.secret)
      refs.push({ kind: 'Secret', name: volume.secret.secretName, relation: 'mounts' })
    if (volume.persistentVolumeClaim) {
      refs.push({
        kind: 'PersistentVolumeClaim',
        name: volume.persistentVolumeClaim.claimName,
        relation: 'mounts',
      })
    }
    for (const source of volume.projected?.sources ?? []) {
      if (source.configMap)
        refs.push({ kind: 'ConfigMap', name: source.configMap.name, relation: 'mounts' })
      if (source.secret) refs.push({ kind: 'Secret', name: source.secret.name, relation: 'mounts' })
    }
  }
  for (const c of [...(spec.initContainers ?? []), ...spec.containers]) {
    for (const { valueFrom } of c.env ?? []) {
      if (valueFrom?.configMapKeyRef) {
        refs.push({ kind: 'ConfigMap', name: valueFrom.configMapKeyRef.name, relation: 'uses' })
      }
      if (valueFrom?.secretKeyRef) {
        refs.push({ kind: 'Secret', name: valueFrom.secretKeyRef.name, relation: 'uses' })
      }
    }
    for (const from of c.envFrom ?? []) {
      if (from.configMapRef)
        refs.push({ kind: 'ConfigMap', name: from.configMapRef.name, relation: 'uses' })
      if (from.secretRef) refs.push({ kind: 'Secret', name: from.secretRef.name, relation: 'uses' })
    }
  }
  for (const { name } of spec.imagePullSecrets ?? [])
    refs.push({ kind: 'Secret', name, relation: 'uses' })
  // Every pod has a service account; only one of its own says anything.
  if (spec.serviceAccountName && spec.serviceAccountName !== 'default') {
    refs.push({ kind: 'ServiceAccount', name: spec.serviceAccountName, relation: 'uses' })
  }
  return refs
}

interface IngressRule {
  http?: { paths?: { backend?: { service?: { name: string } } }[] }
}

/** A ConfigMap's or Secret's data, if it has any. */
const entries = (data: unknown) => (data ?? {}) as Record<string, string>

/** The owner that controls an object, or its first owner. */
function ownerOf(object: KubeObject) {
  const owners = object.metadata.ownerReferences ?? []
  return owners.find((o) => o.controller) ?? owners[0]
}

const HTTP_ROUTE = 'HTTPRoute.gateway.networking.k8s.io'
const GATEWAY = 'Gateway.gateway.networking.k8s.io'
const PDB = 'PodDisruptionBudget.policy'

/** The kinds the map lists to find relations: a namespace's, and the cluster's. */
export const MAP_KINDS: ResourceKind[] = [
  'Pod',
  'Deployment',
  'ReplicaSet',
  'StatefulSet',
  'DaemonSet',
  'Job',
  'CronJob',
  'HorizontalPodAutoscaler',
  'Service',
  'Ingress',
  'NetworkPolicy',
  'ConfigMap',
  'Secret',
  'PersistentVolumeClaim',
  'ServiceAccount',
  PDB,
  HTTP_ROUTE,
  GATEWAY,
]
export const CLUSTER_MAP_KINDS: ResourceKind[] = ['Node', 'PersistentVolume', 'StorageClass']

// ——— The graph ———

/** How far the map follows relations from its object: what it depends on, and what depends on it. */
const DOWN = 5
const UP = 3
/** A node runs pods of everything: what's on it, and whose they are, is enough. */
const UP_FROM: Partial<Record<ResourceKind, number>> = { Node: 2 }

/**
 * The map of `focus`: its neighbourhood among `pool`, with pods grouped by
 * controller except those `expanded`. `listed` are the kinds whose lists
 * loaded: a reference to one of those that isn't in `pool` is missing.
 * `related` are a view's relations of the focus (custom kinds).
 */
export function buildMap({
  pool,
  listed,
  focus,
  expanded,
  related,
}: {
  pool: KubeObject[]
  listed: ReadonlySet<ResourceKind>
  focus: KubeObject
  expanded: ReadonlySet<string>
  related: KubeObject[]
}): MapGraph {
  const byId = new Map<string, KubeObject>()
  for (const object of [...pool, ...related, focus]) byId.set(objectId(object), object)
  const nodes = new Map<string, MapNode>()
  const node = (kind: ResourceKind, name: string, namespace?: string): MapNode => {
    const id = idOf(kind, name, namespace)
    let found = nodes.get(id)
    if (!found) {
      const object = byId.get(id)
      found = { id, kind, name, namespace, object, missing: !object && listed.has(kind) }
      nodes.set(id, found)
    }
    return found
  }
  const of = (object: KubeObject) =>
    node(kindOf(object), object.metadata.name, object.metadata.namespace)
  const edges: MapEdge[] = []
  const edge = (from: MapNode, to: MapNode, relation: Relation) => {
    edges.push({ from: from.id, to: to.id, relation })
  }

  const objects = [...byId.values()]
  const pods = objects.filter((o) => o.kind === 'Pod')
  const workloads = objects.filter((o) => WORKLOADS.has(kindOf(o)))
  /** The workload a pod's pods are counted under: its Deployment, rather than its ReplicaSet. */
  const controllerOf = (pod: KubeObject): MapNode | undefined => {
    const owner = ownerOf(pod)
    if (!owner) return undefined
    const ownerNode = node(
      kindFor(owner.apiVersion, owner.kind),
      owner.name,
      pod.metadata.namespace,
    )
    const deployment = ownerNode.object && owner.kind === 'ReplicaSet' && ownerOf(ownerNode.object)
    return deployment
      ? node(
          kindFor(deployment.apiVersion, deployment.kind),
          deployment.name,
          pod.metadata.namespace,
        )
      : ownerNode
  }
  /**
   * What a selector picks in a namespace: the workloads whose pods it matches (those
   * without pods, scaled to zero, by their template), and pods without one.
   */
  const picks = (selector: LabelSelector, namespace: string | undefined) => {
    const found = new Set<MapNode>()
    for (const pod of pods) {
      if (pod.metadata.namespace === namespace && selects(selector, pod.metadata.labels)) {
        found.add(controllerOf(pod) ?? of(pod))
      }
    }
    for (const w of workloads) {
      if (
        w.metadata.namespace === namespace &&
        !ownerOf(w) &&
        selects(selector, templateOf(w).metadata?.labels)
      ) {
        found.add(of(w))
      }
    }
    return [...found]
  }

  for (const object of objects) {
    const kind = kindOf(object)
    const self = of(object)
    const ns = object.metadata.namespace
    const owner = ownerOf(object)
    if (owner) edge(node(kindFor(owner.apiVersion, owner.kind), owner.name, ns), self, 'owns')
    if (kind === 'Pod') {
      if (object.spec.nodeName) edge(self, node('Node', object.spec.nodeName), 'runs')
      for (const ref of specRefs(object.spec)) {
        edge(self, node(ref.kind, ref.name, ns), ref.relation)
      }
    }
    if (WORKLOADS.has(kind)) {
      for (const ref of specRefs(templateOf(object).spec)) {
        edge(self, node(ref.kind, ref.name, ns), ref.relation)
      }
    }
    switch (kind) {
      case 'StatefulSet': {
        // Its pods' claims, made from its claim templates: <template>-<name>-<ordinal>.
        const prefixes: string[] = (object.spec.volumeClaimTemplates ?? []).map(
          (t: KubeObject) => `${t.metadata.name}-${object.metadata.name}-`,
        )
        for (const claim of objects) {
          const name = claim.metadata.name
          if (
            claim.kind === 'PersistentVolumeClaim' &&
            claim.metadata.namespace === ns &&
            prefixes.some((p) => name.startsWith(p) && /^\d+$/.test(name.slice(p.length)))
          ) {
            edge(self, of(claim), 'uses')
          }
        }
        break
      }
      case 'Service': {
        // Without a selector, its endpoints are managed by hand (or it's an ExternalName).
        if (Object.keys(object.spec.selector ?? {}).length === 0) break
        self.selected = pods.filter(
          (p) =>
            p.metadata.namespace === ns &&
            selects({ matchLabels: object.spec.selector }, p.metadata.labels),
        )
        for (const target of picks({ matchLabels: object.spec.selector }, ns)) {
          edge(self, target, 'selects')
        }
        break
      }
      case 'Ingress': {
        const backends = [
          object.spec.defaultBackend,
          ...((object.spec.rules ?? []) as IngressRule[]).flatMap((r) =>
            (r.http?.paths ?? []).map((p) => p.backend),
          ),
        ]
        for (const backend of backends) {
          if (backend?.service) edge(self, node('Service', backend.service.name, ns), 'routes')
        }
        for (const tls of object.spec.tls ?? []) {
          if (tls.secretName) edge(self, node('Secret', tls.secretName, ns), 'uses')
        }
        break
      }
      case HTTP_ROUTE: {
        for (const parent of object.spec.parentRefs ?? []) {
          if ((parent.kind ?? 'Gateway') === 'Gateway') {
            edge(node(GATEWAY, parent.name, parent.namespace ?? ns), self, 'routes')
          }
        }
        for (const rule of object.spec.rules ?? []) {
          for (const ref of rule.backendRefs ?? []) {
            if ((ref.kind ?? 'Service') === 'Service') {
              edge(self, node('Service', ref.name, ref.namespace ?? ns), 'routes')
            }
          }
        }
        break
      }
      case 'HorizontalPodAutoscaler': {
        const target = object.spec.scaleTargetRef
        edge(self, node(kindFor(target.apiVersion, target.kind), target.name, ns), 'scales')
        break
      }
      case PDB:
        for (const target of picks(object.spec.selector ?? {}, ns)) edge(self, target, 'guards')
        break
      case 'NetworkPolicy':
        // An empty selector is every pod in the namespace.
        for (const target of picks(object.spec.podSelector, ns)) edge(self, target, 'applies')
        break
      case 'PersistentVolumeClaim':
        if (object.spec.volumeName) {
          edge(self, node('PersistentVolume', object.spec.volumeName), 'binds')
        } else if (object.spec.storageClassName) {
          edge(self, node('StorageClass', object.spec.storageClassName), 'class')
        }
        break
      case 'PersistentVolume':
        if (object.spec.storageClassName) {
          edge(self, node('StorageClass', object.spec.storageClassName), 'class')
        }
        break
    }
  }
  const focusNode = of(focus)
  for (const object of related) edge(focusNode, of(object), 'related')

  // ReplicaSets of a Deployment are its revisions: their pods hang off the Deployment.
  const passThrough = new Map<string, string>()
  for (const n of nodes.values()) {
    const owner = n.object && n.kind === 'ReplicaSet' && ownerOf(n.object)
    if (owner && owner.kind === 'Deployment' && n.id !== focusNode.id) {
      passThrough.set(n.id, idOf('Deployment', owner.name, n.namespace))
    }
  }
  // Pods (but the map's own) are shown a controller's, or a revision's, at a time.
  const groupOf = new Map<string, string>()
  for (const pod of pods) {
    const owner = ownerOf(pod)
    const id = objectId(pod)
    if (!owner || id === focusNode.id) continue
    const key = idOf(kindFor(owner.apiVersion, owner.kind), owner.name, pod.metadata.namespace)
    const groupId = `pods:${key}`
    if (expanded.has(groupId)) {
      of(pod).unfolded = true
      continue
    }
    groupOf.set(id, groupId)
    let group = nodes.get(groupId)
    if (!group) {
      // A revision's pods go by their Deployment's name.
      const revision = passThrough.has(key) ? byId.get(key)! : undefined
      group = {
        id: groupId,
        kind: 'Pod',
        name: revision ? ownerOf(revision)!.name : owner.name,
        namespace: pod.metadata.namespace,
        pods: [],
        revision: revision?.metadata.annotations?.['deployment.kubernetes.io/revision'],
      }
      nodes.set(groupId, group)
    }
    group.pods!.push(pod)
  }
  const resolve = (id: string) => groupOf.get(id) ?? id
  const merged = new Map<string, MapEdge>()
  const add = (from: string, to: string, relation: Relation) => {
    const key = `${from}>${to}`
    if (from !== to && !merged.has(key)) merged.set(key, { from, to, relation })
  }
  for (const e of edges) {
    const from = resolve(e.from)
    const to = resolve(e.to)
    if (passThrough.has(to)) continue
    // Deployment → ReplicaSet → pods becomes Deployment → pods.
    add(passThrough.get(from) ?? from, to, e.relation)
  }
  const all = [...merged.values()]

  // The neighbourhood: what the focus leads to, and what leads to it.
  const outgoing = new Map<string, MapEdge[]>()
  const incoming = new Map<string, MapEdge[]>()
  for (const e of all) {
    if (!outgoing.has(e.from)) outgoing.set(e.from, [])
    if (!incoming.has(e.to)) incoming.set(e.to, [])
    outgoing.get(e.from)!.push(e)
    incoming.get(e.to)!.push(e)
  }
  const reach = (
    start: string,
    next: Map<string, MapEdge[]>,
    side: 'to' | 'from',
    depth: number,
  ) => {
    const seen = new Set([start])
    let frontier = [start]
    for (let d = 0; d < depth && frontier.length > 0; d++) {
      frontier = frontier.flatMap((id) =>
        (next.get(id) ?? [])
          .map((e) => e[side])
          .filter((id) => !seen.has(id) && (seen.add(id), true)),
      )
    }
    return seen
  }
  const down = reach(focusNode.id, outgoing, 'to', DOWN)
  const up = reach(focusNode.id, incoming, 'from', UP_FROM[focusNode.kind] ?? UP)
  const keep = new Set([...down, ...up])
  const kept = all.filter(
    (e) => (down.has(e.from) && down.has(e.to)) || (up.has(e.from) && up.has(e.to)),
  )
  // What a group's pods use, their controller already does: the controller's line says it.
  const shown = kept.filter((e) => {
    if (!nodes.get(e.from)!.pods || !USES.has(e.relation)) return true
    const controllers = kept
      .filter((c) => c.to === e.from && c.relation === 'owns')
      .map((c) => c.from)
    return !kept.some((u) => controllers.includes(u.from) && u.to === e.to)
  })
  return {
    nodes: new Map([...nodes].filter(([id]) => keep.has(id))),
    edges: shown,
    focus: focusNode.id,
  }
}

// ——— What a node says ———

/** The worst health first, then the most common. */
function worst(statuses: Status[]): Health {
  return statuses.map((s) => s.health).sort((a, b) => HEALTH_RANK[a] - HEALTH_RANK[b])[0]!
}

/** A node's status: its own, its pods', or its endpoints'. Null when it says nothing. */
export function nodeStatus(node: MapNode): Status | null {
  if (node.missing) return { health: 'critical', label: 'Not found' }
  if (node.pods) {
    const statuses = node.pods.map((p) => statusFor('Pod', p)!)
    const ready = statuses.filter((s) => s.health === 'healthy').length
    return { health: worst(statuses), label: `${ready}/${node.pods.length} ready` }
  }
  if (!node.object) return null
  if (node.kind === 'Service' && node.selected) {
    const ready = node.selected.filter((p) => statusFor('Pod', p)!.health === 'healthy').length
    if (node.selected.length === 0) return { health: 'warning', label: 'No pods' }
    return {
      health: ready === 0 ? 'critical' : ready < node.selected.length ? 'warning' : 'healthy',
      label: `${ready}/${node.selected.length} ready`,
    }
  }
  return statusFor(node.kind, node.object)
}

/** A line about a node, under its kind: a Service's type and ports, a ConfigMap's keys. */
export function nodeMeta(node: MapNode): string | undefined {
  const o = node.object
  if (node.pods) return node.revision && `revision ${node.revision}`
  if (!o) return undefined
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
  switch (node.kind) {
    case 'Service':
      return [o.spec.type, (o.spec.ports ?? []).map((p: { port: number }) => p.port).join(', ')]
        .filter(Boolean)
        .join(' · ')
    case 'Ingress':
      return o.spec.rules?.[0]?.host
    case HTTP_ROUTE:
      return o.spec.hostnames?.[0]
    case 'ConfigMap':
      return count(Object.keys({ ...entries(o.data), ...entries(o.binaryData) }).length, 'key')
    case 'Secret':
      return o.type === 'kubernetes.io/tls'
        ? 'TLS'
        : o.type === 'kubernetes.io/dockerconfigjson'
          ? 'Registry'
          : count(Object.keys(entries(o.data)).length, 'key')
    case 'PersistentVolumeClaim':
      return o.status?.capacity?.storage ?? o.spec.resources?.requests?.storage
    case 'PersistentVolume':
      return o.spec.capacity?.storage
    case 'HorizontalPodAutoscaler':
      return `${o.spec.minReplicas ?? 1}–${o.spec.maxReplicas} replicas`
    case 'CronJob':
      return o.spec.schedule
    case 'Node':
      return o.metadata.labels?.['node.kubernetes.io/instance-type']
    case 'StorageClass':
      return o.provisioner as string
    case 'NetworkPolicy':
      return (o.spec.policyTypes ?? ['Ingress']).join(', ')
    default:
      return undefined
  }
}

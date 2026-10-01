/**
 * The Kubernetes resource kinds KubeStacks knows how to show.
 *
 * Built-in kinds are described here once, for the main process (to build API
 * paths) and the renderer (navigation and table columns). Every other
 * resource the cluster serves, custom resources included, is found through
 * API discovery and described the same way.
 */

/** Kinds with their own pages, columns, details and actions. */
export const BUILTIN_KINDS = [
  'Node',
  'Namespace',
  'Event',
  'Pod',
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'Job',
  'CronJob',
  'HorizontalPodAutoscaler',
  'Service',
  'Ingress',
  'NetworkPolicy',
  'ConfigMap',
  'Secret',
  'PersistentVolumeClaim',
  'PersistentVolume',
  'StorageClass',
] as const

export type BuiltinKind = (typeof BUILTIN_KINDS)[number]

/**
 * What KubeStacks calls a resource. Built-in kinds go by their kind ("Pod");
 * others by kind and API group ("Certificate.cert-manager.io"), which is what
 * object references (apiVersion and kind) identify, or by kind alone in the
 * core group ("ServiceAccount").
 */
// `string & {}` keeps the built-in names as suggestions without excluding others.
export type ResourceKind = BuiltinKind | (string & {})

export type ResourceCategory = 'cluster' | 'workloads' | 'network' | 'config' | 'storage'

export interface ResourceDefinition {
  kind: ResourceKind
  /** The kind its objects have, e.g. `Certificate`; the same as `kind` for built-ins. */
  apiKind: string
  /** Plural resource name used in API paths, e.g. `pods`. */
  plural: string
  /** API group; empty string for the core group. */
  group: string
  version: string
  namespaced: boolean
  /** Human readable plural label, e.g. `Pods`. */
  label: string
  /** Where a built-in kind sits in the sidebar. */
  category?: ResourceCategory
  /** Short names kubectl accepts, e.g. `cert`. */
  shortNames?: string[]
  /** Subresources it serves, such as `status` and `scale`. */
  subresources?: string[]
}

/** A built-in kind's definition: always placed in the sidebar. */
export type BuiltinDefinition = ResourceDefinition & {
  kind: BuiltinKind
  category: ResourceCategory
}

function def(
  kind: BuiltinKind,
  plural: string,
  groupVersion: string,
  namespaced: boolean,
  label: string,
  category: ResourceCategory,
): BuiltinDefinition {
  const [group, version] = groupVersion.includes('/')
    ? (groupVersion.split('/') as [string, string])
    : ['', groupVersion]
  return { kind, apiKind: kind, plural, group, version, namespaced, label, category }
}

/** The built-in kinds, in sidebar order. */
export const RESOURCES: readonly BuiltinDefinition[] = [
  def('Node', 'nodes', 'v1', false, 'Nodes', 'cluster'),
  def('Namespace', 'namespaces', 'v1', false, 'Namespaces', 'cluster'),
  def('Event', 'events', 'v1', true, 'Events', 'cluster'),
  def('Pod', 'pods', 'v1', true, 'Pods', 'workloads'),
  def('Deployment', 'deployments', 'apps/v1', true, 'Deployments', 'workloads'),
  def('StatefulSet', 'statefulsets', 'apps/v1', true, 'StatefulSets', 'workloads'),
  def('DaemonSet', 'daemonsets', 'apps/v1', true, 'DaemonSets', 'workloads'),
  def('ReplicaSet', 'replicasets', 'apps/v1', true, 'ReplicaSets', 'workloads'),
  def('Job', 'jobs', 'batch/v1', true, 'Jobs', 'workloads'),
  def('CronJob', 'cronjobs', 'batch/v1', true, 'CronJobs', 'workloads'),
  def(
    'HorizontalPodAutoscaler',
    'horizontalpodautoscalers',
    'autoscaling/v2',
    true,
    'Autoscalers',
    'workloads',
  ),
  def('Service', 'services', 'v1', true, 'Services', 'network'),
  def('Ingress', 'ingresses', 'networking.k8s.io/v1', true, 'Ingresses', 'network'),
  def(
    'NetworkPolicy',
    'networkpolicies',
    'networking.k8s.io/v1',
    true,
    'Network Policies',
    'network',
  ),
  def('ConfigMap', 'configmaps', 'v1', true, 'ConfigMaps', 'config'),
  def('Secret', 'secrets', 'v1', true, 'Secrets', 'config'),
  def('PersistentVolumeClaim', 'persistentvolumeclaims', 'v1', true, 'Volume Claims', 'storage'),
  def('PersistentVolume', 'persistentvolumes', 'v1', false, 'Volumes', 'storage'),
  def('StorageClass', 'storageclasses', 'storage.k8s.io/v1', false, 'Storage Classes', 'storage'),
]

const BY_KIND = new Map(RESOURCES.map((r) => [r.kind as ResourceKind, r]))
const BY_PLURAL = new Map(RESOURCES.map((r) => [r.plural, r]))

export function isBuiltinKind(value: unknown): value is BuiltinKind {
  return typeof value === 'string' && BY_KIND.has(value)
}

export function resourceByKind(kind: BuiltinKind): BuiltinDefinition {
  return BY_KIND.get(kind)!
}

/** A built-in kind's definition, or nothing for other kinds. */
export function builtinResource(kind: ResourceKind): ResourceDefinition | undefined {
  return BY_KIND.get(kind)
}

export function resourceByPlural(plural: string): ResourceDefinition | undefined {
  return BY_PLURAL.get(plural)
}

/** `Certificate.cert-manager.io`: how a kind and its API group name a resource. */
const KIND_PATTERN = /^[A-Za-z][A-Za-z0-9]*(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/

export function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === 'string' && value.length <= 320 && KIND_PATTERN.test(value)
}

/** The group of an `apiVersion` like `apps/v1`; empty for the core group's `v1`. */
export function groupOf(apiVersion: string | undefined): string {
  return apiVersion?.includes('/') ? apiVersion.slice(0, apiVersion.indexOf('/')) : ''
}

/** The resource that `apiVersion` and `kind` name, as an object or a reference to one does. */
export function kindFor(apiVersion: string | undefined, kind: string): ResourceKind {
  const group = groupOf(apiVersion)
  const builtin = BY_KIND.get(kind)
  if (builtin && builtin.group === group) return kind
  return group ? `${kind}.${group}` : kind
}

/** The resource an object is one of. */
export function kindOf(object: { apiVersion?: string; kind?: string }): ResourceKind {
  return kindFor(object.apiVersion, object.kind!)
}

/** The kind its objects have: `Certificate` for `Certificate.cert-manager.io`. */
export function apiKindOf(kind: ResourceKind): string {
  const dot = kind.indexOf('.')
  return dot === -1 ? kind : kind.slice(0, dot)
}

/**
 * The API group in a kind's name: `cert-manager.io` for `Certificate.cert-manager.io`.
 * Built-in kinds are named without theirs.
 */
export function apiGroupOf(kind: ResourceKind): string {
  const dot = kind.indexOf('.')
  return dot === -1 ? '' : kind.slice(dot + 1)
}

/** API groups that are part of Kubernetes itself; anything else is added to the cluster. */
const KUBERNETES_GROUPS = new Set([
  '',
  'apps',
  'batch',
  'autoscaling',
  'policy',
  'admissionregistration.k8s.io',
  'apiextensions.k8s.io',
  'apiregistration.k8s.io',
  'authentication.k8s.io',
  'authorization.k8s.io',
  'certificates.k8s.io',
  'coordination.k8s.io',
  'discovery.k8s.io',
  'events.k8s.io',
  'flowcontrol.apiserver.k8s.io',
  'internal.apiserver.k8s.io',
  'metrics.k8s.io',
  'networking.k8s.io',
  'node.k8s.io',
  'rbac.authorization.k8s.io',
  'resource.k8s.io',
  'scheduling.k8s.io',
  'storage.k8s.io',
  'storagemigration.k8s.io',
])

/** Whether a resource was added to the cluster (a custom resource), rather than built in. */
export function isCustomGroup(group: string): boolean {
  return !KUBERNETES_GROUPS.has(group)
}

/**
 * "ClusterIssuers" for `ClusterIssuer` served as `clusterissuers`: the kind,
 * pluralised the way its API does.
 */
export function pluralLabel(apiKind: string, plural: string): string {
  const lower = apiKind.toLowerCase()
  let shared = 0
  while (shared < lower.length && lower[shared] === plural[shared]) shared++
  return apiKind.slice(0, shared) + plural.slice(shared)
}

/** Builds the REST path for a list (no name) or a single object. */
export function resourcePath(
  resource: ResourceDefinition,
  namespace?: string,
  name?: string,
): string {
  const base = resource.group
    ? `/apis/${resource.group}/${resource.version}`
    : `/api/${resource.version}`
  const scope =
    resource.namespaced && namespace ? `/namespaces/${encodeURIComponent(namespace)}` : ''
  const object = name ? `/${encodeURIComponent(name)}` : ''
  return `${base}${scope}/${resource.plural}${object}`
}

/**
 * The Kubernetes resource kinds KubeStacks knows how to show.
 *
 * This registry is shared by the main process (to build API paths) and the
 * renderer (to build navigation and pick table columns), so a kind only has
 * to be described once.
 */

export const RESOURCE_KINDS = [
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

export type ResourceKind = (typeof RESOURCE_KINDS)[number]

export type ResourceCategory = 'cluster' | 'workloads' | 'network' | 'config' | 'storage'

export interface ResourceDefinition {
  kind: ResourceKind
  /** Plural resource name used in API paths and routes, e.g. `pods`. */
  plural: string
  /** API group; empty string for the core group. */
  group: string
  version: string
  namespaced: boolean
  /** Human readable plural label, e.g. `Pods`. */
  label: string
  category: ResourceCategory
}

function def(
  kind: ResourceKind,
  plural: string,
  groupVersion: string,
  namespaced: boolean,
  label: string,
  category: ResourceCategory,
): ResourceDefinition {
  const [group, version] = groupVersion.includes('/')
    ? (groupVersion.split('/') as [string, string])
    : ['', groupVersion]
  return { kind, plural, group, version, namespaced, label, category }
}

export const RESOURCES: readonly ResourceDefinition[] = [
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

const BY_KIND = new Map(RESOURCES.map((r) => [r.kind, r]))
const BY_PLURAL = new Map(RESOURCES.map((r) => [r.plural, r]))

export function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === 'string' && BY_KIND.has(value as ResourceKind)
}

export function resourceByKind(kind: ResourceKind): ResourceDefinition {
  return BY_KIND.get(kind)!
}

export function resourceByPlural(plural: string): ResourceDefinition | undefined {
  return BY_PLURAL.get(plural)
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

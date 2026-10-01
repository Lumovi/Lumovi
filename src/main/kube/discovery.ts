/**
 * API discovery: every kind the cluster serves, custom resources included.
 *
 * Clusters with aggregated discovery (Kubernetes 1.26 and later) describe
 * everything in two documents. Older ones get kubectl's way: one request per
 * API group, at each group's preferred version.
 */
import { kindFor, pluralLabel, RESOURCES, type ResourceDefinition } from '@shared/resources'

/** Asks for aggregated discovery; servers without it answer with the plain documents. */
export const DISCOVERY_ACCEPT = [
  'application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList',
  'application/json;g=apidiscovery.k8s.io;v=v2beta1;as=APIGroupDiscoveryList',
  'application/json',
].join(',')

/**
 * Groups shown elsewhere: events.k8s.io serves the core group's Events again,
 * and metrics.k8s.io is the live usage on pages and nodes.
 */
const HIDDEN_GROUPS = new Set(['events.k8s.io', 'metrics.k8s.io'])

/** One resource as discovery describes it. */
interface Found {
  group: string
  version: string
  plural: string
  kind: string
  namespaced: boolean
  verbs: string[]
  shortNames?: string[]
  subresources: string[]
}

interface AggregatedResource {
  resource: string
  responseKind: { kind: string }
  scope: 'Cluster' | 'Namespaced'
  verbs: string[]
  shortNames?: string[]
  subresources?: { subresource: string }[]
}

interface AggregatedList {
  kind: 'APIGroupDiscoveryList'
  items: {
    /** The core group's has no name. */
    metadata: { name?: string }
    /** A version whose API is down is stale, without resources. */
    versions: { version: string; resources?: AggregatedResource[] }[]
  }[]
}

interface ResourceList {
  groupVersion: string
  resources: {
    name: string
    kind: string
    namespaced: boolean
    verbs: string[]
    shortNames?: string[]
  }[]
}

type Get = (path: string, accept?: string) => Promise<unknown>
type Limit = <T>(task: () => Promise<T>) => Promise<T>

/** Every listable kind the cluster serves, sorted by label. */
export async function discover(get: Get, limit: Limit): Promise<ResourceDefinition[]> {
  const [core, groups] = await Promise.all([
    get('/api', DISCOVERY_ACCEPT),
    get('/apis', DISCOVERY_ACCEPT),
  ])
  const found = [
    ...(await fromDocument(core, get, limit)),
    ...(await fromDocument(groups, get, limit)),
  ]
  return definitions(found)
}

async function fromDocument(document: unknown, get: Get, limit: Limit): Promise<Found[]> {
  const kind = (document as { kind?: string }).kind
  if (kind === 'APIGroupDiscoveryList') return fromAggregated(document as AggregatedList)
  if (kind === 'APIVersions') {
    // The core group, served at /api/v1.
    const versions = (document as { versions: string[] }).versions
    return fromResourceList((await get(`/api/${versions[0]}`)) as ResourceList)
  }
  const { groups } = document as {
    groups: { preferredVersion: { groupVersion: string } }[]
  }
  const lists = await Promise.all(
    groups.map(({ preferredVersion }) =>
      limit(async () => {
        try {
          return (await get(`/apis/${preferredVersion.groupVersion}`)) as ResourceList
        } catch {
          // An aggregated API that's down (a metrics server, say) leaves its group out, like kubectl.
          return undefined
        }
      }),
    ),
  )
  return lists.flatMap((list) => (list ? fromResourceList(list) : []))
}

function fromAggregated(list: AggregatedList): Found[] {
  const found: Found[] = []
  for (const group of list.items) {
    const name = group.metadata.name ?? ''
    // Versions come in order of preference: a resource is taken from the first that has it.
    const seen = new Set<string>()
    for (const { version, resources = [] } of group.versions) {
      for (const resource of resources) {
        if (seen.has(resource.resource)) continue
        seen.add(resource.resource)
        found.push({
          group: name,
          version,
          plural: resource.resource,
          kind: resource.responseKind.kind,
          namespaced: resource.scope === 'Namespaced',
          verbs: resource.verbs,
          shortNames: resource.shortNames,
          subresources: (resource.subresources ?? []).map((s) => s.subresource),
        })
      }
    }
  }
  return found
}

function fromResourceList(list: ResourceList): Found[] {
  const [group, version] = list.groupVersion.includes('/')
    ? (list.groupVersion.split('/') as [string, string])
    : ['', list.groupVersion]
  const subresources = new Map<string, string[]>()
  for (const { name } of list.resources) {
    const [plural, subresource] = name.split('/')
    if (subresource) subresources.set(plural!, [...(subresources.get(plural!) ?? []), subresource])
  }
  return list.resources
    .filter(({ name }) => !name.includes('/'))
    .map((resource) => ({
      group,
      version,
      plural: resource.name,
      kind: resource.kind,
      namespaced: resource.namespaced,
      verbs: resource.verbs,
      shortNames: resource.shortNames,
      subresources: subresources.get(resource.name) ?? [],
    }))
}

/** What KubeStacks can browse: kinds that can be listed, described like the built-in ones. */
function definitions(found: Found[]): ResourceDefinition[] {
  const resources = new Map<string, ResourceDefinition>()
  for (const f of found) {
    if (!f.verbs.includes('list') || HIDDEN_GROUPS.has(f.group)) continue
    const extra = {
      ...(f.shortNames?.length ? { shortNames: f.shortNames } : {}),
      ...(f.subresources.length ? { subresources: f.subresources } : {}),
    }
    const builtin = RESOURCES.find((r) => r.group === f.group && r.apiKind === f.kind)
    const kind = kindFor(f.group ? `${f.group}/${f.version}` : f.version, f.kind)
    resources.set(
      kind,
      builtin
        ? { ...builtin, ...extra }
        : {
            kind,
            apiKind: f.kind,
            plural: f.plural,
            group: f.group,
            version: f.version,
            namespaced: f.namespaced,
            label: pluralLabel(f.kind, f.plural),
            ...extra,
          },
    )
  }
  return [...resources.values()].sort((a, b) => a.label.localeCompare(b.label))
}

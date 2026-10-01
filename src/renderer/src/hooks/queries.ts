import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { KubeList, KubeObject } from '@shared/api'
import type { ResourceKind } from '@shared/resources'
import { api, unwrap } from '@renderer/lib/api'
import { useCluster } from '@renderer/state/cluster'

/** How often lists and metrics refresh while the window is visible. */
export const POLL_INTERVAL = 5_000

export function useContexts() {
  return useQuery({ queryKey: ['contexts'], queryFn: () => api.kube.contexts() })
}

/** The cluster's version; also the connection check. `refetchInterval` keeps checking. */
export function useVersion(context: string, refetchInterval: number | false = false) {
  return useQuery({
    queryKey: ['version', context],
    queryFn: () => unwrap(api.kube.version(context)),
    staleTime: 60_000,
    refetchInterval,
  })
}

interface ListOptions {
  /** `null` means all namespaces; `undefined` uses the namespace picked in the header. */
  namespace?: string | null
  labelSelector?: string
  fieldSelector?: string
  enabled?: boolean
}

/** Big lists are heavier to fetch, so they refresh less often. */
export function listPollInterval(items: number): number {
  if (items > 2_000) return 30_000
  return items > 500 ? 10_000 : POLL_INTERVAL
}

function useListQuery<T>(kind: ResourceKind, options: ListOptions, select: (list: KubeList) => T) {
  const { context, namespace: selected } = useCluster()
  const namespace = (options.namespace === undefined ? selected : options.namespace) ?? undefined
  const { labelSelector, fieldSelector, enabled = true } = options
  return useQuery({
    queryKey: ['list', context, kind, namespace, labelSelector, fieldSelector],
    queryFn: () =>
      unwrap(api.kube.list({ context, kind, namespace, labelSelector, fieldSelector })),
    select,
    refetchInterval: (query) => listPollInterval(query.state.data?.items.length ?? 0),
    placeholderData: keepPreviousData,
    enabled,
  })
}

const selectItems = (list: KubeList) => list.items
const selectTotals = ({ items, truncated, total }: KubeList) => ({
  loaded: items.length,
  truncated,
  total,
})

export function useList(kind: ResourceKind, options: ListOptions = {}) {
  return useListQuery(kind, options, selectItems)
}

const selectAll = (list: KubeList) => list

/** The whole list, with the API server's columns for kinds that get them. */
export function useListResponse(kind: ResourceKind, options: ListOptions) {
  return useListQuery(kind, options, selectAll)
}

/** How complete a list is: loaded items, whether it was capped, and the server-side total. */
export function useListTotals(kind: ResourceKind, options: ListOptions) {
  return useListQuery(kind, options, selectTotals).data
}

export function useObject(kind: ResourceKind, name: string, namespace?: string) {
  const { context } = useCluster()
  return useQuery<KubeObject>({
    queryKey: ['object', context, kind, namespace, name],
    queryFn: () => unwrap(api.kube.get({ context, kind, name, namespace })),
    refetchInterval: POLL_INTERVAL,
  })
}

export function useMetrics(target: 'nodes' | 'pods', namespace?: string | null, enabled = true) {
  const { context } = useCluster()
  const ns = namespace ?? undefined
  return useQuery({
    queryKey: ['metrics', context, target, ns],
    queryFn: () => unwrap(api.kube.metrics({ context, target, namespace: ns })),
    refetchInterval: POLL_INTERVAL,
    placeholderData: keepPreviousData,
    enabled,
  })
}

/** An object's identity within a list: `namespace/name`. */
export function objectKey(object: KubeObject): string {
  return `${object.metadata.namespace ?? ''}/${object.metadata.name}`
}

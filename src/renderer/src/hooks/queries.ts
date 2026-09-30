import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { KubeObject } from '@shared/api'
import type { ResourceKind } from '@shared/resources'
import { api, unwrap } from '@renderer/lib/api'
import { useCluster } from '@renderer/state/cluster'

/** How often lists and metrics refresh while the window is visible. */
export const POLL_INTERVAL = 5_000

export function useContexts() {
  return useQuery({ queryKey: ['contexts'], queryFn: () => api.kube.contexts() })
}

export function useVersion(context: string) {
  return useQuery({
    queryKey: ['version', context],
    queryFn: () => unwrap(api.kube.version(context)),
    staleTime: 60_000,
  })
}

interface ListOptions {
  /** `null` means all namespaces; `undefined` uses the namespace picked in the header. */
  namespace?: string | null
  labelSelector?: string
  fieldSelector?: string
  enabled?: boolean
}

export function useList(kind: ResourceKind, options: ListOptions = {}) {
  const { context, namespace: selected } = useCluster()
  const namespace = (options.namespace === undefined ? selected : options.namespace) ?? undefined
  const { labelSelector, fieldSelector, enabled = true } = options
  return useQuery({
    queryKey: ['list', context, kind, namespace, labelSelector, fieldSelector],
    queryFn: () =>
      unwrap(api.kube.list({ context, kind, namespace, labelSelector, fieldSelector })),
    select: (list) => list.items,
    refetchInterval: POLL_INTERVAL,
    placeholderData: keepPreviousData,
    enabled,
  })
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

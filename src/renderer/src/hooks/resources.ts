import { useQuery } from '@tanstack/react-query'
import {
  builtinResource,
  RESOURCES,
  type ResourceDefinition,
  type ResourceKind,
} from '@shared/resources'
import { api, unwrap } from '@renderer/lib/api'
import { useCluster } from '@renderer/state/cluster'

/** Discovery runs again this often, so newly installed CRDs show up. */
const REDISCOVER_INTERVAL = 60_000

/** Every kind discovery has found, for code outside components (labels, kubectl commands). */
const known = new Map<ResourceKind, ResourceDefinition>(RESOURCES.map((r) => [r.kind, r]))

/** A kind's definition, if it's built in or discovery has found it. */
export function resourceFor(kind: ResourceKind): ResourceDefinition | undefined {
  return known.get(kind)
}

/** "Certificates": a known kind's plural label (actions only exist for kinds that are known). */
export function labelFor(kind: ResourceKind): string {
  return known.get(kind)!.label
}

/** Every kind the current cluster serves that can be listed, built-in kinds included. */
export function useResources() {
  const { context } = useCluster()
  return useQuery({
    queryKey: ['resources', context],
    queryFn: async () => {
      // Looks again each time: a CRD may have been installed or removed since.
      const resources = await unwrap(api.kube.resources(context))
      for (const resource of resources) known.set(resource.kind, resource)
      return resources
    },
    staleTime: REDISCOVER_INTERVAL,
    refetchInterval: REDISCOVER_INTERVAL,
  })
}

/**
 * A kind's definition. Built-in kinds are known at once; others once
 * discovery answers (`pending` until then), or never if the cluster lacks them.
 */
export function useResource(kind: ResourceKind | undefined) {
  const resources = useResources()
  const builtin = kind ? builtinResource(kind) : undefined
  const retry = () => void resources.refetch()
  if (builtin || !kind) return { resource: builtin, pending: false, error: null, retry }
  return {
    resource: resources.data?.find((r) => r.kind === kind),
    pending: resources.isPending,
    error: resources.error,
    retry,
  }
}

/** A kind's schema, to explain its fields; null when the cluster publishes none. */
export function useSchema(kind: ResourceKind) {
  const { context } = useCluster()
  return useQuery({
    queryKey: ['schema', context, kind],
    queryFn: () => unwrap(api.kube.schema(context, kind)),
    // Schemas only change when a CRD is upgraded; a reload picks that up.
    staleTime: Infinity,
  })
}

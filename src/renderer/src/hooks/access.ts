import { useQuery } from '@tanstack/react-query'
import type { AccessCheck } from '@shared/api'
import { api, unwrap } from '@renderer/lib/api'
import { useCluster } from '@renderer/state/cluster'

/**
 * Whether the user may do each of `checks` on the current cluster, asked with
 * SelfSubjectAccessReviews. `undefined` while unknown (or if the cluster can't
 * say): the action stays available and the API server has the final word.
 */
export function useAccess(checks: AccessCheck[]): (boolean | undefined)[] {
  const { context } = useCluster()
  const query = useQuery({
    queryKey: ['access', context, checks],
    queryFn: () => unwrap(api.kube.can(context, checks)),
    staleTime: 5 * 60_000,
    enabled: checks.length > 0,
    retry: false,
  })
  return checks.map((_, i) => query.data?.[i])
}

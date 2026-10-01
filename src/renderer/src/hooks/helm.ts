import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Result } from '@shared/api'
import { api, unwrap } from '@renderer/lib/api'
import { useActivity } from '@renderer/state/activity'
import { useCluster } from '@renderer/state/cluster'
import { toast } from '@renderer/state/toasts'

/** Releases change less often than pods, and reading them decodes Helm's records. */
const RELEASES_INTERVAL = 15_000

/** The current cluster's releases, in the namespace picked in the header. */
export function useHelmReleases() {
  const { context, namespace } = useCluster()
  return useQuery({
    queryKey: ['helm', context, 'releases', namespace],
    queryFn: () => unwrap(api.helm.releases(context, namespace ?? undefined)),
    refetchInterval: RELEASES_INTERVAL,
    placeholderData: keepPreviousData,
  })
}

/** A release with its history. */
export function useHelmRelease(namespace: string, name: string) {
  const { context } = useCluster()
  return useQuery({
    queryKey: ['helm', context, 'release', namespace, name],
    queryFn: () => unwrap(api.helm.release(context, namespace, name)),
    refetchInterval: RELEASES_INTERVAL,
  })
}

/** The helm that makes changes: whether there is one, and which. */
export function useHelmCli() {
  return useQuery({ queryKey: ['helm-cli'], queryFn: () => api.helm.cli(), staleTime: Infinity })
}

/**
 * Runs a helm change: logs it in the activity log with its command, says how
 * it went, and refreshes releases and the objects they made.
 */
export function useHelmChange() {
  const { context } = useCluster()
  const queryClient = useQueryClient()
  const { start, finish } = useActivity()
  return async <T>(
    run: () => Promise<Result<T>>,
    meta: { title: string; command: string },
  ): Promise<Result<T>> => {
    const id = start({ context, title: meta.title, command: meta.command })
    const result = await run()
    if (!result.ok) {
      finish(id, 'failed', result.error.message)
      return result
    }
    finish(id, 'done')
    for (const key of ['helm', 'list', 'object']) {
      void queryClient.invalidateQueries({ queryKey: [key, context] })
    }
    toast({ tone: 'success', title: meta.title })
    return result
  }
}

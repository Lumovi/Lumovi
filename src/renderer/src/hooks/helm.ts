import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import type { HelmRelease, Result } from '@shared/api'
import { api, unwrap } from '@renderer/lib/api'
import { useActivity } from '@renderer/state/activity'
import {
  AT_ONCE,
  namespacesParam,
  settledAtMost,
  whyUnread,
  type Unread,
} from '@renderer/lib/namespaces'
import { useCluster } from '@renderer/state/cluster'
import { toast } from '@renderer/state/toasts'

/** Releases change less often than pods, and reading them decodes Helm's records. */
const RELEASES_INTERVAL = 15_000

/**
 * The current cluster's releases, in the namespaces picked in the header: several are read as
 * lists are, each on its own, AT_ONCE at a time, and those that can't be read said (`unread`).
 */
export function useHelmReleases() {
  const { context, namespaces } = useCluster()
  const releasesIn = (namespace?: string) => unwrap(api.helm.releases(context, namespace))
  return useQuery({
    queryKey: ['helm', context, 'releases', namespaces ? namespacesParam(namespaces) : null],
    queryFn: async (): Promise<HelmRelease[] & { unread?: readonly Unread[] }> => {
      if (!namespaces || namespaces.length < 2) return releasesIn(namespaces?.[0])
      const settled = await settledAtMost(namespaces, AT_ONCE, releasesIn)
      const read = settled.flatMap((each) => (each.status === 'fulfilled' ? [each.value] : []))
      if (read.length === 0) throw (settled[0] as PromiseRejectedResult).reason
      const unread = settled.flatMap((each, i) =>
        each.status === 'rejected'
          ? [{ namespace: namespaces[i]!, why: whyUnread(each.reason) }]
          : [],
      )
      return Object.assign(read.flat(), unread.length ? { unread } : {})
    },
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

/**
 * Every namespace of every cluster, with its labels, for the AI permissions
 * page: what rules match, counted, and found by name. Each cluster's is
 * listed as the person may; one that can't be listed is left out, and said.
 */
import { useQueries, type UseQueryResult } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import type { KubeContext, KubeList, Result } from '@shared/api'
import { api } from '@renderer/lib/api'

export interface IndexedNamespace {
  /** cluster/name: unique among them all. */
  key: string
  cluster: KubeContext
  name: string
  labels: Record<string, string>
}

export interface NamespaceIndex {
  namespaces: IndexedNamespace[]
  /** Clusters whose namespaces are still being listed. */
  counting: string[]
  /** Clusters whose namespaces can't be listed, and why. */
  failed: { context: string; message: string }[]
  /**
   * Clusters not counted yet: each signs in through a program and hasn't since Lumovi started.
   * Listed, it would start that program (a browser, a prompt), so only once asked (`countAll`).
   */
  waiting: string[]
  /** Lists those too, signing in to them as it does. */
  countAll: () => void
}

/** A cluster whose namespaces are listed only once asked: see `NamespaceIndex.waiting`. */
const waits = (cluster: KubeContext) => Boolean(cluster.signsInWith && !cluster.signedIn)

export function useNamespaceIndex(contexts: KubeContext[] | undefined): NamespaceIndex {
  const [all, setAll] = useState(false)
  const countAll = useCallback(() => setAll(true), [])
  // Built again only when a list changes, not as the page does.
  const combine = useCallback(
    (lists: UseQueryResult<Result<KubeList>>[]) => {
      const index: NamespaceIndex = {
        namespaces: [],
        counting: [],
        failed: [],
        waiting: [],
        countAll,
      }
      ;(contexts ?? []).forEach((cluster, i) => {
        const result = lists[i]!.data
        if (!all && waits(cluster)) index.waiting.push(cluster.name)
        else if (!result) index.counting.push(cluster.name)
        else if (!result.ok) {
          index.failed.push({ context: cluster.name, message: result.error.message })
        } else {
          for (const ns of result.data.items) {
            index.namespaces.push({
              key: `${cluster.name}/${ns.metadata.name}`,
              cluster,
              name: ns.metadata.name,
              labels: ns.metadata.labels ?? {},
            })
          }
        }
      })
      return index
    },
    [contexts, all, countAll],
  )
  return useQueries({
    queries: (contexts ?? []).map((context) => ({
      queryKey: ['ai-namespaces', context.name],
      queryFn: () => api.kube.list({ context: context.name, kind: 'Namespace' }),
      staleTime: 60_000,
      enabled: all || !waits(context),
    })),
    combine,
  })
}

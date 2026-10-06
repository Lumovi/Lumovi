/**
 * Every namespace of every cluster, with its labels, for the AI permissions
 * page: what rules match, counted, and found by name. Each cluster's is
 * listed as the person may; one that can't be listed is left out, and said.
 */
import { useQueries, type UseQueryResult } from '@tanstack/react-query'
import { useCallback } from 'react'
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
}

export function useNamespaceIndex(contexts: KubeContext[] | undefined): NamespaceIndex {
  // Built again only when a list changes, not as the page does.
  const combine = useCallback(
    (lists: UseQueryResult<Result<KubeList>>[]) => {
      const index: NamespaceIndex = { namespaces: [], counting: [], failed: [] }
      ;(contexts ?? []).forEach((cluster, i) => {
        const result = lists[i]!.data
        if (!result) index.counting.push(cluster.name)
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
    [contexts],
  )
  return useQueries({
    queries: (contexts ?? []).map((context) => ({
      queryKey: ['ai-namespaces', context.name],
      queryFn: () => api.kube.list({ context: context.name, kind: 'Namespace' }),
      staleTime: 60_000,
    })),
    combine,
  })
}

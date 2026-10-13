import { useMemo } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import type { KubeObject } from '@shared/api'
import { indexManagers, type Managers } from '@renderer/lib/managers'
import { managingKinds } from '@renderer/lib/plugins'
import { usePlugins } from './plugins'
import { useCombinedLists } from './queries'
import { useResources } from './resources'

/** Each list's objects; `refused` where it couldn't be read. (Stable: see `useCombinedLists`.) */
const read = (results: UseQueryResult<KubeObject[]>[]) =>
  results.map((result) => (result.isError ? ('refused' as const) : result.data))

/**
 * What manages the objects in view (a workload Flux or Argo CD applied): the kinds plugins say
 * manage others, where the cluster serves them, each listed in the whole cluster as the person may
 * (managers are seldom in the namespace of what they manage), or, where they may not, in the
 * namespaces in view. Nothing where no plugin says so or no such kind is served, and then no list
 * is read; nothing (and no error) of a kind that can't be read at all.
 */
export function useManagers(enabled = true): Managers | undefined {
  const plugins = usePlugins().data
  const resources = useResources().data
  const served = useMemo(
    () =>
      enabled && plugins && resources
        ? managingKinds().filter(({ kind }) => resources.some((r) => r.kind === kind))
        : [],
    [enabled, plugins, resources],
  )
  const everywhere = useCombinedLists(
    served.map(({ kind }) => ({ kind, namespace: null })),
    read,
  )
  const refused = useMemo(
    () => served.filter((_, i) => everywhere[i] === 'refused'),
    [served, everywhere],
  )
  const near = useCombinedLists(
    refused.map(({ kind }) => ({ kind })),
    read,
  )
  return useMemo(() => {
    if (served.length === 0) return undefined
    const lists = served.flatMap(({ kind, view }, i) => {
      const listed =
        everywhere[i] === 'refused'
          ? near[refused.findIndex((r) => r.kind === kind)]
          : everywhere[i]
      return Array.isArray(listed) ? [{ kind, view, items: listed }] : []
    })
    return indexManagers(lists)
  }, [served, everywhere, refused, near])
}

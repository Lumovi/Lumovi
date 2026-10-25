import { useMemo } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { COUNTED_KINDS, indexFindings, type Findings } from '@renderer/lib/findings'
import { listedLinks } from '@renderer/lib/plugins'
import type { PickedList } from '@renderer/lib/namespaces'
import type { Listed } from '@renderer/lib/pointing'
import { usePlugins } from './plugins'
import { useCombinedListResponses, useList } from './queries'
import { useResources } from './resources'
import { useCluster } from '@renderer/state/cluster'

/** Each list; `refused` where it couldn't be read. (Stable: see `useCombinedListResponses`.) */
const read = (results: UseQueryResult<PickedList>[]) =>
  results.map((result) => (result.isError ? ('refused' as const) : result.data))

/**
 * The labels a counting link's objects are listed by: its name's label there at all, and its
 * kind's a workload's; nothing, for a link that names another kind.
 */
function selectorOf({ labels }: Listed): string | undefined {
  if ('written' in labels.kind) {
    return COUNTED_KINDS.includes(labels.kind.written) ? labels.name : undefined
  }
  return `${labels.name},${labels.kind.label} in (${COUNTED_KINDS.join(',')})`
}

/**
 * What plugins' objects say of the workloads in view (see lib/findings): the kinds of links that
 * `count`, where the cluster serves them, each listed by its labels in the whole cluster as the
 * person may, or, where they may not, in the namespaces in view; and the ReplicaSets in view, for
 * what's said of a Deployment's. Nothing where no plugin's link counts, and then nothing is read;
 * nothing (and no error) of a kind that can't be read at all.
 */
export function useFindings(enabled = true): Findings | undefined {
  const plugins = usePlugins().data
  const resources = useResources().data
  const counted = useMemo(
    () =>
      enabled && plugins && resources
        ? listedLinks().flatMap((listed) => {
            const labelSelector = selectorOf(listed)
            return listed.link.counts &&
              labelSelector &&
              resources.some((r) => r.kind === listed.kind)
              ? [{ listed, labelSelector }]
              : []
          })
        : [],
    [enabled, plugins, resources],
  )
  const everywhere = useCombinedListResponses(
    counted.map(({ listed, labelSelector }) => ({
      kind: listed.kind,
      namespace: null,
      labelSelector,
    })),
    read,
  )
  // In the namespaces in view, where some are picked: with all of them in view, that's the read
  // in the whole cluster again (the same query), and refused there is refused.
  const picked = Boolean(useCluster().namespaces?.length)
  const refused = useMemo(
    () => (picked ? counted.filter((_, i) => everywhere[i] === 'refused') : []),
    [picked, counted, everywhere],
  )
  const near = useCombinedListResponses(
    refused.map(({ listed, labelSelector }) => ({ kind: listed.kind, labelSelector })),
    read,
  )
  const replicaSets = useList('ReplicaSet', { enabled: counted.length > 0 }).data
  return useMemo(() => {
    if (counted.length === 0) return undefined
    const unread: { kind: Listed['kind']; view: Listed['view'] }[] = []
    const lists = counted.flatMap(({ listed }, i) => {
      const list =
        everywhere[i] === 'refused' && picked
          ? near[refused.findIndex((r) => r.listed === listed)]
          : everywhere[i]
      // Not read whole: refused even in view, some namespaces not read, or past the list limit.
      // (One still being read is neither.)
      if (list === 'refused' || (list && (list.truncated || list.unread?.length))) {
        unread.push({ kind: listed.kind, view: listed.view })
      }
      return list && list !== 'refused' ? [{ listed, items: list.items }] : []
    })
    return indexFindings(lists, replicaSets ?? [], unread)
  }, [counted, everywhere, picked, refused, near, replicaSets])
}

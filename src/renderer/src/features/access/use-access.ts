/**
 * A server's access, as its pages see it: the person's own (what decides it,
 * and nothing about anyone else's), decided here with the same code the
 * server decides with, so what the page offers is what the server allows.
 * The desktop app has none: its person may do all their kubeconfig allows.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import {
  allows,
  myDecider,
  reasonOf,
  SCOPES,
  usesLabels,
  type Capability,
  type Levels,
  type MyAccess,
} from '@shared/access'
import type { KubeContext } from '@shared/api'
import { useContexts, useList } from '@renderer/hooks/queries'
import { api } from '@renderer/lib/api'
import { useCluster } from '@renderer/state/cluster'

/** The person's own access: undefined in the desktop app, and until it's read. */
export function useMyAccess(): MyAccess | undefined {
  return useQuery({
    queryKey: ['access', 'mine'],
    queryFn: () => api.access!.mine(),
    enabled: Boolean(api.access),
    staleTime: Infinity,
  }).data
}

const NONE: KubeContext[] = []

/** The server's clusters: none until they're read. */
export const useClusters = () => useContexts().data?.contexts ?? NONE

/** Whether the person is one of Lumovi's admins: they see the Admin pages. */
export const useIsAdmin = () => useMyAccess()?.admin === true

/**
 * Keeps what pages show of access fresh: an admin changed it (here, or on another server's
 * page). Whose audit events someone reads can change with it.
 */
export function AccessUpdates() {
  const client = useQueryClient()
  useEffect(
    () =>
      api.access?.onChanged(() => {
        void client.invalidateQueries({ queryKey: ['access'] })
        void client.invalidateQueries({ queryKey: ['audit'] })
      }),
    [client],
  )
  return null
}

/** What the person may do in the cluster shown: somewhere, and why not where they may not. */
export interface AccessHere {
  /**
   * Why not, said whole ("Your access doesn’t let you open shells in shop: …"), or undefined
   * where they may (or it isn't known yet: the server decides then).
   */
  whyNot<K extends Capability>(
    cap: K,
    level: Levels[K],
    namespace?: string,
    doing?: string,
  ): string | undefined
}

const ALLOWED: AccessHere = { whyNot: () => undefined }

/** "make changes", "open shells": what a capability is, as a refusal says it. */
const DOING: Record<Capability, string> = {
  changes: 'make changes',
  shells: 'open shells',
  nodeShells: 'open shells on nodes',
  logs: 'read logs',
  secrets: 'see Secrets',
  helm: 'use Helm',
  assistants: 'use AI assistants',
  audit: 'read everyone’s audit events',
}

export function useAccessHere(): AccessHere {
  const mine = useMyAccess()
  const { context } = useCluster()
  const cluster = useContexts().data?.contexts.find((c) => c.name === context)
  const labelled = mine ? usesLabels(mine.policy) : false
  const namespaces = useList('Namespace', { namespace: null, enabled: labelled })
  return useMemo(() => {
    if (!mine) return ALLOWED
    const decide = myDecider(mine)
    const listed = namespaces.data
    // Labels not read yet (or they can't be): the server decides meanwhile.
    if (labelled && !listed) return ALLOWED
    const labels = new Map(listed?.map((ns) => [ns.metadata.name, ns.metadata.labels]))
    const decideAt = (namespace?: string) =>
      decide({
        cluster: { name: context, labels: cluster?.labels },
        ...(namespace === undefined
          ? {}
          : { namespace: { name: namespace, labels: { ...labels.get(namespace) } } }),
      })
    return {
      whyNot: (cap, level, namespace, doing) => {
        const where = SCOPES[cap] === 'namespace' ? namespace : undefined
        const decision = decideAt(where)
        if (allows(decision, cap, level)) return undefined
        const place = where === undefined ? `on ${context}` : `in ${where}`
        const what = doing ?? DOING[cap]
        return `Your access doesn’t let you ${what} ${place}: ${reasonOf(decision[cap].from)}.`
      },
    }
  }, [mine, context, cluster?.labels, labelled, namespaces.data])
}

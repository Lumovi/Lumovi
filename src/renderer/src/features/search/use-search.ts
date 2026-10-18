/**
 * What Search reads (LMV-171): each kind the person may list, once, when Search opens or the
 * namespaces picked change, and again on Refresh; typing matches against what's read and reads
 * nothing more. A few kinds at a time, each given up on after 10 seconds; at most as many of a
 * kind as a list reads. A kind cut short is asked again by the labels typed, so a label reaches
 * all of it. The page and the palette share what's read.
 */
import { useQueries, useQueryClient, type QueryFunctionContext } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { SearchItem, SearchList } from '@shared/api'
import type { ResourceDefinition } from '@shared/resources'
import { RESOURCES } from '@shared/resources'
import { useResources } from '@renderer/hooks/resources'
import { api, KubeApiError, unwrap } from '@renderer/lib/api'
import { useCluster } from '@renderer/state/cluster'
import { matching, type Terms } from './terms'

/** How many kinds are read at once. */
const AT_ONCE = 4
/** How long a kind has to answer. */
export const ANSWER_WITHIN_MS = 10_000

/** A kind's state, as Search shows it. */
export interface KindSearch {
  resource: ResourceDefinition
  state: 'waiting' | 'done' | 'denied' | 'late' | 'failed' | 'stopped'
  /** What matches, best first. */
  found: SearchItem[]
  /** Of the kind's objects, how many were read, and whether there were more. */
  read: number
  truncated: boolean
  total?: number
  /** Searched by the labels typed, not just what was read by name (it was cut short). */
  byLabel: boolean
  retry: () => void
}

let running = 0
const queue: (() => void)[] = []

/** Waits its turn: a few reads at a time. Let go of if it's stopped while it waits. */
async function turn<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  if (running >= AT_ONCE) {
    await new Promise<void>((go, stop) => {
      const next = () => {
        signal.removeEventListener('abort', stopped)
        go()
      }
      const stopped = () => {
        queue.splice(queue.indexOf(next), 1)
        stop(new KubeApiError({ code: 'timeout', message: 'Stopped.' }))
      }
      queue.push(next)
      signal.addEventListener('abort', stopped, { once: true })
    })
  }
  running++
  try {
    return await read()
  } finally {
    running--
    queue.shift()?.()
  }
}

/** A read, or a timeout once `ms` have gone by without its answer. */
function within<T>(ms: number, read: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new KubeApiError({ code: 'timeout', message: 'It didn’t answer in time.' })),
      ms,
    )
    read.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error as Error)
      },
    )
  })
}

/** A kind's objects in the namespaces picked (or all), read once each. */
async function readKind(
  context: string,
  resource: ResourceDefinition,
  namespaces: readonly string[] | null,
  labelSelector: string | undefined,
  { signal }: QueryFunctionContext,
): Promise<SearchList> {
  const where = resource.namespaced && namespaces ? namespaces : [undefined]
  const lists = await Promise.all(
    where.map((namespace) =>
      turn(signal, () =>
        within(
          ANSWER_WITHIN_MS,
          unwrap(
            api.kube.search({
              context,
              kind: resource.kind,
              ...(namespace ? { namespace } : {}),
              ...(labelSelector ? { labelSelector } : {}),
            }),
          ),
        ),
      ),
    ),
  )
  return {
    items: lists.flatMap((list) => list.items),
    truncated: lists.some((list) => list.truncated),
    ...(lists.every((list) => list.total !== undefined)
      ? { total: lists.reduce((sum, list) => sum + list.total!, 0) }
      : {}),
  }
}

/**
 * Kinds in the sidebar's order: Workloads' kinds, then Pods, then its sections; then the cluster's
 * own by name.
 */
const SECTIONS = ['workloads', 'pods', 'cluster', 'network', 'config', 'storage', 'access']
const ORDER = new Map<string, number>(
  RESOURCES.map((resource, i) => [
    resource.kind,
    SECTIONS.indexOf(resource.kind === 'Pod' ? 'pods' : resource.category) * 100 + i,
  ]),
)
/** What happened to objects, not things: found on the Events page and an object's Events. */
const NOT_SEARCHED = new Set(['Event'])
const inOrder = (a: ResourceDefinition, b: ResourceDefinition) =>
  (ORDER.get(a.kind) ?? Infinity) - (ORDER.get(b.kind) ?? Infinity) ||
  a.label.localeCompare(b.label)

/**
 * Search's kinds and what of each matches `terms` (none until it's on): the kinds the person may
 * list among those the cluster serves, in the namespaces picked. Kinds outside namespaces only
 * with all of them.
 */
export function useClusterSearch(terms: Terms, on: boolean) {
  const { context, namespaces } = useCluster()
  const queryClient = useQueryClient()
  const resources = useResources()
  const kinds = useMemo(
    () =>
      (resources.data ?? [])
        .filter(
          (resource) =>
            !NOT_SEARCHED.has(resource.kind) && (resource.namespaced || namespaces === null),
        )
        .sort(inOrder),
    [resources.data, namespaces],
  )
  const where = namespaces === null ? '*' : namespaces.join(',')
  const key = (resource: ResourceDefinition, selector?: string) =>
    ['search', context, where, resource.kind, ...(selector ? [selector] : [])] as const
  const options = (resource: ResourceDefinition, selector?: string, enabled = on) => ({
    queryKey: key(resource, selector),
    queryFn: (query: QueryFunctionContext) =>
      readKind(context, resource, namespaces, selector, query),
    enabled,
    // Read once while it's shown; again on Refresh, or when the namespaces change.
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  })
  const reads = useQueries({ queries: kinds.map((resource) => options(resource)) })
  // A kind cut short, read again by the labels typed.
  const cut = kinds.filter((_, i) => terms.selector && reads[i]?.data?.truncated)
  const byLabels = useQueries({
    queries: cut.map((resource) => options(resource, terms.selector)),
  })
  const results: KindSearch[] = kinds.map((resource, i) => {
    const read = reads[i]!
    const again = cut.indexOf(resource)
    const labelled = again >= 0 ? byLabels[again]! : undefined
    const answer = labelled?.data ?? read.data
    const error = (labelled?.error ?? read.error) as KubeApiError | null
    // (Read again, on Refresh: searching, what was read still shown meanwhile.)
    const state: KindSearch['state'] =
      (labelled ?? read).fetchStatus === 'fetching'
        ? 'waiting'
        : answer
          ? 'done'
          : error
            ? error.code === 'forbidden'
              ? 'denied'
              : error.code === 'timeout'
                ? 'late'
                : 'failed'
            : on && (labelled ?? read).fetchStatus === 'idle'
              ? 'stopped'
              : 'waiting'
    return {
      resource,
      state,
      found: answer ? matching(answer.items, terms) : [],
      read: answer?.items.length ?? 0,
      truncated: answer?.truncated ?? false,
      ...(answer?.total !== undefined ? { total: answer.total } : {}),
      byLabel: labelled?.data !== undefined,
      retry: () => void (labelled?.error ? labelled : read).refetch(),
    }
  })
  // When what's shown was read: the oldest kind's read.
  const readAt = Math.min(
    ...reads.filter((read) => read.dataUpdatedAt > 0).map((read) => read.dataUpdatedAt),
  )
  return {
    kinds: results,
    /** When the oldest of what's shown was read (Infinity before any is). */
    readAt,
    /** Reads every kind again, as Refresh does. */
    refresh: () => void queryClient.invalidateQueries({ queryKey: ['search', context] }),
    /** Discovery hasn't said which kinds there are yet. */
    discovering: resources.isPending,
    /** Lets go of every kind not yet read. */
    stop: () => void queryClient.cancelQueries({ queryKey: ['search', context] }),
  }
}

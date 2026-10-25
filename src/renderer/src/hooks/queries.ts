import { keepPreviousData, useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { KubeList, KubeObject } from '@shared/api'
import type { ResourceDefinition, ResourceKind } from '@shared/resources'
import { api, KubeApiError, unwrap } from '@renderer/lib/api'
import { AT_ONCE, settledAtMost, whyUnread, type PickedList } from '@renderer/lib/namespaces'
import { useCluster } from '@renderer/state/cluster'
import { watched, WATCHED_POLL_MS } from '@renderer/lib/watches'

/** How often lists and metrics refresh while the window is visible. */
export const POLL_INTERVAL = 5_000

export function useContexts() {
  return useQuery({ queryKey: ['contexts'], queryFn: () => api.kube.contexts() })
}

/**
 * The cluster's version; also the connection check. `refetchInterval` keeps checking. Not
 * `enabled`, nothing's asked (a cluster that signs in through a program, where a list of them is
 * shown: asked, it would start that program, a browser or a prompt, for clusters nobody picked).
 */
export function useVersion(
  context: string,
  refetchInterval: number | false = false,
  enabled = true,
) {
  return useQuery({
    queryKey: ['version', context],
    queryFn: () => unwrap(api.kube.version(context)),
    staleTime: 60_000,
    refetchInterval,
    enabled,
  })
}

interface ListOptions {
  /** `null` means all namespaces; `undefined` uses the namespaces picked in the header. */
  namespace?: string | null
  labelSelector?: string
  fieldSelector?: string
  enabled?: boolean
}

/**
 * Big lists are heavier to fetch, so they refresh less often. (A list watched is read again as
 * it changes, and on this timer only now and then: `lib/watches`.)
 */
export function listPollInterval(items: number): number {
  if (items > 2_000) return 30_000
  return items > 500 ? 10_000 : POLL_INTERVAL
}

/**
 * Several namespaces' lists of one kind, as one: their objects one after another, and the API
 * server's columns, which are the kind's whatever the namespace.
 */
export function joinLists(lists: KubeList[]): KubeList {
  const tables = lists.map((list) => list.table)
  const totals = lists.map((list) => list.total)
  return {
    items: lists.flatMap((list) => list.items),
    truncated: lists.some((list) => list.truncated),
    ...(totals.every((total) => total !== undefined)
      ? { total: totals.reduce((sum, total) => sum! + total!, 0) }
      : {}),
    ...(tables.every((table) => table !== undefined) && tables.length > 0
      ? {
          table: {
            columns: tables[0]!.columns,
            cells: tables.flatMap((table) => table!.cells),
          },
        }
      : {}),
    ...(lists.some((list) => list.certificates)
      ? { certificates: Object.assign({}, ...lists.map((list) => list.certificates ?? {})) }
      : {}),
  }
}

/** A list's query, for useQuery or useQueries. */
function listQuery<T>(
  context: string,
  selected: readonly string[] | null,
  kind: ResourceKind,
  options: ListOptions,
  select: (list: PickedList) => T,
) {
  const namespaces =
    options.namespace === undefined
      ? selected
      : options.namespace === null
        ? null
        : [options.namespace]
  const { labelSelector, fieldSelector, enabled = true } = options
  // (One namespace's key is its name, as it always was; several are named together, sorted.)
  const key = namespaces?.length ? [...namespaces].sort().join(',') : undefined
  const listIn = (namespace?: string) =>
    unwrap(api.kube.list({ context, kind, namespace, labelSelector, fieldSelector }))
  return {
    queryKey: ['list', context, kind, key, labelSelector, fieldSelector],
    // Several namespaces are each read on their own, as anyone may whose access is to each of
    // them: at most AT_ONCE at a time, the rest after. One that can't be read is left out and
    // said (`unread`); only when none can is the list an error.
    queryFn: async (): Promise<PickedList> => {
      if (!namespaces || namespaces.length < 2) return listIn(namespaces?.[0])
      const settled = await settledAtMost(namespaces, AT_ONCE, listIn)
      const read = settled.flatMap((each) => (each.status === 'fulfilled' ? [each.value] : []))
      if (read.length === 0) throw (settled[0] as PromiseRejectedResult).reason
      const unread = settled.flatMap((each, i) =>
        each.status === 'rejected'
          ? [{ namespace: namespaces[i]!, why: whyUnread(each.reason) }]
          : [],
      )
      return { ...joinLists(read), ...(unread.length ? { unread } : {}) }
    },
    select,
    // (One whose last read failed is read again as often as it was: it's back as soon as it can.)
    refetchInterval: (query: { queryHash: string; state: { data?: KubeList; status: string } }) =>
      watched(query.queryHash) && query.state.status !== 'error'
        ? WATCHED_POLL_MS
        : listPollInterval(query.state.data?.items.length ?? 0),
    placeholderData: keepPreviousData,
    enabled,
  }
}

/**
 * One kind's whole list in each of `contexts`, each read on its own with that cluster's access,
 * so one slow, refused or unreachable cluster never holds the others. `namespaces` as a cluster's
 * picker has them. Each is keyed as that cluster's own list is, so it's watched as that list is.
 * `reads(context)`: whether a cluster is read at all (one that signs in, unopened, isn't).
 */
export function useListsAcross(
  contexts: readonly string[],
  namespaces: readonly string[] | null,
  kind: ResourceKind,
  options: ListOptions = {},
  reads: (context: string) => boolean = () => true,
  /** How long a cluster has to answer a read before it's given up on: then it's late. */
  answerWithinMs?: number,
) {
  return useQueries({
    queries: contexts.map((context) => {
      const query = listQuery(
        context,
        namespaces,
        kind,
        { ...options, enabled: (options.enabled ?? true) && reads(context) },
        (list: PickedList) => list,
      )
      return answerWithinMs === undefined
        ? query
        : { ...query, queryFn: () => within(answerWithinMs, query.queryFn), retry: false }
    }),
  })
}

/** `read`, or a timeout once `ms` have gone by without its answer. */
function within<T>(ms: number, read: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new KubeApiError({ code: 'timeout', message: 'It didn’t answer in time.' })),
      ms,
    )
    read().then(
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

function useListQuery<T>(
  kind: ResourceKind,
  options: ListOptions,
  select: (list: PickedList) => T,
) {
  const { context, namespaces } = useCluster()
  return useQuery(listQuery(context, namespaces, kind, options, select))
}

const selectItems = (list: KubeList) => list.items
const selectTotals = ({ items, truncated, total }: KubeList) => ({
  loaded: items.length,
  truncated,
  total,
})

export function useList(kind: ResourceKind, options: ListOptions = {}) {
  return useListQuery(kind, options, selectItems)
}

const selectAll = (list: PickedList) => list

/** The whole list, with the API server's columns for kinds that get them. */
export function useListResponse(kind: ResourceKind, options: ListOptions) {
  return useListQuery(kind, options, selectAll)
}

/**
 * The whole lists of several kinds, as `useListResponse` reads each: in the
 * namespaces picked, or the whole cluster for kinds without namespaces.
 */
export function useListResponses(resources: ResourceDefinition[], labelSelector?: string) {
  const { context, namespaces } = useCluster()
  return useQueries({
    queries: resources.map((resource) =>
      listQuery(
        context,
        namespaces,
        resource.kind,
        { namespace: resource.namespaced ? undefined : null, labelSelector },
        selectAll,
      ),
    ),
  })
}

/** Several lists at once, each as `useList` reads it. */
export function useLists(lists: ({ kind: ResourceKind } & ListOptions)[]) {
  const { context, namespaces } = useCluster()
  return useQueries({
    queries: lists.map(({ kind, ...options }) =>
      listQuery(context, namespaces, kind, options, selectItems),
    ),
  })
}

/**
 * Several lists at once, each as `useList` reads it, made one value by `combine`: a stable one,
 * for a value that's new only when one of them is.
 */
export function useCombinedLists<T>(
  lists: ({ kind: ResourceKind } & ListOptions)[],
  combine: (results: UseQueryResult<KubeObject[]>[]) => T,
): T {
  const { context, namespaces } = useCluster()
  return useQueries({
    queries: lists.map(({ kind, ...options }) =>
      listQuery(context, namespaces, kind, options, selectItems),
    ),
    combine,
  })
}

/** How complete a list is: loaded items, whether it was capped, and the server-side total. */
export function useListTotals(kind: ResourceKind, options: ListOptions) {
  return useListQuery(kind, options, selectTotals).data
}

export function useObject(kind: ResourceKind, name: string, namespace?: string, enabled = true) {
  const { context } = useCluster()
  return useQuery<KubeObject>({
    queryKey: ['object', context, kind, namespace, name],
    queryFn: () => unwrap(api.kube.get({ context, kind, name, namespace })),
    enabled,
    refetchInterval: (query) =>
      watched(query.queryHash) && query.state.status !== 'error' ? WATCHED_POLL_MS : POLL_INTERVAL,
  })
}

/**
 * Live usage of nodes, or of pods: in `namespace`, in each of several namespaces (one at a time,
 * as a list of them is read), or everywhere (`null`, or nothing).
 */
export function useMetrics(
  target: 'nodes' | 'pods',
  namespace?: string | readonly string[] | null,
  enabled = true,
) {
  const { context } = useCluster()
  const namespaces = typeof namespace === 'string' ? [namespace] : (namespace ?? [])
  const key = namespaces.length ? [...namespaces].sort().join(',') : undefined
  const usageIn = (ns?: string) => unwrap(api.kube.metrics({ context, target, namespace: ns }))
  return useQuery({
    queryKey: ['metrics', context, target, key],
    // (As lists are: each on its own, AT_ONCE at a time; one that can't be read adds nothing.)
    queryFn: async () => {
      if (namespaces.length < 2) return usageIn(namespaces[0])
      const settled = await settledAtMost(namespaces, AT_ONCE, usageIn)
      const read = settled.flatMap((each) => (each.status === 'fulfilled' ? [each.value] : []))
      if (read.length === 0) throw (settled[0] as PromiseRejectedResult).reason
      return {
        available: read.every((snapshot) => snapshot.available),
        items: read.flatMap((snapshot) => snapshot.items),
      }
    },
    refetchInterval: POLL_INTERVAL,
    placeholderData: keepPreviousData,
    enabled,
  })
}

/** An object's identity within a list: `namespace/name`. */
export function objectKey(object: KubeObject): string {
  return `${object.metadata.namespace ?? ''}/${object.metadata.name}`
}

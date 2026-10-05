import { useQueries, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import type { InstantResult, KubeObject } from '@shared/api'
import { useHistorySource } from '@renderer/hooks/history'
import { useList } from '@renderer/hooks/queries'
import { useResource } from '@renderer/hooks/resources'
import { api, KubeApiError, unwrap } from '@renderer/lib/api'
import { allocatable } from '@renderer/lib/usage'
import {
  adviseWorkload,
  batchNamespaces,
  keyOf,
  measure,
  podOwners,
  RIGHTSIZING_RESULTS,
  rightsizingQueries,
  type ContainerUsage,
  type WorkloadAdvice,
} from '@renderer/lib/rightsizing'
import { useCluster } from '@renderer/state/cluster'

const VPA = 'VerticalPodAutoscaler.autoscaling.k8s.io'

/** The namespaces workloads are in, in order. */
const namespacesOf = (workloads: KubeObject[] | undefined) =>
  [...new Set(workloads?.map((w) => w.metadata.namespace!))].sort()
/** A week of history changes slowly: asked again every quarter hour. */
const REFRESH = 15 * 60_000
/** Batches asked about at once: each is eight queries over a week. */
const CONCURRENCY = 2

export interface Advised {
  key: string
  workload: KubeObject
  advice: WorkloadAdvice
}

interface Batch {
  time: number
  results: InstantResult['results']
  /** Namespaces asked about apart (the batch was too big) that Prometheus didn't answer for. */
  failed: { namespaces: string[]; error: Error }[]
}

let running = 0
const waiting: (() => void)[] = []

/** Runs `task` once fewer than CONCURRENCY others are running. */
async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve))
  running += 1
  try {
    return await task()
  } finally {
    running -= 1
    waiting.shift()?.()
  }
}

/**
 * Whether Prometheus (or VictoriaMetrics) refused a query for what it would
 * load or how long it would take, which fewer namespaces at once may not.
 */
const tooBig = (error: unknown) =>
  error instanceof KubeApiError &&
  (error.code === 'timeout' ||
    /too many|timed out|deadline exceeded|maxSamplesPerQuery|maxUniqueTimeseries|exceeds?\b/i.test(
      error.message,
    ))

/**
 * A batch's usage at `time`. One too big for Prometheus is asked about in
 * halves, and so on, and what fails then fails for its own namespaces; a
 * batch that fails as a whole (`whole`) fails.
 */
async function measureBatch(
  context: string,
  namespaces: string[],
  time: number,
  whole = true,
): Promise<Omit<Batch, 'time'>> {
  try {
    const queries = rightsizingQueries(namespaces)
    return {
      results: (await unwrap(api.usage.instant({ context, queries, time }))).results,
      failed: [],
    }
  } catch (error) {
    if (namespaces.length > 1 && tooBig(error)) {
      const half = Math.ceil(namespaces.length / 2)
      const parts = await Promise.all([
        measureBatch(context, namespaces.slice(0, half), time, false),
        measureBatch(context, namespaces.slice(half), time, false),
      ])
      return {
        results: RIGHTSIZING_RESULTS.map((id) => ({
          id,
          series: parts.flatMap((part) => part.results.find((r) => r.id === id)?.series ?? []),
        })),
        failed: parts.flatMap((part) => part.failed),
      }
    }
    if (whole) throw error
    return { results: [], failed: [{ namespaces, error: error as Error }] }
  }
}

/**
 * The namespaces to measure, in batches: planned when the namespaces are
 * known (by the pods there are then), and again only when they change, not
 * whenever a pod does, which would ask about everything again.
 */
function useBatches(workloads: KubeObject[] | undefined, pods: KubeObject[] | undefined) {
  const namespaces = useMemo(() => namespacesOf(workloads), [workloads])
  const key = namespaces.join(' ')
  const [plan, setPlan] = useState<{ key: string; batches: string[][] }>()
  // Adjusted as React adjusts state to what changed: while rendering, before anything's shown.
  if (pods && plan?.key !== key) {
    const containers = new Map(namespaces.map((namespace) => [namespace, 0]))
    for (const pod of pods) {
      const count = containers.get(pod.metadata.namespace!)
      if (count !== undefined) {
        containers.set(pod.metadata.namespace!, count + pod.spec.containers.length)
      }
    }
    setPlan({ key, batches: batchNamespaces(containers) })
  }
  return { namespaces, batches: plan?.key === key ? plan.batches : undefined }
}

// Stable, so the combined result only changes when a batch's answer does.
const combine = (results: UseQueryResult<Batch>[]) => ({
  batches: results.map((r) => r.data),
  errors: results.map((r) => (r.data === undefined ? r.error : null)),
})

/** Each batch's usage measured once (a batch's answer is new when it's asked again). */
const measured = new WeakMap<
  Batch,
  { pods: KubeObject[]; owners: unknown; usage: Map<string, Map<string, ContainerUsage>> }
>()

/**
 * What every Deployment, StatefulSet and DaemonSet in view should request,
 * from the last week of its containers' usage, asked a few namespaces at a
 * time: those measured so far, while the rest are.
 */
export function useRightsizing() {
  const { context } = useCluster()
  const queryClient = useQueryClient()
  const ready = useHistorySource().data?.state === 'ready'
  const deployments = useList('Deployment')
  const statefulSets = useList('StatefulSet')
  const daemonSets = useList('DaemonSet')
  const pods = useList('Pod')
  const hpas = useList('HorizontalPodAutoscaler')
  // What the cluster can allocate, to weigh CPU and memory changes against each other. Listing
  // nodes takes access to the whole cluster: without it, changes are ranked by their size alone.
  const nodes = useList('Node', { namespace: null })
  // VerticalPodAutoscalers are a custom resource, there only when the VPA is installed.
  const vpaKind = useResource(VPA)
  const vpas = useList(VPA, { enabled: vpaKind.resource !== undefined })
  const lists = [deployments, statefulSets, daemonSets, pods, hpas]
  /** VerticalPodAutoscalers that couldn't be listed: the workloads they manage aren't known. */
  const vpaError = vpas.data === undefined ? vpas.error : null

  const workloads = useMemo(
    () =>
      deployments.data && statefulSets.data && daemonSets.data
        ? [...deployments.data, ...statefulSets.data, ...daemonSets.data]
        : undefined,
    [deployments.data, statefulSets.data, daemonSets.data],
  )
  const { namespaces, batches = [] } = useBatches(workloads, pods.data)
  const usage = useQueries({
    queries: batches.map((batch) => ({
      queryKey: ['usage', context, 'rightsizing', batch.join(' ')],
      queryFn: () =>
        limited(async (): Promise<Batch> => {
          const time = Date.now()
          return { time, ...(await measureBatch(context, batch, time)) }
        }),
      enabled: ready,
      staleTime: REFRESH,
      refetchInterval: REFRESH,
    })),
    combine,
  })

  const listed =
    workloads !== undefined &&
    pods.data !== undefined &&
    hpas.data !== undefined &&
    (nodes.data !== undefined || nodes.error !== null) &&
    !vpaKind.pending &&
    (vpaKind.resource === undefined || vpas.data !== undefined || vpaError !== null)
  const owners = useMemo(() => (workloads ? podOwners(workloads) : undefined), [workloads])
  const computed = useMemo(() => {
    if (!listed || batches.length !== usage.batches.length) return undefined
    // Each namespace's batch, and what it came to.
    const measuredIn = new Map<string, { batch?: Batch; error: Error | null }>()
    batches.forEach((namespaces, i) => {
      const batch = usage.batches[i]
      const error = usage.errors[i] ?? null
      if (batch || error)
        for (const namespace of namespaces) measuredIn.set(namespace, { batch, error })
      for (const { namespaces: apart, error } of batch?.failed ?? []) {
        for (const namespace of apart) measuredIn.set(namespace, { batch, error })
      }
    })
    const all = new Map<string, Map<string, ContainerUsage>>()
    let now = 0
    for (const batch of usage.batches) {
      if (!batch) continue
      let cached = measured.get(batch)
      if (cached?.pods !== pods.data || cached.owners !== owners) {
        cached = {
          pods: pods.data!,
          owners,
          usage: measure(batch.results, pods.data!, owners!, batch.time),
        }
        measured.set(batch, cached)
      }
      for (const [key, value] of cached.usage) all.set(key, value)
      now = Math.max(now, batch.time)
    }
    const autoscalers = { hpas: hpas.data!, vpas: vpas.data ?? [] }
    const capacity = { cpu: 0, memory: 0 }
    for (const node of nodes.data ?? []) {
      capacity.cpu += allocatable(node).cpu
      capacity.memory += allocatable(node).memory
    }
    const advised = workloads.flatMap((workload): Advised[] => {
      const answer = measuredIn.get(workload.metadata.namespace!)
      if (!answer) return []
      const advice = adviseWorkload(workload, all.get(keyOf(workload)), autoscalers)
      return [
        {
          key: keyOf(workload),
          workload,
          advice: answer.error
            ? {
                ...advice,
                note: `Prometheus couldn’t answer for its namespace: ${answer.error.message}`,
              }
            : advice,
        },
      ]
    })
    const failed = [...measuredIn].flatMap(([namespace, { error }]) =>
      error ? [{ namespace, error }] : [],
    )
    return { advised, capacity, failed, settled: measuredIn.size, now }
  }, [listed, batches, usage, workloads, owners, pods.data, hpas.data, nodes.data, vpas.data])

  const failed = computed?.failed ?? []
  const everyFailed = failed.length > 0 && failed.length === namespaces.length
  const listError = lists.find((q) => q.error && q.data === undefined)?.error
  const settled = computed?.settled ?? 0
  return {
    /** Those measured so far, once one batch is (or everything is listed, with nothing to measure). */
    advised:
      computed && !everyFailed && (settled > 0 || namespaces.length === 0)
        ? computed.advised
        : undefined,
    /** Lists that couldn't load, or Prometheus failing for every namespace. */
    error: listError ?? (everyFailed ? failed[0]!.error : null),
    /** Namespaces Prometheus couldn't answer for, when others it could. */
    failed: everyFailed ? [] : failed,
    capacity: computed?.capacity,
    vpaError,
    progress: { settled, total: namespaces.length },
    /** Loads what failed again: lists, and the namespaces Prometheus didn't answer for. */
    retry: () => {
      for (const q of [...lists, nodes, vpas]) if (q.error) void q.refetch()
      void queryClient.refetchQueries({
        queryKey: ['usage', context, 'rightsizing'],
        predicate: (query) =>
          query.state.status === 'error' ||
          (query.state.status === 'success' && (query.state.data as Batch).failed.length > 0),
      })
    },
  }
}

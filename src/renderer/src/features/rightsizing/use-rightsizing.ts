import { useQueries, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { InstantResult, KubeObject } from '@shared/api'
import { useHistorySource } from '@renderer/hooks/history'
import { useList } from '@renderer/hooks/queries'
import { useResource } from '@renderer/hooks/resources'
import { api, unwrap } from '@renderer/lib/api'
import { allocatable } from '@renderer/lib/usage'
import {
  adviseWorkload,
  keyOf,
  measure,
  podOwners,
  rightsizingQueries,
  type WorkloadAdvice,
} from '@renderer/lib/rightsizing'
import { useCluster } from '@renderer/state/cluster'

const VPA = 'VerticalPodAutoscaler.autoscaling.k8s.io'

/** The namespaces workloads are in, in order: the batches usage is asked in. */
const namespacesOf = (workloads: KubeObject[] | undefined) =>
  [...new Set(workloads?.map((w) => w.metadata.namespace!))].sort()
/** A week of history changes slowly: asked again every quarter hour. */
const REFRESH = 15 * 60_000
/** Namespaces asked about at once: each is eight queries over a week. */
const CONCURRENCY = 2

export interface Advised {
  key: string
  workload: KubeObject
  advice: WorkloadAdvice
}

interface Batch {
  time: number
  results: InstantResult['results']
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

// Stable, so the combined result only changes when a namespace's answer does.
const combine = (results: UseQueryResult<Batch>[]) => ({
  batches: results.map((r) => r.data),
  errors: results.map((r) => (r.data === undefined ? r.error : null)),
  settled: results.filter((r) => r.data !== undefined || r.error).length,
})

/**
 * What every Deployment, StatefulSet and DaemonSet in view should request,
 * from the last week of its containers' usage, asked a namespace at a time.
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
  // What the cluster can allocate, to weigh CPU and memory changes against each other.
  const nodes = useList('Node', { namespace: null })
  // VerticalPodAutoscalers are a custom resource, there only when the VPA is installed.
  const vpaKind = useResource(VPA)
  const vpas = useList(VPA, { enabled: vpaKind.resource !== undefined })
  const lists = [deployments, statefulSets, daemonSets, pods, hpas, nodes]

  const workloads = useMemo(
    () =>
      deployments.data && statefulSets.data && daemonSets.data
        ? [...deployments.data, ...statefulSets.data, ...daemonSets.data]
        : undefined,
    [deployments.data, statefulSets.data, daemonSets.data],
  )
  const namespaces = namespacesOf(workloads)
  const usage = useQueries({
    queries: namespaces.map((namespace) => ({
      queryKey: ['usage', context, 'rightsizing', namespace],
      queryFn: () =>
        limited(async (): Promise<Batch> => {
          const time = Date.now()
          const queries = rightsizingQueries(namespace)
          const { results } = await unwrap(api.usage.instant({ context, queries, time }))
          return { time, results }
        }),
      enabled: ready,
      staleTime: REFRESH,
      refetchInterval: REFRESH,
    })),
    combine,
  })

  const loaded =
    workloads !== undefined &&
    pods.data !== undefined &&
    hpas.data !== undefined &&
    nodes.data !== undefined &&
    !vpaKind.pending &&
    (vpaKind.resource === undefined || vpas.data !== undefined) &&
    usage.settled === namespaces.length
  const computed = useMemo(() => {
    if (!loaded) return undefined
    const answered = usage.batches.filter((b) => b !== undefined)
    // Every namespace's series together, query by query.
    const results = rightsizingQueries('').map(({ id }) => ({
      id,
      series: answered.flatMap((b) => b.results.find((r) => r.id === id)!.series),
    }))
    const now = Math.max(0, ...answered.map((b) => b.time))
    const measured = measure(results, pods.data!, podOwners(workloads), now)
    const autoscalers = { hpas: hpas.data!, vpas: vpas.data ?? [] }
    const batches = namespacesOf(workloads)
    const capacity = { cpu: 0, memory: 0 }
    for (const node of nodes.data!) {
      capacity.cpu += allocatable(node).cpu
      capacity.memory += allocatable(node).memory
    }
    const advised = workloads.map((workload): Advised => {
      const failed = usage.errors[batches.indexOf(workload.metadata.namespace!)]
      const advice = adviseWorkload(workload, measured.get(keyOf(workload)), autoscalers)
      return {
        key: keyOf(workload),
        workload,
        advice: failed
          ? { ...advice, note: `Prometheus couldn’t answer for its namespace: ${failed.message}` }
          : advice,
      }
    })
    return { advised, capacity }
  }, [loaded, workloads, pods.data, hpas.data, nodes.data, vpas.data, usage])
  const advised = computed?.advised

  const failed = namespaces.flatMap((namespace, i) => {
    const error = usage.errors[i]
    return error ? [{ namespace, error }] : []
  })
  const listError = lists.find((q) => q.error && q.data === undefined)?.error
  return {
    advised:
      advised && failed.length === namespaces.length && failed.length > 0 ? undefined : advised,
    /** Lists that couldn't load, or Prometheus failing for every namespace. */
    error:
      listError ??
      (failed.length > 0 && failed.length === namespaces.length ? failed[0]!.error : null),
    /** Namespaces Prometheus couldn't answer for, when others it could. */
    failed: failed.length < namespaces.length ? failed : [],
    capacity: computed?.capacity,
    progress: { settled: usage.settled, total: namespaces.length },
    /** Loads what failed again: lists, and the namespaces Prometheus didn't answer for. */
    retry: () => {
      for (const q of lists) if (q.error) void q.refetch()
      void queryClient.refetchQueries({
        queryKey: ['usage', context, 'rightsizing'],
        predicate: (query) => query.state.status === 'error',
      })
    },
  }
}

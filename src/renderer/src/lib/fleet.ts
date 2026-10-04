/**
 * A fleet's clusters, summed up: each one's status from its summary (what
 * needs attention first), and the labels to filter and group them by.
 */
import type { ClusterSummary, KubeContext } from '@shared/api'
import type { Status } from '@shared/health'
import { ERROR_LABELS, pluralize } from './format'

/** What the fleet page shows of each cluster: worst first. */
export type FleetFilter = 'all' | 'attention' | 'healthy' | 'unreachable'

/**
 * A cluster's status, as its overview would put it: what didn't answer, then
 * nodes that aren't ready, then workloads and pods in trouble, as far as the
 * person may see (one who may see none of them isn't told it's healthy).
 * Warning events are counted on its card, but don't make a cluster need
 * attention: every cluster has some.
 */
export function clusterStatus(summary: ClusterSummary | undefined): Status {
  if (!summary) return { health: 'progressing', label: 'Checking…' }
  if (!summary.version.ok) {
    const { code, message } = summary.version.error
    return { health: 'critical', label: ERROR_LABELS[code], detail: message }
  }
  // Every part is there once the cluster answered.
  const { nodes, workloads, pods } = summary as Required<ClusterSummary>
  if (!nodes.ok && !workloads.ok && !pods.ok) return { health: 'neutral', label: 'No access' }
  const notReady = nodes.ok ? nodes.data.total - nodes.data.ready : 0
  if (notReady > 0) return { health: 'critical', label: `${pluralize(notReady, 'node')} not ready` }
  const degraded = workloads.ok ? workloads.data.total - workloads.data.healthy : 0
  if (degraded > 0)
    return { health: 'warning', label: `${pluralize(degraded, 'workload')} degraded` }
  const unhealthy = pods.ok ? pods.data.unhealthy : 0
  if (unhealthy > 0) return { health: 'warning', label: `${pluralize(unhealthy, 'pod')} unhealthy` }
  return { health: 'healthy', label: 'Healthy' }
}

/** Whether a cluster is one the filter shows. */
export function shows(filter: FleetFilter, summary: ClusterSummary | undefined): boolean {
  if (filter === 'all') return true
  // Still being checked: under all, until its summary says.
  if (!summary) return false
  const { health } = clusterStatus(summary)
  if (filter === 'unreachable') return !summary.version.ok
  if (filter === 'attention') return health === 'critical' || health === 'warning'
  return health === 'healthy'
}

/** `key=value`, as a label filter and a label read. */
export const labelText = (key: string, value: string) => `${key}=${value}`

/** A label filter's key and value (a value may have = in it). */
export function splitLabel(text: string): [string, string] {
  const at = text.indexOf('=')
  return [text.slice(0, at), text.slice(at + 1)]
}

/** Every label the clusters have, each with how many have it, by key then value. */
export function fleetLabels(
  contexts: KubeContext[],
): { key: string; value: string; count: number }[] {
  const counts = new Map<string, number>()
  // A fleet's clusters always have labels, if none.
  for (const context of contexts) {
    for (const [key, value] of Object.entries(context.labels!)) {
      const text = labelText(key, value)
      counts.set(text, (counts.get(text) ?? 0) + 1)
    }
  }
  return [...counts]
    .map(([text, count]) => {
      const [key, value] = splitLabel(text)
      return { key, value, count }
    })
    .sort((a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value))
}

/** Whether a cluster has every label of a filter (`env=production`, …). */
export function hasLabels(context: KubeContext, wanted: string[]): boolean {
  const labels = context.labels!
  return wanted.every((text) => {
    const [key, value] = splitLabel(text)
    return labels[key] === value
  })
}

/** Clusters grouped by a label's values, in order, those without it last. */
export function groupBy<T extends { context: KubeContext }>(
  items: T[],
  key: string,
): { value: string | undefined; items: T[] }[] {
  const groups = new Map<string | undefined, T[]>()
  for (const item of items) {
    const value = item.context.labels![key]
    groups.set(value, [...(groups.get(value) ?? []), item])
  }
  const values = [...groups.keys()].filter((value) => value !== undefined).sort()
  // Those without it, last.
  return [...values, ...(groups.has(undefined) ? [undefined] : [])].map((value) => ({
    value,
    items: groups.get(value)!,
  }))
}

/**
 * The PromQL KubeStacks asks Prometheus (or VictoriaMetrics) for: usage from
 * cAdvisor and restarts from kube-state-metrics, summed over the pods or
 * containers a view is about.
 */
import type { ResourceKind } from '@shared/resources'

export type UsageMetric = 'cpu' | 'memory' | 'rx' | 'tx' | 'restarts'
export type Unit = 'cores' | 'bytes' | 'bytesPerSecond' | 'count'

/** Each metric's name as a label, within a sentence, and its unit. */
export const USAGE_METRICS: Record<UsageMetric, { label: string; noun: string; unit: Unit }> = {
  cpu: { label: 'CPU', noun: 'CPU', unit: 'cores' },
  memory: { label: 'Memory', noun: 'memory', unit: 'bytes' },
  rx: { label: 'Network in', noun: 'network in', unit: 'bytesPerSecond' },
  tx: { label: 'Network out', noun: 'network out', unit: 'bytesPerSecond' },
  restarts: { label: 'Restarts', noun: 'restarts', unit: 'count' },
}

export type Matcher = readonly [label: string, op: '=' | '!=' | '=~' | '!~', value: string]

export const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const selector = (matchers: readonly Matcher[]) =>
  `{${matchers.map(([label, op, value]) => `${label}${op}${JSON.stringify(value)}`).join(',')}}`

// cAdvisor also reports the pod's sandbox and the pod as a whole; only real containers count.
export const CONTAINERS: Matcher[] = [
  ['container', '!=', ''],
  ['container', '!=', 'POD'],
]

// Pods on the host network see the node's own interfaces too: loopback, every pod's
// veth, bridges and tunnels. Counting them would count other pods' traffic again.
const INTERFACES: Matcher[] = [
  ['interface', '!~', 'lo|veth.*|cali.*|lxc.*|cni.*|flannel.*|vxlan.*|tunl.*|docker.*|br-.*'],
]

/** The per-series expression before summing: a rate, an increase, or a gauge. */
function inner(metric: UsageMetric, matchers: readonly Matcher[], window: number): string {
  const range = `[${window}s]`
  switch (metric) {
    case 'cpu':
      return `rate(container_cpu_usage_seconds_total${selector([...CONTAINERS, ...matchers])}${range})`
    case 'memory':
      return `container_memory_working_set_bytes${selector([...CONTAINERS, ...matchers])}`
    case 'rx':
      return `rate(container_network_receive_bytes_total${selector([...INTERFACES, ...matchers])}${range})`
    case 'tx':
      return `rate(container_network_transmit_bytes_total${selector([...INTERFACES, ...matchers])}${range})`
    case 'restarts':
      return `increase(kube_pod_container_status_restarts_total${selector(matchers)}${range})`
  }
}

const sum = (by: readonly string[]) => (by.length ? `sum by (${by.join(', ')})` : 'sum')

/**
 * One metric summed by `by` over what `matchers` pick, with `window` seconds
 * for rates and increases.
 */
export function usageQuery(
  metric: UsageMetric,
  matchers: readonly Matcher[],
  by: readonly string[],
  window: number,
): string {
  return `${sum(by)} (${inner(metric, matchers, window)})`
}

/**
 * Usage on one node. Setups that label cAdvisor's series with the node answer
 * the first form; others need kube-state-metrics to say where each pod ran.
 */
export function nodeQuery(
  metric: UsageMetric,
  node: string,
  by: readonly string[],
  window: number,
): string {
  const joined = `${sum(by)} (${inner(metric, [], window)} * on (namespace, pod) group_left () max by (namespace, pod) (kube_pod_info${selector([['node', '=', node]])}))`
  return `${usageQuery(metric, [['node', '=', node]], by, window)} or ${joined}`
}

/** Usage per node across the cluster, with the same fallback as `nodeQuery`. */
export function byNodeQuery(metric: UsageMetric, matchers: readonly Matcher[], window: number) {
  const joined = `sum by (node) (${inner(metric, matchers, window)} * on (namespace, pod) group_left (node) max by (namespace, pod, node) (kube_pod_info))`
  return `${usageQuery(metric, [...matchers, ['node', '!=', '']], ['node'], window)} or ${joined}`
}

/** A subquery reduced over the whole range: the average or peak of each series. */
export function overRange(reduce: 'avg' | 'max', expr: string, range: number, step: number) {
  return `${reduce}_over_time((${expr})[${range}s:${step}s])`
}

/** The pods a workload made, by the names its controller gives them. */
export function podPattern(kind: ResourceKind, name: string): string {
  const base = escapeRegex(name)
  switch (kind) {
    case 'Deployment':
      return `${base}-[a-z0-9]+-[a-z0-9]+`
    case 'StatefulSet':
      return `${base}-[0-9]+`
    case 'CronJob':
      return `${base}-[0-9]+-[a-z0-9]+`
    default:
      return `${base}-[a-z0-9]+`
  }
}

/**
 * The workload a pod most likely belongs to, from its name alone (for pods
 * that are gone): Deployment pods carry two generated suffixes, others one.
 */
export function workloadOf(pod: string): string {
  return (
    /^(.+)-[a-z0-9]{6,10}-[a-z0-9]{5}$/.exec(pod)?.[1] ??
    /^(.+)-(?:[0-9]+|[a-z0-9]{5})$/.exec(pod)?.[1] ??
    pod
  )
}

// ——— Time ———

export type RangeId = '15m' | '1h' | '6h' | '24h' | '7d'

export const RANGES: { id: RangeId; label: string; seconds: number; step: number }[] = [
  { id: '15m', label: 'Last 15 minutes', seconds: 900, step: 15 },
  { id: '1h', label: 'Last hour', seconds: 3_600, step: 30 },
  { id: '6h', label: 'Last 6 hours', seconds: 21_600, step: 120 },
  { id: '24h', label: 'Last 24 hours', seconds: 86_400, step: 300 },
  { id: '7d', label: 'Last 7 days', seconds: 604_800, step: 1_800 },
]

export function isRangeId(value: unknown): value is RangeId {
  return RANGES.some((r) => r.id === value)
}

/** What to chart: a preset that follows the clock, or a window zoomed into from one. */
export type TimeSelection = { range: RangeId } | { from: number; to: number; back: RangeId }

/** Zooms into a window; resetting goes back to the preset it started from. */
export function zoomInto(selection: TimeSelection, from: number, to: number): TimeSelection {
  return { from, to, back: 'range' in selection ? selection.range : selection.back }
}

/** A chart's time axis, in milliseconds. */
export interface TimeWindow {
  start: number
  end: number
  step: number
}

// The last step fits any span, so one is always found.
const NICE_STEPS = [
  15,
  30,
  60,
  120,
  300,
  600,
  900,
  1_800,
  3_600,
  7_200,
  10_800,
  21_600,
  43_200,
  86_400,
  Number.MAX_SAFE_INTEGER,
]

/** The smallest nice step (seconds) that keeps a span under `points` steps. */
export function niceStep(span: number, points: number): number {
  return NICE_STEPS.find((step) => span / step <= points)! * 1000
}

export function windowFor(selection: TimeSelection, now: number): TimeWindow {
  if ('range' in selection) {
    const preset = RANGES.find((r) => r.id === selection.range)!
    const step = preset.step * 1000
    const end = Math.floor(now / step) * step
    return { start: end - preset.seconds * 1000, end, step }
  }
  const step = niceStep((selection.to - selection.from) / 1000, 240)
  return {
    start: Math.floor(selection.from / step) * step,
    end: Math.ceil(selection.to / step) * step,
    step,
  }
}

/** Restarts are counted per bucket: about 48 bars across any window. */
export function bucketWindow({ start, end }: TimeWindow): TimeWindow {
  const step = niceStep((end - start) / 1000, 48)
  return { start: Math.floor(start / step) * step, end: Math.floor(end / step) * step, step }
}

/** The rate window for a step: two steps, and at least two minutes so it spans a few scrapes. */
export const rateWindow = (step: number) => Math.max(120, (2 * step) / 1000)

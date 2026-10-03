/**
 * A Prometheus (or VictoriaMetrics) HTTP API for the mock clusters, answering
 * the PromQL shapes KubeStacks sends with smooth, deterministic history made
 * from each pod's usage in the fixture: cAdvisor CPU, memory, network and
 * CPU throttling, and kube-state-metrics restarts and why containers last
 * stopped.
 */
import { parseQuantity } from '../../src/shared/quantity.ts'
import type { KubeObject } from './types.ts'

export type MetricsFlavor = 'prometheus' | 'victoriametrics'

export interface PodSource {
  pod: KubeObject
  /** Typical usage per container: CPU in cores, memory in bytes. */
  containers: { name: string; cpu: number; memory: number }[]
}

type Labels = Record<string, string>
/** A series' value at a time in seconds, or null where it has no sample. */
interface Series {
  labels: Labels
  at: (t: number) => number | null
}

interface Response {
  status: number
  body: string
  contentType: string
}

const json = (status: number, body: unknown): Response => ({
  status,
  body: JSON.stringify(body),
  contentType: 'application/json',
})
const badData = (error: string) => json(400, { status: 'error', errorType: 'bad_data', error })

function hash(seed: string): number {
  let h = 2166136261
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return (h >>> 0) / 2 ** 32
}

/** Daily, three-hourly and quarter-hourly swings, plus a little minute-to-minute noise. */
function wave(seed: string, t: number): number {
  const h = hash(seed) * Math.PI * 2
  return (
    1 +
    0.28 * Math.sin((2 * Math.PI * t) / 86_400 + h) +
    0.16 * Math.sin((2 * Math.PI * t) / 10_800 + h * 2) +
    0.12 * Math.sin((2 * Math.PI * t) / 1_020 + h * 3) +
    0.1 * (hash(`${seed}/${Math.floor(t / 60)}`) - 0.5)
  )
}

const seconds = (timestamp: string | undefined) => Date.parse(timestamp ?? '') / 1000

/** How often the mock's series are scraped: what raw `*_over_time` windows see. */
const SCRAPE = 60

/**
 * The share of its CFS periods a container's CPU limit throttles. Work comes
 * in bursts of about two and a half times the average, so a container that
 * uses half its limit on average is throttled a quarter of the time.
 */
function throttledShare(cpu: number, limit: number): number {
  return Math.min(0.9, Math.max(0, (cpu * 2.5) / limit - 1))
}

/** A container's limits, in cores and bytes. */
function limitsOf(pod: KubeObject, container: string): { cpu?: number; memory?: number } {
  const limits: Record<string, string> =
    pod.spec.containers.find((c: { name: string }) => c.name === container)?.resources?.limits ?? {}
  return {
    cpu: limits.cpu === undefined ? undefined : parseQuantity(limits.cpu),
    memory: limits.memory === undefined ? undefined : parseQuantity(limits.memory),
  }
}

/** When a container was last OOM-killed, in seconds, if it was. */
function oomKilledAt(pod: KubeObject, container: string): number | undefined {
  const status = (pod.status?.containerStatuses ?? []).find(
    (s: { name: string }) => s.name === container,
  )
  const terminated = status?.lastState?.terminated
  return terminated?.reason === 'OOMKilled' ? seconds(terminated.finishedAt) : undefined
}

/** The series behind each metric name, made from the pods the cluster has now. */
function seriesFor(metric: string, pods: PodSource[], all: KubeObject[], now: number): Series[] {
  const since = (pod: KubeObject, f: (t: number) => number) => (t: number) =>
    t < seconds(pod.metadata.creationTimestamp) ? null : f(t)
  const base = (pod: KubeObject): Labels => ({
    namespace: pod.metadata.namespace!,
    pod: pod.metadata.name,
    node: pod.spec.nodeName,
  })
  switch (metric) {
    case 'container_cpu_usage_seconds_total':
    case 'container_memory_working_set_bytes':
      return pods.flatMap(({ pod, containers }) =>
        containers.map((c) => {
          const key = `${pod.metadata.name}/${c.name}`
          const limits = limitsOf(pod, c.name)
          // Before an OOM kill, memory climbs to the limit over half an hour.
          const killed = oomKilledAt(pod, c.name)
          const memory = (t: number) =>
            killed !== undefined && limits.memory !== undefined && t > killed - 1800 && t <= killed
              ? limits.memory * (0.85 + (0.15 * (t - killed + 1800)) / 1800)
              : c.memory * (0.94 + 0.06 * wave(`${key}/mem`, t))
          return {
            labels: { ...base(pod), container: c.name },
            at:
              metric === 'container_memory_working_set_bytes'
                ? since(pod, memory)
                : // A CPU limit is a ceiling: the kernel throttles a container at it.
                  since(pod, (t) => Math.min(limits.cpu ?? Infinity, c.cpu * wave(key, t))),
          }
        }),
      )
    case 'container_network_receive_bytes_total':
    case 'container_network_transmit_bytes_total': {
      // Pod-level, like cAdvisor's: no container label.
      const perCore = metric.includes('receive') ? 2_400_000 : 1_100_000
      return pods.map(({ pod, containers }) => ({
        labels: { ...base(pod), interface: 'eth0' },
        at: since(
          pod,
          (t) =>
            containers.reduce((sum, c) => sum + c.cpu * wave(`${pod.metadata.name}/net`, t), 0) *
            perCore,
        ),
      }))
    }
    case 'container_cpu_cfs_periods_total':
    case 'container_cpu_cfs_throttled_periods_total':
      // cAdvisor only counts periods for containers with a CPU quota: a limit.
      return pods.flatMap(({ pod, containers }) =>
        containers.flatMap((c) => {
          const limit = limitsOf(pod, c.name).cpu
          if (limit === undefined) return []
          const created = seconds(pod.metadata.creationTimestamp)
          // Ten 100ms periods a second, in the periods it had work to do.
          const share =
            metric === 'container_cpu_cfs_periods_total' ? 1 : throttledShare(c.cpu, limit)
          return [
            {
              labels: { ...base(pod), container: c.name },
              at: since(pod, (t) => 10 * (t - created) * share),
            },
          ]
        }),
      )
    case 'kube_pod_container_status_last_terminated_reason':
      return all.flatMap((pod) =>
        (pod.status?.containerStatuses ?? []).flatMap(
          (status: { name: string; lastState?: { terminated?: { reason: string } } }) =>
            status.lastState?.terminated
              ? [
                  {
                    labels: {
                      namespace: pod.metadata.namespace!,
                      pod: pod.metadata.name,
                      container: status.name,
                      reason: status.lastState.terminated.reason,
                    },
                    at: since(pod, () => 1),
                  },
                ]
              : [],
        ),
      )
    case 'kube_pod_container_status_restarts_total':
      // kube-state-metrics has no node label here; restarts are spread over the pod's life.
      return all.flatMap((pod) =>
        (pod.status?.containerStatuses ?? []).map(
          (status: { name: string; restartCount: number }) => {
            const created = seconds(pod.metadata.creationTimestamp)
            const times = Array.from(
              { length: status.restartCount },
              (_, k) => created + ((now - created) * (k + 1)) / (status.restartCount + 1),
            )
            return {
              labels: {
                namespace: pod.metadata.namespace!,
                pod: pod.metadata.name,
                container: status.name,
              },
              at: since(pod, (t) => times.filter((time) => time <= t).length),
            }
          },
        ),
      )
    default:
      return []
  }
}

type Matcher = { label: string; op: string; value: string }

function matchers(text: string | undefined): Matcher[] {
  const found: Matcher[] = []
  for (const m of (text ?? '').matchAll(/(\w+)(=~|!~|!=|=)"((?:[^"\\]|\\.)*)"/g)) {
    found.push({ label: m[1]!, op: m[2]!, value: JSON.parse(`"${m[3]}"`) as string })
  }
  return found
}

function matches(labels: Labels, list: Matcher[]): boolean {
  return list.every(({ label, op, value }) => {
    const actual = labels[label] ?? ''
    if (op === '=') return actual === value
    if (op === '!=') return actual !== value
    // RE2's inline flag for case-insensitive matching; JavaScript takes it as a flag.
    const insensitive = value.startsWith('(?i)')
    const regex = new RegExp(
      `^(?:${insensitive ? value.slice(4) : value})$`,
      insensitive ? 'i' : '',
    )
    return op === '=~' ? regex.test(actual) : !regex.test(actual)
  })
}

/**
 * A parsed `sum by (…) (fn(metric{…}[w]))` (or `max`, `min`); `over` wraps it
 * in a subquery reduction. `first` is `min_over_time(timestamp(metric{…})[w:s])`:
 * when a series was first seen, `step` apart.
 */
interface Query {
  agg: 'sum' | 'max' | 'min'
  by?: string[]
  fn?: 'rate' | 'increase' | 'max_over_time' | 'min_over_time' | 'first'
  metric: string
  matchers: Matcher[]
  window: number
  step?: number
  over?: { reduce: 'avg' | 'max' | 'quantile'; phi?: number; range: number; step: number }
}

const WRAP = /^(avg|max|quantile)_over_time\((?:(\d*\.?\d+), )?\((.+)\)\[(\d+)s:(\d+)s\]\)$/
const AGG = /^(sum|max|min)(?: by \(([\w, ]*)\))? \((.+)\)$/
// A selector's braces, allowing braces inside its quoted values (regexes like [a-z]{5}).
const SELECTOR = String.raw`(\{(?:[^}"]|"(?:[^"\\]|\\.)*")*\})`
const INNER = new RegExp(
  String.raw`^(?:(rate|increase|max_over_time|min_over_time)\((\w+)${SELECTOR}?\[(\d+)s\]\)|(\w+)${SELECTOR}?|min_over_time\(timestamp\((\w+)${SELECTOR}?\)\[(\d+)s:(\d+)s\]\))$`,
)

function parse(expr: string): Query | undefined {
  let text = expr.trim()
  let over: Query['over']
  const wrap = WRAP.exec(text)
  if (wrap) {
    over = {
      reduce: wrap[1] as 'avg' | 'max' | 'quantile',
      phi: wrap[2] === undefined ? undefined : Number(wrap[2]),
      range: Number(wrap[4]),
      step: Number(wrap[5]),
    }
    text = wrap[3]!
  }
  // Fallbacks after " or " are for other Prometheus setups; the mock answers the first form.
  text = text.split(' or ')[0]!.trim()
  const agg = AGG.exec(text)
  if (!agg) return undefined
  const inner = INNER.exec(agg[3]!)
  if (!inner) return undefined
  return {
    agg: agg[1] as Query['agg'],
    by: agg[2]?.split(',').map((label) => label.trim()),
    fn: inner[7] ? 'first' : (inner[1] as Query['fn']),
    metric: inner[2] ?? inner[5] ?? inner[7]!,
    matchers: matchers(inner[3] ?? inner[6] ?? inner[8]),
    window: Number(inner[4] ?? inner[9] ?? 0),
    step: inner[10] ? Number(inner[10]) : undefined,
    over,
  }
}

/** A series' value for a query at time `t`, before aggregating. */
function valueAt(query: Query, s: Series, t: number): number | null {
  switch (query.fn) {
    case 'increase': {
      const now = s.at(t)
      return now === null ? null : now - (s.at(t - query.window) ?? 0)
    }
    case 'max_over_time':
    case 'min_over_time': {
      // Every scrape in the window.
      let found: number | null = null
      for (let at = t - query.window + SCRAPE; at <= t; at += SCRAPE) {
        const v = s.at(at)
        if (v === null) continue
        found =
          found === null
            ? v
            : query.fn === 'max_over_time'
              ? Math.max(found, v)
              : Math.min(found, v)
      }
      return found
    }
    case 'first': {
      // Subquery steps are whole multiples of the step.
      const step = query.step!
      for (let at = Math.ceil((t - query.window) / step) * step; at <= t; at += step) {
        if (s.at(at) !== null) return at
      }
      return null
    }
    default:
      return s.at(t)
  }
}

/** The φ-quantile of values, interpolated between ranks as Prometheus does. */
function quantile(phi: number, values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = phi * (sorted.length - 1)
  const below = Math.floor(rank)
  const above = Math.min(sorted.length - 1, below + 1)
  return sorted[below]! + (sorted[above]! - sorted[below]!) * (rank - below)
}

/** Evaluates a parsed query at time `t`: one value per group. */
function evaluate(
  query: Query,
  series: Series[],
  t: number,
): Map<string, { labels: Labels; value: number }> {
  const groups = new Map<string, { labels: Labels; value: number }>()
  for (const s of series) {
    const value = valueAt(query, s, t)
    if (value === null) continue
    const labels = Object.fromEntries(
      (query.by ?? []).map((label) => [label, s.labels[label] ?? '']),
    )
    const key = JSON.stringify(labels)
    const group = groups.get(key)
    if (!group) groups.set(key, { labels, value })
    else if (query.agg === 'sum') group.value += value
    else group.value = (query.agg === 'max' ? Math.max : Math.min)(group.value, value)
  }
  return groups
}

const format = (value: number) => String(Number(value.toPrecision(6)))

/**
 * Answers the Prometheus HTTP API at `path`. VictoriaMetrics differs in two
 * ways that matter here: it aligns ranges to whole steps, and it has no
 * build info endpoint.
 */
export function prometheusApi(
  flavor: MetricsFlavor,
  path: string,
  params: URLSearchParams,
  pods: PodSource[],
  all: KubeObject[],
): Response {
  const now = Date.now() / 1000
  if (path === '/api/v1/status/buildinfo') {
    return flavor === 'prometheus'
      ? json(200, { status: 'success', data: { version: '3.5.0', goVersion: 'go1.24.6' } })
      : {
          status: 404,
          body: 'unsupported path requested: "/api/v1/status/buildinfo"',
          contentType: 'text/plain',
        }
  }
  if (path !== '/api/v1/query' && path !== '/api/v1/query_range') {
    return { status: 404, body: '404 page not found', contentType: 'text/plain' }
  }
  const expr = params.get('query') ?? ''
  if (expr === 'vector(1)') {
    return json(200, {
      status: 'success',
      data: { resultType: 'vector', result: [{ metric: {}, value: [now, '1'] }] },
    })
  }
  const query = parse(expr)
  if (!query) return badData(`1:1: parse error: unexpected expression "${expr.slice(0, 40)}"`)
  const series = seriesFor(query.metric, pods, all, now).filter((s) =>
    matches(s.labels, query.matchers),
  )

  if (path === '/api/v1/query') {
    const time = Number(params.get('time') ?? now)
    let groups: Map<string, { labels: Labels; value: number }>
    if (query.over) {
      // A subquery: evaluate at every step in the range, then reduce each group.
      const { range, step, reduce, phi } = query.over
      const samples = new Map<string, { labels: Labels; values: number[] }>()
      for (let t = Math.ceil((time - range) / step) * step; t <= time; t += step) {
        for (const [key, group] of evaluate(query, series, t)) {
          const entry = samples.get(key) ?? { labels: group.labels, values: [] }
          entry.values.push(group.value)
          samples.set(key, entry)
        }
      }
      groups = new Map(
        [...samples].map(([key, { labels, values }]) => [
          key,
          {
            labels,
            value:
              reduce === 'max'
                ? Math.max(...values)
                : reduce === 'quantile'
                  ? quantile(phi!, values)
                  : values.reduce((sum, v) => sum + v, 0) / values.length,
          },
        ]),
      )
    } else {
      groups = evaluate(query, series, time)
    }
    return json(200, {
      status: 'success',
      data: {
        resultType: 'vector',
        result: [...groups.values()].map(({ labels, value }) => ({
          metric: labels,
          value: [time, format(value)],
        })),
      },
    })
  }

  let start = Number(params.get('start'))
  let end = Number(params.get('end'))
  const step = Number(params.get('step'))
  if (flavor === 'victoriametrics') {
    start = Math.floor(start / step) * step
    end = Math.ceil(end / step) * step
  }
  const result = new Map<string, { metric: Labels; values: [number, string][] }>()
  for (let t = start; t <= end + 1e-9; t += step) {
    for (const [key, { labels, value }] of evaluate(query, series, t)) {
      const entry = result.get(key) ?? { metric: labels, values: [] }
      entry.values.push([t, format(value)])
      result.set(key, entry)
    }
  }
  return json(200, {
    status: 'success',
    data: { resultType: 'matrix', result: [...result.values()] },
  })
}

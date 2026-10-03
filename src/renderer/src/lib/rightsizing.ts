/**
 * Right-sizing: what a workload's containers should request, from what they
 * used. The method is the one the Kubernetes VPA recommender and Robusta's
 * KRR are built on, made conservative and explainable:
 *
 * - CPU is compressible: a container that needs more than it requested is
 *   slowed, not killed. Its request covers the 95th percentile of its use
 *   (5-minute rates, in its busiest pod), plus 15% headroom.
 * - Memory isn't: a container that needs more than it can have is killed.
 *   Its request covers its peak, plus 15% headroom.
 * - What was measured under a limit understates what was needed: a container
 *   that was OOM-killed gets more memory, and is never cut; one its CPU limit
 *   throttles gets a higher limit, and isn't cut when its usual use was held
 *   at the limit too.
 * - Limits are never lowered: what a lower limit would do (throttling, OOM
 *   kills) happens in bursts the samples average away. They're raised when
 *   they hold a container back, and to stay at or above its request.
 * - Requests an autoscaler scales on stay as they are: they're what its
 *   targets are relative to.
 * - Changes too small to matter are left alone, and nothing is said about a
 *   workload with less than a day of history.
 *
 * Each recommendation carries its reasons, in sentences.
 */
import type { InstantResult, KubeObject } from '@shared/api'
import { parseQuantity } from '@shared/quantity'
import { CONTAINERS, escapeRegex, selector, type Matcher } from './promql'

export type Resource = 'cpu' | 'memory'
export const RESOURCES: Resource[] = ['cpu', 'memory']

/** The history recommendations are based on: a week covers weekly cycles, within the usual retention. */
export const WINDOW = 7 * 86_400
/** The percentile of CPU use a request covers. */
export const CPU_PERCENTILE = 0.95
/** Headroom on top of what was used, as the VPA recommender keeps. */
export const HEADROOM = 1.15
/** OOM-killed containers needed more than they got; how much more is unknown. */
export const OOM_BUMP = 1.25
/** Throttled in this share of its CPU periods, a container is held back by its limit… */
export const THROTTLED = 0.1
/** …which goes up by half, or to its peak with this much room, whichever is more. */
export const THROTTLED_BUMP = 1.5
export const LIMIT_HEADROOM = 1.2
/** Peak memory this close to its limit is a spike away from an OOM kill. */
export const NEAR_LIMIT = 0.9
/** The least a recommendation asks for. */
export const MIN_CPU = 0.01
export const MIN_MEMORY = 32 * 2 ** 20
/** A change is worth making when it's at least this big, both relatively and absolutely. */
export const MIN_CHANGE = 0.2
export const MIN_CPU_CHANGE = 0.025
export const MIN_MEMORY_CHANGE = 32 * 2 ** 20
/** Hours of history before anything is recommended, and before a recommendation is fully trusted. */
export const MIN_HISTORY = 24
export const GOOD_HISTORY = 6 * 24

const MI = 2 ** 20
const GI = 2 ** 30

// ——— Amounts ———

/** CPU steps that read well and add little: 5m up to 100m, 10m up to 500m, and so on. */
const CPU_STEPS: [upTo: number, step: number][] = [
  [100, 5],
  [500, 10],
  [1000, 25],
  [4000, 50],
  [Infinity, 100],
]

/** CPU rounded up to its step. */
export function roundCpu(cores: number): number {
  const millis = cores * 1000
  const step = CPU_STEPS.find(([upTo]) => millis <= upTo)![1]
  return (Math.ceil(millis / step - 1e-9) * step) / 1000
}

/**
 * Memory rounded up to a power-of-two step about a sixteenth of it (8Mi at
 * least): 400Mi, 1472Mi, 3840Mi.
 */
export function roundMemory(bytes: number): number {
  const mib = bytes / MI
  const step = Math.max(8, 2 ** (Math.floor(Math.log2(Math.max(mib, 1))) - 4))
  return Math.ceil(mib / step - 1e-9) * step * MI
}

/** As a request or limit: "250m", "1500m"; "512Mi", "3Gi". */
export function quantity(resource: Resource, value: number): string {
  if (resource === 'cpu') return `${Math.round(value * 1000)}m`
  const mib = Math.round(value / MI)
  return mib % 1024 === 0 ? `${mib / 1024}Gi` : `${mib}Mi`
}

/** For reading: "250m", "1.5 cores"; "512 MiB", "3 GiB". */
export function describeAmount(resource: Resource, value: number): string {
  if (resource === 'cpu') {
    if (value < 1) return `${Math.round(value * 1000)}m`
    const cores = Number(value.toFixed(2))
    return `${cores} ${cores === 1 ? 'core' : 'cores'}`
  }
  return value < GI ? `${Math.round(value / MI)} MiB` : `${Number((value / GI).toFixed(2))} GiB`
}

// ——— Measuring ———

/** What was measured of one container, over all its workload's pods in the window. */
export interface ContainerUsage {
  /** The 95th percentile of its CPU use (cores) in its busiest pod, and its peak. */
  cpuP95: number
  cpuMax: number
  /** Its peak memory (working set), in bytes. */
  memoryMax: number
  /** Hours since its first sample in the window. */
  history: number
  /** The share of its CPU periods that were throttled (none without a CPU limit). */
  throttled: number
  /** Whether it was OOM-killed in the window. */
  oomKilled: boolean
}

const BY = 'namespace, pod, container'

/**
 * What right-sizing asks Prometheus, for every container in `namespace`: its
 * CPU's 95th percentile and peak, its memory's peak, when it was first seen,
 * how often its CPU was throttled, and its OOM kills (from kube-state-metrics,
 * when it's there). A namespace at a time, so a big cluster's week stays
 * within what Prometheus loads for one query, and answers in time.
 */
export function rightsizingQueries(namespace: string): { id: string; expr: string }[] {
  const scope: Matcher[] = [['namespace', '=', namespace]]
  const containers = selector([...CONTAINERS, ...scope])
  const window = `${WINDOW}s`
  const cpu = `sum by (${BY}) (rate(container_cpu_usage_seconds_total${containers}[300s]))`
  const increase = (metric: string, matchers: Matcher[] = [...CONTAINERS, ...scope]) =>
    `sum by (${BY}) (increase(${metric}${selector(matchers)}[${window}]))`
  return [
    { id: 'cpuP95', expr: `quantile_over_time(${CPU_PERCENTILE}, (${cpu})[${window}:300s])` },
    { id: 'cpuMax', expr: `max_over_time((${cpu})[${window}:300s])` },
    {
      id: 'memoryMax',
      expr: `max by (${BY}) (max_over_time(container_memory_working_set_bytes${containers}[${window}]))`,
    },
    {
      id: 'first',
      expr: `min by (${BY}) (min_over_time(timestamp(container_memory_working_set_bytes${containers})[${window}:3600s]))`,
    },
    { id: 'throttled', expr: increase('container_cpu_cfs_throttled_periods_total') },
    { id: 'periods', expr: increase('container_cpu_cfs_periods_total') },
    {
      id: 'oomKilled',
      expr: `max by (${BY}) (max_over_time(kube_pod_container_status_last_terminated_reason${selector([['reason', '=', 'OOMKilled'], ...scope])}[${window}]))`,
    },
    { id: 'restarts', expr: increase('kube_pod_container_status_restarts_total', scope) },
  ]
}

export const workloadKey = (kind: string, namespace: string, name: string) =>
  `${kind}/${namespace}/${name}`

export const keyOf = (workload: KubeObject) =>
  workloadKey(workload.kind!, workload.metadata.namespace!, workload.metadata.name)

/**
 * The names of a workload's pods, gone ones too: a Deployment's are
 * `name-<template hash>-<5>`, a DaemonSet's `name-<5>`, a StatefulSet's
 * `name-<ordinal>`. A regex in RE2 and JavaScript alike.
 */
export function podRegex(workload: KubeObject): string {
  const suffix =
    workload.kind === 'StatefulSet'
      ? '[0-9]+'
      : workload.kind === 'DaemonSet'
        ? '[a-z0-9]{5}'
        : '[a-z0-9]{6,10}-[a-z0-9]{5}'
  return `${escapeRegex(workload.metadata.name)}-${suffix}`
}

/**
 * The workload a pod belongs to, by its name, which is how pods that are
 * gone are known. Longer names are tried first, so `web-api`'s pods aren't
 * taken for `web`'s.
 */
export function podOwners(workloads: KubeObject[]) {
  const patterns = new Map<string, { key: string; pattern: RegExp }[]>()
  const sorted = [...workloads].sort((a, b) => b.metadata.name.length - a.metadata.name.length)
  for (const w of sorted) {
    const list = patterns.get(w.metadata.namespace!) ?? []
    list.push({ key: keyOf(w), pattern: new RegExp(`^${podRegex(w)}$`) })
    patterns.set(w.metadata.namespace!, list)
  }
  // Each pod is asked about once per query: remembered.
  const owners = new Map<string, string | undefined>()
  return (namespace: string, pod: string): string | undefined => {
    const key = `${namespace}/${pod}`
    if (!owners.has(key)) {
      owners.set(key, patterns.get(namespace)?.find((w) => w.pattern.test(pod))?.key)
    }
    return owners.get(key)
  }
}

interface Tally {
  cpuP95?: number
  cpuMax?: number
  memoryMax?: number
  /** Its first sample's time, in seconds: none yet is now. */
  first: number
  throttled: number
  periods: number
  oomKilled: boolean
}

/**
 * Each workload's containers' usage over the window, from the series of all
 * its pods (gone ones too): the busiest pod's CPU and memory, the earliest
 * sample, throttling over all of them. OOM kills come from kube-state-metrics
 * (a pod's last termination was one, and it restarted in the window) and
 * from the pods there are now. Containers without CPU and memory history
 * aren't measured.
 */
export function measure(
  results: InstantResult['results'],
  pods: KubeObject[],
  ownerOf: (namespace: string, pod: string) => string | undefined,
  now: number,
): Map<string, Map<string, ContainerUsage>> {
  const tallies = new Map<string, Map<string, Tally>>()
  const tally = (namespace: string, pod: string, container: string) => {
    const owner = ownerOf(namespace, pod)
    if (!owner) return undefined
    const containers = tallies.get(owner) ?? new Map<string, Tally>()
    tallies.set(owner, containers)
    const entry = containers.get(container) ?? {
      first: now / 1000,
      throttled: 0,
      periods: 0,
      oomKilled: false,
    }
    containers.set(container, entry)
    return entry
  }
  const series = (id: string) =>
    results
      .find((r) => r.id === id)!
      .series.filter((s): s is typeof s & { value: number } => s.value !== null)
  const restarted = new Set(
    series('restarts')
      .filter((s) => s.value > 0)
      .map(({ labels }) => `${labels.namespace}/${labels.pod}/${labels.container}`),
  )
  const max = (a: number | undefined, b: number) => Math.max(a ?? b, b)
  for (const id of [
    'cpuP95',
    'cpuMax',
    'memoryMax',
    'first',
    'throttled',
    'periods',
    'oomKilled',
  ]) {
    for (const { labels, value } of series(id)) {
      const t = tally(labels.namespace!, labels.pod!, labels.container!)
      if (!t) continue
      if (id === 'cpuP95' || id === 'cpuMax' || id === 'memoryMax') t[id] = max(t[id], value)
      else if (id === 'first') t.first = Math.min(t.first, value)
      else if (id === 'throttled' || id === 'periods') t[id] += value
      else if (restarted.has(`${labels.namespace}/${labels.pod}/${labels.container}`)) {
        t.oomKilled = t.oomKilled || value >= 1
      }
    }
  }
  // The kubelet says why a container last stopped, whether or not kube-state-metrics runs.
  for (const pod of pods) {
    for (const status of pod.status?.containerStatuses ?? []) {
      const terminated = status.lastState?.terminated
      if (
        terminated?.reason === 'OOMKilled' &&
        now - Date.parse(terminated.finishedAt) <= WINDOW * 1000
      ) {
        const t = tally(pod.metadata.namespace!, pod.metadata.name, status.name)
        if (t) t.oomKilled = true
      }
    }
  }

  const measured = new Map<string, Map<string, ContainerUsage>>()
  for (const [owner, containers] of tallies) {
    const usage = new Map<string, ContainerUsage>()
    for (const [name, t] of containers) {
      if (t.cpuP95 === undefined || t.cpuMax === undefined || t.memoryMax === undefined) continue
      usage.set(name, {
        cpuP95: t.cpuP95,
        cpuMax: t.cpuMax,
        memoryMax: t.memoryMax,
        history: Math.max(0, now / 1000 - t.first) / 3600,
        throttled: t.periods > 0 ? t.throttled / t.periods : 0,
        oomKilled: t.oomKilled,
      })
    }
    measured.set(owner, usage)
  }
  return measured
}

// ——— Autoscalers ———

/**
 * The requests a HorizontalPodAutoscaler scales `workload` on: its
 * utilization targets are relative to them. Targets in absolute amounts
 * aren't, and leave requests free to change.
 */
export function scaledOn(hpas: KubeObject[], workload: KubeObject) {
  const scaled: { resource: Resource; container?: string; hpa: string }[] = []
  for (const hpa of hpas) {
    const ref = hpa.spec.scaleTargetRef
    if (
      hpa.metadata.namespace !== workload.metadata.namespace ||
      ref.kind !== workload.kind ||
      ref.name !== workload.metadata.name
    ) {
      continue
    }
    // Without metrics of its own, an autoscaler keeps CPU at 80% of what's requested.
    const metrics = hpa.spec.metrics ?? [
      { type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization' } } },
    ]
    for (const metric of metrics) {
      const source =
        metric.type === 'ContainerResource' ? metric.containerResource : metric.resource
      if (source?.target?.type === 'Utilization' && RESOURCES.includes(source.name)) {
        scaled.push({ resource: source.name, container: source.container, hpa: hpa.metadata.name })
      }
    }
  }
  return scaled
}

/** The VerticalPodAutoscaler that sets `workload`'s requests, if one does (not just recommends). */
export function managedBy(vpas: KubeObject[], workload: KubeObject): KubeObject | undefined {
  return vpas.find(
    (vpa) =>
      vpa.metadata.namespace === workload.metadata.namespace &&
      vpa.spec?.targetRef?.kind === workload.kind &&
      vpa.spec.targetRef.name === workload.metadata.name &&
      (vpa.spec.updatePolicy?.updateMode ?? 'Auto') !== 'Off',
  )
}

// ——— Recommending ———

/** How a request or limit changes: `set` where there was none. */
export type Change = 'raise' | 'lower' | 'set' | 'keep'

export interface Plan {
  current?: number
  recommended?: number
  change: Change
}

export interface ContainerAdvice {
  name: string
  requests: Record<Resource, Plan>
  limits: Record<Resource, Plan>
  usage: ContainerUsage
  /** Why each resource is recommended as it is, in sentences. */
  reasons: Record<Resource, string[]>
}

interface Resources {
  requests?: Record<string, string>
  limits?: Record<string, string>
}

const amount = (values: Record<string, string> | undefined, resource: Resource) =>
  values?.[resource] === undefined ? undefined : parseQuantity(values[resource])

/** Whether going from `current` to `next` is worth a change. */
function worthIt(resource: Resource, current: number, next: number): boolean {
  const floor = resource === 'cpu' ? MIN_CPU_CHANGE : MIN_MEMORY_CHANGE
  // With room for rounding: 125m - 100m is a hair under 25m in floating point.
  return Math.abs(next - current) >= Math.max(floor, current * MIN_CHANGE) - 1e-9
}

const NOUN: Record<Resource, string> = { cpu: 'CPU', memory: 'memory' }

/** One resource of one container: its request and limit, and why. */
function adviseResource(
  resource: Resource,
  { request, limit, explicit }: { request?: number; limit?: number; explicit: boolean },
  usage: ContainerUsage,
  autoscaled: string | undefined,
): { request: Plan; limit: Plan; reasons: string[] } {
  const reasons: string[] = []
  const say = (value: number) => describeAmount(resource, value)
  const cpu = resource === 'cpu'
  // What it needs: CPU covers the 95th percentile, memory the peak, both with headroom.
  let needed = cpu
    ? Math.max(MIN_CPU, roundCpu(usage.cpuP95 * HEADROOM))
    : Math.max(MIN_MEMORY, roundMemory(usage.memoryMax * HEADROOM))
  // The least its limit should be, when it holds it back.
  let limitFloor = 0
  // Why it mustn't be cut, when it mustn't.
  let held = false
  if (cpu && limit !== undefined && usage.throttled >= THROTTLED) {
    limitFloor = Math.max(roundCpu(limit * THROTTLED_BUMP), roundCpu(usage.cpuMax * LIMIT_HEADROOM))
    // Its 95th percentile is still a fair measure, unless the limit held that down too.
    held = usage.cpuP95 >= limit * NEAR_LIMIT
    reasons.push(
      held
        ? `Its limit throttled it in ${Math.round(usage.throttled * 100)}% of its CPU periods, so it used less than it needed: the limit goes up to ${say(limitFloor)}, and the request isn’t lowered.`
        : `Its limit throttled it in ${Math.round(usage.throttled * 100)}% of its CPU periods, in bursts above its usual use: the limit goes up to ${say(limitFloor)}.`,
    )
  }
  if (!cpu && usage.oomKilled) {
    held = true
    // What it used was cut short at its limit (or by the node): it needs more than that.
    needed = Math.max(needed, roundMemory((limit ?? usage.memoryMax) * OOM_BUMP))
    limitFloor = needed
    reasons.push(
      `It was OOM-killed in the last 7 days, so what it used was cut short: it needs at least ${say(needed)}, a quarter more than ${limit === undefined ? 'its peak' : 'its limit'}.`,
    )
  } else if (!cpu && limit !== undefined && usage.memoryMax >= limit * NEAR_LIMIT) {
    limitFloor = roundMemory(usage.memoryMax * HEADROOM)
    reasons.push(
      `Its peak is within ${Math.round((1 - NEAR_LIMIT) * 100)}% of its limit, a spike away from an OOM kill: the limit goes up to ${say(limitFloor)}.`,
    )
  }
  if (!explicit && request !== undefined) {
    reasons.push(`It sets no request, so it requests its limit, ${say(request)}.`)
  }

  let change: Change =
    request === undefined
      ? 'set'
      : !worthIt(resource, request, needed)
        ? 'keep'
        : needed > request
          ? 'raise'
          : 'lower'
  if (autoscaled && request !== undefined) {
    change = 'keep'
    reasons.push(
      `${autoscaled} scales it on its ${NOUN[resource]} use relative to this request, so the request stays: changing it would change when it scales.`,
    )
  } else if (change === 'lower' && held) {
    change = 'keep'
  } else if (change === 'set') {
    reasons.push(
      `It requests no ${NOUN[resource]}, so the scheduler places it as if it used none: ${say(needed)} covers ${cpu ? '95% of its use' : 'its peak'}, with 15% headroom.`,
    )
  } else if (change === 'raise') {
    reasons.push(
      held
        ? `Its request goes up to ${say(needed)}.`
        : `It uses more than it requests: ${say(needed)} covers ${cpu ? '95% of its use' : 'its peak'}, with 15% headroom.`,
    )
  } else if (change === 'lower') {
    reasons.push(
      `${say(needed)} covers ${cpu ? '95% of its use' : 'its peak'} with 15% headroom, ${say(request! - needed)} a pod less than it requests.`,
    )
  } else if (!held) {
    reasons.push(
      `Its request is within ${MIN_CHANGE * 100}% of the ${say(needed)} it needs, close enough to leave.`,
    )
  }
  const recommended = change === 'keep' ? request! : needed

  // Limits never go down: only up, to what holds it back no longer, and to its request.
  let nextLimit = limit
  if (limit !== undefined) {
    nextLimit = Math.max(limit, limitFloor, recommended)
    if (nextLimit > limit && nextLimit === recommended && nextLimit > limitFloor) {
      reasons.push(`Its limit goes up to ${say(nextLimit)}, as it can’t be below the request.`)
    }
    if (recommended < limit && request === limit) {
      reasons.push(
        `Its request ${explicit ? 'equals' : 'is'} its limit now: below it, its pods are Burstable rather than Guaranteed.`,
      )
    }
  }
  return {
    request: { current: request, recommended, change },
    limit: {
      current: limit,
      recommended: nextLimit,
      change: nextLimit === limit ? 'keep' : 'raise',
    },
    reasons,
  }
}

/** What one container should request, and what its limits should be. */
export function adviseContainer(
  name: string,
  resources: Resources | undefined,
  usage: ContainerUsage,
  /** The autoscaler that scales it on each resource, if one does. */
  autoscaled: Partial<Record<Resource, string>>,
): ContainerAdvice {
  const each = RESOURCES.map((resource) => {
    const limit = amount(resources?.limits, resource)
    const request = amount(resources?.requests, resource)
    // A limit without a request is the request too: Kubernetes defaults it so.
    return adviseResource(
      resource,
      { request: request ?? limit, limit, explicit: request !== undefined },
      usage,
      autoscaled[resource],
    )
  })
  const [cpu, memory] = each as [(typeof each)[0], (typeof each)[0]]
  return {
    name,
    usage,
    requests: { cpu: cpu.request, memory: memory.request },
    limits: { cpu: cpu.limit, memory: memory.limit },
    reasons: { cpu: cpu.reasons, memory: memory.reasons },
  }
}

export type Verdict =
  /** Needs more than it has: it's OOM-killed, throttled, or uses more than it requests. */
  | 'under'
  /** Requests nothing for CPU or memory: the scheduler doesn't know what it uses. */
  | 'unset'
  /** Requests more than it uses. */
  | 'over'
  | 'fine'
  /** Less than a day of history. */
  | 'young'
  /** No usage in the window. */
  | 'unknown'
  /** A VerticalPodAutoscaler sets its requests. */
  | 'managed'

export type Confidence = 'high' | 'medium' | 'low'

export interface WorkloadAdvice {
  verdict: Verdict
  confidence?: Confidence
  /** Hours of history the recommendation is based on (its longest-measured container's). */
  history: number
  replicas: number
  containers: ContainerAdvice[]
  /** Containers of its template with no usage in the window. */
  unmeasured: string[]
  /** What its requests change by across its replicas: negative frees capacity. */
  delta: Record<Resource, number>
  /** A pod's requests (all its containers'), now and as recommended. */
  pod: Record<Resource, { current: number; recommended: number }>
  /** The same across its replicas. */
  totals: Record<Resource, { current: number; recommended: number }>
  /** Why there's no recommendation, when there isn't. */
  note?: string
}

/** The containers of a workload's pod template. */
export function containersOf(workload: KubeObject): { name: string; resources?: Resources }[] {
  return workload.spec.template.spec.containers
}

/** How many pods a workload runs: the replicas it wants, or for a DaemonSet, the nodes it's on. */
export function replicasOf(workload: KubeObject): number {
  return workload.kind === 'DaemonSet'
    ? (workload.status?.desiredNumberScheduled ?? 0)
    : (workload.spec.replicas ?? 1)
}

const DAYS = new Intl.NumberFormat('en', { style: 'unit', unit: 'day', unitDisplay: 'long' })
const HOURS = new Intl.NumberFormat('en', { style: 'unit', unit: 'hour', unitDisplay: 'long' })

/** "7 days", "36 hours". */
export function describeHistory(hours: number): string {
  return hours >= 48 ? DAYS.format(Math.round(hours / 24)) : HOURS.format(Math.floor(hours))
}

/**
 * What a workload's containers should request, from what each used: its
 * verdict, how sure that is, and what it changes across its replicas.
 * Containers injected into its pods at runtime (service mesh proxies) aren't
 * in its template, so they're left alone.
 */
export function adviseWorkload(
  workload: KubeObject,
  usage: Map<string, ContainerUsage> | undefined,
  autoscalers: { hpas: KubeObject[]; vpas: KubeObject[] },
): WorkloadAdvice {
  const replicas = replicasOf(workload)
  const template = containersOf(workload)
  const measured = template.filter((c) => usage?.has(c.name))
  const history = Math.max(0, ...measured.map((c) => usage!.get(c.name)!.history))
  const current = { cpu: 0, memory: 0 }
  for (const c of template) {
    for (const resource of RESOURCES) {
      const value = amount(c.resources?.requests, resource) ?? amount(c.resources?.limits, resource)
      current[resource] += value ?? 0
    }
  }
  const sizes = (change: Record<Resource, number>) => {
    const of = (resource: Resource, n: number) => ({
      current: current[resource] * n,
      recommended: (current[resource] + change[resource]) * n,
    })
    return {
      delta: { cpu: change.cpu * replicas, memory: change.memory * replicas },
      pod: { cpu: of('cpu', 1), memory: of('memory', 1) },
      totals: { cpu: of('cpu', replicas), memory: of('memory', replicas) },
    }
  }
  const base = {
    history,
    replicas,
    containers: [],
    unmeasured: template.filter((c) => !usage?.has(c.name)).map((c) => c.name),
    ...sizes({ cpu: 0, memory: 0 }),
  }
  const vpa = managedBy(autoscalers.vpas, workload)
  if (vpa) {
    return {
      ...base,
      verdict: 'managed',
      note: `The VerticalPodAutoscaler ${vpa.metadata.name} sets its requests.`,
    }
  }
  if (measured.length === 0) {
    return {
      ...base,
      verdict: 'unknown',
      note:
        replicas === 0
          ? 'It has no pods, and had none in the last 7 days.'
          : 'Prometheus has no CPU and memory use for its containers in the last 7 days.',
    }
  }
  if (history < MIN_HISTORY) {
    return {
      ...base,
      verdict: 'young',
      note: `It has ${describeHistory(history)} of history: recommendations need a day.`,
    }
  }

  const scaled = scaledOn(autoscalers.hpas, workload)
  const containers = measured.map((c) => {
    const autoscaled: Partial<Record<Resource, string>> = {}
    for (const s of scaled) {
      if (s.container === undefined || s.container === c.name) {
        autoscaled[s.resource] = `The HorizontalPodAutoscaler ${s.hpa}`
      }
    }
    return adviseContainer(c.name, c.resources, usage!.get(c.name)!, autoscaled)
  })
  // What a pod's requests change by.
  const change = { cpu: 0, memory: 0 }
  for (const c of containers) {
    for (const resource of RESOURCES) {
      const { current, recommended } = c.requests[resource]
      change[resource] += recommended! - (current ?? 0)
    }
  }
  const changes = containers.flatMap((c) =>
    RESOURCES.flatMap((r) => [c.requests[r].change, c.limits[r].change]),
  )
  const verdict: Verdict = changes.includes('raise')
    ? 'under'
    : changes.includes('set')
      ? 'unset'
      : changes.includes('lower')
        ? 'over'
        : 'fine'
  return {
    ...base,
    verdict,
    confidence: history >= GOOD_HISTORY ? 'high' : history >= 3 * 24 ? 'medium' : 'low',
    containers,
    ...sizes(change),
  }
}

/** The containers whose requests or limits the advice changes. */
export function changedContainers(advice: WorkloadAdvice): ContainerAdvice[] {
  return advice.containers.filter((c) =>
    RESOURCES.some((r) => c.requests[r].change !== 'keep' || c.limits[r].change !== 'keep'),
  )
}

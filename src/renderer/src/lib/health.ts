import type { KubeObject } from '@shared/api'
import { isBuiltinKind, type BuiltinKind, type ResourceKind } from '@shared/resources'
import { viewFor, viewStatus } from './views'

/**
 * Health is the one status vocabulary used everywhere in the UI. Each level
 * maps to a reserved status color and always ships with an icon + label.
 */
export type Health = 'healthy' | 'progressing' | 'warning' | 'critical' | 'neutral'

export interface Status {
  health: Health
  label: string
  /** Longer explanation, e.g. a scheduler message. */
  detail?: string
}

/** Sort order and severity: most urgent first. */
export const HEALTH_RANK: Record<Health, number> = {
  critical: 0,
  warning: 1,
  progressing: 2,
  healthy: 3,
  neutral: 4,
}

// Container waiting reasons that are part of a normal start-up.
const STARTING = new Set(['ContainerCreating', 'PodInitializing'])

interface ContainerStatus {
  name: string
  ready: boolean
  restartCount: number
  state?: {
    waiting?: { reason?: string; message?: string }
    running?: { startedAt?: string }
    terminated?: { reason?: string; exitCode?: number }
  }
}

interface Condition {
  type: string
  status: string
  reason?: string
  message?: string
}

export function containerStatuses(pod: KubeObject): ContainerStatus[] {
  return pod.status?.containerStatuses ?? []
}

function condition(object: KubeObject, type: string): Condition | undefined {
  return (object.status?.conditions as Condition[] | undefined)?.find((c) => c.type === type)
}

export function podStatus(pod: KubeObject): Status {
  const phase: string = pod.status.phase
  if (pod.metadata.deletionTimestamp) return { health: 'warning', label: 'Terminating' }
  if (phase === 'Succeeded') return { health: 'neutral', label: 'Completed' }

  const statuses = [...(pod.status?.initContainerStatuses ?? []), ...containerStatuses(pod)]
  const waiting = statuses.find((c) => c.state?.waiting?.reason)?.state?.waiting
  if (phase === 'Failed') {
    const terminated = statuses.find((c) => c.state?.terminated)?.state?.terminated
    // kubectl's order: the pod's own reason (e.g. Evicted), then the container's (e.g. OOMKilled).
    return {
      health: 'critical',
      label: pod.status.reason ?? terminated?.reason ?? 'Failed',
      detail: pod.status.message,
    }
  }
  if (waiting) {
    return {
      health: STARTING.has(waiting.reason!) ? 'progressing' : 'critical',
      label: waiting.reason!,
      detail: waiting.message,
    }
  }
  if (phase === 'Pending') {
    const scheduled = condition(pod, 'PodScheduled')
    return { health: 'warning', label: scheduled?.reason ?? 'Pending', detail: scheduled?.message }
  }
  if (phase === 'Running') {
    const ready = containerStatuses(pod).every((c) => c.ready)
    return ready
      ? { health: 'healthy', label: 'Running' }
      : { health: 'warning', label: 'Not ready' }
  }
  return { health: 'warning', label: phase }
}

export function replicaStatus(ready: number, desired: number): Status {
  if (desired === 0) return { health: 'neutral', label: 'Scaled to zero' }
  if (ready >= desired) return { health: 'healthy', label: 'Ready' }
  return ready === 0
    ? { health: 'critical', label: 'Unavailable' }
    : { health: 'warning', label: 'Degraded' }
}

/** Ready vs desired replicas for the replicated workload kinds. */
export function replicaCounts(object: KubeObject): { ready: number; desired: number } {
  if (object.kind === 'DaemonSet') {
    return { ready: object.status.numberReady, desired: object.status.desiredNumberScheduled }
  }
  // The API server omits readyReplicas while it is zero.
  return { ready: object.status.readyReplicas ?? 0, desired: object.spec.replicas }
}

export function nodeStatus(node: KubeObject): Status {
  const ready = condition(node, 'Ready')
  if (ready?.status !== 'True') {
    return { health: 'critical', label: 'NotReady', detail: ready?.message }
  }
  const pressure = (node.status.conditions as Condition[]).find(
    (c) => c.type !== 'Ready' && c.status === 'True',
  )
  if (pressure) return { health: 'warning', label: pressure.type, detail: pressure.message }
  if (node.spec?.unschedulable) return { health: 'warning', label: 'Cordoned' }
  return { health: 'healthy', label: 'Ready' }
}

export function jobStatus(job: KubeObject): Status {
  const failed = condition(job, 'Failed')
  if (failed?.status === 'True') {
    return { health: 'critical', label: 'Failed', detail: failed.message }
  }
  if (condition(job, 'Complete')?.status === 'True') return { health: 'healthy', label: 'Complete' }
  return { health: 'progressing', label: 'Running' }
}

const STATUS_BY_KIND: Partial<Record<BuiltinKind, (object: KubeObject) => Status>> = {
  Pod: podStatus,
  Node: nodeStatus,
  Job: jobStatus,
  Deployment: (o) => replicaStatusOf(o),
  StatefulSet: (o) => replicaStatusOf(o),
  DaemonSet: (o) => replicaStatusOf(o),
  ReplicaSet: (o) => replicaStatusOf(o),
  CronJob: (o) =>
    o.spec?.suspend
      ? { health: 'neutral', label: 'Suspended' }
      : { health: 'healthy', label: 'Scheduled' },
  Namespace: (o) =>
    o.status?.phase === 'Active'
      ? { health: 'healthy', label: 'Active' }
      : { health: 'warning', label: o.status?.phase },
  PersistentVolumeClaim: (o) =>
    o.status?.phase === 'Bound'
      ? { health: 'healthy', label: 'Bound' }
      : { health: 'warning', label: o.status?.phase },
  PersistentVolume: (o) =>
    ['Bound', 'Available'].includes(o.status?.phase)
      ? { health: 'healthy', label: o.status.phase }
      : { health: 'warning', label: o.status?.phase },
  HorizontalPodAutoscaler: autoscalerStatus,
  Event: (o) =>
    o.type === 'Warning'
      ? { health: 'warning', label: 'Warning' }
      : { health: 'neutral', label: 'Normal' },
}

function autoscalerStatus(hpa: KubeObject): Status {
  const active = condition(hpa, 'ScalingActive')
  if (active?.status === 'False') {
    return { health: 'warning', label: 'Not scaling', detail: active.message }
  }
  const limited = condition(hpa, 'ScalingLimited')
  return limited?.status === 'True'
    ? { health: 'warning', label: 'At limit', detail: limited.message }
    : { health: 'healthy', label: 'Scaling' }
}

function replicaStatusOf(object: KubeObject): Status {
  const { ready, desired } = replicaCounts(object)
  return replicaStatus(ready, desired)
}

/** Whether `kind` has a meaningful health status at all. */
/** Whether a built-in kind has a status; other kinds have one when their objects say. */
export function hasHealth(kind: ResourceKind): boolean {
  return kind in STATUS_BY_KIND
}

/**
 * An object's status: from KubeStacks' rules for built-in kinds, a view's
 * rules, or the conventions most controllers follow. Null when its kind
 * says nothing about health.
 */
export function statusFor(kind: ResourceKind, object: KubeObject): Status | null {
  if (isBuiltinKind(kind)) return STATUS_BY_KIND[kind]?.(object) ?? null
  const view = viewFor(kind)
  return (view && viewStatus(view, object)) ?? conventionalStatus(object)
}

const UNKNOWN: Status = { health: 'neutral', label: 'Unknown' }

export function statusOf(kind: ResourceKind, object: KubeObject): Status {
  return statusFor(kind, object) ?? UNKNOWN
}

/** Conditions that say an object is fine, in the order they're looked for. */
const GOOD_CONDITIONS = [
  'Ready',
  'Available',
  'Healthy',
  'Programmed',
  'Established',
  'Succeeded',
  'Accepted',
]

/** Conditions that, while true, mean the controller is still working on it. */
const WORKING_CONDITIONS = ['Reconciling', 'Issuing']

const PHASES: [RegExp, Health][] = [
  [/fail|error|unhealthy|degraded|crash|invalid|reject|lost|broken|abort/i, 'critical'],
  [
    /pending|progress|creating|provisioning|initiali[sz]ing|starting|deploying|updating|upgrading|installing|reconciling|syncing|waiting|scaling|terminating|deleting|restoring|setting up/i,
    'progressing',
  ],
  [/missing|warn/i, 'warning'],
  [/suspend|paus|stopped/i, 'neutral'],
  [
    /healthy|running|active|ready|available|bound|succe|complete|established|deployed|synced|online/i,
    'healthy',
  ],
]

/**
 * What the conventions most controllers follow say: deletion, suspension,
 * kstatus' Stalled and Reconciling conditions, a Ready-like condition, a
 * spec the controller hasn't caught up with, Argo's health, or a phase.
 */
export function conventionalStatus(object: KubeObject): Status | null {
  if (object.metadata.deletionTimestamp) return { health: 'warning', label: 'Terminating' }
  if (object.spec?.suspend === true) return { health: 'neutral', label: 'Suspended' }
  if (object.spec?.paused === true) return { health: 'neutral', label: 'Paused' }
  const conditions = (object.status?.conditions ?? []) as Condition[]
  const isTrue = (type: string) => conditions.find((c) => c.type === type && c.status === 'True')
  const stalled = isTrue('Stalled')
  if (stalled) {
    return { health: 'critical', label: stalled.reason || 'Stalled', detail: stalled.message }
  }
  const working = WORKING_CONDITIONS.map(isTrue).find(Boolean)
  const good = GOOD_CONDITIONS.map((type) => conditions.find((c) => c.type === type)).find(Boolean)
  if (good?.status === 'False' && !working) {
    return {
      health: 'critical',
      label: good.reason || `Not ${good.type.toLowerCase()}`,
      detail: good.message,
    }
  }
  // A changed spec the controller hasn't seen yet is still on its way.
  const generation = object.metadata.generation
  const observed = object.status?.observedGeneration
  if (
    working ||
    (generation !== undefined && observed !== undefined && Number(observed) < generation)
  ) {
    return {
      health: 'progressing',
      label: working?.reason || 'Reconciling',
      detail: working?.message,
    }
  }
  if (good) {
    return good.status === 'True'
      ? { health: 'healthy', label: good.type }
      : { health: 'progressing', label: good.reason || 'Unknown', detail: good.message }
  }
  const health = object.status?.health as { status?: string; message?: string } | undefined
  if (typeof health?.status === 'string') return phaseStatus(health.status, health.message)
  const phase = object.status?.phase ?? object.status?.state
  return typeof phase === 'string' && phase ? phaseStatus(phase) : null
}

function phaseStatus(phase: string, detail?: string): Status {
  const health = PHASES.find(([pattern]) => pattern.test(phase))?.[1] ?? 'neutral'
  return { health, label: phase, ...(detail ? { detail } : {}) }
}

const DEFAULT_NAMES: Record<Health, string> = {
  healthy: 'Healthy',
  progressing: 'In progress',
  warning: 'Warning',
  critical: 'Failing',
  neutral: 'Inactive',
}

/** What each health level is called for a kind, in filter chips ("Running", "Normal"…). */
const NAMES: Partial<Record<BuiltinKind, Partial<Record<Health, string>>>> = {
  Pod: { healthy: 'Running', progressing: 'Starting', neutral: 'Completed' },
  Event: { neutral: 'Normal' },
  Job: { healthy: 'Complete', progressing: 'Running' },
  CronJob: { healthy: 'Scheduled', neutral: 'Suspended' },
  ReplicaSet: {
    healthy: 'Ready',
    warning: 'Degraded',
    critical: 'Unavailable',
    neutral: 'Scaled to zero',
  },
  Namespace: { healthy: 'Active', warning: 'Terminating' },
}

export function healthName(kind: ResourceKind, health: Health): string {
  return (isBuiltinKind(kind) ? NAMES[kind]?.[health] : undefined) ?? DEFAULT_NAMES[health]
}

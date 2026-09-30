import type { KubeObject } from '@shared/api'
import type { ResourceKind } from '@shared/resources'

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

const STATUS_BY_KIND: Partial<Record<ResourceKind, (object: KubeObject) => Status>> = {
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
  Event: (o) =>
    o.type === 'Warning'
      ? { health: 'warning', label: 'Warning' }
      : { health: 'neutral', label: 'Normal' },
}

function replicaStatusOf(object: KubeObject): Status {
  const { ready, desired } = replicaCounts(object)
  return replicaStatus(ready, desired)
}

/** Whether `kind` has a meaningful health status at all. */
export function hasHealth(kind: ResourceKind): boolean {
  return kind in STATUS_BY_KIND
}

export function statusOf(kind: ResourceKind, object: KubeObject): Status {
  return STATUS_BY_KIND[kind]!(object)
}

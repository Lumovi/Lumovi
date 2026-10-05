import type { KubeObject } from '@shared/api'
import { conventionalStatus, STATUS_BY_KIND, type Health, type Status } from '@shared/health'
import { isBuiltinKind, type BuiltinKind, type ResourceKind } from '@shared/resources'
import { viewFor, viewStatus } from './views'

export {
  containerStatuses,
  conventionalStatus,
  HEALTH_RANK,
  jobStatus,
  nodeStatus,
  podStatus,
  replicaCounts,
  replicaStatus,
  type Health,
  type Status,
} from '@shared/health'

/** Whether `kind` has a meaningful health status at all. */
/** Whether a built-in kind has a status; other kinds have one when their objects say. */
export function hasHealth(kind: ResourceKind): boolean {
  return kind in STATUS_BY_KIND
}

/**
 * An object's status: from Lumovi's rules for built-in kinds, a view's
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

/** What each health level is called where no kind gives it a name of its own. */
export const HEALTH_NAMES: Record<Health, string> = {
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
  return (isBuiltinKind(kind) ? NAMES[kind]?.[health] : undefined) ?? HEALTH_NAMES[health]
}

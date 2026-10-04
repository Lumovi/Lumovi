import type { KubeObject } from '@shared/api'
import { STATUS_BY_KIND, type Condition, type Health, type Status } from '@shared/health'
import { isBuiltinKind, type BuiltinKind, type ResourceKind } from '@shared/resources'
import { viewFor, viewStatus } from './views'

export {
  containerStatuses,
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

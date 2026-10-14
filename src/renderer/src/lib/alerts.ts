/**
 * Prometheus's alerts as the Alerts page reads them: each one's severity and level, the object
 * its labels name, how long it has fired or when it fires, the order they're listed in, and how
 * many alerting rules are quiet. Plain functions of what the source answered.
 */
import type { PrometheusAlert, PrometheusAlerts } from '@shared/api'
import type { Health } from '@shared/health'
import { age } from './format'

/** A severity as its label says it; any other word, or none, is "none" (Watchdog's). */
export type Severity = 'critical' | 'warning' | 'info' | 'none'
export const SEVERITIES: Severity[] = ['critical', 'warning', 'info', 'none']
export const SEVERITY_WORDS: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
  none: 'None',
}
/** Critical red, Warning amber, Info and none quiet. */
export const SEVERITY_LEVEL: Record<Severity, Health> = {
  critical: 'critical',
  warning: 'warning',
  info: 'neutral',
  none: 'neutral',
}

export function severityOf(alert: PrometheusAlert): Severity {
  const said = alert.labels.severity?.toLowerCase()
  return said === 'critical' || said === 'warning' || said === 'info' ? said : 'none'
}

/** The object an alert is about, by the labels Kubernetes' usual rules give it. */
export interface AlertObject {
  kind:
    | 'Pod'
    | 'Deployment'
    | 'StatefulSet'
    | 'DaemonSet'
    | 'Job'
    | 'PersistentVolumeClaim'
    | 'Service'
    | 'Node'
  name: string
  namespace?: string
}

const NAMESPACED: [string, AlertObject['kind']][] = [
  ['pod', 'Pod'],
  ['deployment', 'Deployment'],
  ['statefulset', 'StatefulSet'],
  ['daemonset', 'DaemonSet'],
  ['job_name', 'Job'],
  ['persistentvolumeclaim', 'PersistentVolumeClaim'],
  ['service', 'Service'],
]

export function objectOf(alert: PrometheusAlert): AlertObject | undefined {
  const { namespace, node } = alert.labels
  if (namespace) {
    for (const [label, kind] of NAMESPACED) {
      const name = alert.labels[label]
      if (name) return { kind, name, namespace }
    }
  }
  return node ? { kind: 'Node', name: node } : undefined
}

/** A short, stable name for an alert: its rule's, and a hash of its group and labels. */
export function alertId(alert: PrometheusAlert): string {
  const labels = Object.keys(alert.labels)
    .sort()
    .map((key) => `${key}=${alert.labels[key]}`)
    .join(',')
  let hash = 2166136261
  for (const char of `${alert.group}/${labels}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  }
  return `${alert.name}~${hash.toString(36)}`
}

/** A span of time as kubectl prints an age: 42s, 11m, 1h30m. */
const span = (ms: number, now: number) => age(new Date(now - Math.max(0, ms)).toISOString(), now)

/** Its state's second line: how long it has fired, or when it fires if its condition holds. */
export function stateLine(alert: PrometheusAlert, now: number): string | undefined {
  if (alert.activeAt === undefined) return undefined
  const fires = alert.activeAt + alert.for * 1000
  return alert.state === 'firing'
    ? `for ${span(now - fires, now)}`
    : `fires in ${span(fires - now, now)}`
}

/** Worst first, firing before pending within a severity, then the one that began first. */
export function byConcern(a: PrometheusAlert, b: PrometheusAlert): number {
  return (
    SEVERITIES.indexOf(severityOf(a)) - SEVERITIES.indexOf(severityOf(b)) ||
    Number(a.state === 'pending') - Number(b.state === 'pending') ||
    (a.activeAt ?? Infinity) - (b.activeAt ?? Infinity) ||
    alertId(a).localeCompare(alertId(b))
  )
}

/**
 * Its alerting rules that are quiet, and those of severity none, which fire on purpose and are
 * never counted: firing, or quiet.
 */
export function ruleCounts(answer: PrometheusAlerts): {
  quiet: number
  none: number
  /** The first rule of severity none, by name. */
  firstNone?: string
} {
  const none = answer.rules.filter((rule) => (rule.severity ?? 'none').toLowerCase() === 'none')
  const counted = answer.rules.filter((rule) => !none.includes(rule))
  return {
    quiet: counted.filter((rule) => !rule.active).length,
    none: none.length,
    ...(none[0] ? { firstNone: none[0].name } : {}),
  }
}

/** Whether an alert is under the namespaces shown (all, where none are picked): one with none only under all. */
export const inNamespaces = (alert: PrometheusAlert, namespaces: readonly string[] | null) =>
  !namespaces?.length ||
  (alert.labels.namespace !== undefined && namespaces.includes(alert.labels.namespace))

/** What the text filter matches: its name, its summary and its labels' values. */
export const matchesText = (alert: PrometheusAlert, needle: string) =>
  needle === '' ||
  [alert.name, alert.annotations.summary ?? '', ...Object.values(alert.labels)]
    .join('\n')
    .toLowerCase()
    .includes(needle.toLowerCase())

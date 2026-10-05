/**
 * What's wrong in a cluster, in one answer: the nodes, pods, workloads, jobs
 * and volume claims whose health is a warning or critical, with Lumovi's
 * reasons, and the warnings Kubernetes reported in the last hour.
 */
import type { KubeObject } from '@shared/api'
import { eventCount, lastSeen } from '@shared/events'
import { HEALTH_RANK } from '@shared/health'
import type { BuiltinKind } from '@shared/resources'
import type { KubeService } from '../kube/service'
import { age, describeStatus, involved, statusOf } from './present'

const KINDS: readonly BuiltinKind[] = [
  'Node',
  'Pod',
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'Job',
  'PersistentVolumeClaim',
]
const HOUR = 3_600_000
/** Warnings shown, the most frequent first. */
const MAX_WARNINGS = 20

export interface Problems {
  problems: Record<string, unknown>[]
  warnings: Record<string, unknown>[]
  /** Kinds that couldn't be looked at, and why. */
  unchecked: string[]
}

export async function findProblems(
  kube: KubeService,
  context: string,
  namespace: string | undefined,
  now: number,
): Promise<Problems> {
  // A namespace's: nodes aren't in one.
  const kinds = namespace ? KINDS.filter((kind) => kind !== 'Node') : KINDS
  const [events, ...lists] = await Promise.all([
    kube.list({ context, kind: 'Event', namespace }),
    ...kinds.map((kind) => kube.list({ context, kind, namespace })),
  ])
  const found: { rank: number; problem: Record<string, unknown> }[] = []
  const unchecked: string[] = []
  lists.forEach((list, i) => {
    const kind = kinds[i]!
    if (!list.ok) {
      unchecked.push(`${kind}: ${list.error.message}`)
      return
    }
    for (const object of list.data.items) {
      const status = statusOf(kind, object)!
      if (status.health !== 'critical' && status.health !== 'warning') continue
      found.push({
        rank: HEALTH_RANK[status.health],
        problem: {
          object: `${kind}/${object.metadata.name}`,
          ...(object.metadata.namespace ? { namespace: object.metadata.namespace } : {}),
          status: describeStatus(status),
          age: age(object.metadata.creationTimestamp!, now),
        },
      })
    }
  })
  if (!events.ok) unchecked.push(`Event: ${events.error.message}`)
  return {
    problems: found.sort((a, b) => a.rank - b.rank).map(({ problem }) => problem),
    warnings: events.ok ? recentWarnings(events.data.items, now) : [],
    unchecked,
  }
}

/** When an event last happened, in milliseconds. */
const seen = (event: KubeObject) => Date.parse(lastSeen(event))

/** The last hour's warnings, one an object and reason, the most frequent first. */
function recentWarnings(events: KubeObject[], now: number): Record<string, unknown>[] {
  const grouped = new Map<string, { count: number; last: number; event: KubeObject }>()
  for (const event of events) {
    if (event.type !== 'Warning' || seen(event) < now - HOUR) continue
    const { kind, name, namespace } = involved(event)
    const key = `${namespace}/${kind}/${name}/${event.reason}`
    const group = grouped.get(key)
    const count = eventCount(event)
    if (!group) grouped.set(key, { count, last: seen(event), event })
    else {
      group.count += count
      group.last = Math.max(group.last, seen(event))
    }
  }
  return [...grouped.values()]
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .slice(0, MAX_WARNINGS)
    .map(({ count, last, event }) => ({
      object: `${involved(event).kind}/${involved(event).name}`,
      ...(involved(event).namespace ? { namespace: involved(event).namespace } : {}),
      reason: event.reason,
      message: event.message,
      count,
      last: `${age(new Date(last).toISOString(), now)} ago`,
    }))
}

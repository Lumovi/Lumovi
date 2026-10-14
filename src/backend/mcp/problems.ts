/**
 * What's wrong in a cluster, in one answer: the nodes, pods, workloads, jobs
 * and volume claims whose health is a warning or critical, with Lumovi's
 * reasons, and the warnings Kubernetes reported in the last hour. For a pod,
 * why each of its failing containers fails: how its last run ended, and (read
 * by the tool, where logs may be) the last error lines of that run. And the
 * workloads whose config could hurt their data, healthy as they may be.
 */
import type { KubeObject } from '@shared/api'
import { eventCount, lastSeen } from '@shared/events'
import { containerStatuses, HEALTH_RANK } from '@shared/health'
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
/** Problems shown, the worst first: past them, how many more. */
export const MAX_PROBLEMS = 100
/** Workloads with risky config shown: past them, how many more. */
export const MAX_RISKY = 20
/** Workloads whose config find_problems reads for what could hurt their data. */
const WORKLOADS: readonly BuiltinKind[] = ['Deployment', 'StatefulSet', 'DaemonSet']

export interface Problems {
  problems: Record<string, unknown>[]
  warnings: Record<string, unknown>[]
  /** Workloads, healthy or not, whose config could hurt their data. */
  risky: Record<string, unknown>[]
  /** Kinds that couldn't be looked at, and why. */
  unchecked: string[]
  /** Problems past those shown. */
  more: number
}

/** A container that keeps failing: how its last run ended, as the cluster says. */
export interface Failing {
  container: string
  restarts: number
  /** Why it isn't running now (CrashLoopBackOff, Error…), and the cluster's words for it. */
  now?: string
  lastRun?: { exitCode?: number; reason?: string; message?: string; ended?: string }
  /** Its last run's last error lines, where the tool could read them; or why not. */
  lastLines?: string[]
  lastLinesNot?: string
}

/** The containers of a pod that keep failing or aren't running, each with how its last run ended. */
export function failingContainers(pod: KubeObject, now: number): Failing[] {
  const failing: Failing[] = []
  for (const status of containerStatuses(pod)) {
    const waiting = status.state?.waiting
    const terminated = status.state?.terminated as Terminated | undefined
    const last = (status as { lastState?: { terminated?: Terminated } }).lastState?.terminated
    const ended = terminated ?? last
    const failed =
      (waiting && waiting.reason !== 'ContainerCreating' && waiting.reason !== 'PodInitializing') ||
      (terminated && terminated.exitCode !== 0) ||
      (!status.ready && status.restartCount > 0)
    if (!failed) continue
    failing.push({
      container: status.name,
      restarts: status.restartCount,
      ...(waiting?.reason
        ? { now: waiting.message ? `${waiting.reason}: ${waiting.message}` : waiting.reason }
        : {}),
      ...(ended
        ? {
            lastRun: {
              ...(ended.exitCode === undefined ? {} : { exitCode: ended.exitCode }),
              ...(ended.reason ? { reason: ended.reason } : {}),
              ...(ended.message ? { message: cut(ended.message, 500) } : {}),
              ...(ended.finishedAt ? { ended: `${age(ended.finishedAt, now)} ago` } : {}),
            },
          }
        : {}),
    })
  }
  return failing
}

interface Terminated {
  exitCode?: number
  reason?: string
  message?: string
  finishedAt?: string
}

/** A line, at most so long: what's cut is said to be. */
export const cut = (line: string, most: number) =>
  line.length > most ? `${line.slice(0, most)}… (${line.length - most} more characters)` : line

/** What a line that tells of a failure says: an error's words, or a structured log's level. */
const FAILURE =
  /\b(error|fatal|panic|exception|refused|denied|failed|failure|cannot|can't|unable|incompatible|invalid|segmentation|killed)\b|"level"\s*:\s*"(error|fatal|critical|panic)"/i

/**
 * Of a run's last lines, the last few that tell of a failure; where none does, its very last
 * lines. Each at most so long.
 */
export function errorLines(logs: string, most = 5): string[] {
  const lines = logs.split('\n').filter((line) => line.trim() !== '')
  const failures = lines.filter((line) => FAILURE.test(line))
  return (failures.length ? failures : lines).slice(-most).map((line) => cut(line, 300))
}

/**
 * How an image's tag moves, where it does: none (so latest), latest, or a major version alone
 * (16, v2, 16-alpine). Nothing for one that names a version, or a digest.
 */
export function floatingTag(image: string): string | undefined {
  if (image.includes('@')) return undefined
  const colon = image.lastIndexOf(':')
  const tag = colon > image.lastIndexOf('/') ? image.slice(colon + 1) : ''
  if (tag === '') return 'no tag, so latest'
  if (tag === 'latest') return 'latest'
  if (/^v?\d{1,3}(?:-[a-z][\w.-]*)?$/i.test(tag)) return 'a major version alone'
  return undefined
}

interface Container {
  name: string
  image?: string
  imagePullPolicy?: string
}

/**
 * A workload that keeps data (a volume claim) and runs an image whose tag moves, pulled again
 * whenever a pod starts (imagePullPolicy Always, as it is unless said for latest): what
 * find_problems warns of, with the containers that do. Nothing for one that doesn't.
 */
export function riskyConfig(kind: string, workload: KubeObject): Record<string, unknown> | null {
  const spec = workload.spec?.template?.spec as
    | {
        containers?: Container[]
        initContainers?: Container[]
        volumes?: { persistentVolumeClaim?: unknown }[]
      }
    | undefined
  const keepsData =
    Boolean((workload.spec?.volumeClaimTemplates as unknown[] | undefined)?.length) ||
    Boolean(spec?.volumes?.some((volume) => volume.persistentVolumeClaim))
  if (!spec || !keepsData) return null
  const containers = [...(spec.initContainers ?? []), ...(spec.containers ?? [])].flatMap((c) => {
    const tag = c.image ? floatingTag(c.image) : undefined
    const always =
      c.imagePullPolicy === 'Always' ||
      (c.imagePullPolicy === undefined && tag !== undefined && tag !== 'a major version alone')
    return tag && always ? [{ container: c.name, image: c.image, tag }] : []
  })
  if (!containers.length) return null
  return {
    object: `${kind}/${workload.metadata.name}`,
    ...(workload.metadata.namespace ? { namespace: workload.metadata.namespace } : {}),
    containers,
    why: 'It keeps data in volume claims, and its image’s tag can move to a newer version, pulled whenever a pod starts: so a restart can run a newer version on the same data, without anyone choosing it. A tag that names one version, or a digest, holds it to that.',
  }
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
  const risky: Record<string, unknown>[] = []
  const unchecked: string[] = []
  lists.forEach((list, i) => {
    const kind = kinds[i]!
    if (!list.ok) {
      unchecked.push(`${kind}: ${list.error.message}`)
      return
    }
    for (const object of list.data.items) {
      const config = WORKLOADS.includes(kind) ? riskyConfig(kind, object) : null
      if (config) risky.push(config)
      const status = statusOf(kind, object)!
      if (status.health !== 'critical' && status.health !== 'warning') continue
      const failing = kind === 'Pod' ? failingContainers(object, now) : []
      found.push({
        rank: HEALTH_RANK[status.health],
        problem: {
          object: `${kind}/${object.metadata.name}`,
          ...(object.metadata.namespace ? { namespace: object.metadata.namespace } : {}),
          status: describeStatus(status),
          age: age(object.metadata.creationTimestamp!, now),
          ...(failing.length ? { containers: failing } : {}),
        },
      })
    }
  })
  if (!events.ok) unchecked.push(`Event: ${events.error.message}`)
  const sorted = found.sort((a, b) => a.rank - b.rank).map(({ problem }) => problem)
  return {
    problems: sorted,
    warnings: events.ok ? recentWarnings(events.data.items, now) : [],
    risky,
    unchecked,
    more: 0,
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

/**
 * What's new among a cluster's Warning events since the last look, and what to tell of it: the
 * desktop app's main process and a server's page each look every 30 seconds, and both tell the
 * same. New is an event not seen before, or one whose count has gone up; what was there at the
 * first look is only remembered. An object and reason is told once in 10 minutes; several in one
 * namespace at one look are told as one.
 */
import type { KubeObject } from './api'
import { eventCount } from './events'
import { spelled } from './kit/characters'
import { eventMessage } from './plugin-reads'
import { builtinResource, type ResourceKind } from './resources'

/** How often each looks, in milliseconds. */
export const WARNINGS_EVERY_MS = 30_000
/** An object and reason told once in this long. */
const QUIET_MS = 10 * 60_000
/** The most of a message a notification says: its first line, at most this long. */
const MESSAGE_MOST = 200

/** What the system is asked to show, and where a click on it opens Lumovi. */
export interface WarningNotice {
  title: string
  body: string
  /** The cluster's name, last, so a person with two knows which. */
  cluster: string
  /** A path in Lumovi: the object, or a namespace's warnings. */
  opens: string
}

interface Involved {
  kind?: string
  name?: string
  namespace?: string
}

/** A namespace's warnings, on the Events page. */
const warningsIn = (context: string, namespace?: string) =>
  `/cluster/${encodeURIComponent(context)}/events?${new URLSearchParams({
    health: 'warning',
    ...(namespace ? { namespaces: namespace } : {}),
  })}`

/** Where a click opens: the object in its list, or (another kind) its namespace's warnings. */
function placeOf(context: string, event: KubeObject): string {
  const involved = (event.involvedObject ?? {}) as Involved
  const builtin = involved.kind ? builtinResource(involved.kind as ResourceKind) : undefined
  if (builtin && involved.name) {
    const open = `${involved.kind}/${involved.namespace ?? ''}/${involved.name}`
    return `/cluster/${encodeURIComponent(context)}/${builtin.plural}?${new URLSearchParams({ open })}`
  }
  return warningsIn(context, involved.namespace ?? event.metadata.namespace)
}

/**
 * A message's first line, at most MESSAGE_MOST long, as plain text: cut first where it could
 * carry what only the person may read (as a plugin is handed it), since a notification is shown
 * wherever the system shows them, its lock screen too.
 */
function firstLine(message: unknown): string {
  const line = spelled(
    eventMessage(String(message ?? ''))
      .split('\n')[0]!
      .trim(),
  )
  return line.length > MESSAGE_MOST ? `${line.slice(0, MESSAGE_MOST - 1)}…` : line
}

/** Reasons and how many of each, "BackOff ×3, FailedScheduling, Unhealthy": past four, "and 2 more". */
function reasonsIn(reasons: Map<string, number>): string {
  const said = [...reasons].map(([reason, n]) => (n > 1 ? `${reason} ×${n}` : reason))
  return said.length > 4
    ? `${said.slice(0, 4).join(', ')} and ${said.length - 4} more`
    : said.join(', ')
}

/** Each cluster's events as last seen, and what was told when: kept between looks. */
export class WarningWatch {
  /** Each cluster's events as last seen: their counts, by uid. None yet: not looked at. */
  readonly #seen = new Map<string, Map<string, number>>()
  /** When each cluster's object and reason was last told. */
  readonly #told = new Map<string, number>()

  /** Forgets a cluster: turned on again, it starts from what's there then. */
  forget(context: string): void {
    this.#seen.delete(context)
  }

  get watched(): string[] {
    return [...this.#seen.keys()]
  }

  /**
   * A look at a cluster's Warning events (`cluster`, its name in Lumovi): what to tell. Only a
   * whole look, every namespace it watches read: one with a read that failed is left out, or what
   * that read would have held would be new at the next.
   */
  look(
    context: string,
    cluster: string,
    events: readonly KubeObject[],
    now: number,
  ): WarningNotice[] {
    // (Its name can be a kubeconfig's, written by anyone: said as plain text, as the rest is.)
    const name = spelled(cluster)
    const before = this.#seen.get(context)
    const seen = new Map<string, number>()
    for (const event of events)
      seen.set(event.metadata.uid ?? event.metadata.name, eventCount(event))
    this.#seen.set(context, seen)
    // The first look only remembers: what was there before Lumovi looked isn't new.
    if (!before) return []
    const fresh = events.filter((event) => {
      const key = event.metadata.uid ?? event.metadata.name
      const was = before.get(key)
      if (was !== undefined && eventCount(event) <= was) return false
      const involved = (event.involvedObject ?? {}) as Involved
      const once = `${context}/${involved.kind}/${involved.namespace ?? ''}/${involved.name}/${String(event.reason)}`
      const last = this.#told.get(once)
      if (last !== undefined && now - last < QUIET_MS) return false
      this.#told.set(once, now)
      return true
    })
    const byNamespace = new Map<string, KubeObject[]>()
    for (const event of fresh) {
      const namespace = event.metadata.namespace ?? ''
      byNamespace.set(namespace, [...(byNamespace.get(namespace) ?? []), event])
    }
    return [...byNamespace].map(([namespace, them]) => {
      if (them.length === 1) {
        const event = them[0]!
        const involved = (event.involvedObject ?? {}) as Involved
        return {
          title: spelled(
            `${String(event.reason)}: ${involved.kind ?? 'Object'} ${involved.namespace ? `${involved.namespace}/` : ''}${involved.name ?? ''}`,
          ),
          body: firstLine(event.message),
          cluster: name,
          opens: placeOf(context, event),
        }
      }
      // Several at once: one notification, with their reasons and how many of each.
      const reasons = new Map<string, number>()
      for (const event of them) {
        const reason = String(event.reason)
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
      }
      return {
        title: `${them.length} new warnings${namespace ? ` in ${namespace}` : ''}`,
        body: spelled(reasonsIn(reasons)),
        cluster: name,
        opens: warningsIn(context, namespace || undefined),
      }
    })
  }
}

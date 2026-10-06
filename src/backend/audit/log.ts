/**
 * The audit log: records each event (in its place in the chain), keeps it
 * in the history, sends it everywhere else it goes, and tells whoever's
 * watching; and finds events again, for the Audit page.
 */
import { randomUUID } from 'node:crypto'
import {
  AUDIT_ACTIONS,
  AUDIT_TYPE,
  AUDIT_VERSION,
  HISTORY,
  lostText,
  matches,
  recordedAt,
  wordsOf,
  type AuditDetail,
  type AuditEvent,
  type AuditInfo,
  type AuditInput,
  type AuditLevel,
  type AuditPage,
  type AuditQuery,
  type AuditVerification,
} from '@shared/audit'
import { ChainCheck, hashOf } from './chain'
import type { AuditSink } from './sinks'
import type { AuditStore } from './store'

export interface AuditLogOptions {
  store: AuditStore
  sinks: AuditSink[]
  level: AuditLevel
  /** How many events one search looks through, at most, before it says so and stops. */
  scanLimit: number
  /** How many events an export holds, at most. */
  exportLimit: number
  /** Said in the server's (or app's) own log: what couldn't be kept, and why. */
  warn: (message: string) => void
}

/** Whose events a reader may see: everyone's, or theirs alone. */
export type AuditReader = (event: AuditEvent) => boolean

/** How often what's older than it keeps is let go, and what couldn't be sent said (an env for tests). */
const WATCH_MS = Number(process.env.LUMOVI_AUDIT_WATCH_MS) || 60_000

const MAX_TEXT = 4000
const MAX_DETAIL = 1000
const MAX_DETAILS = 50
const MAX_LIST = 100

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** What it says, bounded: an event stays a line, however much is in what it's about. */
function bounded(input: AuditInput): AuditInput {
  const details = input.details && Object.entries(input.details).slice(0, MAX_DETAILS)
  return {
    ...input,
    summary: clip(input.summary, MAX_TEXT),
    command: input.command && clip(input.command, MAX_TEXT),
    error: input.error && clip(input.error, MAX_TEXT),
    approval: input.approval && {
      ...input.approval,
      note: input.approval.note && clip(input.approval.note, MAX_DETAIL),
    },
    details:
      details &&
      Object.fromEntries(
        details.map(([key, value]): [string, AuditDetail] => [
          clip(key, 100),
          typeof value === 'string'
            ? clip(value, MAX_DETAIL)
            : Array.isArray(value)
              ? value.slice(0, MAX_LIST).map((item) => clip(item, MAX_DETAIL))
              : value,
        ]),
      ),
  }
}

export class AuditLog {
  readonly level: AuditLevel
  readonly #store: AuditStore
  readonly #sinks: AuditSink[]
  readonly #warn: (message: string) => void
  readonly #now: () => Date
  readonly #scanLimit: number
  readonly #exportLimit: number
  readonly #listeners = new Set<(event: AuditEvent) => void>()
  /** Where the chain is: whether or not the history kept the last one. */
  #head: { seq: number; hash: string }
  #storeDropped = 0
  #storeProblem: string | undefined
  /** The drops last said, sink by sink: so each is said once a minute at most. */
  #toldDropped = new Map<string, number>()
  #watch: NodeJS.Timeout

  constructor(options: AuditLogOptions) {
    this.level = options.level
    this.#store = options.store
    this.#sinks = options.sinks
    this.#warn = options.warn
    this.#now = () => new Date()
    this.#scanLimit = options.scanLimit
    this.#exportLimit = options.exportLimit
    const last = this.#store.last()
    this.#head = last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: '' }
    this.#store.prune(this.#now())
    this.#watch = setInterval(() => {
      this.#store.prune(this.#now())
      this.#sayDropped()
    }, WATCH_MS)
    this.#watch.unref()
  }

  /** Records it, if the level records its kind: in its place, kept, sent, and told. */
  record(input: AuditInput): AuditEvent | undefined {
    if (!recordedAt(this.level, input.action)) return undefined
    const given = bounded(input)
    const unhashed: Omit<AuditEvent, 'hash'> = {
      type: AUDIT_TYPE,
      version: AUDIT_VERSION,
      id: randomUUID(),
      seq: this.#head.seq + 1,
      time: this.#now().toISOString(),
      category: AUDIT_ACTIONS[given.action],
      action: given.action,
      outcome: given.outcome,
      actor: given.actor,
      cluster: given.cluster,
      target: given.target,
      summary: given.summary,
      command: given.command,
      approval: given.approval,
      details: given.details,
      error: given.error,
      prev: this.#head.hash,
    }
    // Only what's given: no keys that say nothing.
    for (const key of Object.keys(unhashed) as (keyof typeof unhashed)[]) {
      if (unhashed[key] === undefined) delete unhashed[key]
    }
    const event = { ...unhashed, hash: hashOf(unhashed) } as AuditEvent
    this.#head = { seq: event.seq, hash: event.hash }
    try {
      this.#store.append(event)
    } catch (error) {
      this.#storeDropped++
      if (!this.#storeProblem) {
        this.#warn(`The audit history can’t be kept: ${(error as Error).message}`)
      }
      this.#storeProblem = (error as Error).message
    }
    for (const sink of this.#sinks) sink.send(event)
    for (const listener of this.#listeners) listener(event)
    return event
  }

  /** Called with each event as it's recorded, until let go of. */
  subscribe(listener: (event: AuditEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** What couldn't be kept or sent since the last time it was said: said in the log, as an event. */
  #sayDropped() {
    for (const { name, dropped, problem } of this.#sinkStates()) {
      const told = this.#toldDropped.get(name) ?? 0
      if (dropped <= told) continue
      const count = dropped - told
      const summary = lostText(count, name)
      // Whatever drops them is why (a sink only drops what it says it couldn't keep or send).
      this.#warn(`${summary}: ${problem}`)
      this.record({
        action: 'audit.dropped',
        outcome: 'failure',
        actor: { user: 'lumovi', via: 'server' },
        summary,
        details: { sink: name, count },
        error: problem,
      })
      // Counted after it's said: saying so can't be kept where nothing can, and isn't news.
      this.#toldDropped.set(name, this.#sinkStates().find((sink) => sink.name === name)!.dropped)
    }
  }

  #sinkStates(): AuditInfo['sinks'] {
    return [
      { name: HISTORY, dropped: this.#storeDropped, problem: this.#storeProblem },
      ...this.#sinks.map((sink) => ({
        name: sink.name,
        dropped: sink.dropped(),
        problem: sink.problem(),
      })),
    ]
  }

  info(everyone: boolean): AuditInfo {
    return {
      kept: this.#store.kind,
      retentionDays: this.#store.retentionDays,
      level: this.level,
      everyone,
      sinks: this.#sinkStates(),
      oldest: this.#store.oldest(),
      exportLimit: this.#exportLimit,
    }
  }

  /** The events a query asks for that a reader may see, the newest first, a page at a time. */
  async query(query: AuditQuery, reader: AuditReader): Promise<AuditPage> {
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 1000)
    const before = query.after !== undefined ? Number(query.after) : undefined
    if (before !== undefined && !Number.isSafeInteger(before)) {
      throw new Error(`Where the page ended isn’t one Lumovi gave: "${query.after}".`)
    }
    const words = wordsOf(query.text)
    const events: AuditEvent[] = []
    let scanned = 0
    let lastSeen: number | undefined
    for await (const stored of this.#store.newestFirst({
      before,
      from: query.from,
      to: query.to,
    })) {
      if (!('event' in stored)) continue
      const { event } = stored
      if (query.from && event.time < query.from) break
      scanned++
      lastSeen = event.seq
      if (reader(event) && matches(query, event, words)) {
        // One more than asked for says there is a next page.
        if (events.length === limit) return { events, next: String(events.at(-1)!.seq), scanned }
        events.push(event)
      }
      if (scanned >= this.#scanLimit) {
        return { events, next: String(lastSeen), scanned, stopped: true }
      }
    }
    return { events, scanned }
  }

  /** Checks the chain, from the oldest event kept to the newest. */
  async verify(): Promise<AuditVerification> {
    const check = new ChainCheck()
    for await (const stored of this.#store.oldestFirst()) {
      if ('event' in stored) {
        if (!check.add(stored.event)) break
      } else {
        check.unreadable(stored.unreadable)
        break
      }
    }
    return check.result()
  }

  /** Sends what's waiting, says what was dropped, and lets the history go. */
  async close(ms = 5000) {
    clearInterval(this.#watch)
    this.#sayDropped()
    await Promise.all(this.#sinks.map((sink) => sink.flush(ms)))
    this.#store.close()
  }
}

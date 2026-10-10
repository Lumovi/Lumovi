/**
 * The audit log: records each event (in its place in the chain), keeps it
 * in the history, sends it everywhere else it goes, and tells whoever's
 * watching; and finds events again, for the Audit page.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
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
import type { AuditStore, Position } from './store'

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

/** How many searches (and checks) read the history at once: the rest wait their turn (an env for tests). */
const SEARCHES = Number(process.env.LUMOVI_AUDIT_SEARCHES) || 4

/** What one event says, at most: its sentences, a detail, a name, how many details and items. */
const MAX_TEXT = 4000
const MAX_DETAIL = 1000
const MAX_NAME = 256
const MAX_DETAILS = 50
const MAX_LIST = 100
/** How much its details hold together, and the whole event, in bytes (as JSON). */
const MAX_DETAILS_BYTES = 16 * 1024
export const MAX_EVENT_BYTES = 64 * 1024

/**
 * Text as it's kept: whole characters (never half of a pair, which no two JSON tools read the
 * same), at most `max` of them.
 */
export function clip(text: string, max: number): string {
  const whole = text.toWellFormed()
  if (whole.length <= max) return whole
  let kept = ''
  let count = 1
  for (const char of whole) {
    if (count++ === max) break
    kept += char
  }
  return `${kept}…`
}

const optional = (text: string | undefined, max: number) =>
  text === undefined ? undefined : clip(text, max)

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

/** A detail as it's kept: its text clipped. */
function detail(value: AuditDetail): AuditDetail {
  if (typeof value === 'string') return clip(value, MAX_DETAIL)
  // A number not a whole one within JSON's safe range (1e21, 0.1), as its text: JSON tools
  // write those each their own way.
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return String(value)
  return Array.isArray(value)
    ? value.slice(0, MAX_LIST).map((item) => clip(item, MAX_DETAIL))
    : value
}

/** An event's details, bounded: as many as fit, and that some didn't. */
function boundedDetails(details: Record<string, AuditDetail>): Record<string, AuditDetail> {
  const kept: Record<string, AuditDetail> = {}
  let size = 2
  for (const [key, value] of Object.entries(details).slice(0, MAX_DETAILS)) {
    // Said nothing: as JSON leaves it out.
    if (value === undefined) continue
    const name = clip(key, 100)
    const given = detail(value)
    size += bytes(name) + bytes(given) + 2
    if (size > MAX_DETAILS_BYTES) return { ...kept, truncated: true }
    kept[name] = given
  }
  return kept
}

/**
 * What it says, bounded: an event stays a line of at most MAX_EVENT_BYTES, however much is in
 * what it's about (an object's name, a header, an error), whoever sent it.
 */
export function bounded(input: AuditInput): AuditInput {
  const { actor, target, approval } = input
  const event: AuditInput = {
    ...input,
    actor: {
      ...actor,
      user: clip(actor.user, MAX_NAME),
      groups: actor.groups?.slice(0, MAX_LIST).map((group) => clip(group, MAX_NAME)),
      assistant: optional(actor.assistant, 100),
      session: optional(actor.session, 64),
      address: optional(actor.address, 100),
      forwardedFor: optional(actor.forwardedFor, 200),
      userAgent: optional(actor.userAgent, 300),
      kubeUser: optional(actor.kubeUser, MAX_NAME),
    },
    cluster: optional(input.cluster, MAX_NAME),
    target: target && {
      kind: clip(target.kind, 100),
      name: optional(target.name, MAX_NAME),
      namespace: optional(target.namespace, MAX_NAME),
      uid: optional(target.uid, 64),
    },
    summary: clip(input.summary, MAX_TEXT),
    command: optional(input.command, MAX_TEXT),
    error: optional(input.error, MAX_TEXT),
    approval: approval && {
      ...approval,
      by: optional(approval.by, MAX_NAME),
      note: optional(approval.note, MAX_DETAIL),
    },
    details: input.details && boundedDetails(input.details),
  }
  if (bytes(event) <= MAX_EVENT_BYTES) return event
  // Still too much (characters JSON writes as six bytes each, say): its sentences shorter, fewer
  // of its groups, and none of its details. That fits, whatever they say.
  return {
    ...event,
    actor: { ...event.actor, groups: event.actor.groups?.slice(0, 10) },
    summary: clip(event.summary, MAX_DETAIL),
    command: optional(event.command, MAX_DETAIL),
    error: optional(event.error, MAX_DETAIL),
    details: { truncated: true },
  }
}

/**
 * Where a page ended, as the page is told it: sealed with this run's own key, so it says nothing
 * of others' events (how many, nor their numbers) and is only ever one Lumovi gave.
 */
class Cursors {
  readonly #key = randomBytes(32)

  seal(at: Position): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
    const sealed = Buffer.concat([cipher.update(JSON.stringify(at)), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url')
  }

  open(text: string): Position {
    try {
      const given = Buffer.from(text, 'base64url')
      const decipher = createDecipheriv('aes-256-gcm', this.#key, given.subarray(0, 12))
      decipher.setAuthTag(given.subarray(12, 28))
      return JSON.parse(
        Buffer.concat([decipher.update(given.subarray(28)), decipher.final()]).toString(),
      ) as Position
    } catch {
      throw new Error(
        'Where the page ended isn’t one this Lumovi gave (it may have started again since): search again.',
      )
    }
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
  readonly #cursors = new Cursors()
  /** Where the chain is: whether or not the history kept the last one. */
  #head: { seq: number; hash: string; chain: string }
  /** What the history couldn't keep, by why; and why it can't now. */
  readonly #storeLosses = new Map<string, number>()
  #storeProblem: string | undefined
  #pruneProblem: string | undefined
  /** The losses last said, sink by sink and why: so each is said once a minute at most. */
  readonly #told = new Map<string, number>()
  #watch: NodeJS.Timeout
  /** Searches reading the history now, and those waiting their turn. */
  #searching = 0
  readonly #waiting: (() => void)[] = []

  constructor(options: AuditLogOptions) {
    this.level = options.level
    this.#store = options.store
    this.#sinks = options.sinks
    this.#warn = options.warn
    this.#now = () => new Date()
    this.#scanLimit = options.scanLimit
    this.#exportLimit = options.exportLimit
    const last = this.#store.last()
    // A chain goes on where the history's ends; with nothing to follow, a new one starts.
    this.#head = last
      ? { seq: last.seq, hash: last.hash, chain: last.chain }
      : { seq: 0, hash: '', chain: randomUUID() }
    this.#store.prune(this.#now())
    this.#watch = setInterval(() => {
      this.#prune()
      this.#sayDropped()
    }, WATCH_MS)
    this.#watch.unref()
  }

  /** Records it, if the level records its kind: in its place, kept, sent, and told. */
  record(input: AuditInput): AuditEvent | undefined {
    if (!recordedAt(this.level, input)) return undefined
    const given = bounded(input)
    const unhashed: Omit<AuditEvent, 'hash'> = {
      type: AUDIT_TYPE,
      version: AUDIT_VERSION,
      id: randomUUID(),
      chain: this.#head.chain,
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
    const event = JSON.parse(JSON.stringify({ ...unhashed, hash: hashOf(unhashed) })) as AuditEvent
    // The chain goes on whether or not the history keeps it: what it couldn't is said, as an event.
    this.#head = { seq: event.seq, hash: event.hash, chain: event.chain }
    try {
      this.#store.append(event)
      // Kept again (its folder back, its lock in reach): the problem is over, and a next one said.
      this.#storeProblem = undefined
    } catch (error) {
      const { message } = error as Error
      this.#storeLosses.set(message, (this.#storeLosses.get(message) ?? 0) + 1)
      if (message !== this.#storeProblem) this.#warn(`The audit history can’t be kept: ${message}`)
      this.#storeProblem = message
    }
    for (const sink of this.#sinks) sink.send(event)
    for (const listener of this.#listeners) listener(event)
    return event
  }

  /** What's older than it keeps, let go of: or, if it can't be (its folder gone, say), said once. */
  #prune() {
    try {
      this.#store.prune(this.#now())
      this.#pruneProblem = undefined
    } catch (error) {
      const { message } = error as Error
      if (message !== this.#pruneProblem) {
        this.#warn(`The audit history can’t be looked after: ${message}`)
      }
      this.#pruneProblem = message
    }
  }

  /** Called with each event as it's recorded, until let go of. */
  subscribe(listener: (event: AuditEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** What couldn't be kept or sent since the last time it was said: said in the log, as an event. */
  #sayDropped() {
    for (const { name, losses } of this.#sinkStates()) {
      // Each why on its own, with how many it was why for.
      for (const [why, total] of [...losses]) {
        const key = `${name}\n${why}`
        const told = this.#told.get(key) ?? 0
        if (total <= told) continue
        const count = total - told
        const summary = lostText(count, name)
        this.#warn(`${summary}: ${why}`)
        this.record({
          action: 'audit.dropped',
          outcome: 'failure',
          actor: { user: 'lumovi', via: 'server' },
          summary,
          details: { sink: name, count },
          error: why,
        })
        // Counted after it's said: saying so can't be kept where nothing can, and isn't news.
        this.#told.set(key, losses.get(why)!)
      }
    }
  }

  /** Where events go: how many each couldn't keep or send, what's wrong now, and why it lost some. */
  #sinkStates(): (AuditInfo['sinks'][number] & { losses: ReadonlyMap<string, number> })[] {
    const total = (losses: ReadonlyMap<string, number>) =>
      [...losses.values()].reduce((sum, n) => sum + n, 0)
    return [
      {
        name: HISTORY,
        dropped: total(this.#storeLosses),
        problem: this.#storeProblem,
        losses: this.#storeLosses,
      },
      ...this.#sinks.map((sink) => ({
        name: sink.name,
        dropped: sink.dropped(),
        problem: sink.problem() ?? sink.lost(),
        losses: sink.losses(),
      })),
    ]
  }

  /**
   * What the page says about the log: for an auditor, all of it; for someone reading their own
   * events, only how much is kept (not where else events go, nor what happened to everyone's).
   */
  info(everyone: boolean): AuditInfo {
    return {
      kept: this.#store.kind,
      retentionDays: this.#store.retentionDays,
      unkept: this.#store.unkept,
      level: this.level,
      everyone,
      sinks: everyone ? this.#sinkStates().map(({ losses: _, ...sink }) => sink) : [],
      oldest: everyone ? this.#store.oldest() : undefined,
      exportLimit: this.#exportLimit,
    }
  }

  /** One at a time, as many as SEARCHES: the history is read by so many at once, at most. */
  async #inTurn<T>(read: () => Promise<T>): Promise<T> {
    if (this.#searching < SEARCHES) this.#searching++
    // Its turn is handed over, as one ends.
    else await new Promise<void>((turn) => this.#waiting.push(turn))
    try {
      return await read()
    } finally {
      const next = this.#waiting.shift()
      if (next) next()
      else this.#searching--
    }
  }

  /**
   * The events a query asks for that a reader may see, the newest first, a page at a time. How
   * many were looked through is said to whoever sees everyone's (`everyone`): to anyone else,
   * it would say how many others did what.
   */
  async query(query: AuditQuery, reader: AuditReader, everyone = true): Promise<AuditPage> {
    // Where the page ended: checked before it waits its turn.
    const before = query.after === undefined ? undefined : this.#cursors.open(query.after)
    return this.#inTurn(async () => {
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 1000)
      const words = wordsOf(query.text)
      const events: AuditEvent[] = []
      let scanned = 0
      let at: Position | undefined
      const page = (more: Position | undefined, stopped?: true): AuditPage => ({
        events,
        ...(more ? { next: this.#cursors.seal(more) } : {}),
        ...(everyone ? { scanned } : {}),
        ...(stopped ? { stopped } : {}),
      })
      for await (const stored of this.#store.newestFirst({
        before,
        from: query.from,
        to: query.to,
      })) {
        // Every line read is looked through, an event or not.
        scanned++
        if ('event' in stored) {
          const { event } = stored
          if (query.from && event.time < query.from) break
          if (reader(event) && matches(query, event, words)) {
            // One more than asked for says there is a next page.
            if (events.length === limit) return page(at)
            events.push(event)
            at = stored.at
          }
        }
        if (scanned >= this.#scanLimit) return page(stored.at, true)
      }
      return page(undefined)
    })
  }

  /** Checks the chain, from the oldest event kept to the newest: every place it doesn't hold. */
  verify(): Promise<AuditVerification> {
    return this.#inTurn(async () => {
      const check = new ChainCheck()
      for await (const stored of this.#store.oldestFirst()) {
        if ('event' in stored) check.add(stored.event)
        else check.unreadable(stored.unreadable)
      }
      return check.result()
    })
  }

  /** Sends what's waiting, says what couldn't be (and was dropped), and lets the history go. */
  async close(ms = 5000) {
    clearInterval(this.#watch)
    await Promise.all(this.#sinks.map((sink) => sink.flush(ms)))
    // What's still waiting is lost as Lumovi stops: said, in the history and the server's log.
    for (const sink of this.#sinks) sink.abandon()
    this.#sayDropped()
    this.#store.close()
  }
}

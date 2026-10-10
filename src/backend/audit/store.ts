/**
 * Where the audit log's history is kept, for the Audit page to look
 * through: a file a day (`audit-2026-10-06.jsonl`, one event a line) in a
 * folder (a volume's, on a server; the desktop app's own), each kept for as
 * many days as set; or, with no folder, the most recent events in memory,
 * until the server stops.
 */
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { isAuditAction, type AuditEvent } from '@shared/audit'

/** What a store reads: an event, or a line that isn't one. */
export type Read = { event: AuditEvent } | { unreadable: string }

/** What a store gives back, newest first: and where it is, for a page that ends with it. */
export type Stored = Read & { at: Position }

/**
 * Where something kept is: what's older than it is what a page that ends with it goes on to.
 * Its day's file, and where its line starts in it (in memory, just its place in the chain).
 */
export interface Position {
  /** What's older has a smaller seq than this. */
  seq: number
  day?: string
  offset?: number
  /** It's a line that isn't an event (a search can stop at one). */
  unreadable?: true
}

export interface AuditStore {
  readonly kind: 'files' | 'memory'
  readonly retentionDays?: number
  /** Why it's kept in memory, where it would have been kept in files. */
  readonly unkept?: string
  /** The newest event kept: where the chain goes on from. */
  last(): AuditEvent | undefined
  /** The oldest event's time. */
  oldest(): string | undefined
  /** Keeps it, or throws why it couldn't. */
  append(event: AuditEvent): void
  /** Newest first: older than `before`, skipping days before `from` and after `to` (ISO times). */
  newestFirst(options: { before?: Position; from?: string; to?: string }): AsyncIterable<Stored>
  oldestFirst(): AsyncIterable<Read>
  /** Lets go of what's older than it keeps. */
  prune(now: Date): void
  close(): void
}

/** Reads a line as an event, or says it isn't one. */
export function eventOf(line: string): AuditEvent | undefined {
  try {
    const event = JSON.parse(line) as AuditEvent
    return event?.type === 'lumovi.audit' &&
      typeof event.seq === 'number' &&
      typeof event.hash === 'string' &&
      isAuditAction(event.action)
      ? event
      : undefined
  } catch {
    return undefined
  }
}

/** The most recent events, in memory: as many as `capacity`, the oldest let go first. */
export class MemoryStore implements AuditStore {
  readonly kind = 'memory'
  readonly #events: AuditEvent[] = []

  constructor(
    private readonly capacity: number,
    readonly unkept?: string,
  ) {}

  last = () => this.#events.at(-1)
  oldest = () => this.#events[0]?.time

  append(event: AuditEvent) {
    this.#events.push(event)
    if (this.#events.length > this.capacity) this.#events.shift()
  }

  async *newestFirst({ before }: { before?: Position }): AsyncIterable<Stored> {
    for (let i = this.#events.length - 1; i >= 0; i--) {
      const event = this.#events[i]!
      if (before === undefined || event.seq < before.seq) yield { event, at: { seq: event.seq } }
    }
  }

  async *oldestFirst(): AsyncIterable<Read> {
    for (const event of [...this.#events]) yield { event }
  }

  prune() {}
  close() {}
}

const DAY_FILE = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/
const dayOf = (time: string) => time.slice(0, 10)

/** A file a day, in a folder; each kept for `retentionDays`. */
export class FileStore implements AuditStore {
  readonly kind = 'files'
  #last: AuditEvent | undefined
  /** The day files' days, oldest first. */
  #days: string[] = []
  /** The day whose file was last written to: checked, as it was first, for a line left unfinished. */
  #writing: string | undefined
  readonly #lock: HistoryLock

  /**
   * The folder's history, once it's this Lumovi's alone: held by another, it waits (`wait`) for
   * that one to let go or stop renewing it, saying so (`say`); still held, it says who holds it.
   */
  static async open(
    dir: string,
    retentionDays: number,
    { wait, say }: { wait: boolean; say: (message: string) => void },
  ): Promise<FileStore> {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // Its own, whoever made it (a volume, mounted): nobody else reads who did what.
    ownOnly(dir, 0o700)
    return new FileStore(dir, retentionDays, await HistoryLock.take(dir, wait, say))
  }

  private constructor(
    readonly dir: string,
    readonly retentionDays: number,
    lock: HistoryLock,
  ) {
    this.#lock = lock
    lock.unmoved = () => this.#unmoved()
    this.#days = this.#listDays()
    for (const day of this.#days) ownOnly(this.#path(day), 0o600)
    // Where the chain goes on from: the newest file's last event that can be read.
    for (const day of [...this.#days].reverse()) {
      this.#last = lastEventIn(this.#path(day))
      if (this.#last) break
    }
  }

  last = () => this.#last

  oldest(): string | undefined {
    for (const day of this.#days) {
      // One that can't be read is skipped here: searching it says why.
      let first: AuditEvent | undefined
      try {
        first = firstEventIn(this.#path(day))
      } catch {
        continue
      }
      if (first) return first.time
    }
    return undefined
  }

  #path = (day: string) => join(this.dir, `audit-${day}.jsonl`)

  /**
   * Whether the folder's history still ends where this Lumovi left it: with the last event it
   * kept, or with none at all. If it ends with another, another Lumovi has written to it.
   */
  #unmoved(): boolean {
    for (const day of this.#listDays().reverse()) {
      const last = lastEventIn(this.#path(day))
      if (last) return last.seq === this.#last?.seq && last.hash === this.#last.hash
    }
    return true
  }

  #listDays = () =>
    readdirSync(this.dir)
      .map((name) => DAY_FILE.exec(name)?.[1])
      .filter((day): day is string => Boolean(day))
      .sort()

  append(event: AuditEvent) {
    // Only while the history is this Lumovi's: another's would get a second event of this number.
    this.#lock.held()
    // Never a day before the newest file's (the clock was set back): the files keep the chain's
    // order, whatever the clock says.
    const newest = this.#days.at(-1)
    const day = newest !== undefined && newest > dayOf(event.time) ? newest : dayOf(event.time)
    const path = this.#path(day)
    let line = `${JSON.stringify(event)}\n`
    if (this.#writing !== day) {
      this.#writing = day
      if (newest !== day) this.#days = [...this.#days, day]
      // A line left unfinished (the computer stopped as it was written) stays as it is, on its own.
      if (endsUnfinished(path)) line = `\n${line}`
    }
    appendFileSync(path, line, { mode: 0o600 })
    this.#last = event
  }

  async *newestFirst({
    before,
    from,
    to,
  }: {
    before?: Position
    from?: string
    to?: string
  }): AsyncIterable<Stored> {
    for (const day of [...this.#days].reverse()) {
      if (from && day < dayOf(from)) break
      if (to && day > dayOf(to)) continue
      // All of it newer than where a page ended: not read again.
      if (before && day > before.day!) continue
      const path = this.#path(day)
      // Where the page ended, if what's there is what it ended with: read on from there, and all
      // before it is older. If it isn't (written over meanwhile), what's older has smaller numbers.
      const end = before?.day === day ? await resumable(path, before) : undefined
      const counted = before?.day === day && end === undefined
      let newer = counted ? before.seq : Number.MAX_SAFE_INTEGER
      for await (const line of linesBackward(path, end)) {
        const event = eventOf(line.text)
        if (!event) {
          yield {
            unreadable: `Line ${await lineNumberAt(path, line.at)} of audit-${day}.jsonl`,
            at: { seq: newer, day, offset: line.at, unreadable: true },
          }
        } else if (!counted || event.seq < newer) {
          newer = event.seq
          yield { event, at: { seq: event.seq, day, offset: line.at } }
        }
      }
    }
  }

  async *oldestFirst(): AsyncIterable<Read> {
    for (const day of [...this.#days]) {
      for await (const line of linesForward(this.#path(day))) {
        const event = eventOf(line.text)
        yield event ? { event } : { unreadable: `Line ${line.number} of audit-${day}.jsonl` }
      }
    }
  }

  /** Deletes the days older than it keeps; never the one the chain goes on from. */
  prune(now: Date) {
    this.#lock.held()
    const oldestKept = dayOf(
      new Date(now.getTime() - this.retentionDays * 86_400_000).toISOString(),
    )
    const newest = this.#days.at(-1)
    for (const day of this.#days) {
      if (day >= oldestKept || day === newest) continue
      rmSync(this.#path(day), { force: true })
    }
    this.#days = this.#listDays()
  }

  close() {
    this.#lock.release()
  }
}

/** Only its owner's, if it can be made so (what someone else made may not let it be). */
function ownOnly(path: string, mode: number) {
  try {
    if ((statSync(path).mode & 0o777) !== mode) chmodSync(path, mode)
  } catch {
    // It's still kept there: as private as whoever made it let it be.
  }
}

// ——— One writer ———

/**
 * How long a lock nobody renews holds (a Lumovi that stopped without letting go of it: its node
 * lost, say), and how often it's renewed (an env for tests).
 */
const LOCK_STALE_MS = Number(process.env.LUMOVI_AUDIT_LOCK_STALE_MS) || 30_000
const LOCK_RENEW_MS = LOCK_STALE_MS / 3
/** This process's number (an env for tests: in a container the first process is always 1). */
const PID = Number(process.env.LUMOVI_AUDIT_LOCK_PID) || process.pid
/** How often a lock that can't be read is read again before it's taken for unreadable. */
const READ_AGAIN = { times: 5, everyMs: 100 }

/** A lock as its holder writes it: which hold it is, whose, where, and when it was last said. */
interface Hold {
  /** One for each time the history is opened: a process number comes around again. */
  id?: string
  pid: number
  host: string
  at: number
}

/**
 * What's in a lock's place: a hold as written (and its text, to tell it from another); or
 * something that isn't one, and when it was last written; or nothing.
 */
type Found =
  { hold: Hold; text: string } | { unreadable: true; text: string; writtenAt: number } | undefined

/**
 * The folder's one writer: two would number events the same (two pods sharing a volume, say).
 * Taken as the history opens, renewed while it's kept, and let go of as it closes.
 *
 * The lock is a file that is always whole: it's written beside its place and put there in one
 * step, so nobody reads half of it. It's taken by linking it into place, which only one of any
 * number at once can do; renewed by renaming over it; and whoever holds it looks that it's
 * still its own before it writes anything, and stops for good if it isn't (it stopped for
 * longer than a lock holds, and another took the history over).
 *
 * That makes two writers at once as unlikely as files on a shared volume can: it is not a
 * fence. One that loses its hold between looking and writing still writes that one event.
 */
class HistoryLock {
  readonly #path: string
  readonly #id: string
  readonly #renew: NodeJS.Timeout
  /** When it last took or said its hold again: its lease runs from then. */
  #renewedAt = Date.now()
  /** Whether the history still ends where its holder left it (said by the store that holds it). */
  unmoved: () => boolean = () => true
  /** Its hold went unrenewed long enough to have been taken: whether it was isn't known yet. */
  #doubted = false
  /** Why the history isn't this one's to write any more, once it isn't. */
  #lost: string | undefined

  /** Taken: at once, or once whoever holds it lets go or stops renewing it (`wait`). */
  static async take(
    dir: string,
    wait: boolean,
    say: (message: string) => void,
  ): Promise<HistoryLock> {
    const path = join(dir, 'audit.lock')
    const id = randomUUID()
    sweep(dir)
    // Long enough for one that stopped renewing it to be stale; not for one that renews it.
    const until = Date.now() + (wait ? LOCK_STALE_MS + LOCK_RENEW_MS : 0)
    let told = false
    // The lock as it was last seen to change, by this one's own clock: one that waits tells a
    // lock nobody renews by watching it, not by its holder's clock (or a file server's), which
    // may be half a minute off this one's.
    let seen: { text: string; since: number } | undefined
    while (!place(path, id)) {
      const found = await settled(path)
      // Let go of meanwhile: taken on the next turn, if nobody is quicker.
      if (!found) {
        seen = undefined
        continue
      }
      if (seen?.text !== found.text) seen = { text: found.text, since: Date.now() }
      const holder = holderOf(found, wait ? Date.now() - seen.since : undefined)
      if (!holder) {
        discard(path, id, found)
        continue
      }
      const who = `Another Lumovi (${holder})`
      if (Date.now() >= until) {
        throw new Error(
          `${who} keeps its audit history in ${dir}: two can’t, or they’d number events the same. Stop it, or give this one a folder of its own.`,
        )
      }
      if (!told) {
        say(
          `${who} keeps its audit history in ${dir}: waiting for it to stop (${Math.round(LOCK_STALE_MS / 1000)} seconds at most).`,
        )
        told = true
      }
      await new Promise((done) => setTimeout(done, 500))
    }
    return new HistoryLock(path, id)
  }

  private constructor(path: string, id: string) {
    this.#path = path
    this.#id = id
    this.#renew = setInterval(() => {
      try {
        this.held()
        this.#write()
      } catch {
        // Said where it matters: as events can't be kept there.
      }
    }, LOCK_RENEW_MS)
    this.#renew.unref()
  }

  /**
   * Looks that the history is still this one's to write, and throws why if it isn't: asked
   * before anything is written to it.
   *
   * Its hold is a lease. While the lock is its own, it's this one's. Once another's hold is
   * there, it's lost for good. And when it can neither see its lock nor say it again, it's this
   * one's only for as long as a lock holds unrenewed: after that another may have taken the
   * history over unseen, and nothing is written until the lock is seen to be its own again.
   */
  held() {
    if (this.#lost) throw new Error(this.#lost)
    const lapsed = () => Date.now() - this.#renewedAt >= LOCK_STALE_MS
    const unsure = (why: unknown) =>
      new Error(
        `This Lumovi hasn’t been able to renew its hold on the audit history for ${Math.round(LOCK_STALE_MS / 1000)} seconds (${(why as Error).message}): another may have taken it over meanwhile, so nothing is written to it until its lock can be read and renewed again.`,
      )
    // (Read again where its place is found empty and then taken: a few times at most.)
    let found: Found
    for (let again = 3; ; again--) {
      try {
        found = read(this.#path)
      } catch (error) {
        // It couldn't be looked at just now (a file busy, a volume slow): not another's hold.
        if (lapsed()) throw unsure(error)
        return
      }
      if (!found) {
        // Gone: its folder with it (thrown as it is: there's nowhere to keep anything), or
        // moved aside a moment by one clearing away a lock it took for abandoned, which puts
        // back what it finds isn't. Its own, said again, unless another is there first.
        if (this.#taken()) break
        if (place(this.#path, this.#id)) {
          this.#renewedAt = Date.now()
          return
        }
        if (again > 0) continue
      } else if ('unreadable' in found) {
        // Not a hold at all: one being put there this moment, where a volume can't put it whole.
        // Nobody's name is on it: looked at again, and then as one that can't be looked at.
        if (again > 0) continue
        if (lapsed()) throw unsure(new Error('its lock can’t be read'))
        return
      } else if (found.hold.id === this.#id) {
        if (this.#taken()) break
        // Late with renewing it (the process was held up): said again before going on.
        if (Date.now() - this.#renewedAt > LOCK_RENEW_MS * 2) {
          try {
            this.#write()
          } catch (error) {
            // Not this time (the file busy): it's still this one's, while its lease lasts.
            if (lapsed()) throw unsure(error)
          }
        }
        return
      }
      break
    }
    clearInterval(this.#renew)
    // (Named, if its hold is there to read: not where only the history says there was one.)
    const taker =
      found && 'hold' in found && found.hold.id !== this.#id
        ? `process ${found.hold.pid} on ${found.hold.host}`
        : undefined
    this.#lost = `${taker ? `Another Lumovi (${taker})` : 'Another Lumovi'} took this audit history over: it found this one’s hold on it not renewed. Two can’t keep one history: start this one again, and it waits its turn.`
    throw new Error(this.#lost)
  }

  /**
   * Whether another has had the history meanwhile, though no lock says so. A hold that went
   * unrenewed for as long as the quickest takeover takes may have been taken, written under,
   * and let go of again (its lock gone); or taken, and then written over by this one's own late
   * renewal (the lock its own again). Either way the history tells: it no longer ends where
   * this one left it. Asked only then, and until it has been asked once.
   */
  #taken(): boolean {
    this.#doubted ||= Date.now() - this.#renewedAt >= LOCK_RENEW_MS * 2
    if (!this.#doubted) return false
    if (!this.unmoved()) return true
    this.#doubted = false
    return false
  }

  #write() {
    // Said late, it may be said over another's hold: looked into before anything more is kept.
    this.#doubted ||= Date.now() - this.#renewedAt >= LOCK_RENEW_MS * 2
    replace(this.#path, this.#id)
    this.#renewedAt = Date.now()
  }

  release() {
    clearInterval(this.#renew)
    // Only its own: one that took it over holds it now.
    try {
      const found = read(this.#path)
      if (found && 'hold' in found && found.hold.id === this.#id) {
        rmSync(this.#path, { force: true })
      }
    } catch {
      // Left where it is: stale soon enough.
    }
  }
}

/** A lock as this process holds it. */
const mine = (id: string) =>
  JSON.stringify({ id, pid: PID, host: hostname(), at: Date.now() } satisfies Hold)

/**
 * Puts a file where there is none, whole: whether it did (one that's there stays). A link is
 * made by one taker alone, of any number at once, and what it links to is already written.
 * Where a volume has no links, the file is made there and then written: only one makes it, and
 * a reader gives one it can't read yet the time to be written (`settled`, `holderOf`).
 */
function putNew(path: string, text: string, beside: string): boolean {
  writeFileSync(beside, text, { mode: 0o600 })
  try {
    linkSync(beside, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
  } finally {
    rmSync(beside, { force: true })
  }
  try {
    writeFileSync(path, text, { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return false
  }
}

/** Takes a lock nobody holds: whether it was taken (one that's there is someone's, or was). */
const place = (path: string, id: string) => putNew(path, mine(id), `${path}.${id}`)

/** Says a lock again, whole: what's read is the old one or the new one, never part of either. */
function replace(path: string, id: string) {
  const beside = `${path}.${id}`
  try {
    writeFileSync(beside, mine(id), { mode: 0o600 })
    renameSync(beside, path)
  } catch (error) {
    rmSync(beside, { force: true })
    throw error
  }
}

/** What's in a lock's place now. Throws if it's there and can't be looked at. */
function read(path: string): Found {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const hold = JSON.parse(text) as Partial<Hold> | null
    if (
      hold &&
      typeof hold.pid === 'number' &&
      typeof hold.host === 'string' &&
      typeof hold.at === 'number'
    ) {
      return { hold: hold as Hold, text }
    }
  } catch {
    // Not a hold: below.
  }
  // (When it was written is asked only of one that isn't a hold: a holder's own look, before
  // each event, is the one read.)
  try {
    return { unreadable: true, text, writtenAt: statSync(path).mtimeMs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * What's in a lock's place, given a moment to be whole: one that can't be read (being written,
 * on a volume without links; or not to be looked at just now) is read again a few times first.
 */
async function settled(path: string): Promise<Found> {
  for (let again = READ_AGAIN.times; ; again--) {
    try {
      const found = read(path)
      if (!found || 'hold' in found || again === 0) return found
    } catch {
      // There, and not to be read: someone's, until it has been so for as long as a lock holds.
      if (again === 0) return { unreadable: true, text: '', writtenAt: Date.now() }
    }
    await new Promise((done) => setTimeout(done, READ_AGAIN.everyMs))
  }
}

/**
 * Who holds a lock, if anyone still does: in words, for whoever waits for it.
 *
 * `unchangedFor` is how long whoever asks has watched it stay as it is, by its own clock: a
 * lock is nobody's once that's as long as one holds unrenewed. One that can't wait and watch
 * (the desktop app, which opens its history at once or not at all) goes by when the lock says
 * it was last renewed.
 */
function holderOf(found: NonNullable<Found>, unchangedFor?: number): string | undefined {
  const unrenewed = (saidAt: number) => unchangedFor ?? Date.now() - saidAt
  if ('unreadable' in found) {
    // Nobody's name on it: someone's all the same, until it's stayed so as long as a lock holds.
    return unrenewed(found.writtenAt) < LOCK_STALE_MS ? 'its lock can’t be read yet' : undefined
  }
  const { hold } = found
  const who = `process ${hold.pid} on ${hold.host}`
  if (hold.host === hostname()) {
    // On this computer, one that's gone.
    if (hold.pid !== PID && !alive(hold.pid)) return undefined
    // This process's own number: this Lumovi before it started again (a container's first
    // process is number 1, each time), unless it's another container of the same name, whose
    // first is number 1 too. That one would renew it: watched for two renewals' time (one may
    // come late).
    if (hold.pid === PID) {
      return unchangedFor !== undefined && unchangedFor < LOCK_RENEW_MS * 2 ? who : undefined
    }
  }
  return unrenewed(hold.at) < LOCK_STALE_MS ? who : undefined
}

/** What's beside a lock, left by a Lumovi stopped as it wrote one: cleared once it's an hour old. */
function sweep(dir: string) {
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('audit.lock.')) continue
      const path = join(dir, name)
      if (Date.now() - statSync(path).mtimeMs > 3_600_000) rmSync(path, { force: true })
    }
  } catch {
    // Left there: in nobody's way.
  }
}

/**
 * Clears away a lock nobody holds any more (`judged`), for the next turn to take its place.
 * It's moved aside first, which one taker alone does, and looked at again there: if it isn't
 * the one that was judged (another was quicker, and this is its new hold), it's put back. If
 * it can't be (a third has the place by now), the one whose hold it was finds out as it next
 * looks, and stops: two never go on.
 */
function discard(path: string, id: string, judged: NonNullable<Found>) {
  const aside = `${path}.${id}.stale`
  try {
    renameSync(path, aside)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try {
    const moved = readFileSync(aside, 'utf8')
    if (moved !== judged.text) putNew(path, moved, `${aside}.back`)
  } finally {
    rmSync(aside, { force: true })
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // There, but not this one's to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// ——— Reading, a piece at a time ———

/** How much is read at once; and the longest line read as an event (one is at most 64 KiB). */
const PIECE = 64 * 1024
const MAX_LINE = 1024 * 1024

/** A line: what it says (nothing, when it's too long to be an event), and where it starts. */
interface Line {
  text: string
  at: number
}

/** Splits a file read backwards, a piece at a time, into its lines: the last first. */
class Backward {
  #rest = Buffer.alloc(0)
  /** The line being put together is longer than any event: whatever it says, it isn't one. */
  #long = false;

  /** The lines that end in a piece (which starts at `start`), given the pieces after it. */
  *take(piece: Buffer, start: number): Generator<Line> {
    const buffer = Buffer.concat([piece, this.#rest])
    let end = buffer.length
    for (let i = buffer.lastIndexOf(0x0a, end - 1); i >= 0; i = buffer.lastIndexOf(0x0a, i - 1)) {
      if (end > i + 1 || this.#long) yield this.#line(buffer, i + 1, end, start)
      this.#long = false
      end = i
      // (Searching from -1 would search from the end again.)
      if (i === 0) break
    }
    this.#rest = buffer.subarray(0, end)
    if (this.#rest.length > MAX_LINE) {
      this.#rest = Buffer.alloc(0)
      this.#long = true
    }
  }

  /** The file's first line, once there's nothing before it. */
  *finish(): Generator<Line> {
    if (this.#rest.length > 0 || this.#long) yield this.#line(this.#rest, 0, this.#rest.length, 0)
  }

  #line(buffer: Buffer, from: number, to: number, start: number): Line {
    return { text: this.#long ? '' : buffer.toString('utf8', from, to), at: start + from }
  }
}

/** Splits a file read forwards, a piece at a time, into its lines, numbered. */
class Forward {
  #rest = Buffer.alloc(0)
  #long = false
  #number = 0
  /** Where what's being put together starts in the file, and where its line does. */
  #restAt: number
  #lineAt: number

  constructor(start: number) {
    this.#restAt = start
    this.#lineAt = start
  }

  *take(piece: Buffer): Generator<Line & { number: number }> {
    const buffer = Buffer.concat([this.#rest, piece])
    let from = 0
    for (let i = buffer.indexOf(0x0a); i >= 0; i = buffer.indexOf(0x0a, i + 1)) {
      this.#number++
      if (i > from || this.#long) yield this.#line(buffer, from, i)
      this.#long = false
      from = i + 1
      this.#lineAt = this.#restAt + from
    }
    this.#rest = buffer.subarray(from)
    this.#restAt += from
    if (this.#rest.length > MAX_LINE) {
      this.#restAt += this.#rest.length
      this.#rest = Buffer.alloc(0)
      this.#long = true
    }
  }

  /** The last line, unfinished (no newline ends it), if there is one. */
  *finish(): Generator<Line & { number: number }> {
    if (this.#rest.length > 0 || this.#long) {
      this.#number++
      yield this.#line(this.#rest, 0, this.#rest.length)
    }
  }

  #line(buffer: Buffer, from: number, to: number) {
    return {
      text: this.#long ? '' : buffer.toString('utf8', from, to),
      at: this.#lineAt,
      number: this.#number,
    }
  }
}

/** A file's lines from its end (or from `end`, where a line starts), the last first. */
async function* linesBackward(path: string, end?: number): AsyncGenerator<Line> {
  const file = await openIfThere(path)
  if (!file) return
  try {
    const lines = new Backward()
    for (let until = end ?? (await file.stat()).size; until > 0;) {
      const start = Math.max(0, until - PIECE)
      const piece = Buffer.alloc(until - start)
      await file.read(piece, 0, piece.length, start)
      yield* lines.take(piece, start)
      until = start
    }
    yield* lines.finish()
  } finally {
    await file.close()
  }
}

/** A file's lines from its start (or from `start`, where a line starts), numbered from there. */
async function* linesForward(path: string, start = 0): AsyncGenerator<Line & { number: number }> {
  const file = await openIfThere(path)
  if (!file) return
  try {
    const lines = new Forward(start)
    const piece = Buffer.alloc(PIECE)
    for (let at = start; ;) {
      const { bytesRead } = await file.read(piece, 0, PIECE, at)
      if (bytesRead === 0) break
      yield* lines.take(piece.subarray(0, bytesRead))
      at += bytesRead
    }
    yield* lines.finish()
  } finally {
    await file.close()
  }
}

/**
 * Opened, or not there (let go of meanwhile, by retention). A file's alone: a device in its
 * place (a full disk's, say) reads forever, and isn't.
 */
async function openIfThere(path: string) {
  let file: FileHandle
  try {
    file = await open(path, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if ((await file.stat()).isFile()) return file
  await file.close()
  return undefined
}

/**
 * Where a page ended in a file, if what's there is still what it ended with: the same event, or
 * (where a search stopped) a line that isn't one.
 */
async function resumable(path: string, at: Position): Promise<number | undefined> {
  for await (const line of linesForward(path, at.offset)) {
    return eventOf(line.text)?.seq === (at.unreadable ? undefined : at.seq) ? at.offset : undefined
  }
  return undefined
}

/** Which line starts at a byte: said of one that can't be read, so it can be found. */
async function lineNumberAt(path: string, at: number): Promise<number> {
  let number = 0
  for await (const line of linesForward(path)) {
    number = line.number
    if (line.at >= at) break
  }
  return number
}

/** Whether a file's last line is unfinished (it doesn't end in a newline); none, it isn't. */
function endsUnfinished(path: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return false
  }
  try {
    const size = fstatSync(fd).size
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, Math.max(size - 1, 0))
    return size > 0 && last[0] !== 0x0a
  } finally {
    closeSync(fd)
  }
}

/** The first of some lines that's an event. */
function firstEvent(lines: Iterable<Line>): AuditEvent | undefined {
  for (const line of lines) {
    const event = eventOf(line.text)
    if (event) return event
  }
  return undefined
}

/** A file's last event that can be read, read from its end a piece at a time. */
function lastEventIn(path: string): AuditEvent | undefined {
  const fd = openSync(path, 'r')
  try {
    if (!fstatSync(fd).isFile()) return undefined
    const lines = new Backward()
    for (let end = fstatSync(fd).size; end > 0;) {
      const start = Math.max(0, end - PIECE)
      const piece = Buffer.alloc(end - start)
      readSync(fd, piece, 0, piece.length, start)
      const event = firstEvent(lines.take(piece, start))
      if (event) return event
      end = start
    }
    return firstEvent(lines.finish())
  } finally {
    closeSync(fd)
  }
}

/** A file's first event that can be read, read from its start a piece at a time. */
function firstEventIn(path: string): AuditEvent | undefined {
  const fd = openSync(path, 'r')
  try {
    if (!fstatSync(fd).isFile()) return undefined
    const lines = new Forward(0)
    const piece = Buffer.alloc(PIECE)
    for (let at = 0; ;) {
      const bytesRead = readSync(fd, piece, 0, PIECE, at)
      if (bytesRead === 0) break
      const event = firstEvent(lines.take(piece.subarray(0, bytesRead)))
      if (event) return event
      at += bytesRead
    }
    return firstEvent(lines.finish())
  } finally {
    closeSync(fd)
  }
}

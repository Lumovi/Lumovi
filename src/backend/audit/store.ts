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
  /** Each day file's first event, read once for as long as its size stays the same. */
  readonly #firsts = new Map<string, { size: number; seq: number | undefined }>()
  readonly #lock: HistoryLock

  constructor(
    readonly dir: string,
    readonly retentionDays: number,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // Its own, whoever made it (a volume, mounted): nobody else reads who did what.
    ownOnly(dir, 0o700)
    this.#lock = new HistoryLock(dir)
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

  #listDays = () =>
    readdirSync(this.dir)
      .map((name) => DAY_FILE.exec(name)?.[1])
      .filter((day): day is string => Boolean(day))
      .sort()

  append(event: AuditEvent) {
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
      if (before && (day > before.day! || (await this.#firstSeq(day))! >= before.seq)) continue
      const path = this.#path(day)
      // Where the page ended, if what's there is what it ended with: read on from there.
      const end = before?.day === day ? await resumable(path, before) : undefined
      // What's older than an unreadable line: older than the newest event after it.
      let newer = before?.seq ?? Number.MAX_SAFE_INTEGER
      for await (const line of linesBackward(path, end)) {
        const event = eventOf(line.text)
        if (!event) {
          yield {
            unreadable: `Line ${await lineNumberAt(path, line.at)} of audit-${day}.jsonl`,
            at: { seq: newer, day, offset: line.at, unreadable: true },
          }
        } else if (event.seq < newer) {
          newer = event.seq
          yield { event, at: { seq: event.seq, day, offset: line.at } }
        }
      }
    }
  }

  /** The first event's seq in a day's file (none: it can't be skipped). */
  async #firstSeq(day: string): Promise<number | undefined> {
    const path = this.#path(day)
    const size = statSync(path, { throwIfNoEntry: false })?.size
    const known = this.#firsts.get(day)
    if (known && known.size === size) return known.seq
    let seq: number | undefined
    for await (const line of linesForward(path)) {
      seq = eventOf(line.text)?.seq
      if (seq !== undefined) break
    }
    this.#firsts.set(day, { size: size!, seq })
    return seq
  }

  async *oldestFirst(): AsyncIterable<Read> {
    for (const day of [...this.#days]) {
      for await (const line of linesForward(this.#path(day))) {
        const event = eventOf(line.text)
        yield event ? { event } : { unreadable: `Line ${line.number} of audit-${day}.jsonl` }
      }
    }
  }

  /** Deletes the days older than it keeps (never the one the chain goes on from), and says it's still kept. */
  prune(now: Date) {
    this.#lock.renew()
    const oldestKept = dayOf(
      new Date(now.getTime() - this.retentionDays * 86_400_000).toISOString(),
    )
    const newest = this.#days.at(-1)
    for (const day of this.#days) {
      if (day >= oldestKept || day === newest) continue
      rmSync(this.#path(day), { force: true })
      this.#firsts.delete(day)
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

/** How long a lock nobody renews holds: a Lumovi that stopped without letting go of it. */
const LOCK_STALE_MS = 5 * 60_000

/**
 * The folder's one writer: two would number events the same (two pods sharing a volume, say).
 * Taken as the history opens, renewed as it's looked after (a minute at a time), and let go of
 * as it closes.
 */
class HistoryLock {
  readonly #path: string

  constructor(dir: string) {
    this.#path = join(dir, 'audit.lock')
    try {
      writeFileSync(this.#path, this.#mine(), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder = holderOf(this.#path)
      if (holder) {
        throw new Error(
          `Another Lumovi (process ${holder.pid} on ${holder.host}) keeps its audit history in ${dir}: two can’t, or they’d number events the same. Stop it, or give this one a folder of its own.`,
          { cause: error },
        )
      }
      // Left by one that stopped: moved aside by one taker alone (a rename is), then taken.
      const stale = `${this.#path}.${process.pid}`
      renameSync(this.#path, stale)
      rmSync(stale)
      writeFileSync(this.#path, this.#mine(), { flag: 'wx', mode: 0o600 })
    }
  }

  #mine = () => JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() })

  /** Still held: said, so it isn't taken as left by one that stopped. */
  renew() {
    writeFileSync(this.#path, this.#mine(), { mode: 0o600 })
  }

  release() {
    rmSync(this.#path, { force: true })
  }
}

/** Who holds a lock, if anyone still does. */
function holderOf(path: string): { pid: number; host: string } | undefined {
  let holder: { pid: number; host: string; at: number }
  try {
    holder = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  // On this computer: this process before it started again (a container's first process is
  // number 1, each time), or one that's gone.
  if (holder.host === hostname() && (holder.pid === process.pid || !alive(holder.pid))) {
    return undefined
  }
  return Date.now() - holder.at < LOCK_STALE_MS ? holder : undefined
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

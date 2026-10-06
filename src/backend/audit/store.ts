/**
 * Where the audit log's history is kept, for the Audit page to look
 * through: a file a day (`audit-2026-10-06.jsonl`, one event a line) in a
 * folder (a volume's, on a server; the desktop app's own), each kept for as
 * many days as set; or, with no folder, the most recent events in memory,
 * until the server stops.
 */
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isAuditAction, type AuditEvent } from '@shared/audit'

/** What a store gives back, oldest or newest first: events, or a line that isn't one. */
export type Stored = { event: AuditEvent } | { unreadable: string }

export interface AuditStore {
  readonly kind: 'files' | 'memory'
  readonly retentionDays?: number
  /** The newest event kept: where the chain goes on from. */
  last(): AuditEvent | undefined
  /** The oldest event's time. */
  oldest(): string | undefined
  /** Keeps it, or throws why it couldn't. */
  append(event: AuditEvent): void
  /** Newest first, from before `before` (a seq), skipping days before `from` (an ISO time). */
  newestFirst(options: { before?: number; from?: string; to?: string }): AsyncIterable<Stored>
  oldestFirst(): AsyncIterable<Stored>
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

  constructor(private readonly capacity: number) {}

  last = () => this.#events.at(-1)
  oldest = () => this.#events[0]?.time

  append(event: AuditEvent) {
    this.#events.push(event)
    if (this.#events.length > this.capacity) this.#events.shift()
  }

  async *newestFirst({ before }: { before?: number }): AsyncIterable<Stored> {
    for (let i = this.#events.length - 1; i >= 0; i--) {
      const event = this.#events[i]!
      if (before === undefined || event.seq < before) yield { event }
    }
  }

  async *oldestFirst(): AsyncIterable<Stored> {
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

  constructor(
    readonly dir: string,
    readonly retentionDays: number,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.#days = this.#listDays()
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
    const day = dayOf(event.time)
    const path = this.#path(day)
    let line = `${JSON.stringify(event)}\n`
    if (this.#writing !== day) {
      this.#writing = day
      if (!this.#days.includes(day)) this.#days = [...this.#days, day].sort()
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
    before?: number
    from?: string
    to?: string
  }): AsyncIterable<Stored> {
    for (const day of [...this.#days].reverse()) {
      if (from && day < dayOf(from)) break
      if (to && day > dayOf(to)) continue
      const lines = await this.#lines(day)
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!
        if (!line) continue
        const event = eventOf(line)
        if (!event) yield { unreadable: `Line ${i + 1} of audit-${day}.jsonl` }
        else if (before === undefined || event.seq < before) yield { event }
      }
    }
  }

  async *oldestFirst(): AsyncIterable<Stored> {
    for (const day of [...this.#days]) {
      const lines = await this.#lines(day)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        if (!line) continue
        const event = eventOf(line)
        yield event ? { event } : { unreadable: `Line ${i + 1} of audit-${day}.jsonl` }
      }
    }
  }

  async #lines(day: string): Promise<string[]> {
    try {
      return (await readFile(this.#path(day), 'utf8')).split('\n')
    } catch (error) {
      // Let go of meanwhile, by retention.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  /** Deletes the days older than it keeps; never the one the chain goes on from. */
  prune(now: Date) {
    const oldestKept = dayOf(
      new Date(now.getTime() - this.retentionDays * 86_400_000).toISOString(),
    )
    const newest = this.#last ? dayOf(this.#last.time) : this.#days.at(-1)
    for (const day of this.#days) {
      if (day >= oldestKept || day === newest) continue
      rmSync(this.#path(day), { force: true })
    }
    this.#days = this.#listDays()
  }

  // Nothing's kept open.
  close() {}
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

/** A file's events from its end, read a piece at a time: its last that can be read. */
function lastEventIn(path: string): AuditEvent | undefined {
  const fd = openSync(path, 'r')
  try {
    let end = fstatSync(fd).size
    // Bytes, not text, until a line is whole: a piece can end in the middle of a character.
    let rest = Buffer.alloc(0)
    while (end > 0) {
      const start = Math.max(0, end - 65_536)
      const piece = Buffer.alloc(end - start)
      readSync(fd, piece, 0, piece.length, start)
      const buffer = Buffer.concat([piece, rest])
      let lineEnd = buffer.length
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i] !== 0x0a) continue
        const line = buffer.subarray(i + 1, lineEnd).toString('utf8')
        const event = line ? eventOf(line) : undefined
        if (event) return event
        lineEnd = i
      }
      // Before the first newline, it may be cut off: it's read with the piece before it.
      rest = buffer.subarray(0, lineEnd)
      end = start
    }
    return rest.length ? eventOf(rest.toString('utf8')) : undefined
  } finally {
    closeSync(fd)
  }
}

function firstEventIn(path: string): AuditEvent | undefined {
  const fd = openSync(path, 'r')
  try {
    const piece = Buffer.alloc(Math.min(fstatSync(fd).size, 65_536))
    readSync(fd, piece, 0, piece.length, 0)
    for (const line of piece.toString('utf8').split('\n')) {
      const event = line ? eventOf(line) : undefined
      if (event) return event
    }
    return undefined
  } finally {
    closeSync(fd)
  }
}

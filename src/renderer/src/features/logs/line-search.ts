/**
 * A search of the logs, run in a worker the page stops if it takes too long: never on the page's
 * own thread, plain text included. Each line is matched once for a search, as it comes, and
 * what's known of it is kept with the line itself. A search that took too long is remembered as
 * that, and not run again.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { shownParts, type Range, type Runnable } from '@renderer/lib/log-search'
import type { LogLine } from '@renderer/lib/logs'
import type { MatchAnswer, MatchRequest } from './match.worker'

/** How long the worker may take over one batch of lines before it's stopped. */
export const TOO_LONG_MS = 1000
/** Lines sent at once: a long log is matched in steps, each with its own bound. */
const BATCH = 2000

/** What's known of a line, for a search: whether it matches, and where it's marked. */
export interface Known {
  match: boolean
  ranges: readonly Range[]
}

export const keyOf = (search: Runnable) => JSON.stringify(search)

/** One search's run: what's known of each line, and which lines it has been given. */
interface Run {
  key: string
  search: Runnable
  known: WeakMap<LogLine, Known>
  asked: WeakSet<LogLine>
}

export class LineSearch {
  #worker: Worker | undefined
  /** The search being run, and the last one that ran on every line it was given (its answers
   *  are what's shown while another runs, and are kept should that one take too long). */
  #current: Run | undefined
  #previous: Run | undefined
  #queue: LogLine[] = []
  #waiting: { id: number; lines: LogLine[]; timer: ReturnType<typeof setTimeout> } | undefined
  #next = 0
  readonly #slow = new Set<string>()
  readonly #listeners = new Set<() => void>()
  #version = 0

  constructor(
    private readonly make: () => Worker = () =>
      new Worker(new URL('./match.worker.ts', import.meta.url), { type: 'module' }),
  ) {}

  subscribe = (changed: () => void) => {
    this.#listeners.add(changed)
    return () => void this.#listeners.delete(changed)
  }

  /** Counts up whenever something new is known. */
  version = () => this.#version

  /** Whether this search took too long once: it isn't run again. */
  isSlow(search: Runnable): boolean {
    return this.#slow.has(keyOf(search))
  }

  /** Whether this search has been run on every line it was given: nothing waits for the worker. */
  done(search: Runnable): boolean {
    return keyOf(search) === this.#current?.key && this.#idle()
  }

  #idle() {
    return !this.#waiting && this.#queue.length === 0
  }

  /**
   * What's known of each line for this search (nothing for one not run, or not run on a line
   * yet): found once, then asked of each line.
   */
  lookup(search: Runnable): (line: LogLine) => Known | undefined {
    const key = keyOf(search)
    const run =
      key === this.#current?.key
        ? this.#current
        : key === this.#previous?.key
          ? this.#previous
          : undefined
    return (line) => run?.known.get(line)
  }

  /** Has these lines matched with this search: those already known, or asked, aren't asked again. */
  run(search: Runnable, lines: readonly LogLine[]): void {
    const key = keyOf(search)
    if (this.#slow.has(key)) return
    if (key !== this.#current?.key) {
      // Another search: what the worker is doing is no use (and may be what would never end),
      // so it's let go with its worker. The one that was running is kept, if it had finished.
      const finished = this.#current && this.#idle() ? this.#current : undefined
      this.#stop()
      const back = this.#previous?.key === key ? this.#previous : undefined
      this.#previous = finished ?? (back ? undefined : this.#previous)
      this.#current = back ?? { key, search, known: new WeakMap(), asked: new WeakSet() }
    }
    const run = this.#current!
    for (const line of lines) {
      if (run.asked.has(line)) continue
      run.asked.add(line)
      this.#queue.push(line)
    }
    this.#send()
  }

  #send(): void {
    if (this.#waiting || this.#queue.length === 0) return
    const lines = this.#queue.splice(0, BATCH)
    const id = ++this.#next
    const worker = (this.#worker ??= this.#started())
    const request: MatchRequest = {
      id,
      search: this.#current!.search,
      lines: lines.map((line, key) => ({ key, message: line.message, parts: shownParts(line) })),
    }
    this.#waiting = { id, lines, timer: setTimeout(() => this.#tooLong(), TOO_LONG_MS) }
    worker.postMessage(request)
  }

  #started(): Worker {
    const worker = this.make()
    worker.onmessage = ({ data }: MessageEvent<MatchAnswer>) => {
      const waiting = this.#waiting
      if (data.id !== waiting?.id) return
      clearTimeout(waiting.timer)
      for (const { key, match, ranges } of data.matched) {
        this.#current!.known.set(waiting.lines[key]!, { match, ranges })
      }
      this.#waiting = undefined
      this.#changed()
      this.#send()
    }
    return worker
  }

  /** It took too long: stopped, and the search remembered as one that does. */
  #tooLong(): void {
    this.#slow.add(this.#current!.key)
    this.#stop()
    this.#current = undefined
    this.#changed()
  }

  /** The worker let go, and the lines it hadn't answered for asked again should that search be. */
  #stop(): void {
    const run = this.#current
    for (const line of [...this.#queue, ...(this.#waiting?.lines ?? [])]) run?.asked.delete(line)
    if (this.#waiting) clearTimeout(this.#waiting.timer)
    this.#waiting = undefined
    this.#queue = []
    this.#worker?.terminate()
    this.#worker = undefined
  }

  #changed(): void {
    this.#version++
    this.#listeners.forEach((listener) => listener())
  }

  close(): void {
    this.#stop()
  }
}

/** A view's own search, redrawn whenever something new is known; stopped with the view. */
export function useLineSearch(): LineSearch {
  const [searcher] = useState(() => new LineSearch())
  useEffect(() => () => searcher.close(), [searcher])
  useSyncExternalStore(searcher.subscribe, searcher.version)
  return searcher
}

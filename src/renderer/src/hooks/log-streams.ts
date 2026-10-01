import { useEffect, useRef, useState } from 'react'
import type { KubeError, KubeErrorCode } from '@shared/api'
import { api } from '@renderer/lib/api'
import { mergeLines, parseLine, type LogLine } from '@renderer/lib/logs'
import { useCluster } from '@renderer/state/cluster'

/** A container whose logs to stream. */
export interface LogSource {
  key: string
  namespace: string
  pod: string
  container: string
}

export interface LogOptions {
  tailLines?: number
  sinceSeconds?: number
  previous: boolean
  follow: boolean
  /** Changes to start over ("Try again"). */
  attempt: number
}

/** Where a container's stream is at. */
export type StreamState =
  | { status: 'connecting' | 'streaming' | 'ended' }
  /** Following: it ended or failed, and is tried again shortly. */
  | { status: 'reconnecting'; error?: KubeError }
  | { status: 'failed'; error: KubeError }

export interface LogSnapshot {
  lines: LogLine[]
  states: Record<string, StreamState>
}

/** The most lines kept; older ones go first. */
export const MAX_LINES = 20_000
const RETRY_MS = 3_000
/** Failures that trying again won't fix: the user has to (sign in, ask for access…). */
const LASTING: ReadonlySet<KubeErrorCode> = new Set([
  'auth',
  'unauthorized',
  'forbidden',
  'tls',
  'insecure',
])
/** The page updates at most this often, however fast lines arrive. */
const FLUSH_MS = 100

interface Stream {
  source: LogSource
  id: string
  state: StreamState
  /** When the last line was written, and the lines written then: a reconnect sends them again. */
  lastAt: number
  seen: Set<string>
  retry?: ReturnType<typeof setTimeout>
}

/** The streams of some containers, merged into one list of lines. */
class LogSession {
  readonly #streams = new Map<string, Stream>()
  /** What becomes of each running stream's lines and end, by its id. */
  readonly #handlers = new Map<
    string,
    { lines: (lines: string[]) => void; end: (error?: KubeError) => void }
  >()
  readonly #unsubscribe: (() => void)[]
  #lines: LogLine[] = []
  #pending: LogLine[] = []
  #timer?: ReturnType<typeof setTimeout>

  constructor(
    private readonly context: string,
    private readonly options: LogOptions,
    private readonly notify: (snapshot: LogSnapshot) => void,
  ) {
    this.#unsubscribe = [
      // Other sessions' streams, and ones stopped here, have no handlers.
      api.logs.onLines((id, lines) => this.#handlers.get(id)?.lines(lines)),
      api.logs.onEnd((id, error) => this.#handlers.get(id)?.end(error)),
    ]
  }

  /** Streams these containers: new ones start, ones no longer here stop (their lines stay). */
  setSources(sources: LogSource[]) {
    const keys = new Set(sources.map((s) => s.key))
    for (const stream of [...this.#streams.values()]) {
      if (!keys.has(stream.source.key)) this.#drop(stream)
    }
    for (const source of sources.filter((s) => !this.#streams.has(s.key))) {
      const stream: Stream = {
        source,
        id: '',
        state: { status: 'connecting' },
        lastAt: -Infinity,
        seen: new Set(),
      }
      this.#streams.set(source.key, stream)
      void this.#start(stream)
    }
    this.#schedule()
  }

  close() {
    for (const stream of [...this.#streams.values()]) this.#drop(stream)
    for (const unsubscribe of this.#unsubscribe) unsubscribe()
    clearTimeout(this.#timer)
  }

  async #start(stream: Stream) {
    const id = crypto.randomUUID()
    stream.id = id
    this.#handlers.set(id, {
      lines: (lines) => this.#received(stream, lines),
      end: (error) => this.#ended(stream, error),
    })
    const { namespace, pod, container } = stream.source
    const { tailLines, sinceSeconds, previous, follow } = this.options
    const result = await api.logs.start(id, {
      context: this.context,
      namespace,
      pod,
      container,
      previous,
      follow,
      // Carry on from the last line; the API server sends lines written at that time again.
      ...(Number.isFinite(stream.lastAt)
        ? { sinceTime: new Date(stream.lastAt).toISOString() }
        : { tailLines, sinceSeconds }),
    })
    // Not wanted any more (or ended already): let it go.
    if (!this.#handlers.has(id)) {
      api.logs.stop(id)
      return
    }
    if (!result.ok) {
      this.#ended(stream, result.error)
      return
    }
    stream.state = { status: 'streaming' }
    this.#schedule()
  }

  #received(stream: Stream, lines: string[]) {
    stream.state = { status: 'streaming' }
    for (const raw of lines) {
      const line = parseLine(raw, stream.source.key)
      if (line.at < stream.lastAt || (line.at === stream.lastAt && stream.seen.has(raw))) continue
      if (line.at > stream.lastAt) {
        stream.lastAt = line.at
        stream.seen.clear()
      }
      stream.seen.add(raw)
      this.#pending.push(line)
    }
    this.#schedule()
  }

  #ended(stream: Stream, error?: KubeError) {
    this.#handlers.delete(stream.id)
    if (this.options.follow && !this.options.previous && !(error && LASTING.has(error.code))) {
      // The container restarted or stopped, or the connection dropped: try again.
      stream.state = { status: 'reconnecting', error }
      stream.retry = setTimeout(() => void this.#start(stream), RETRY_MS)
    } else {
      stream.state = error ? { status: 'failed', error } : { status: 'ended' }
    }
    this.#schedule()
  }

  #drop(stream: Stream) {
    clearTimeout(stream.retry)
    if (this.#handlers.delete(stream.id)) api.logs.stop(stream.id)
    this.#streams.delete(stream.source.key)
    // Its lines go too: a container switched away from, a pod that's gone.
    const kept = (line: LogLine) => line.source !== stream.source.key
    this.#lines = this.#lines.filter(kept)
    this.#pending = this.#pending.filter(kept)
  }

  #schedule() {
    this.#timer ??= setTimeout(() => this.#flush(), FLUSH_MS)
  }

  #flush() {
    this.#timer = undefined
    // Each stream's lines are in order; sorting (stably) interleaves the streams'.
    const incoming = this.#pending.sort((a, b) => a.at - b.at)
    this.#pending = []
    this.#lines = mergeLines(this.#lines, incoming).slice(-MAX_LINES)
    this.notify({
      lines: this.#lines,
      states: Object.fromEntries(
        [...this.#streams.values()].map((stream) => [stream.source.key, stream.state]),
      ),
    })
  }
}

/**
 * Streams the logs of `sources`, merged in the order they were written.
 * Changing the options starts over; sources can come and go.
 */
export function useLogStreams(sources: LogSource[], options: LogOptions): LogSnapshot {
  const { context } = useCluster()
  const [snapshot, setSnapshot] = useState<LogSnapshot>({ lines: [], states: {} })
  const session = useRef<LogSession>(null)
  const latest = useRef<LogSource[]>([])
  const optionsKey = JSON.stringify(options)
  const sourcesKey = JSON.stringify(sources)
  useEffect(() => {
    const created = new LogSession(context, JSON.parse(optionsKey) as LogOptions, setSnapshot)
    session.current = created
    created.setSources(latest.current)
    return () => created.close()
  }, [context, optionsKey])
  useEffect(() => {
    latest.current = JSON.parse(sourcesKey) as LogSource[]
    session.current!.setSources(latest.current)
  }, [sourcesKey])
  return snapshot
}

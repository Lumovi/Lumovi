/**
 * Lists watched for the page: each told when it changed (never how), so the page reads it again
 * at once rather than at its next poll. A watch the API server ends (its time up, a dropped
 * connection) begins again from where it got to; one that can't go on (refused, its kind gone)
 * is ended, saying why, and the page polls its list as it did.
 */
import type { KubeError, Result } from '@shared/api'
import type { KubeStream } from './client'
import { KubeRequestError, statusError, toKubeError } from './errors'
import type { KubeService } from './service'
import { invalid } from './validate'

/** Changes are told at most this often, per watch: a rollout's many, as one. */
const SETTLE_MS = 250
/** A watch the API server ended begins again after this long. */
const AGAIN_MS = 1_000
/** How many lists are watched at once: the desktop app's windows together, or a person's pages. */
export const MOST_WATCHED = 200
/** The most of one event held while it comes: far more than an object's metadata ever is. */
const MOST_EVENT = 1024 * 1024

/** What the API server sends, one a line. */
interface WatchEvent {
  type?: string
  object?: {
    metadata?: { resourceVersion?: string }
    /** An ERROR's: its status. */
    code?: number
  }
}

/** How many watches may be held at once, by whoever shares it: a person's every page, say. */
export class WatchAllowance {
  #held = 0

  constructor(readonly most = MOST_WATCHED) {}

  take(): boolean {
    if (this.#held >= this.most) return false
    this.#held++
    return true
  }

  give(): void {
    this.#held = Math.max(0, this.#held - 1)
  }
}

interface Watch {
  abort(): void
  /** Waiting to tell of changes. */
  telling?: ReturnType<typeof setTimeout>
  /** Waiting to begin again. */
  again?: ReturnType<typeof setTimeout>
}

export class ListWatches {
  readonly #watches = new Map<string, Watch>()

  constructor(
    private readonly kube: Pick<KubeService, 'watch'>,
    private readonly emit: {
      changed: (id: string) => void
      ended: (id: string, error?: KubeError) => void
    },
    /** Shared with whatever else of the same person's watches. */
    private readonly allowance = new WatchAllowance(),
    private readonly timing = { settleMs: SETTLE_MS, againMs: AGAIN_MS },
  ) {}

  /** Watches what `query` lists (as `kube.list` takes it), by an id the page picked. */
  async start(id: unknown, query: unknown): Promise<Result<null>> {
    try {
      if (typeof id !== 'string' || !/^[\w-]{8,64}$/.test(id) || this.#watches.has(id)) {
        throw invalid('A new watch needs a new id')
      }
      if (!this.allowance.take()) {
        throw invalid(`Lumovi watches at most ${this.allowance.most} lists at once`)
      }
      // (Its id taken at once: another start by it is refused while this one waits.)
      const watch: Watch = { abort: () => {} }
      this.#watches.set(id, watch)
      let opened
      try {
        opened = await this.kube.watch(query)
      } catch (error) {
        this.#forget(id, watch)
        throw error
      }
      // Stopped while it began: nobody's listening.
      if (this.#watches.get(id) !== watch) opened.abort()
      else this.#follow(id, watch, query, opened)
      return { ok: true, data: null }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  stop(id: unknown): void {
    const watch = this.#watches.get(String(id))
    if (!watch) return
    this.#forget(String(id), watch)
    watch.abort()
  }

  stopAll(): void {
    for (const id of [...this.#watches.keys()]) this.stop(id)
  }

  /** Reads a watch's events as they come; once it's over, begins it again. */
  #follow(id: string, watch: Watch, query: unknown, opened: KubeStream & { from: string }) {
    watch.abort = opened.abort
    let from: string | undefined = opened.from
    let partial = ''
    let failed: KubeRequestError | undefined
    const { body } = opened
    body.setEncoding('utf8')
    body.on('data', (chunk: string) => {
      // One event a line; a chunk can end mid-line.
      const lines = (partial + chunk).split('\n')
      partial = lines.pop()!
      // (What never ends a line isn't held without end: the watch is, and its list is polled.)
      if (partial.length > MOST_EVENT) {
        failed = new KubeRequestError('server', 'The cluster sent a watch event too long to be one')
        partial = ''
        opened.abort()
        return
      }
      for (const line of lines) {
        let event: WatchEvent
        try {
          event = JSON.parse(line) as WatchEvent
        } catch {
          continue
        }
        if (event.type === 'ERROR') {
          const code = event.object?.code ?? 500
          // Watched from a version gone from the API server's memory: from now, the list read
          // again for what came between.
          if (code === 410) {
            from = undefined
            this.#changed(id, watch)
          } else {
            failed = statusError(code, JSON.stringify(event.object))
          }
          continue
        }
        const version = event.object?.metadata?.resourceVersion
        if (version) from = version
        if (event.type !== 'BOOKMARK') this.#changed(id, watch)
      }
    })
    let over = false
    const ended = () => {
      if (over) return
      over = true
      // (Stopped by the page.)
      if (this.#watches.get(id) !== watch) return
      if (failed) {
        this.#end(id, watch, failed)
        return
      }
      watch.again = setTimeout(() => void this.#again(id, watch, query, from), this.timing.againMs)
    }
    body.on('end', ended)
    body.on('close', ended)
    body.on('error', ended)
  }

  /** Begins a watch again: from where it got to, or (that version gone) from now. */
  async #again(id: string, watch: Watch, query: unknown, from: string | undefined) {
    let opened
    try {
      try {
        opened = await this.kube.watch(query, from)
      } catch (error) {
        if (!(from && error instanceof KubeRequestError && error.status === 410)) throw error
        opened = await this.kube.watch(query)
        this.#changed(id, watch)
      }
      if (!from) this.#changed(id, watch)
    } catch (error) {
      this.#end(id, watch, error)
      return
    }
    if (this.#watches.get(id) !== watch) opened.abort()
    else this.#follow(id, watch, query, opened)
  }

  /** Tells the page its list changed: once for what changes together. */
  #changed(id: string, watch: Watch) {
    watch.telling ??= setTimeout(() => {
      watch.telling = undefined
      if (this.#watches.get(id) === watch) this.emit.changed(id)
    }, this.timing.settleMs)
  }

  #end(id: string, watch: Watch, error: unknown) {
    if (this.#forget(id, watch)) this.emit.ended(id, toKubeError(error))
  }

  /** A watch let go of, and its place in the allowance given back: false, where it was already. */
  #forget(id: string, watch: Watch): boolean {
    if (this.#watches.get(id) !== watch) return false
    this.#watches.delete(id)
    clearTimeout(watch.telling)
    clearTimeout(watch.again)
    this.allowance.give()
    return true
  }
}

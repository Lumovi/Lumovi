/**
 * Container logs streamed to the page as the API server sends them
 * (`kubectl logs -f --timestamps`), in batches so a chatty container doesn't
 * flood the page with messages.
 */
import type { KubeError, LogStreamRequest, Result } from '@shared/api'
import { kubeStream } from './client'
import { toKubeError } from './errors'
import type { KubeConfigStore } from './kubeconfig'
import { assertIntegerInRange, assertQuery, assertString, invalid } from './validate'

/** Lines are sent to the page at most this often, per stream. */
const BATCH_MS = 100
const MAX_TAIL = 10_000
const MAX_SINCE = 30 * 86_400

interface Dependencies {
  store: KubeConfigStore
  envReady: Promise<void>
  /** How long the API server has to start answering. */
  timeoutMs: number
}

export class LogStreams {
  readonly #streams = new Map<string, () => void>()

  constructor(
    private readonly deps: Dependencies,
    private readonly emit: {
      lines: (id: string, lines: string[]) => void
      end: (id: string, error?: KubeError) => void
    },
  ) {}

  async start(id: unknown, request: unknown): Promise<Result<null>> {
    try {
      if (typeof id !== 'string' || !/^[\w-]{8,64}$/.test(id) || this.#streams.has(id)) {
        throw invalid('A new stream needs a new id')
      }
      const r = assertQuery<LogStreamRequest>(request)
      assertString(r.context, 'context')
      assertString(r.namespace, 'namespace')
      assertString(r.pod, 'pod')
      assertString(r.container, 'container')
      const params = new URLSearchParams({ container: r.container, timestamps: 'true' })
      if (r.tailLines !== undefined) {
        assertIntegerInRange(r.tailLines, 'tailLines', 1, MAX_TAIL)
        params.set('tailLines', String(r.tailLines))
      }
      if (r.sinceSeconds !== undefined) {
        assertIntegerInRange(r.sinceSeconds, 'sinceSeconds', 1, MAX_SINCE)
        params.set('sinceSeconds', String(r.sinceSeconds))
      } else if (r.sinceTime !== undefined) {
        assertString(r.sinceTime, 'sinceTime')
        if (Number.isNaN(Date.parse(r.sinceTime))) throw invalid('sinceTime must be a time')
        params.set('sinceTime', r.sinceTime)
      }
      // A previous container has stopped: there's nothing more to follow.
      if (r.previous === true) params.set('previous', 'true')
      else if (r.follow === true) params.set('follow', 'true')
      const path = `/api/v1/namespaces/${encodeURIComponent(r.namespace)}/pods/${encodeURIComponent(r.pod)}/log?${params}`

      const kc = this.deps.store.forContext(r.context)
      await this.deps.envReady
      const { body, abort } = await kubeStream(kc, path, { timeoutMs: this.deps.timeoutMs })
      this.#streams.set(id, abort)
      let partial = ''
      let batch: string[] = []
      let timer: NodeJS.Timeout | undefined
      const flush = () => {
        clearTimeout(timer)
        timer = undefined
        if (batch.length) this.emit.lines(id, batch)
        batch = []
      }
      // The API server ends every line; a chunk can end mid-line, or mid-character.
      body.setEncoding('utf8')
      body.on('data', (chunk: string) => {
        const lines = (partial + chunk).split('\n')
        partial = lines.pop()!
        batch.push(...lines.filter(Boolean))
        timer ??= setTimeout(flush, BATCH_MS)
      })
      let ended = false
      const end = (error?: Error) => {
        if (ended) return
        ended = true
        // Stopped by the page, which isn't listening any more.
        if (!this.#streams.delete(id)) return
        flush()
        this.emit.end(id, error && toKubeError(error))
      }
      body.on('end', () => end())
      body.on('error', end)
      body.on('close', () => end())
      return { ok: true, data: null }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  stop(id: unknown): void {
    const abort = this.#streams.get(String(id))
    this.#streams.delete(String(id))
    abort?.()
  }

  stopAll(): void {
    for (const id of [...this.#streams.keys()]) this.stop(id)
  }
}

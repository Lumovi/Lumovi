/**
 * Where else audit events go, as they're recorded: the server's output, one
 * JSON line each (for whatever collects its logs: Fluent Bit, Vector, the
 * Datadog agent…), and a webhook, sent in batches and tried again until it
 * takes them. What can't be sent is counted, and said, never lost quietly.
 */
import type { AuditEvent } from '@shared/audit'

export interface AuditSink {
  /** What the Audit page calls it: "the server’s output", "https://siem.example.com/…". */
  readonly name: string
  send(event: AuditEvent): void
  /** How many it couldn't send, ever, and why the last couldn't be. */
  dropped(): number
  problem(): string | undefined
  /** Sends what's waiting, for at most `ms`. */
  flush(ms: number): Promise<void>
}

/** One JSON line each, to the server's output. */
export class StdoutSink implements AuditSink {
  readonly name = 'the server’s output'
  #dropped = 0
  #problem: string | undefined

  send(event: AuditEvent) {
    try {
      process.stdout.write(`${JSON.stringify(event)}\n`)
    } catch (error) {
      this.#dropped++
      this.#problem = (error as Error).message
    }
  }

  dropped = () => this.#dropped
  problem = () => this.#problem
  flush = async () => {}
}

export type WebhookFormat = 'json' | 'ndjson'

export interface WebhookOptions {
  url: URL
  /** Sent with each request: an Authorization header, say. */
  headers: Record<string, string>
  /** A JSON array of events, or a JSON line each. */
  format: WebhookFormat
  /** How many are kept to send, at most: the oldest are let go first. */
  buffer: number
}

const SECOND = 1000
/** How many go in one request, at most (fewer, if it says that's too many). */
const BATCH = 100

/** Batches to a URL, in order: a second's worth at a time, tried again as long as it fails. */
export class WebhookSink implements AuditSink {
  readonly name: string
  readonly #queue: AuditEvent[] = []
  #batch = BATCH
  #dropped = 0
  #problem: string | undefined
  #timer: NodeJS.Timeout | undefined
  #sending: Promise<void> | undefined
  #retryIn = SECOND

  constructor(private readonly options: WebhookOptions) {
    // Where it goes, not who it goes as: no user, password or query (a token can be in one).
    this.name = `${options.url.origin}${options.url.pathname}`
  }

  send(event: AuditEvent) {
    this.#queue.push(event)
    if (this.#queue.length > this.options.buffer) {
      this.#queue.shift()
      this.#dropped++
      this.#problem = `More than ${this.options.buffer.toLocaleString('en')} events were waiting to be sent: the oldest were let go.`
    }
    this.#schedule(SECOND)
  }

  dropped = () => this.#dropped
  problem = () => this.#problem

  #schedule(ms: number) {
    if (this.#timer || this.#sending) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#sending = this.#deliver().finally(() => (this.#sending = undefined))
    }, ms)
    this.#timer.unref()
  }

  async #deliver(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.slice(0, this.#batch)
      const outcome = await this.#post(batch)
      if (outcome === 'sent') {
        // What was let go meanwhile came off the front: these are still the first.
        this.#queue.splice(0, this.#queue.indexOf(batch.at(-1)!) + 1)
        this.#retryIn = SECOND
        this.#problem = undefined
      } else if (outcome === 'rejected') {
        // Refused as they are: sending them again won't change that.
        const sent = this.#queue.indexOf(batch.at(-1)!) + 1
        this.#queue.splice(0, sent)
        this.#dropped += sent
      } else if (outcome === 'smaller') {
        continue
      } else {
        const wait = this.#retryIn
        this.#retryIn = Math.min(this.#retryIn * 2, 60 * SECOND)
        this.#sending = undefined
        this.#schedule(wait)
        return
      }
    }
  }

  async #post(batch: AuditEvent[]): Promise<'sent' | 'rejected' | 'smaller' | 'retry'> {
    const body =
      this.options.format === 'ndjson'
        ? batch.map((event) => `${JSON.stringify(event)}\n`).join('')
        : JSON.stringify(batch)
    try {
      const response = await fetch(this.options.url, {
        method: 'POST',
        headers: {
          'content-type':
            this.options.format === 'ndjson' ? 'application/x-ndjson' : 'application/json',
          ...this.options.headers,
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(10 * SECOND),
      })
      await response.body?.cancel()
      if (response.ok) return 'sent'
      if (response.status === 413 && this.#batch > 1) {
        this.#batch = Math.max(1, Math.floor(this.#batch / 2))
        return 'smaller'
      }
      this.#problem = `It answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`
      // The events themselves refused (not who sends them, nor how often): they never will be taken.
      return [400, 413, 422].includes(response.status) ? 'rejected' : 'retry'
    } catch (error) {
      this.#problem = `It can’t be reached: ${(error as Error).message}.`
      return 'retry'
    }
  }

  async flush(ms: number) {
    const deadline = Date.now() + ms
    while (this.#queue.length > 0 && Date.now() < deadline) {
      // Now, not when a retry would have been: and only one sending at a time.
      clearTimeout(this.#timer)
      this.#timer = undefined
      this.#sending ??= this.#deliver().finally(() => (this.#sending = undefined))
      await this.#sending
      if (this.#queue.length > 0) await new Promise((done) => setTimeout(done, 200))
    }
    clearTimeout(this.#timer)
    this.#timer = undefined
  }
}

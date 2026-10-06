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
  /** How many it couldn't send, ever. */
  dropped(): number
  /** Why it can't send now, if it can't. */
  problem(): string | undefined
  /** Why it last couldn't send some (and let them go). */
  lost(): string | undefined
  /** Sends what's waiting, for at most `ms`. */
  flush(ms: number): Promise<void>
  /** Lets go of what's still waiting, counted: Lumovi is stopping. Sends nothing more. */
  abandon(): void
}

/** One JSON line each, to the server's output (whatever collects it says when it can't). */
export class StdoutSink implements AuditSink {
  readonly name = 'the server’s output'
  send = (event: AuditEvent) => void process.stdout.write(`${JSON.stringify(event)}\n`)
  dropped = () => 0
  problem = () => undefined
  lost = () => undefined
  flush = async () => {}
  abandon = () => {}
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
/** How many go in one request, at most (fewer, for a while, if it says that's too many). */
const BATCH = 100
/** How long it sends fewer, once it said that was too many; and waits for an answer (envs for tests). */
const SMALLER_FOR_MS = Number(process.env.LUMOVI_AUDIT_SMALLER_MS) || 10 * 60 * SECOND
const ANSWER_MS = Number(process.env.LUMOVI_AUDIT_ANSWER_MS) || 10 * SECOND
/** How much waits to be sent, at most, however many events that is. */
const BUFFER_BYTES = 64 * 1024 * 1024

/** An event waiting: as it's sent. */
interface Waiting {
  event: AuditEvent
  json: string
}

/** Batches to a URL, in order: a second's worth at a time, tried again as long as it fails. */
export class WebhookSink implements AuditSink {
  readonly name: string
  readonly #queue: Waiting[] = []
  #bytes = 0
  #batch = BATCH
  #smallerUntil = 0
  #dropped = 0
  #problem: string | undefined
  #lost: string | undefined
  #timer: NodeJS.Timeout | undefined
  #sending: Promise<void> | undefined
  #retryIn = SECOND
  /** Ends a send in flight, as Lumovi stops. */
  #stopping = new AbortController()
  #abandoned = false

  constructor(private readonly options: WebhookOptions) {
    // Where it goes, not who it goes as: no user, password or query (a token can be in one).
    this.name = `${options.url.origin}${options.url.pathname}`
  }

  send(event: AuditEvent) {
    if (this.#abandoned) return
    const json = JSON.stringify(event)
    this.#queue.push({ event, json })
    this.#bytes += json.length
    if (this.#queue.length > this.options.buffer || this.#bytes > BUFFER_BYTES) {
      this.#lose(
        this.#take(1),
        `More than ${this.options.buffer.toLocaleString('en')} events (or ${BUFFER_BYTES / 1024 / 1024} MiB of them) were waiting to be sent: the oldest were let go.`,
      )
    }
    this.#schedule(SECOND)
  }

  dropped = () => this.#dropped
  problem = () => this.#problem
  lost = () => this.#lost

  /** The first `count` waiting, taken off the queue. */
  #take(count: number): Waiting[] {
    const taken = this.#queue.splice(0, count)
    for (const { json } of taken) this.#bytes -= json.length
    return taken
  }

  /**
   * Counts what's let go, and why: but not what it was told of its own losses (a webhook refusing
   * every event refuses those too, and that's no news: counted, it'd be told again, and again).
   */
  #lose(waiting: Waiting[], why: string) {
    const counted = waiting.filter(
      ({ event }) => !(event.action === 'audit.dropped' && event.details?.sink === this.name),
    ).length
    this.#dropped += counted
    if (counted > 0) this.#lost = why
  }

  #schedule(ms: number) {
    if (this.#timer || this.#sending || this.#abandoned) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#sending = this.#deliver().finally(() => (this.#sending = undefined))
    }, ms)
    this.#timer.unref()
  }

  async #deliver(): Promise<void> {
    while (this.#queue.length > 0 && !this.#abandoned) {
      if (this.#batch < BATCH && Date.now() > this.#smallerUntil) this.#batch = BATCH
      const batch = this.#queue.slice(0, this.#batch)
      const outcome = await this.#post(batch)
      // What was let go meanwhile came off the front: these are still the first.
      const sent = () => this.#take(this.#queue.indexOf(batch.at(-1)!) + 1)
      if (outcome === 'sent') {
        sent()
        this.#retryIn = SECOND
        this.#problem = undefined
      } else if (outcome === 'rejected') {
        // Refused as they are: sending them again won't change that.
        this.#lose(sent(), this.#problem!)
      } else if (outcome === 'retry') {
        // Waits longer each time (a minute at most), and not in step with others that failed too.
        const wait = this.#retryIn * (0.5 + Math.random() / 2)
        this.#retryIn = Math.min(this.#retryIn * 2, 60 * SECOND)
        this.#sending = undefined
        this.#schedule(wait)
        return
      }
    }
  }

  async #post(batch: Waiting[]): Promise<'sent' | 'rejected' | 'smaller' | 'retry'> {
    const json = batch.map((waiting) => waiting.json)
    const body = this.options.format === 'ndjson' ? `${json.join('\n')}\n` : `[${json.join(',')}]`
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
        signal: AbortSignal.any([AbortSignal.timeout(ANSWER_MS), this.#stopping.signal]),
      })
      await response.body?.cancel()
      if (response.ok) return 'sent'
      if (response.status === 413 && this.#batch > 1) {
        this.#batch = Math.max(1, Math.floor(this.#batch / 2))
        this.#smallerUntil = Date.now() + SMALLER_FOR_MS
        return 'smaller'
      }
      this.#problem = `It answered ${response.status}.`
      // The events themselves refused (not who sends them, nor how often): they never will be taken.
      return [400, 413, 422].includes(response.status) ? 'rejected' : 'retry'
    } catch (error) {
      // Said as what went wrong, not what was sent (a header's value can be a token).
      this.#problem = `It can’t be reached: ${reasonOf(error)}.`
      return 'retry'
    }
  }

  async flush(ms: number) {
    const deadline = Date.now() + ms
    // What's in flight as time's up is ended: stopping takes as long as it's given.
    const stop = setTimeout(() => this.#stopping.abort(), ms)
    while (this.#queue.length > 0 && Date.now() < deadline) {
      // Now, not when a retry would have been: and only one sending at a time.
      clearTimeout(this.#timer)
      this.#timer = undefined
      this.#sending ??= this.#deliver().finally(() => (this.#sending = undefined))
      await this.#sending
      if (this.#queue.length > 0) await new Promise((done) => setTimeout(done, 200))
    }
    clearTimeout(stop)
    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  abandon() {
    this.#abandoned = true
    this.#stopping.abort()
    clearTimeout(this.#timer)
    if (this.#queue.length > 0) {
      this.#lose(this.#take(this.#queue.length), 'Lumovi stopped before they could be sent.')
    }
  }
}

/** Why a request failed, in words that never hold what it sent. */
function reasonOf(error: unknown): string {
  const { name, cause } = error as Error & { cause?: { code?: string } }
  if (name === 'TimeoutError') return `it didn’t answer within ${ANSWER_MS / SECOND} seconds`
  if (name === 'AbortError') return 'Lumovi stopped as it was sending'
  return cause?.code ? `the connection failed (${cause.code})` : 'the request failed'
}

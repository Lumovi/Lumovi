/**
 * The audit log's chain: each event's hash is the SHA-256 of the event
 * itself (every field but its hash, keys in order, as JSON), and that
 * includes the hash of the event before it. Changing, removing or adding an
 * event anywhere breaks every hash after it, so it shows when the chain is
 * checked: by Lumovi, or by anyone with the events and `sha256sum`.
 */
import { createHash } from 'node:crypto'
import type { AuditEvent, AuditVerification } from '@shared/audit'

/** As jq writes a string: JSON's escapes, and DEL (U+007F) too. */
const text = (value: string) => JSON.stringify(value).replace(/\u007f/g, '\\u007f')

/**
 * JSON with every object's keys in order, so the same event always has the same text: the text
 * `jq -jcS 'del(.hash)'` writes, so anyone can check a hash with jq and sha256sum.
 */
export function canonical(value: unknown): string {
  if (typeof value === 'string') return text(value)
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    // By code point, as jq sorts them (not UTF-16's units); keys are each other's own, never the same.
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  return `{${entries.map(([k, v]) => `${text(k)}:${canonical(v)}`).join(',')}}`
}

export const hashOf = (event: Omit<AuditEvent, 'hash'>): string =>
  createHash('sha256')
    .update(canonical({ ...event, hash: undefined }))
    .digest('hex')

/** How many places a check lists where the chain doesn't hold: past that, how many more. */
const LISTED = 100

type Break = AuditVerification['breaks'][number]

/** Checks events in order, oldest first: whether each follows from the one before it. */
export class ChainCheck {
  /** The event checked last; and each chain's last, each checked against its own. */
  #last: AuditEvent | undefined
  readonly #lasts = new Map<string, AuditEvent>()
  #checked = 0
  #first: AuditEvent | undefined
  readonly #breaks: Break[] = []
  #more = 0

  /** Takes the next event: where it doesn't follow, that's said, and the check goes on from it. */
  add(event: AuditEvent) {
    const reason = this.#reasonAgainst(event)
    if (reason) this.#break({ seq: event.seq, time: event.time, reason })
    this.#first ??= event
    this.#last = event
    this.#lasts.set(event.chain, event)
    this.#checked++
  }

  /** A line that can't be read as an event at all, where the next should have been. */
  unreadable(where: string) {
    this.#break({
      seq: (this.#last?.seq ?? 0) + 1,
      time: this.#last?.time ?? '',
      reason: `${where} can’t be read as an audit event.`,
    })
  }

  #break(broken: Break) {
    if (this.#breaks.length < LISTED) this.#breaks.push(broken)
    else this.#more++
  }

  #reasonAgainst(event: AuditEvent): string | undefined {
    if (hashOf(event) !== event.hash) {
      return 'Its hash isn’t what its contents give: it was changed after it was recorded.'
    }
    // The first checked follows from whatever came before it, kept no longer.
    if (!this.#last) return undefined
    const last = this.#lasts.get(event.chain) ?? this.#last
    if (event.seq === 1 && event.prev === '') {
      return `A new chain starts here, after event ${last.seq}: Lumovi started again without the events before it (they were removed, or couldn’t be read), or two of Lumovi’s servers kept this history at once.`
    }
    if (!this.#lasts.has(event.chain)) {
      return 'It’s from another chain than the events before it: two of Lumovi’s servers kept their events here at once, or one was put in.'
    }
    if (event.seq <= last.seq) {
      return `It’s number ${event.seq}, after number ${last.seq}: one was repeated, or moved, or two of Lumovi’s servers kept this history at once.`
    }
    if (event.seq !== last.seq + 1) {
      return event.seq === last.seq + 2
        ? `Event ${last.seq + 1} is missing.`
        : `Events ${last.seq + 1}–${event.seq - 1} are missing.`
    }
    if (event.prev !== last.hash) {
      return 'It doesn’t follow from the event before it: one of them was changed, or replaced.'
    }
    return undefined
  }

  result(): AuditVerification {
    const last = this.#last
    return {
      checked: this.#checked,
      from: this.#first?.time,
      to: last?.time,
      ...(last ? { last: { seq: last.seq, hash: last.hash } } : {}),
      breaks: this.#breaks,
      more: this.#more,
    }
  }
}

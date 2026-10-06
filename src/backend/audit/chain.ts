/**
 * The audit log's chain: each event's hash is the SHA-256 of the event
 * itself (every field but its hash, keys in order, as JSON), and that
 * includes the hash of the event before it. Changing, removing or adding an
 * event anywhere breaks every hash after it, so it shows when the chain is
 * checked: by Lumovi, or by anyone with the events and `sha256sum`.
 */
import { createHash } from 'node:crypto'
import type { AuditEvent, AuditVerification } from '@shared/audit'

/** JSON with every object's keys in order, so the same event always has the same text. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

export const hashOf = (event: Omit<AuditEvent, 'hash'>): string =>
  createHash('sha256')
    .update(canonical({ ...event, hash: undefined }))
    .digest('hex')

/** Checks events in order, oldest first: whether each follows from the one before it. */
export class ChainCheck {
  #last: AuditEvent | undefined
  #checked = 0
  #first: AuditEvent | undefined
  #broken: AuditVerification['broken']

  /** Takes the next event; false once the chain is broken (nothing after it is checked). */
  add(event: AuditEvent): boolean {
    if (this.#broken) return false
    const reason = this.#reasonAgainst(event)
    if (reason) {
      this.#broken = { seq: event.seq, time: event.time, reason }
      return false
    }
    this.#first ??= event
    this.#last = event
    this.#checked++
    return true
  }

  /** An event that couldn't be read at all, where the next should have been. */
  unreadable(where: string) {
    this.#broken ??= {
      seq: (this.#last?.seq ?? 0) + 1,
      time: this.#last?.time ?? '',
      reason: `${where} can’t be read as an audit event.`,
    }
  }

  #reasonAgainst(event: AuditEvent): string | undefined {
    if (hashOf(event) !== event.hash) {
      return 'Its hash isn’t what its contents give: it was changed after it was recorded.'
    }
    const last = this.#last
    if (!last) return undefined
    // A new chain starts where the server started with nothing to follow (memory, or a new volume).
    if (event.seq === 1 && event.prev === '') return undefined
    if (event.seq <= last.seq) {
      return `It’s number ${event.seq}, after number ${last.seq}: one was repeated, or moved.`
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
    return {
      checked: this.#checked,
      from: this.#first?.time,
      to: this.#last?.time,
      broken: this.#broken,
    }
  }
}

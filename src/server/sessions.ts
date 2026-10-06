/**
 * Who is signed in, kept in the server's memory: a session ends when it
 * expires, when its person signs out, or when the server restarts (people
 * then sign in again). The browser only holds a random id, in a cookie.
 */
import { randomBytes } from 'node:crypto'
import type { SessionEnd } from '@shared/server'
import type { Identity } from './cluster'

export interface StoredSession {
  id: string
  identity: Identity
  expires: number
}

/** Sessions are capped well below what a timer can wait (24.8 days). */
export const MAX_SESSION_HOURS = 24 * 7

export class Sessions {
  readonly #sessions = new Map<string, StoredSession & { timer: NodeJS.Timeout }>()

  constructor(
    private readonly hours: number,
    /** Called with each session that ends (and why, when it expired early), so its pages can be told. */
    private readonly ended: (session: StoredSession, how: SessionEnd, why: string) => void,
  ) {}

  create(identity: Identity): StoredSession {
    const id = randomBytes(32).toString('base64url')
    const lifetime = this.hours * 3_600_000
    const timer = setTimeout(
      () => this.end(id, 'expired', `It lasted the ${this.hours} hours sessions do.`),
      lifetime,
    ).unref()
    const session = { id, identity, expires: Date.now() + lifetime }
    this.#sessions.set(id, { ...session, timer })
    return session
  }

  get(id: string | undefined): StoredSession | undefined {
    return id === undefined ? undefined : this.#sessions.get(id)
  }

  end(id: string, how: SessionEnd, why: string): void {
    const session = this.#sessions.get(id)
    if (!session) return
    clearTimeout(session.timer)
    this.#sessions.delete(id)
    const { timer: _timer, ...ended } = session
    this.ended(ended, how, why)
  }
}

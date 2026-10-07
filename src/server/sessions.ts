/**
 * Who is signed in: a session ends when it expires, or when its person signs out. The browser
 * holds a random id, in a cookie; the server knows a session by that id's hash alone, and keeps
 * it (see state.ts), so a restart signs nobody out.
 *
 * What a session passes on to the cluster (its person's own token, and with single sign-on what
 * renews it) is kept sealed, with a key its cookie alone gives: after a restart, it's unsealed
 * as its browser comes back. Until then the session is there, but dormant: what acts as its
 * person (their AI assistants) waits for them.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import type { SessionEnd, SessionUser } from '@shared/server'
import type { Identity } from './cluster'
import type { ServerState } from './state'

export interface StoredSession {
  /** Its handle on the server: its cookie's hash (the cookie itself is its browser's alone). */
  id: string
  identity: Identity
  expires: number
}

/** What a session passes on to the cluster, and with single sign-on, what renews it. */
export interface Credentials {
  token?: string
  /** When the token expires (ms since the epoch). */
  tokenExpires?: number
  refreshToken?: string
}

/** A session as it's kept. */
interface KeptSession {
  user: SessionUser
  expires: number
  /** Its credentials, sealed with its cookie's key. */
  sealed?: string
}

interface Live extends StoredSession {
  timer: NodeJS.Timeout
  credentials?: Credentials
  /** The key its credentials are sealed with, once its cookie's been seen here (never kept). */
  key?: Buffer
  /** Its credentials as they were kept, until its cookie unseals them. */
  sealed?: string
}

/** Sessions are capped well below what a timer can wait (24.8 days). */
export const MAX_SESSION_HOURS = 24 * 7

/** A cookie's handle on the server. */
export const sessionId = (cookie: string) => createHash('sha256').update(cookie).digest('base64url')

export class Sessions {
  readonly #sessions = new Map<string, Live>()

  constructor(
    private readonly hours: number,
    /** Called with each session that ends (and why, when it expired early), so its pages can be told. */
    private readonly ended: (session: StoredSession, how: SessionEnd, why: string) => void,
    private readonly state?: ServerState,
  ) {
    // Those kept, as they were: the credentials of those that have any, sealed.
    for (const [id, kept] of state?.entries<KeptSession>('sessions') ?? []) {
      if (!isKept(kept) || kept.expires <= Date.now()) continue
      this.#sessions.set(id, {
        id,
        identity: { user: kept.user },
        expires: kept.expires,
        timer: this.#expiring(id, kept.expires),
        ...(kept.sealed ? { sealed: kept.sealed } : {}),
      })
    }
  }

  /** A new session: its cookie, for its browser, and what the server knows it by. */
  create(
    identity: Identity,
    credentials?: Credentials,
  ): { cookie: string; session: StoredSession } {
    const cookie = randomBytes(32).toString('base64url')
    const id = sessionId(cookie)
    const expires = Date.now() + this.hours * 3_600_000
    const live: Live = {
      id,
      identity: { user: identity.user, ...(identity.token ? { token: identity.token } : {}) },
      expires,
      timer: this.#expiring(id, expires),
      key: keyOf(cookie),
    }
    this.#sessions.set(id, live)
    this.#keep(live, { ...credentials, ...(identity.token ? { token: identity.token } : {}) })
    return { cookie, session: live }
  }

  /**
   * The session a cookie is for; after a restart, its credentials unsealed with it. `resumed`
   * says they were just now (so what renews its token is started again).
   */
  get(cookie: string | undefined): (StoredSession & { resumed?: true }) | undefined {
    if (!cookie) return undefined
    const live = this.#sessions.get(sessionId(cookie))
    if (!live) return undefined
    if (live.sealed === undefined) return live
    const key = keyOf(cookie)
    let credentials: Credentials
    try {
      credentials = JSON.parse(unseal(live.sealed, key)) as Credentials
    } catch {
      // Not what this cookie sealed: it isn't this session's.
      return undefined
    }
    live.key = key
    delete live.sealed
    if (credentials.token) live.identity.token = credentials.token
    live.credentials = credentials
    return { id: live.id, identity: live.identity, expires: live.expires, resumed: true }
  }

  /** A session by its handle (an assistant's, say): dormant ones too. */
  byId(id: string): StoredSession | undefined {
    return this.#sessions.get(id)
  }

  /** Whether its credentials wait for its browser (the server restarted since it was last seen). */
  dormant(id: string): boolean {
    return this.#sessions.get(id)?.sealed !== undefined
  }

  /** With single sign-on: what renews its token, once it's known here. */
  credentials(id: string): Credentials | undefined {
    return this.#sessions.get(id)?.credentials
  }

  /** Its token renewed (single sign-on): passed on from now, and kept. */
  renewed(id: string, credentials: Credentials): void {
    const live = this.#sessions.get(id)
    if (!live) return
    if (credentials.token) live.identity.token = credentials.token
    this.#keep(live, { ...live.credentials, ...credentials })
  }

  end(id: string, how: SessionEnd, why: string): void {
    const live = this.#sessions.get(id)
    if (!live) return
    clearTimeout(live.timer)
    this.#sessions.delete(id)
    this.state?.delete('sessions', id)
    this.ended({ id, identity: live.identity, expires: live.expires }, how, why)
  }

  #expiring(id: string, expires: number): NodeJS.Timeout {
    return setTimeout(
      () => this.end(id, 'expired', `It lasted the ${this.hours} hours sessions do.`),
      Math.max(0, expires - Date.now()),
    ).unref()
  }

  /** It's kept, its credentials sealed with its cookie's key. */
  #keep(live: Live, credentials: Credentials): void {
    const has = Object.values(credentials).some((value) => value !== undefined)
    live.credentials = has ? credentials : undefined
    const kept: KeptSession = {
      user: live.identity.user,
      expires: live.expires,
      ...(has && live.key ? { sealed: seal(JSON.stringify(credentials), live.key) } : {}),
    }
    this.state?.set('sessions', live.id, kept)
  }
}

const isKept = (value: unknown): value is KeptSession => {
  const kept = value as KeptSession
  return (
    typeof kept === 'object' &&
    kept !== null &&
    typeof kept.expires === 'number' &&
    typeof kept.user?.name === 'string' &&
    Array.isArray(kept.user.groups) &&
    (kept.sealed === undefined || typeof kept.sealed === 'string')
  )
}

/** The key a cookie seals its session's credentials with: from it, as only it can give it. */
function keyOf(cookie: string): Buffer {
  return Buffer.from(hkdfSync('sha256', cookie, 'lumovi', 'session credentials', 32))
}

/** AES-256-GCM: its nonce, its tag, and what it seals, together. */
function seal(text: string, key: Buffer): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const sealed = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), sealed]).toString('base64url')
}

function unseal(sealed: string, key: Buffer): string {
  const bytes = Buffer.from(sealed, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
}

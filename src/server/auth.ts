/**
 * Who a request is from, and signing in and out: with a token the cluster
 * accepts, with single sign-on, or (behind an authenticating proxy) as the
 * proxy's headers say.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Session, SessionUser, SignIn, SignInProblem } from '@shared/server'
import { kubeRequest } from '@backend/kube/client'
import type { AuditOutcome } from '@shared/audit'
import type { AuditLog } from '@backend/audit/log'
import { toKubeError } from '@backend/kube/errors'
import { origin, personActor, SERVER_ACTOR } from './audit'
import type { Hosted, Identity } from './cluster'
import type { ServerConfig } from './config'
import { cookie, cookies, readJson, redirect, sameOrigin, secure, sendJson } from './http'
import { log } from './log'
import type { Forwarded, OidcClient, PendingSignIn, SignedIn } from './oidc'
import type { Sessions, StoredSession } from './sessions'

export const SESSION_COOKIE = 'lumovi-session'
/**
 * A sign-in that went to the provider, kept by the browser that started it:
 * its state, PKCE verifier and nonce, signed so it can't be changed.
 */
const SIGN_IN_COOKIE = 'lumovi-sign-in'
/** How long a sign-in with the provider may take (an env for tests). */
const SIGN_IN_MINUTES = Number(process.env.LUMOVI_SIGN_IN_MINUTES) || 10
/** Signs sign-ins in progress; they don't outlive the server. */
const KEY = randomBytes(32)
const signature = (body: string) => createHmac('sha256', KEY).update(body).digest('base64url')
/** Compares in constant time, whatever the lengths. */
const same = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
const REVIEWS = '/apis/authentication.k8s.io/v1/selfsubjectreviews'
/** How long before a passed-on token expires it's renewed. */
const RENEW_EARLY_MS = 60_000

/**
 * Sign-ins that didn't succeed are recorded each, this many a minute at most: past that (anyone
 * can try, as often as they like) they're counted, and said once a minute (envs for tests).
 */
const FAILED_RECORDED = Number(process.env.LUMOVI_SIGN_IN_RECORDED) || 60
const FAILED_WINDOW_MS = Number(process.env.LUMOVI_SIGN_IN_WINDOW_MS) || 60_000

/** A sign-in started with the provider, as its cookie holds it: and when it expires. */
type Started = PendingSignIn & { expires: number }

/** Who a request is from: someone, someone the server won't act as, or nobody. */
export type Caller = { identity: Identity; session?: string } | { refused: true } | undefined

export class Auth {
  /** Failed sign-ins this minute: recorded, and past those, only counted (by where from). */
  #failed = 0
  #unrecorded = new Map<string, number>()
  readonly #window: NodeJS.Timeout
  /** The ways back from the provider already taken (a sign-in's state, until it'd expire). */
  readonly #finished = new Map<string, number>()

  constructor(
    private readonly config: ServerConfig,
    private readonly hosted: Hosted,
    private readonly sessions: Sessions,
    private readonly audit: AuditLog,
    private readonly oidc?: OidcClient,
  ) {
    this.#window = setInterval(() => this.#sayUnrecorded(), FAILED_WINDOW_MS)
    this.#window.unref()
  }

  /** As the server stops: what was only counted, said. */
  close(): void {
    clearInterval(this.#window)
    this.#sayUnrecorded()
  }

  /** The failed sign-ins only counted this minute, said as one event; and a new minute begun. */
  #sayUnrecorded() {
    // Where most came from first: "203.0.113.9: 240".
    const from = [...this.#unrecorded].sort(([, a], [, b]) => b - a)
    if (from.length) {
      const count = from.reduce((sum, [, n]) => sum + n, 0)
      this.audit.record({
        action: 'session.sign-in',
        outcome: 'refused',
        actor: SERVER_ACTOR,
        summary: `${count.toLocaleString('en')} more ${count === 1 ? 'sign-in' : 'sign-ins'} didn’t succeed, each not recorded: more than ${FAILED_RECORDED} were tried in a minute`,
        details: {
          count,
          from: from.slice(0, 20).map(([address, n]) => `${address}: ${n}`),
        },
      })
    }
    this.#failed = 0
    this.#unrecorded = new Map()
  }

  /** A sign-in (or out), as it came out: who (when it's known), from where, how. */
  #record(
    req: IncomingMessage,
    outcome: AuditOutcome,
    summary: string,
    { user, session, error }: { user?: SessionUser; session?: string; error?: string },
  ) {
    if (outcome !== 'success' && ++this.#failed > FAILED_RECORDED) {
      const address = String(req.socket.remoteAddress)
      this.#unrecorded.set(address, (this.#unrecorded.get(address) ?? 0) + 1)
      return
    }
    const how = this.config.auth.mode === 'oidc' ? this.config.auth.provider : 'a token'
    this.audit.record({
      action: summary.startsWith('Signed out') ? 'session.sign-out' : 'session.sign-in',
      outcome,
      actor: user
        ? personActor(user, req, session)
        : { user: '(unknown)', via: 'ui', ...origin(req) },
      summary,
      details: { method: this.config.auth.mode, with: how },
      ...(error ? { error } : {}),
    })
  }

  identify(req: IncomingMessage): Caller {
    const { auth } = this.config
    if (auth.mode === 'proxy') {
      const name = req.headers[auth.userHeader]
      if (typeof name !== 'string' || name === '') return undefined
      const groups = String(req.headers[auth.groupsHeader] ?? '')
        .split(',')
        .map((group) => group.trim())
        .filter(Boolean)
      const user = { name, groups }
      return this.hosted.refuses(user) ? { refused: true } : { identity: { user } }
    }
    const session = this.sessions.get(cookies(req)[SESSION_COOKIE])
    return session && { identity: session.identity, session: session.id }
  }

  /** `GET api/session`: who is signed in, or how to sign in. */
  describe(req: IncomingMessage, res: ServerResponse): void {
    const caller = this.identify(req)
    if (caller && 'identity' in caller) {
      sendJson(res, 200, this.#session(caller.identity.user))
      return
    }
    const signIn: SignIn = {
      auth: this.config.auth.mode,
      provider: this.config.auth.mode === 'oidc' ? this.config.auth.provider : undefined,
      problem: caller && 'refused' in caller ? 'refused' : undefined,
    }
    sendJson(res, 401, signIn)
  }

  /** `POST api/session`: signs in with a token, once the cluster says whose it is. */
  async signInWithToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!sameOrigin(req, this.config.publicUrl)) {
      sendJson(res, 403, { error: 'Sign in from Lumovi’s own page.' })
      return
    }
    const token = ((await readJson(req)) as { token?: unknown } | undefined)?.token
    if (typeof token !== 'string' || !/^\S+$/.test(token)) {
      sendJson(res, 400, { error: 'Paste a token to sign in with.' })
      return
    }
    let user: SessionUser
    try {
      user = await this.#review(token)
    } catch (error) {
      const { code, message } = toKubeError(error)
      const said = code === 'unauthorized' ? 'The cluster doesn’t accept this token.' : message
      this.#record(req, code === 'unauthorized' ? 'refused' : 'failure', 'Sign in with a token', {
        error: said,
      })
      sendJson(res, 401, { error: said })
      return
    }
    const session = this.sessions.create({ user, token })
    log(`${user.name} signed in with a token`)
    this.#record(req, 'success', 'Signed in with a token', { user, session: session.id })
    sendJson(res, 200, this.#session(user), { 'Set-Cookie': this.#sessionCookie(req, session.id) })
  }

  /** `DELETE api/session`: ends the session, and every page of it. */
  signOut(req: IncomingMessage, res: ServerResponse): void {
    if (!sameOrigin(req, this.config.publicUrl)) {
      sendJson(res, 403, { error: 'Sign out from Lumovi’s own page.' })
      return
    }
    const caller = this.identify(req)
    if (caller && 'session' in caller) {
      log(`${caller.identity.user.name} signed out`)
      this.#record(req, 'success', 'Signed out', {
        user: caller.identity.user,
        session: caller.session,
      })
      this.sessions.end(caller.session!, 'signed-out', 'They signed out.')
    }
    res.writeHead(204, { 'Set-Cookie': this.#sessionCookie(req, '', 0) })
    res.end()
  }

  /** `GET auth/sign-in`: off to the provider, to come back to `then`. */
  async startSignIn(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const then = url.searchParams.get('then') ?? '/'
    let started: Awaited<ReturnType<OidcClient['start']>>
    try {
      // Only somewhere in the app: never another site.
      started = await this.oidc!.start(/^\/(?![/\\])/.test(then) ? then : '/')
    } catch (error) {
      this.#record(req, 'failure', this.#signInWith(), { error: (error as Error).message })
      this.#problem(res, 'failed', error)
      return
    }
    // Signed with when it expires: past that, it's refused, whatever cookie brings it back.
    const sealed: Started = { ...started.pending, expires: Date.now() + SIGN_IN_MINUTES * 60_000 }
    const body = Buffer.from(JSON.stringify(sealed)).toString('base64url')
    redirect(res, started.url, {
      'Set-Cookie': cookie(SIGN_IN_COOKIE, `${body}.${signature(body)}`, {
        path: this.config.basePath,
        maxAge: SIGN_IN_MINUTES * 60,
        secure: secure(req, this.config.publicUrl),
      }),
    })
  }

  /** `GET auth/callback`: back from the provider, signed in (or not). */
  async finishSignIn(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // Started in another browser, or long ago (its cookie is gone), or not by Lumovi.
    const sealed = cookies(req)[SIGN_IN_COOKIE] ?? ''
    const body = sealed.slice(0, sealed.lastIndexOf('.'))
    const signed = sealed.slice(sealed.lastIndexOf('.') + 1)
    const pending =
      same(signed, signature(body)) &&
      (JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Started)
    if (
      !pending ||
      pending.state !== url.searchParams.get('state') ||
      pending.expires < Date.now() ||
      this.#taken(pending)
    ) {
      this.#problem(res, 'expired')
      return
    }
    // As the provider said it (an error code), kept short and plain: anyone can make it say more.
    const refusal = url.searchParams
      .get('error')
      ?.replace(/[^\x20-\x7e]/g, '')
      .slice(0, 100)
    if (refusal !== undefined) {
      this.#record(req, 'refused', this.#signInWith(), { error: `The provider said ${refusal}.` })
      this.#problem(res, 'denied', new Error(`The provider said ${refusal}`))
      return
    }
    let signedIn: SignedIn
    try {
      signedIn = await this.oidc!.finish(url.searchParams.get('code') ?? '', pending)
    } catch (error) {
      this.#record(req, 'failure', this.#signInWith(), { error: (error as Error).message })
      this.#problem(res, 'failed', error)
      return
    }
    const { user, token } = signedIn
    const refused = this.hosted.refuses(user)
    if (refused) {
      this.#record(req, 'refused', this.#signInWith(), { user, error: refused })
      this.#problem(res, 'refused', new Error(refused))
      return
    }
    // Their own token, when the API server trusts the provider; otherwise they're impersonated.
    const session = this.sessions.create({ user, token })
    this.#keepFresh(session, signedIn)
    log(`${user.name} signed in`)
    this.#record(
      req,
      'success',
      `Signed in with ${(this.config.auth as { provider: string }).provider}`,
      {
        user,
        session: session.id,
      },
    )
    redirect(res, `${this.config.basePath}${pending.then.slice(1)}`, {
      'Set-Cookie': [
        this.#sessionCookie(req, session.id),
        cookie(SIGN_IN_COOKIE, '', { path: this.config.basePath, maxAge: 0, secure: false }),
      ],
    })
  }

  /**
   * Renews the token a session passes on, shortly before it expires, for as
   * long as the session lasts. Without a way to (no refresh token), the
   * cluster refusing it ends the session.
   */
  #keepFresh(session: StoredSession, { expires, refreshToken }: Forwarded): void {
    if (!refreshToken) return
    const renew = async () => {
      // Signed out meanwhile.
      if (!this.sessions.get(session.id)) return
      try {
        const next = await this.oidc!.renew(refreshToken)
        session.identity.token = next.token
        // Providers that don't rotate refresh tokens keep taking the same one.
        this.#keepFresh(session, { ...next, refreshToken: next.refreshToken ?? refreshToken })
      } catch (error) {
        log(`Renewing ${session.identity.user.name}’s token failed: ${(error as Error).message}`)
        this.sessions.end(
          session.id,
          'expired',
          `Renewing its token failed: ${(error as Error).message}`,
        )
      }
    }
    setTimeout(() => void renew(), Math.max(0, expires! - Date.now() - RENEW_EARLY_MS)).unref()
  }

  /** What a sign-in with the provider is, before it's known whose it is. */
  #signInWith = () => `Sign in with ${(this.config.auth as { provider: string }).provider}`

  /** Back to the sign-in page, which says what went wrong; the details go to the log. */
  /**
   * Whether a way back from the provider was taken already: each is taken once (its cookie
   * would let it be taken again, and again, recorded each time).
   */
  #taken(pending: Started): boolean {
    const now = Date.now()
    for (const [state, expires] of this.#finished) if (expires < now) this.#finished.delete(state)
    if (this.#finished.has(pending.state)) return true
    // Taken until it expires: then refused anyway.
    this.#finished.set(pending.state, pending.expires)
    return false
  }

  #problem(res: ServerResponse, problem: SignInProblem, error?: unknown): void {
    if (error) log(`Signing in failed: ${(error as Error).message}`)
    redirect(res, `${this.config.basePath}?sign-in=${problem}`)
  }

  /** Who a token is, as the cluster says (a SelfSubjectReview, Kubernetes 1.28 and later). */
  async #review(token: string): Promise<SessionUser> {
    const kc = this.hosted
      .configsFor({ user: { name: '', groups: [] }, token })
      .forContext(this.hosted.name!)
    const review = JSON.parse(
      await kubeRequest(kc, REVIEWS, {
        method: 'POST',
        body: { apiVersion: 'authentication.k8s.io/v1', kind: 'SelfSubjectReview' },
        timeoutMs: 20_000,
      }),
    ) as { status: { userInfo: { username: string; groups: string[] } } }
    // Everyone signed in is in system:authenticated, at least.
    const { username, groups } = review.status.userInfo
    return { name: username, groups }
  }

  #session(user: SessionUser): Session {
    const { auth } = this.config
    return {
      user,
      auth: auth.mode,
      ...(this.hosted.fleet ? { fleet: true } : { cluster: this.hosted.name }),
      signOutUrl: auth.mode === 'proxy' ? auth.signOutUrl : undefined,
    }
  }

  #sessionCookie(req: IncomingMessage, value: string, maxAge = this.config.sessionHours * 3600) {
    return cookie(SESSION_COOKIE, value, {
      path: this.config.basePath,
      maxAge: Math.floor(maxAge),
      secure: secure(req, this.config.publicUrl),
    })
  }
}

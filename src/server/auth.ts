/**
 * Who a request is from, and signing in and out: with a token the cluster
 * accepts, with single sign-on, or (behind an authenticating proxy) as the
 * proxy's headers say.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Session, SessionUser, SignIn, SignInProblem } from '@shared/server'
import { kubeRequest } from '@backend/kube/client'
import { toKubeError } from '@backend/kube/errors'
import type { HostedCluster, Identity } from './cluster'
import type { ServerConfig } from './config'
import { cookie, cookies, readJson, redirect, sameOrigin, secure, sendJson } from './http'
import { log } from './log'
import type { Forwarded, OidcClient, PendingSignIn, SignedIn } from './oidc'
import type { Sessions, StoredSession } from './sessions'

export const SESSION_COOKIE = 'kubestacks-session'
/**
 * A sign-in that went to the provider, kept by the browser that started it:
 * its state, PKCE verifier and nonce, signed so it can't be changed.
 */
const SIGN_IN_COOKIE = 'kubestacks-sign-in'
const SIGN_IN_MINUTES = 10
/** Signs sign-ins in progress; they don't outlive the server. */
const KEY = randomBytes(32)
const signature = (body: string) => createHmac('sha256', KEY).update(body).digest('base64url')
/** Compares in constant time, whatever the lengths. */
const same = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
const REVIEWS = '/apis/authentication.k8s.io/v1/selfsubjectreviews'
/** How long before a passed-on token expires it's renewed. */
const RENEW_EARLY_MS = 60_000

/** Who a request is from: someone, someone the server won't act as, or nobody. */
export type Caller = { identity: Identity; session?: string } | { refused: true } | undefined

export class Auth {
  constructor(
    private readonly config: ServerConfig,
    private readonly cluster: HostedCluster,
    private readonly sessions: Sessions,
    private readonly oidc?: OidcClient,
  ) {}

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
      return this.cluster.refuses(user) ? { refused: true } : { identity: { user } }
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
      sendJson(res, 403, { error: 'Sign in from KubeStacks’ own page.' })
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
      sendJson(res, 401, {
        error: code === 'unauthorized' ? 'The cluster doesn’t accept this token.' : message,
      })
      return
    }
    const session = this.sessions.create({ user, token })
    log(`${user.name} signed in with a token`)
    sendJson(res, 200, this.#session(user), { 'Set-Cookie': this.#sessionCookie(req, session.id) })
  }

  /** `DELETE api/session`: ends the session, and every page of it. */
  signOut(req: IncomingMessage, res: ServerResponse): void {
    if (!sameOrigin(req, this.config.publicUrl)) {
      sendJson(res, 403, { error: 'Sign out from KubeStacks’ own page.' })
      return
    }
    const caller = this.identify(req)
    if (caller && 'session' in caller) {
      log(`${caller.identity.user.name} signed out`)
      this.sessions.end(caller.session!, 'signed-out')
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
      this.#problem(res, 'failed', error)
      return
    }
    const body = Buffer.from(JSON.stringify(started.pending)).toString('base64url')
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
    // Started in another browser, or long ago (its cookie is gone), or not by KubeStacks.
    const sealed = cookies(req)[SIGN_IN_COOKIE] ?? ''
    const body = sealed.slice(0, sealed.lastIndexOf('.'))
    const signed = sealed.slice(sealed.lastIndexOf('.') + 1)
    const pending =
      same(signed, signature(body)) &&
      (JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PendingSignIn)
    if (!pending || pending.state !== url.searchParams.get('state')) {
      this.#problem(res, 'expired')
      return
    }
    const refusal = url.searchParams.get('error')
    if (refusal) {
      this.#problem(res, 'denied', new Error(`The provider said ${refusal}`))
      return
    }
    let signedIn: SignedIn
    try {
      signedIn = await this.oidc!.finish(url.searchParams.get('code') ?? '', pending)
    } catch (error) {
      this.#problem(res, 'failed', error)
      return
    }
    const { user, token } = signedIn
    const refused = this.cluster.refuses(user)
    if (refused) {
      this.#problem(res, 'refused', new Error(refused))
      return
    }
    // Their own token, when the API server trusts the provider; otherwise they're impersonated.
    const session = this.sessions.create({ user, token })
    this.#keepFresh(session, signedIn)
    log(`${user.name} signed in`)
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
        this.sessions.end(session.id, 'expired')
      }
    }
    setTimeout(() => void renew(), Math.max(0, expires! - Date.now() - RENEW_EARLY_MS)).unref()
  }

  /** Back to the sign-in page, which says what went wrong; the details go to the log. */
  #problem(res: ServerResponse, problem: SignInProblem, error?: unknown): void {
    if (error) log(`Signing in failed: ${(error as Error).message}`)
    redirect(res, `${this.config.basePath}?sign-in=${problem}`)
  }

  /** Who a token is, as the cluster says (a SelfSubjectReview, Kubernetes 1.28 and later). */
  async #review(token: string): Promise<SessionUser> {
    const kc = this.cluster
      .configsFor({ user: { name: '', groups: [] }, token })
      .forContext(this.cluster.name)
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
      cluster: this.cluster.name,
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

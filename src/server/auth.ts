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
import { origin, personActor, SERVER_ACTOR, sessionActor } from './audit'
import type { Hosted, Identity } from './cluster'
import type { ServerConfig } from './config'
import { cookie, cookies, readJson, redirect, sameOrigin, secure, sendJson } from './http'
import { log } from './log'
import {
  RenewalRefused,
  type OidcClient,
  type PendingSignIn,
  type Renewed,
  type Said,
  type SignedIn,
} from './oidc'
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
/** How long before a passed-on token, or what the provider said, expires it's renewed. */
const RENEW_EARLY_MS = 60_000
/** Never sooner than this after the last renewal (a provider whose tokens last under a minute). */
const RENEW_SOONEST_MS = 1_000
/** A provider that didn't answer is asked again after this, then twice as long each time, to… */
const RETRY_FIRST_MS = 1_000
/** …this at most: and never past when what it last said expires. */
const RETRY_MOST_MS = 60_000

/**
 * Sign-ins that didn't succeed are recorded each, this many a minute at most: past that (anyone
 * can try, as often as they like) they're counted, and said once a minute (envs for tests).
 */
const FAILED_RECORDED = Number(process.env.LUMOVI_SIGN_IN_RECORDED) || 60
const FAILED_WINDOW_MS = Number(process.env.LUMOVI_SIGN_IN_WINDOW_MS) || 60_000

/** A sign-in started with the provider, as its cookie holds it: and when it expires. */
type Started = PendingSignIn & { expires: number }

/**
 * Who a request is from: someone, someone the server won't act as, a session's request that
 * didn't say it came from Lumovi's own page (`unsaid`), or nobody.
 */
export type Caller =
  | {
      identity: Identity
      session?: string
      /** Whether the second wall holds for it: what the hand-over of a plugin's code asks. */
      held: boolean
    }
  | { refused: true }
  | { unsaid: true }
  | undefined

/** What a request refused by the second wall is told: the header, and nothing else of it. */
export const UNSAID =
  'This request didn’t say it came from Lumovi’s own page (Sec-Fetch-Site), so Lumovi didn’t act on it.'

/** Whether a sign-in's request said where it came from: that the header was there, not what it said. */
const saysWhereFrom = (req: IncomingMessage) => req.headers['sec-fetch-site'] !== undefined

export class Auth {
  /** Failed sign-ins this minute: recorded, and past those, only counted (by where from). */
  #failed = 0
  #unrecorded = new Map<string, number>()
  readonly #window: NodeJS.Timeout
  /** The ways back from the provider already taken (a sign-in's state, until it'd expire). */
  readonly #finished = new Map<string, number>()
  /** Sessions whose browser stopped saying where requests come from: said once each. */
  readonly #stopped = new WeakSet<object>()
  /** Those behind the sign-in proxy whose requests stopped saying where they come from, said once. */
  readonly #stoppedBehindProxy = new Set<string>()
  /**
   * Sessions whose provider didn't answer as they were renewed: each ends as what it last said
   * expires, unless it answers before.
   */
  readonly #lapsing = new Map<string, NodeJS.Timeout>()
  /** Sessions whose provider renews them without an ID token: each ends as its last one does. */
  readonly #unrenewed = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly config: ServerConfig,
    private readonly hosted: Hosted,
    private readonly sessions: Sessions,
    private readonly audit: AuditLog,
    private readonly oidc?: OidcClient,
  ) {
    this.#window = setInterval(() => this.#sayUnrecorded(), FAILED_WINDOW_MS)
    this.#window.unref()
    if (config.auth.mode === 'proxy' && this.secondWall(undefined) === 'not-held') {
      log(
        'Plugins that run code aren’t offered: this server’s proxy isn’t said to pass Sec-Fetch-Site through (LUMOVI_PROXY_SEC_FETCH_SITE).',
      )
    }
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
    {
      user,
      session,
      error,
      groupsUnread,
    }: { user?: SessionUser; session?: string; error?: string; groupsUnread?: string },
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
      details: {
        method: this.config.auth.mode,
        with: how,
        ...(groupsUnread ? { groupsUnread } : {}),
      },
      ...(error ? { error } : {}),
    })
  }

  /**
   * The second wall, for a session: `held`, where every request it carries must say it comes
   * from Lumovi's own page; or `not-held`, an old browser's (it said nothing of where its sign-in
   * came from), and any session's with LUMOVI_SEC_FETCH_SITE off. Behind a sign-in proxy there's
   * no sign-in here to note: everyone's held where its operator says it passes the header through
   * (LUMOVI_PROXY_SEC_FETCH_SITE), and no one's otherwise. The one place this is decided: asked by
   * the rule (`identify`) and by whatever hands a plugin's code over, the one never without the
   * other: nothing `not-held` is given a plugin's code.
   */
  secondWall(session: Pick<StoredSession, 'saysWhereFrom'> | undefined): 'held' | 'not-held' {
    if (this.config.fetchSite === 'off') return 'not-held'
    if (this.config.auth.mode === 'proxy') {
      return this.config.auth.passesFetchSite ? 'held' : 'not-held'
    }
    return session?.saysWhereFrom ? 'held' : 'not-held'
  }

  /**
   * Who a request is from. A session's request where the second wall holds is believed only if
   * it says it comes from Lumovi's own page (Sec-Fetch-Site: same-origin, exactly); refused, it
   * is refused and nothing else: its session isn't touched. (`socket`: a live connection's start,
   * held by its Origin alone, which its caller checks: browsers don't say this there.)
   */
  identify(req: IncomingMessage, { socket = false }: { socket?: boolean } = {}): Caller {
    const { auth } = this.config
    if (auth.mode === 'proxy') {
      const name = req.headers[auth.userHeader]
      if (typeof name !== 'string' || name === '') return undefined
      // Held: each request on its own, as the proxy passes it on; one that says nothing of where
      // it comes from is refused, never let through.
      const site = req.headers['sec-fetch-site']
      if (!socket && this.secondWall(undefined) === 'held' && site !== 'same-origin') {
        if (site === undefined && !this.#stoppedBehindProxy.has(name)) {
          this.#stoppedBehindProxy.add(name)
          log(
            `A request of ${name}’s came through the sign-in proxy without Sec-Fetch-Site, and was refused: the browser is too old to send it, or the proxy doesn’t pass it on. See LUMOVI_PROXY_SEC_FETCH_SITE.`,
          )
        }
        return { unsaid: true }
      }
      const groups = String(req.headers[auth.groupsHeader] ?? '')
        .split(',')
        .map((group) => group.trim())
        .filter(Boolean)
      const user = { name, groups }
      return this.hosted.refuses(user)
        ? { refused: true }
        : { identity: { user }, held: this.secondWall(undefined) === 'held' }
    }
    const cookie = cookies(req)[SESSION_COOKIE]
    // (As it's kept, nothing done to it. An expired session isn't there: its timer ended it, as
    // `get` relies on too. One expiring this very moment is judged as it was: a request of it
    // without the header is refused as unsaid, not answered as signed out.)
    const seen = this.sessions.peek(cookie)
    const site = req.headers['sec-fetch-site']
    if (seen && !socket && this.secondWall(seen) === 'held' && site !== 'same-origin') {
      // Said once a session: its browser said where its sign-in came from, and now says nothing
      // (what a gateway that takes the header out looks like).
      if (site === undefined && !this.#stopped.has(seen)) {
        this.#stopped.add(seen)
        log(
          `A session of ${seen.identity.user.name}’s sent Sec-Fetch-Site as it signed in and has stopped: something between the browser and Lumovi may be removing it. See LUMOVI_SEC_FETCH_SITE.`,
        )
      }
      return { unsaid: true }
    }
    const session = this.sessions.get(cookie)
    // Back after a restart: what renews its token (single sign-on) starts again, and past what
    // the provider last said, its person has no groups until it says again.
    if (session?.resumed) {
      const { refreshToken, tokenExpires, idExpires } = this.sessions.credentials(session.id) ?? {}
      if (refreshToken && Math.min(tokenExpires ?? Infinity, idExpires ?? Infinity) <= Date.now()) {
        this.sessions.stale(session.id)
      }
      this.#keepFresh(session.id)
    }
    return (
      session && {
        identity: session.identity,
        session: session.id,
        held: this.secondWall(session) === 'held',
      }
    )
  }

  /** `GET api/session`: who is signed in, or how to sign in. */
  describe(req: IncomingMessage, res: ServerResponse): void {
    const caller = this.identify(req)
    if (caller && 'identity' in caller) {
      const unread = caller.session && this.sessions.byId(caller.session)?.groupsUnread
      sendJson(res, 200, {
        ...this.#session(caller.identity.user),
        ...(unread ? { groupsUnread: true } : {}),
      })
      return
    }
    const signIn: SignIn = {
      auth: this.config.auth.mode,
      provider: this.config.auth.mode === 'oidc' ? this.config.auth.provider : undefined,
      problem:
        caller && 'refused' in caller
          ? 'refused'
          : caller && 'unsaid' in caller
            ? 'browser'
            : undefined,
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
    const { cookie: id, session } = this.sessions.create(
      { user, token },
      undefined,
      saysWhereFrom(req),
    )
    log(`${user.name} signed in with a token`)
    this.#record(req, 'success', 'Signed in with a token', { user, session: session.id })
    sendJson(res, 200, this.#session(user), { 'Set-Cookie': this.#sessionCookie(req, id) })
  }

  /**
   * `DELETE api/session`: ends the session, and every page of it; once it's kept so, so that a
   * restart can't bring it back.
   */
  async signOut(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!sameOrigin(req, this.config.publicUrl)) {
      sendJson(res, 403, { error: 'Sign out from Lumovi’s own page.' })
      return
    }
    const caller = this.identify(req)
    // (Refused, it ends nothing and clears no cookie: no page elsewhere can sign anyone out.)
    if (caller && 'unsaid' in caller) {
      sendJson(res, 403, { error: UNSAID })
      return
    }
    if (caller && 'session' in caller) {
      log(`${caller.identity.user.name} signed out`)
      this.#record(req, 'success', 'Signed out', {
        user: caller.identity.user,
        session: caller.session,
      })
      // What renewed it is let go of at the provider too, where it can be (never waited for).
      const refreshToken = this.sessions.credentials(caller.session!)?.refreshToken
      this.#lapsed(caller.session!)
      this.sessions.end(caller.session!, 'signed-out', 'They signed out.')
      if (refreshToken) this.#revoke(refreshToken, caller.identity.user.name)
      try {
        await this.sessions.kept()
      } catch (error) {
        const said = `Lumovi couldn’t keep that you signed out (${(error as Error).message}): it’s over here, but a restart before it can would bring it back.`
        this.#record(req, 'failure', 'Signed out', {
          user: caller.identity.user,
          session: caller.session,
          error: said,
        })
        sendJson(res, 503, { error: said }, { 'Set-Cookie': this.#sessionCookie(req, '', 0) })
        return
      }
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
    // What renews it all is kept (sealed) either way: their groups follow the provider's.
    const { cookie: id, session } = this.sessions.create(
      { user, token },
      {
        tokenExpires: signedIn.expires,
        refreshToken: signedIn.refreshToken,
        idExpires: signedIn.idExpires,
        subject: signedIn.subject,
        nonce: signedIn.nonce,
      },
      saysWhereFrom(req),
      signedIn.groupsUnread !== undefined,
    )
    this.#keepFresh(session.id)
    log(`${user.name} signed in`)
    if (signedIn.groupsUnread) log(`${user.name} has no groups: ${signedIn.groupsUnread}`)
    this.#record(
      req,
      'success',
      `Signed in with ${(this.config.auth as { provider: string }).provider}`,
      {
        user,
        session: session.id,
        ...(signedIn.groupsUnread ? { groupsUnread: signedIn.groupsUnread } : {}),
      },
    )
    redirect(res, `${this.config.basePath}${pending.then.slice(1)}`, {
      'Set-Cookie': [
        this.#sessionCookie(req, id),
        cookie(SIGN_IN_COOKIE, '', { path: this.config.basePath, maxAge: 0, secure: false }),
      ],
    })
  }

  /**
   * Renews what a session passes on, and what the provider says of its person (their groups),
   * shortly before either expires, for as long as the session lasts. The provider saying no ends
   * the session at once. One that doesn't answer is asked again, until what it last said
   * expires, and then the session ends: nobody keeps what a group gave them past that. Without a
   * way to renew (no refresh token), what it said at sign-in holds for the session, and the
   * cluster refusing a token passed on ends it.
   */
  #keepFresh(id: string, failures = 0): void {
    const scheduled = this.sessions.credentials(id)
    if (!scheduled?.refreshToken || !this.oidc) return
    // What it last said holds until the first of these.
    // (Not by the ID token's end where its provider renews without one: that ends the session.)
    const until = Math.min(
      scheduled.tokenExpires ?? Infinity,
      this.#unrenewed.has(id) ? Infinity : (scheduled.idExpires ?? Infinity),
    )
    if (!Number.isFinite(until)) return
    const left = Math.max(0, until - Date.now())
    // (Expired already, back after a restart: at once.)
    const wait = failures
      ? Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MOST_MS, left)
      : left === 0
        ? 0
        : Math.max(RENEW_SOONEST_MS, left - RENEW_EARLY_MS)
    const renew = async () => {
      // Signed out meanwhile, or ended as what was said expired. (What renews it is read from
      // the session now, not kept here: an ended session's is gone with it.)
      const session = this.sessions.byId(id)
      const credentials = this.sessions.credentials(id)
      const refreshToken = credentials?.refreshToken
      if (!session || !refreshToken) return
      const { name, groups } = session.identity.user
      const wasUnread = session.groupsUnread === true
      // Not answered by the time what it last said expires: no groups until it is.
      const stale = setTimeout(
        () => this.sessions.stale(id),
        Math.max(0, until - Date.now()),
      ).unref()
      let next: Renewed
      try {
        next = await this.oidc!.renew(refreshToken, {
          subject: credentials.subject,
          name,
          nonce: credentials.nonce ?? '',
        })
        clearTimeout(stale)
      } catch (error) {
        clearTimeout(stale)
        const why = (error as Error).message
        if (error instanceof RenewalRefused) {
          log(`Renewing ${name}’s sign-in was refused: ${why}`)
          this.#lapsed(id)
          this.sessions.end(id, 'expired', `The provider wouldn’t renew its sign-in: ${why}`)
          return
        }
        if (!this.#lapsing.has(id)) {
          log(`Renewing ${name}’s sign-in failed, so it’s tried again until it expires: ${why}`)
          this.#lapsing.set(
            id,
            setTimeout(
              () => {
                this.#lapsing.delete(id)
                if (!this.sessions.byId(id)) return
                log(
                  `${name}’s sign-in expired, and the provider still couldn’t be reached to renew it`,
                )
                this.sessions.end(
                  id,
                  'expired',
                  `The provider couldn’t be reached to renew its sign-in before it expired: ${why}`,
                )
              },
              Math.max(0, until - Date.now()),
            ).unref(),
          )
        }
        this.#keepFresh(id, failures + 1)
        return
      }
      // Signed out (or ended) while it was renewed: it stays so, and what the renewal gave is let
      // go of at the provider too.
      if (!this.sessions.byId(id)) {
        if (next.refreshToken && next.refreshToken !== refreshToken)
          this.#revoke(next.refreshToken, name)
        return
      }
      if (this.#lapsed(id)) log(`Renewed ${name}’s sign-in again`)
      const { said } = next
      if (!said) {
        this.#unrenewedUntil(id, name, credentials.idExpires)
        this.sessions.renewed(id, {
          token: next.token,
          tokenExpires: next.expires,
          refreshToken: next.refreshToken ?? refreshToken,
        })
        this.#keepFresh(id)
        return
      }
      // Who they are, renewed after all: their groups go on.
      clearTimeout(this.#unrenewed.get(id))
      this.#unrenewed.delete(id)
      this.sessions.renewed(
        id,
        {
          token: next.token,
          tokenExpires: next.expires,
          refreshToken: next.refreshToken ?? refreshToken,
          idExpires: said.idExpires,
        },
        { user: said.user, groupsUnread: said.groupsUnread !== undefined },
      )
      this.#regrouped(session, groups, wasUnread, said)
      this.#keepFresh(id)
    }
    setTimeout(() => void renew(), wait).unref()
  }

  /**
   * A session whose provider renewed it without an ID token (some never send one on a renewal):
   * that renews no groups, so its person's hold only until the last ID token expires, and then
   * the session ends, as one without a refresh token would. Said once.
   */
  #unrenewedUntil(id: string, name: string, idExpires: number | undefined): void {
    if (this.#unrenewed.has(id) || idExpires === undefined) return
    log(
      `${name}’s provider renewed their sign-in without an ID token: their groups hold until ${new Date(idExpires).toISOString()}, and then the session ends`,
    )
    this.#unrenewed.set(
      id,
      setTimeout(
        () => {
          this.#unrenewed.delete(id)
          if (!this.sessions.byId(id)) return
          this.sessions.end(
            id,
            'expired',
            'Its provider renews it without an ID token, so its groups couldn’t be renewed past the last one.',
          )
        },
        Math.max(0, idExpires - Date.now()),
      ).unref(),
    )
  }

  /** A refresh token let go of at the provider, where it can be: never waited for. */
  #revoke(refreshToken: string, name: string): void {
    this.oidc?.revoke(refreshToken).catch((error: unknown) => {
      log(
        `Letting go of ${name}’s refresh token at the provider failed: ${(error as Error).message}`,
      )
    })
  }

  /** Whether a session was waiting on its provider to answer: it needn't any more. */
  #lapsed(id: string): boolean {
    const lapsing = this.#lapsing.get(id)
    if (!lapsing) return false
    clearTimeout(lapsing)
    this.#lapsing.delete(id)
    return true
  }

  /** Someone's groups as a renewal said them: when they changed, said and recorded. */
  #regrouped(session: StoredSession, was: string[], wasUnread: boolean, said: Said): void {
    const { name, groups } = said.user
    if (said.groupsUnread && !wasUnread) log(`${name} has no groups: ${said.groupsUnread}`)
    const added = groups.filter((group) => !was.includes(group))
    const removed = was.filter((group) => !groups.includes(group))
    if (added.length === 0 && removed.length === 0) return
    log(
      `${name}’s groups changed as the provider renewed their sign-in: ${[
        ...added.map((group) => `+${group}`),
        ...removed.map((group) => `−${group}`),
      ].join(', ')}`,
    )
    this.audit.record({
      action: 'session.groups',
      outcome: 'success',
      actor: sessionActor(said.user, session.id),
      summary: 'Their groups changed as the provider renewed their sign-in',
      details: {
        added,
        removed,
        ...(said.groupsUnread ? { groupsUnread: said.groupsUnread } : {}),
      },
    })
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

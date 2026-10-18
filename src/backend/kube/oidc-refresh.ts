/**
 * A kubeconfig user that signs in with `auth-provider: oidc`, renewed as kubectl renews it
 * (client-go's oidc auth provider): its ID token while it lasts, then a new one from its issuer
 * with its refresh token. client-node's own can't (it hands openid-client a string where a URL is
 * wanted), keeps one expiry for every user, and has every request at once renew.
 *
 * On the desktop the new tokens are written back where kubectl keeps them, under its lock: that
 * user's id-token and refresh-token, in the file it came from, and nothing else of the file. A
 * server keeps them in memory only (its kubeconfig is its operator's).
 *
 * What the provider sends is taken as untrusted: tokens of the shape they must have, or nothing
 * is used or written. Nothing of a token, a secret or an answer's body is said anywhere.
 */
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import https from 'node:https'
import http from 'node:http'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { KubeConfig, User } from '@kubernetes/client-node'
import { isScalar, parseDocument } from 'yaml'
import { fetchFailure } from '../network'
import { KubeRequestError, TLS_ERROR } from './errors'

/** kubectl's margin: an ID token this close to its end is renewed first. */
const EARLY_SECONDS = 10
const TIMEOUT_MS = 15_000
/** An answer, discovery's or the token endpoint's, at most. */
const MOST_BYTES = 1024 * 1024
/** A token at most. */
const MOST_TOKEN = 16 * 1024
/** How long kubectl's lock is waited for before the new tokens are kept in memory only. */
const LOCK_WAIT_MS = 2_000
/**
 * How long a renewal that failed is said again rather than asked of the issuer again, for the
 * same refresh token: one the issuer refused, or answered with nothing usable, a while; one it
 * couldn't be reached for, briefly. (Another refresh token on file is asked at once.)
 */
const REFUSED_FOR_MS = 5 * 60_000
const UNREACHED_FOR_MS = 10_000
/** Three base64url parts, nothing else: no line break can get into a header, or a file. */
const ID_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/
/** Printable ASCII, no whitespace. */
const REFRESH_TOKEN = /^[\x21-\x7e]+$/
/** Plain http only to this machine, as LMV-178's list has it. */
const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/

const UNUSABLE =
  'The identity provider answered with a token Lumovi can’t use, so nothing was saved.'

/** An ID token and the refresh token that renews it. */
interface Pair {
  idToken: string
  refreshToken: string
}

/** Where an oidc user's tokens come from: its file, its name, its issuer and client. */
interface Whose {
  file?: string
  user: string
  issuer: string
  clientId: string
  clientSecret?: string
  /**
   * Its issuer's certificate authority, when the kubeconfig names one: the only one trusted. Its
   * data, or its file (a relative one in the kubeconfig's folder, as kubectl has it).
   */
  caData?: Buffer
  caFile?: string
}

/** client-node's authenticators, as it has them (not exported). */
interface Authenticator {
  isAuthProvider(user: User): boolean
  applyAuthentication(user: User, opts: { headers?: Record<string, unknown> }): Promise<void>
}

export interface OidcRenewalOptions {
  /** Whether new tokens are written back to the file their user came from (the desktop's). */
  writes: boolean
  /** Told, once for each user, that new tokens couldn't be saved, and why. */
  note?: (message: string) => void
}

/**
 * Renews oidc users' tokens for every KubeConfig it's put in: one renewal at a time for each user
 * (by its file, name, issuer and client), whichever context it's for.
 */
export class OidcRenewal {
  /** Each user's tokens as last renewed here, and the refresh token they were renewed with. */
  readonly #held = new Map<string, Pair & { from: string }>()
  readonly #renewing = new Map<string, Promise<Pair>>()
  /**
   * The last renewal that failed, by user: which refresh token (its digest, all that's kept of
   * it here), why, and until when.
   */
  readonly #failed = new Map<string, { digest: string; error: unknown; until: number }>()
  readonly #noted = new Set<string>()

  constructor(private readonly options: OidcRenewalOptions) {}

  /**
   * `kc`, renewing its oidc users with this: each user's file as `fileOf` says, and where there
   * are no files (a server's), each told apart by `scopeOf` (its cluster, say) besides its name.
   */
  install(
    kc: KubeConfig,
    fileOf: (user: string) => string | undefined,
    scopeOf: () => string = () => '',
  ): void {
    const list = (kc as unknown as { authenticators: Authenticator[] }).authenticators
    const probe = { name: '', authProvider: { name: 'oidc', config: {} } } as User
    const at = list.findIndex((authenticator) => authenticator.isAuthProvider(probe))
    const ours: Authenticator = {
      isAuthProvider: (user) => user.authProvider?.name === 'oidc',
      applyAuthentication: async (user, opts) => {
        let token: string
        try {
          token = await this.token(user, fileOf(user.name), scopeOf())
        } catch (error) {
          throw new KubeRequestError(
            'auth',
            `Couldn’t sign in to ${kc.getCurrentContext()}. ${(error as Error).message}`,
          )
        }
        opts.headers = { ...opts.headers, Authorization: `Bearer ${token}` }
      },
    }
    if (at === -1) list.push(ours)
    else list[at] = ours
  }

  /** The ID token to send as `user`: as it is while it lasts, else renewed. */
  async token(user: User, file: string | undefined, scope = ''): Promise<string> {
    const config = (user.authProvider?.config ?? {}) as Record<string, unknown>
    const text = (key: string) => (typeof config[key] === 'string' ? config[key] : undefined)
    const issuer = text('idp-issuer-url')
    const clientId = text('client-id')
    const whose: Whose = {
      file,
      user: user.name,
      issuer: issuer ?? '',
      clientId: clientId ?? '',
      clientSecret: text('client-secret') || undefined,
      ...authorityOf(
        text('idp-certificate-authority-data'),
        text('idp-certificate-authority'),
        file,
      ),
    }
    const key = JSON.stringify([file ?? '', scope, user.name, whose.issuer, whose.clientId])
    // What it holds is newer than the file's while the file still has the refresh token it was
    // renewed with, or the one it got (written back).
    const onFile = { idToken: text('id-token') ?? '', refreshToken: text('refresh-token') ?? '' }
    const held = this.#held.get(key)
    const now =
      held && (onFile.refreshToken === held.from || onFile.refreshToken === held.refreshToken)
        ? held
        : onFile
    if (now.idToken !== '' && lasts(now.idToken)) return now.idToken
    if (!now.refreshToken || !issuer || !clientId) {
      throw new KubeRequestError(
        'auth',
        'Its ID token has expired, and the kubeconfig has no refresh token to renew it. Sign in again with your identity provider’s tool.',
      )
    }
    // Failed just now with this refresh token: said again, not asked again (each read would).
    const failed = this.#failed.get(key)
    if (failed?.digest === digestOf(now.refreshToken) && Date.now() < failed.until) {
      throw failed.error
    }
    let renewing = this.#renewing.get(key)
    if (!renewing) {
      const refreshToken = now.refreshToken
      renewing = this.#renew(key, whose, refreshToken)
        .then(
          (pair) => {
            this.#failed.delete(key)
            return pair
          },
          (error: unknown) => {
            const wait = error instanceof Unreached ? UNREACHED_FOR_MS : REFUSED_FOR_MS
            this.#failed.set(key, {
              digest: digestOf(refreshToken),
              error,
              until: Date.now() + wait,
            })
            throw error
          },
        )
        .finally(() => this.#renewing.delete(key))
      this.#renewing.set(key, renewing)
    }
    return (await renewing).idToken
  }

  /** A new pair from the issuer, kept (written back, or in memory). */
  async #renew(key: string, whose: Whose, refreshToken: string): Promise<Pair> {
    const issued = await refreshed(whose, refreshToken)
    const next = { idToken: issued.idToken, refreshToken: issued.refreshToken ?? refreshToken }
    this.#held.set(key, { ...next, from: refreshToken })
    if (!this.options.writes || !whose.file) return next
    let unsaved: string | undefined
    try {
      const saved = await save(whose, refreshToken, next)
      // Another program renewed it first: what's on file now is taken from now on.
      if (typeof saved === 'object') {
        this.#held.delete(key)
        if (lasts(saved.idToken)) return saved
      } else if (saved !== 'saved') {
        unsaved = saved
      }
    } catch (error) {
      unsaved = (error as Error).message
    }
    if (unsaved && !this.#noted.has(key)) {
      this.#noted.add(key)
      this.options.note?.(
        `Lumovi signed in, but couldn’t save the new token to ${whose.file}: ${unsaved}. kubectl may need to sign in again, and so may Lumovi next time it starts.`,
      )
    }
    return next
  }
}

/** Whether an ID token lasts a while yet; throws when it isn't a JWT, as kubectl does. */
function lasts(idToken: string): boolean {
  let exp: unknown
  try {
    const [, payload] = idToken.split('.')
    exp = (
      JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as { exp?: unknown }
    ).exp
  } catch {
    throw new KubeRequestError('auth', 'Its ID token isn’t a JWT.')
  }
  if (!ID_TOKEN.test(idToken)) throw new KubeRequestError('auth', 'Its ID token isn’t a JWT.')
  return typeof exp === 'number' && exp - EARLY_SECONDS > Date.now() / 1000
}

/** The issuer's certificate authority, as the kubeconfig names it: its data, or its file. */
function authorityOf(
  data: string | undefined,
  file: string | undefined,
  kubeconfig: string | undefined,
): Pick<Whose, 'caData' | 'caFile'> {
  if (data) return { caData: Buffer.from(data, 'base64') }
  if (!file) return {}
  return { caFile: isAbsolute(file) || !kubeconfig ? file : join(dirname(kubeconfig), file) }
}

/** Its issuer's word on a refresh token: a new ID token, and maybe a new refresh token. */
async function refreshed(
  whose: Whose,
  refreshToken: string,
): Promise<{ idToken: string; refreshToken?: string }> {
  const issuer = whose.issuer.replace(/\/+$/, '')
  const ca = await caOf(whose)
  let discovery: { issuer?: unknown; token_endpoint?: unknown }
  try {
    const url = checked(`${issuer}/.well-known/openid-configuration`, 'Its issuer')
    const answer = await request(url, { ca })
    if (answer.status !== 200) throw new NotOpenId(`it answered ${answer.status}`)
    discovery = JSON.parse(answer.body) as typeof discovery
  } catch (error) {
    throw said(issuer, error)
  }
  if (typeof discovery.issuer !== 'string' || discovery.issuer.replace(/\/+$/, '') !== issuer) {
    throw new KubeRequestError(
      'auth',
      `${issuer} didn’t answer as an OpenID provider: it names itself ${spelled(String(discovery.issuer))}.`,
    )
  }
  if (typeof discovery.token_endpoint !== 'string') {
    throw new KubeRequestError(
      'auth',
      `${issuer} didn’t answer as an OpenID provider: it names no token endpoint.`,
    )
  }
  const endpoint = checked(discovery.token_endpoint, 'Its token endpoint')
  const form = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: whose.clientId,
  }
  // HTTP Basic, then the secret in the body if the provider won't take that (as Go's oauth2 does).
  let answer: { status: number; body: string }
  try {
    answer = await post(endpoint, form, whose.clientSecret, 'basic', ca)
    if (whose.clientSecret && errorOf(answer.body) === 'invalid_client') {
      answer = await post(endpoint, form, whose.clientSecret, 'body', ca)
    }
  } catch (error) {
    throw said(issuer, error)
  }
  if (answer.status !== 200) {
    const error = errorOf(answer.body)
    if (error === undefined) {
      const busy = answer.status >= 500 || answer.status === 429
      throw new (busy ? Unreached : KubeRequestError)(
        'auth',
        `${issuer} answered ${answer.status} to the refresh.`,
      )
    }
    const description = scrubbed(descriptionOf(answer.body), [refreshToken, whose.clientSecret])
    throw new KubeRequestError(
      'auth',
      `The identity provider refused the refresh token (${spelled(error)}): it may have expired or been used elsewhere. Sign in again with your identity provider’s tool.${description ? ` It said: “${description}”` : ''}`,
    )
  }
  let tokens: { id_token?: unknown; refresh_token?: unknown }
  try {
    tokens = JSON.parse(answer.body) as typeof tokens
  } catch {
    throw new KubeRequestError('auth', UNUSABLE)
  }
  if (tokens.id_token === undefined) {
    throw new KubeRequestError('auth', 'The identity provider answered without an ID token.')
  }
  const fits = (token: unknown, shape: RegExp): token is string =>
    typeof token === 'string' && token.length <= MOST_TOKEN && shape.test(token)
  if (
    !fits(tokens.id_token, ID_TOKEN) ||
    (tokens.refresh_token !== undefined && !fits(tokens.refresh_token, REFRESH_TOKEN))
  ) {
    throw new KubeRequestError('auth', UNUSABLE)
  }
  return {
    idToken: tokens.id_token,
    ...(typeof tokens.refresh_token === 'string' ? { refreshToken: tokens.refresh_token } : {}),
  }
}

/** Discovery that isn't an OpenID provider's. */
class NotOpenId extends Error {}

/** A refresh token as it's told apart from another, without keeping it. */
const digestOf = (token: string) => createHash('sha256').update(token).digest('hex')

/**
 * The issuer couldn't be reached, was too busy to answer, or wasn't asked (its certificate
 * authority's file can't be read): asked again soon.
 */
class Unreached extends KubeRequestError {}

/** A URL a secret may go to: https, or plain http only to this machine. */
function checked(url: string, what: string): URL {
  if (!URL.canParse(url)) throw new KubeRequestError('auth', `${what} isn’t a URL.`)
  const parsed = new URL(url)
  if (
    parsed.protocol === 'https:' ||
    (parsed.protocol === 'http:' && LOOPBACK.test(parsed.hostname))
  ) {
    return parsed
  }
  throw new KubeRequestError(
    'auth',
    `${what} isn’t https, so Lumovi won’t send it the refresh token (${parsed.origin}).`,
  )
}

/** A reason that ends a sentence, with its full stop. */
const stopped = (reason: string) => (/[.!?]$/.test(reason) ? reason : `${reason}.`)

/** How a failure to reach the issuer, or to read it, is said. */
function said(issuer: string, error: unknown): KubeRequestError {
  if (error instanceof KubeRequestError) return error
  if (error instanceof NotOpenId || error instanceof SyntaxError) {
    return new Unreached(
      'auth',
      `${issuer} didn’t answer as an OpenID provider: ${error instanceof SyntaxError ? 'its discovery document isn’t JSON' : error.message}.`,
    )
  }
  const code = (error as { code?: unknown }).code
  const tls = typeof code === 'string' && TLS_ERROR.test(code)
  return new Unreached(
    'auth',
    `${issuer} can’t be reached: ${stopped(fetchFailure(error))}${tls ? ' If your identity provider’s certificate is signed by your own authority, set idp-certificate-authority in the kubeconfig.' : ''}`,
  )
}

/** The token endpoint, posted to as the client: its secret as HTTP Basic, or in the body. */
function post(
  url: URL,
  form: Record<string, string>,
  secret: string | undefined,
  how: 'basic' | 'body',
  ca: Buffer | undefined,
) {
  const body = new URLSearchParams(form)
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (secret && how === 'body') body.set('client_secret', secret)
  if (secret && how === 'basic') {
    const client = `${encodeURIComponent(form.client_id!)}:${encodeURIComponent(secret)}`
    headers.Authorization = `Basic ${Buffer.from(client).toString('base64')}`
  }
  return request(url, { method: 'POST', headers, body: body.toString(), ca })
}

/**
 * One request: never redirected on (a secret goes nowhere else), its answer at most MOST_BYTES,
 * all of it in TIMEOUT_MS (an answer that trickles in is stopped too). With `ca`, that's the only authority trusted; else Lumovi's own, through its
 * proxy as its other connections go.
 */
function request(
  url: URL,
  options: { method?: string; headers?: Record<string, string>; body?: string; ca?: Buffer },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const through = url.protocol === 'https:' ? https : http
    const done = (settle: () => void) => {
      clearTimeout(deadline)
      settle()
    }
    const req = through.request(
      url,
      {
        method: options.method ?? 'GET',
        headers: { Accept: 'application/json', ...options.headers },
        ...(options.ca ? { ca: options.ca } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MOST_BYTES) {
            req.destroy(new NotOpenId('its answer is too long'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () =>
          done(() =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          ),
        )
        res.on('error', (error) => done(() => reject(error)))
      },
    )
    const deadline = setTimeout(
      () => req.destroy(new Error('it didn’t answer in 15 seconds')),
      TIMEOUT_MS,
    )
    req.on('error', (error) => done(() => reject(error)))
    req.end(options.body)
  })
}

/** The issuer's certificate authority, its file read now (as each renewal needs it). */
async function caOf(whose: Whose): Promise<Buffer | undefined> {
  if (whose.caFile === undefined) return whose.caData
  try {
    return await readFile(whose.caFile)
  } catch (error) {
    // (Nothing was asked of the issuer: tried again soon, as a file put right is.)
    throw new Unreached(
      'auth',
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `Its idp-certificate-authority, ${whose.caFile}, isn’t there.`
        : `Its idp-certificate-authority, ${whose.caFile}, can’t be read: ${stopped(fetchFailure(error))}`,
    )
  }
}

/** An OAuth error's code, as the provider said it, if it said one. */
function errorOf(body: string): string | undefined {
  try {
    const error = (JSON.parse(body) as { error?: unknown }).error
    return typeof error === 'string' ? error : undefined
  } catch {
    return undefined
  }
}

function descriptionOf(body: string): string {
  try {
    const description = (JSON.parse(body) as { error_description?: unknown }).error_description
    return typeof description === 'string' ? description : ''
  } catch {
    return ''
  }
}

/** The provider's words, with nothing of what was sent in them, cut short. */
function scrubbed(text: string, secrets: (string | undefined)[]): string {
  let out = text
  for (const secret of secrets) if (secret) out = out.split(secret).join('…')
  return spelled(out).slice(0, 300)
}

/** Another's text as it's shown: printable, on one line. */
function spelled(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()
}

/**
 * The new pair, written into the file the user came from, under kubectl's lock: only if that
 * user still has the issuer, client and refresh token renewed with. Says what's on file instead,
 * where another program renewed it first; or why it couldn't be written.
 */
async function save(whose: Whose, used: string, next: Pair): Promise<'saved' | Pair | string> {
  const file = whose.file!
  const real = await refusable(realpath(file), GONE)
  if (typeof real !== 'string') return real.said
  const lock = `${file}.lock`
  const free = await refusable(locked(lock), FOLDER_READ_ONLY)
  if (typeof free !== 'boolean') return free.said
  if (!free) return 'kubectl (or another program) is writing it'
  try {
    const now = await refusable(opened(real), GONE)
    if (typeof now === 'string') return now
    if ('said' in now) return now.said
    const { text, mode } = now
    const doc = parseDocument(text)
    if (doc.errors.length > 0) return 'it doesn’t read as YAML now'
    const users = doc.get('users', true) as { items?: { get(key: string): unknown }[] } | undefined
    const index = (users?.items ?? []).findIndex((item) => item.get('name') === whose.user)
    if (index === -1) return `its user ${whose.user} isn’t in it now`
    const config = ['users', index, 'user', 'auth-provider', 'config']
    const at = (key: string) => doc.getIn([...config, key]) as unknown
    if (at('idp-issuer-url') !== whose.issuer || at('client-id') !== whose.clientId) {
      return `its user ${whose.user} was changed`
    }
    if (at('refresh-token') !== used) {
      const idToken = at('id-token')
      const refreshToken = at('refresh-token')
      if (typeof idToken === 'string' && typeof refreshToken === 'string') {
        return { idToken, refreshToken }
      }
      return `its user ${whose.user} was changed`
    }
    const out = written(text, doc, config, next)
    if (out === undefined) return 'it couldn’t be changed without changing anything else'
    const replaced = await refusable(replace(real, out, mode), FOLDER_READ_ONLY)
    return replaced ? replaced.said : 'saved'
  } finally {
    await unlink(lock).catch(() => {})
  }
}

/** What the file system refusing a step means, in the note's words, by its code. */
const GONE = new Map([['ENOENT', 'it isn’t there now']])
const FOLDER_READ_ONLY = new Map(
  ['EACCES', 'EPERM', 'EROFS'].map((code) => [code, 'its folder is read-only to you']),
)

/** A step the file system may refuse: why, where it's one of `reasons`; else what it gave. */
async function refusable<T>(
  step: Promise<T>,
  reasons: Map<string, string>,
): Promise<T | { said: string }> {
  try {
    return await step
  } catch (error) {
    const said = reasons.get((error as NodeJS.ErrnoException).code ?? '')
    if (said) return { said }
    throw error
  }
}

/**
 * The file as it is now, all of it read through the one handle opened (and a pipe never waited
 * on); or why it's not to be written over. Only where kubectl would write it: the new file is
 * renamed over the old, which its folder allows even where the file itself is read-only, or
 * another user's (and it'd be theirs after).
 */
async function opened(real: string): Promise<{ text: string; mode: number } | string> {
  const handle = await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'EISDIR') return undefined
      throw error
    },
  )
  if (!handle) return 'it isn’t a regular file'
  try {
    const info = await handle.stat()
    if (!info.isFile()) return 'it isn’t a regular file'
    const uid = process.platform === 'win32' ? undefined : process.getuid?.()
    if (uid !== undefined && info.uid !== uid) return 'it belongs to another user'
    if ((info.mode & 0o200) === 0) return 'it’s read-only to you'
    return { text: await handle.readFile('utf8'), mode: info.mode }
  } finally {
    await handle.close()
  }
}

/**
 * The file's text with the two tokens changed, each where it is (and as a quoted string, which
 * no token can make more of); or with them set where they're not. Undefined unless it then reads
 * as it did, but for those two.
 */
function written(
  text: string,
  doc: ReturnType<typeof parseDocument>,
  config: (string | number)[],
  next: Pair,
): string | undefined {
  const wanted = { 'id-token': next.idToken, 'refresh-token': next.refreshToken }
  const spans = Object.entries(wanted).map(([key, value]) => {
    const node = doc.getIn([...config, key], true)
    return isScalar(node) && node.range ? { range: node.range, value } : undefined
  })
  let out: string
  if (spans.every(Boolean)) {
    out = text
    // From the end, so each range still points where it did.
    for (const span of spans.sort((a, b) => b!.range[0] - a!.range[0])) {
      out = `${out.slice(0, span!.range[0])}${JSON.stringify(span!.value)}${out.slice(span!.range[1])}`
    }
  } else {
    for (const [key, value] of Object.entries(wanted)) doc.setIn([...config, key], value)
    out = doc.toString({ lineWidth: 0 })
  }
  const expected = parseDocument(text).toJS() as Record<string, unknown>
  let target = expected
  for (const step of config) target = (target as Record<string | number, unknown>)[step] as never
  Object.assign(target, wanted)
  const after = parseDocument(out)
  return after.errors.length === 0 && isDeepStrictEqual(after.toJS(), expected) ? out : undefined
}

/**
 * kubectl's lock (client-go's `<file>.lock`, made only if it isn't there), waited for a while.
 * One a Lumovi left that's no longer running is taken away; anyone else's never.
 */
async function locked(lock: string): Promise<boolean> {
  const until = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const handle = await open(lock, 'wx', 0o600)
      await handle.writeFile(`lumovi ${process.pid}\n`)
      await handle.close()
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (await takenAway(lock)) continue
    if (Date.now() >= until) return false
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * Whether a lock a Lumovi that's gone left is gone now: moved aside first (which one Lumovi
 * alone can do), and removed only if it's the very one read, so a lock made since is never
 * taken. Gone already, it's free to take too.
 */
async function takenAway(lock: string): Promise<boolean> {
  const gone = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  let handle
  try {
    handle = await open(lock, 'r')
  } catch (error) {
    return gone(error)
  }
  let left: { ino: number; dev: number } | undefined
  try {
    const said = /^lumovi (\d+)\n$/.exec(await handle.readFile('utf8'))
    if (said && !running(Number(said[1]))) left = await handle.stat()
  } finally {
    await handle.close()
  }
  if (!left) return false
  const aside = `${lock}.${randomBytes(6).toString('hex')}`
  try {
    await rename(lock, aside)
  } catch (error) {
    return gone(error)
  }
  const moved = await lstat(aside)
  const same = moved.ino === left.ino && moved.dev === left.dev
  // Another's, made since it was read: put back, unless yet another holds it now.
  if (!same) await link(aside, lock).catch(() => {})
  await unlink(aside).catch(() => {})
  return same
}

function running(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * `text` in place of `file`: written to a file of its own beside it, private from the moment it's
 * made, given the file's mode, and renamed over it (Windows: the folder's ACL, as kubectl's own
 * write has it). Nothing's left behind when that fails.
 */
async function replace(file: string, text: string, mode: number): Promise<void> {
  const temporary = join(
    dirname(file),
    `.${basename(file)}.lumovi-${randomBytes(6).toString('hex')}`,
  )
  const handle = await open(temporary, 'wx', mode & 0o600)
  try {
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await chmod(temporary, mode & 0o7777)
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

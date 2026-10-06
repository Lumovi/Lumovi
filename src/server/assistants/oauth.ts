/**
 * Signing AI assistants in to a Lumovi server, as MCP clients do: OAuth 2.1
 * with PKCE. An assistant registers (RFC 7591), sends the person to Lumovi's
 * page to allow it (signed in as they always are: with a token, single
 * sign-on, or a proxy), and gets tokens to act as them.
 *
 * What it's allowed lasts as long as the session it was allowed in: it ends
 * when they sign out, their session expires, or they let it go. Behind a
 * proxy, which has no sessions, it lasts as long as one would. All of it lives
 * in the server's memory, as sessions do: after a restart, assistants sign in
 * again.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isDeepStrictEqual } from 'node:util'
import type { ServerAssistant } from '@shared/assistants'
import type { Identity } from '../cluster'
import { readJson, SECURITY_HEADERS, sendJson } from '../http'
import { log } from '../log'
import type { Sessions } from '../sessions'

/** How long an access token lasts (LUMOVI_ASSISTANT_TOKEN_SECONDS, for tests). */
const ACCESS_SECONDS = Number(process.env.LUMOVI_ASSISTANT_TOKEN_SECONDS) || 3600
/** How long an assistant has to swap the code it's given for tokens. */
const CODE_MS = 2 * 60_000
/**
 * A refresh token used again within this long of its first use is taken for a
 * retry (the assistant never heard the answer); after it, for a stolen copy,
 * and its assistant is let go (LUMOVI_ASSISTANT_REUSE_MS, for tests).
 */
const REUSE_MS = Number(process.env.LUMOVI_ASSISTANT_REUSE_MS) || 30_000
/** The largest token request: a few fields. */
const MAX_FORM = 16 * 1024

/** An assistant that has registered: what it calls itself, and where it may be sent back to. */
interface Client {
  name: string
  redirects: string[]
}

/** Who is signing in an assistant: a session's person, or (behind a proxy) the proxy's. */
export interface Signer {
  identity: Identity
  session?: string
}

/** An assistant someone allowed. */
export interface Grant {
  id: string
  person: string
  /** As Lumovi shows it: the name it registered with, then the one it gives as it connects. */
  name: string
  since: number
  lastUsed?: number
  /** The session it was allowed in (it ends with it); behind a proxy, who it acts as, until `expires`. */
  session?: string
  identity?: Identity
  expires?: number
  refresh: string
}

interface Code {
  clientId: string
  redirect: string
  challenge: string
  signer: Signer
  name: string
  expires: number
}

/** An authorization request, checked. */
interface AuthorizationRequest {
  clientId: string
  client: Client
  redirect: string
  challenge: string
  state: string | null
}

/** How a grant's end reads in the server's log. */
const ENDED = {
  'signed out': 'signed out',
  'let go': 'was let go',
  expired: 'can no longer use Lumovi',
  reused: 'was let go: its refresh token was used again, so someone else may have it',
}

/** Why an authorization or token request can't be answered. */
class OAuthProblem extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

const token = () => randomBytes(32).toString('base64url')

/** Sites that send an assistant's code on to the app on the person's computer (VS Code's). */
const APP_REDIRECTORS = ['vscode.dev', 'insiders.vscode.dev']
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']
const NOT_APPS = ['javascript:', 'data:', 'file:', 'blob:', 'about:', 'vbscript:', 'ws:', 'wss:']

/**
 * Where an assistant may be sent back to, with the person's code: their own
 * computer (an assistant listening there), an app's own scheme, or a site
 * (https) that `hosts` names. Anywhere else, a link to Lumovi's page, made to
 * look like an assistant's, could send someone's code to whoever made it.
 */
function redirectCheck(hosts: string[]): (uri: unknown) => uri is string {
  const sites = [...APP_REDIRECTORS, ...hosts]
  return (uri): uri is string => {
    if (typeof uri !== 'string' || !URL.canParse(uri)) return false
    const url = new URL(uri)
    if (url.hash) return false
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return (
        LOOPBACK.includes(url.hostname) ||
        (url.protocol === 'https:' && sites.includes(url.hostname))
      )
    }
    return !NOT_APPS.includes(url.protocol)
  }
}

/**
 * A registered assistant's id: its registration itself, so that it outlives
 * the server (registering asks nothing of anyone; allowing it does).
 */
const clientId = (client: Client) =>
  `lumovi-${Buffer.from(JSON.stringify([client.name, client.redirects])).toString('base64url')}`

/** The assistant an id is, if it's one this server would register as it is now. */
function clientOf(id: string | null, allowed: (uri: unknown) => boolean): Client | undefined {
  if (!id?.startsWith('lumovi-')) return undefined
  try {
    const [name, redirects] = JSON.parse(Buffer.from(id.slice(7), 'base64url').toString('utf8'))
    if (typeof name !== 'string' || !Array.isArray(redirects) || !redirects.every(allowed))
      return undefined
    return { name, redirects }
  } catch {
    return undefined
  }
}

/** A request's form body (application/x-www-form-urlencoded), as OAuth's token requests are. */
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
    throw new OAuthProblem('invalid_request', 'Send the request as a form.')
  }
  let body = ''
  for await (const chunk of req as AsyncIterable<Buffer>) {
    body += chunk
    if (body.length > MAX_FORM) throw new OAuthProblem('invalid_request', 'That’s too large.')
  }
  return new URLSearchParams(body)
}

/** An OAuth answer: never cached. */
function sendOAuth(res: ServerResponse, status: number, body: unknown): void {
  sendJson(res, status, body, { Pragma: 'no-cache' })
}

export interface Endpoints {
  /** The assistants' MCP endpoint: https://lumovi.example.com/mcp. */
  resource: string
  /** Lumovi, as the authorization server: https://lumovi.example.com. */
  issuer: string
  /** Where the person allows an assistant: Lumovi's own page. */
  authorize: string
  token: string
  register: string
  revoke: string
  /** Where the resource's own metadata is. */
  resourceMetadata: string
}

export class Grants {
  readonly #grants = new Map<string, Grant>()
  readonly #access = new Map<string, { grant: string; expires: number }>()
  readonly #refresh = new Map<string, string>()
  /** Refresh tokens used already: whose, and when. */
  readonly #spent = new Map<string, { grant: string; at: number }>()
  readonly #codes = new Map<string, Code>()
  readonly #allowed: (uri: unknown) => uri is string

  constructor(
    private readonly deps: {
      sessions: Sessions
      /** How long an assistant allowed behind a proxy lasts. */
      sessionHours: number
      /** Sites assistants may be sent back to (https), besides the person's computer and apps. */
      redirectHosts: string[]
      /** A grant that ended: its assistant's connections close, and its person's pages are told. */
      ended(grant: Grant): void
      /** One was allowed, or renamed: its person's pages are told. */
      changed(grant: Grant): void
    },
  ) {
    this.#allowed = redirectCheck(deps.redirectHosts)
  }

  // ——— Metadata ———

  /** The MCP endpoint's metadata (RFC 9728): who signs assistants in to it. */
  resourceMetadata(res: ServerResponse, endpoints: Endpoints): void {
    sendJson(res, 200, {
      resource: endpoints.resource,
      authorization_servers: [endpoints.issuer],
      bearer_methods_supported: ['header'],
      resource_name: 'Lumovi',
    })
  }

  /** The authorization server's metadata (RFC 8414). */
  serverMetadata(res: ServerResponse, endpoints: Endpoints): void {
    sendJson(res, 200, {
      issuer: endpoints.issuer,
      authorization_endpoint: endpoints.authorize,
      token_endpoint: endpoints.token,
      registration_endpoint: endpoints.register,
      revocation_endpoint: endpoints.revoke,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
    })
  }

  // ——— Registering ———

  /** `POST oauth/register` (RFC 7591): as a public client, sent back only where it says. */
  async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const given = Object(await readJson(req)) as { redirect_uris?: unknown; client_name?: unknown }
    // Only those it may be sent back to (VS Code names more than it needs, say).
    const redirects = Array.isArray(given.redirect_uris)
      ? given.redirect_uris.filter(this.#allowed)
      : []
    if (redirects.length === 0) {
      sendOAuth(res, 400, {
        error: 'invalid_redirect_uri',
        error_description:
          'redirect_uris must go back to this computer (http://localhost), to an app (its own scheme), or to a site this server allows (LUMOVI_ASSISTANT_REDIRECT_HOSTS).',
      })
      return
    }
    const name =
      typeof given.client_name === 'string' && given.client_name.trim()
        ? given.client_name.trim().slice(0, 100)
        : 'An AI assistant'
    const client = { name, redirects }
    sendOAuth(res, 201, {
      client_id: clientId(client),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: client.redirects,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    })
  }

  // ——— Allowing ———

  /**
   * An authorization request (the query an assistant sent the person to
   * Lumovi's page with), checked: which assistant, and where it goes back to.
   */
  #request(query: URLSearchParams, endpoints: Endpoints): AuthorizationRequest {
    const clientId = query.get('client_id')
    const client = clientOf(clientId, this.#allowed)
    if (!client) throw new OAuthProblem('invalid_client', 'It doesn’t say which assistant it is.')
    const redirect = query.get('redirect_uri') ?? ''
    if (!client.redirects.includes(redirect)) {
      throw new OAuthProblem('invalid_request', 'It goes back somewhere the assistant didn’t name.')
    }
    if (query.get('response_type') !== 'code') {
      throw new OAuthProblem(
        'unsupported_response_type',
        'It asks for something other than a code.',
      )
    }
    const challenge = query.get('code_challenge') ?? ''
    if (query.get('code_challenge_method') !== 'S256' || !/^[\w.~-]{43,128}$/.test(challenge)) {
      throw new OAuthProblem('invalid_request', 'It has no PKCE code challenge (S256).')
    }
    const resource = query.get('resource')
    if (resource !== null && resource.replace(/\/+$/, '') !== endpoints.resource) {
      throw new OAuthProblem(
        'invalid_target',
        `It’s for ${resource}, not Lumovi’s ${endpoints.resource}.`,
      )
    }
    return { clientId: clientId!, client, redirect, challenge, state: query.get('state') }
  }

  /** `GET api/assistants/authorize?…`: for the page to say who's asking, and where it goes back to. */
  describe(
    res: ServerResponse,
    query: URLSearchParams,
    endpoints: Endpoints,
    signer: Signer,
  ): void {
    try {
      const { client, redirect } = this.#request(query, endpoints)
      const back = new URL(redirect)
      sendJson(res, 200, {
        client: client.name,
        // Where it goes back to: the assistant on this computer, or an app or site.
        returnsTo: back.protocol.startsWith('http') ? back.host : back.protocol.slice(0, -1),
        person: signer.identity.user.name,
      })
    } catch (error) {
      sendJson(res, 400, { error: (error as Error).message })
    }
  }

  /** `POST api/assistants/authorize`: the person's answer; the page goes back to the assistant. */
  async decide(
    req: IncomingMessage,
    res: ServerResponse,
    endpoints: Endpoints,
    signer: Signer,
  ): Promise<void> {
    const given = Object(await readJson(req)) as { query?: unknown; approved?: unknown }
    let request: AuthorizationRequest
    try {
      if (typeof given.query !== 'string' || typeof given.approved !== 'boolean') {
        throw new OAuthProblem('invalid_request', 'Expected the request, and whether it’s allowed.')
      }
      request = this.#request(new URLSearchParams(given.query), endpoints)
    } catch (error) {
      sendJson(res, 400, { error: (error as Error).message })
      return
    }
    const back = new URL(request.redirect)
    if (given.approved) {
      const code = token()
      this.#codes.set(code, {
        clientId: request.clientId,
        redirect: request.redirect,
        challenge: request.challenge,
        signer,
        name: request.client.name,
        expires: Date.now() + CODE_MS,
      })
      back.searchParams.set('code', code)
    } else {
      back.searchParams.set('error', 'access_denied')
    }
    if (request.state !== null) back.searchParams.set('state', request.state)
    back.searchParams.set('iss', endpoints.issuer)
    sendJson(res, 200, { redirect: back.href })
  }

  // ——— Tokens ———

  /** `POST oauth/token`: a code swapped for tokens, or tokens renewed. */
  async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const form = await readForm(req)
      const kind = form.get('grant_type')
      if (kind === 'authorization_code') sendOAuth(res, 200, this.#exchange(form))
      else if (kind === 'refresh_token') sendOAuth(res, 200, this.#renew(form))
      else throw new OAuthProblem('unsupported_grant_type', 'Only codes and refresh tokens.')
    } catch (error) {
      const { error: code, message, status } = error as OAuthProblem
      sendOAuth(res, status, { error: code, error_description: message })
    }
  }

  #exchange(form: URLSearchParams) {
    const code = this.#codes.get(form.get('code') ?? '')
    // Once only.
    this.#codes.delete(form.get('code') ?? '')
    if (!code || code.expires < Date.now()) {
      throw new OAuthProblem('invalid_grant', 'That code has been used, or has expired.')
    }
    if (form.get('client_id') !== code.clientId || form.get('redirect_uri') !== code.redirect) {
      throw new OAuthProblem('invalid_grant', 'That code was given to another assistant.')
    }
    const verifier = form.get('code_verifier') ?? ''
    if (createHash('sha256').update(verifier).digest('base64url') !== code.challenge) {
      throw new OAuthProblem('invalid_grant', 'The PKCE code verifier doesn’t match.')
    }
    const { signer } = code
    const person = signer.identity.user.name
    const grant: Grant = {
      id: token(),
      person,
      name: code.name,
      since: Date.now(),
      refresh: token(),
      ...(signer.session
        ? { session: signer.session }
        : {
            identity: signer.identity,
            expires: Date.now() + this.deps.sessionHours * 3_600_000,
          }),
    }
    this.#grants.set(grant.id, grant)
    this.#refresh.set(grant.refresh, grant.id)
    log(`${person} allowed ${grant.name} to use Lumovi as them`)
    this.deps.changed(grant)
    return this.#tokens(grant)
  }

  #renew(form: URLSearchParams) {
    const given = form.get('refresh_token') ?? ''
    const spent = this.#spent.get(given)
    // Used before, and not just now: someone else has a copy. (A grant takes its own with it.)
    if (spent && Date.now() - spent.at > REUSE_MS)
      this.#end(this.#grants.get(spent.grant)!, 'reused')
    const id = this.#refresh.get(given)
    const grant = id === undefined ? undefined : this.#grants.get(id)!
    if (!grant || !this.#alive(grant)) {
      throw new OAuthProblem('invalid_grant', 'That refresh token has been used, or has ended.')
    }
    // Each is used once: the next comes with the new tokens.
    this.#refresh.delete(grant.refresh)
    this.#spent.set(grant.refresh, { grant: grant.id, at: Date.now() })
    grant.refresh = token()
    this.#refresh.set(grant.refresh, grant.id)
    return this.#tokens(grant)
  }

  #tokens(grant: Grant) {
    const access = token()
    this.#access.set(access, { grant: grant.id, expires: Date.now() + ACCESS_SECONDS * 1000 })
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_SECONDS,
      refresh_token: grant.refresh,
    }
  }

  /** `POST oauth/revoke` (RFC 7009): an assistant signing out. Answered alike, whatever it sent. */
  async revoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const given = (await readForm(req)).get('token') ?? ''
      const id = this.#access.get(given)?.grant ?? this.#refresh.get(given)
      const grant = id === undefined ? undefined : this.#grants.get(id)
      if (grant) this.#end(grant, 'signed out')
    } catch {
      // Not a form: there's nothing to revoke.
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' }).end()
  }

  // ——— Using ———

  /** The grant a request's bearer token is for, and who it acts as; undefined unless it's live. */
  verify(req: IncomingMessage): { grant: Grant; identity: Identity } | undefined {
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? ''
    const access = this.#access.get(bearer)
    if (!access || access.expires < Date.now()) {
      this.#access.delete(bearer)
      return undefined
    }
    // A token's grant is there until it ends, which takes its tokens with it.
    const grant = this.#grants.get(access.grant)!
    if (!this.#alive(grant)) return undefined
    grant.lastUsed = Date.now()
    return { grant, identity: this.identity(grant)! }
  }

  /** Who a grant acts as now: its session's person (their token renewed as it is), or the proxy's. */
  identity(grant: Grant): Identity | undefined {
    return grant.session ? this.deps.sessions.get(grant.session)?.identity : grant.identity
  }

  /**
   * Behind a proxy: who it says `identity`'s person is now (their groups, say),
   * for the assistants they allowed. Those that act as someone else now.
   */
  reidentify(identity: Identity): Grant[] {
    const changed = [...this.#grants.values()].filter(
      (grant) =>
        grant.identity &&
        grant.person === identity.user.name &&
        !isDeepStrictEqual(grant.identity, identity),
    )
    for (const grant of changed) grant.identity = identity
    return changed
  }

  /** Lets go of what has run out: codes and tokens never used in time, and grants that ended. */
  sweep(): void {
    const now = Date.now()
    for (const expiring of [this.#codes, this.#access]) {
      for (const [key, { expires }] of expiring) if (expires < now) expiring.delete(key)
    }
    for (const grant of this.#grants.values()) this.#alive(grant)
  }

  /** Whether a grant still acts as someone: not once its session has, or its time is up (it ends). */
  #alive(grant: Grant): boolean {
    if ((grant.expires ?? Infinity) < Date.now() || !this.identity(grant)) {
      this.#end(grant, 'expired')
      return false
    }
    return true
  }

  // ——— The person's ———

  /** `person`'s assistants, oldest first. */
  of(person: string): ServerAssistant[] {
    return [...this.#grants.values()]
      .filter((grant) => grant.person === person && this.#alive(grant))
      .map(({ id, name, since, lastUsed }) => ({
        id,
        name,
        since,
        ...(lastUsed ? { lastUsed } : {}),
      }))
  }

  /** `person` lets one of theirs go. */
  letGo(person: string, id: string): void {
    const grant = this.#grants.get(id)
    if (grant?.person === person) this.#end(grant, 'let go')
  }

  /** Renames an assistant, as it calls itself once it connects ("Claude Code"). */
  rename(grant: Grant, name: string): void {
    if (grant.name === name) return
    grant.name = name
    this.deps.changed(grant)
  }

  /** A session ended: so do the assistants allowed in it. */
  sessionEnded(session: string): void {
    for (const grant of this.#grants.values()) {
      if (grant.session === session) this.#end(grant, 'expired')
    }
  }

  #end(grant: Grant, how: keyof typeof ENDED): void {
    this.#grants.delete(grant.id)
    this.#refresh.delete(grant.refresh)
    for (const tokens of [this.#access, this.#spent]) {
      for (const [token, { grant: id }] of tokens) if (id === grant.id) tokens.delete(token)
    }
    log(`${grant.person}’s ${grant.name} ${ENDED[how]}`)
    this.deps.ended(grant)
  }
}

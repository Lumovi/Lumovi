/**
 * Single sign-on with OpenID Connect: the authorization code flow with PKCE.
 * The provider says who someone is, and which groups they're in; the server
 * then acts as them in the cluster (see cluster.ts), so their RBAC applies.
 * With a refresh token, it asks again before what the provider said expires:
 * their groups as they are now, or that it won't any more (the session ends).
 */
import { fetchFailure } from '@backend/network'
import { createHash, randomBytes } from 'node:crypto'
import type { SessionUser } from '@shared/server'
import type { AuthConfig } from './config'
import { GraphRefused, memberGroups } from './graph'
import { expiryOf, keyId, verifyIdToken, type Claims, type Jwk } from './jwt'

type OidcConfig = Extract<AuthConfig, { mode: 'oidc' }>

interface Discovery {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  token_endpoint_auth_methods_supported?: string[]
  /** Where a refresh token is let go of (RFC 7009), when the provider has it. */
  revocation_endpoint?: string
}

interface TokenResponse {
  id_token?: unknown
  access_token?: unknown
  refresh_token?: unknown
}

/** The person's own token, when Lumovi passes it on to the API server. */
export interface Forwarded {
  token?: string
  /** When it expires (ms since the epoch). */
  expires?: number
}

/** Who an ID token says someone is: so until it expires. */
export interface Said {
  user: SessionUser
  /** Why their groups couldn't be read, when they couldn't: they have none. */
  groupsUnread?: string
  /** When the ID token expires (ms since the epoch). */
  idExpires: number
}

/** Who signed in, and the token their requests carry, if they carry one. */
export interface SignedIn extends Forwarded, Said {
  /** What renews it all, when the provider gave one. */
  refreshToken?: string
  /** Whom the ID token is about, and the sign-in's nonce: a renewed one must say them still. */
  subject?: string
  nonce: string
}

/** A renewal: the token to pass on now, what renews it next, and the new ID token's word. */
export interface Renewed extends Forwarded {
  refreshToken?: string
  /** Who the provider says they are now; nothing when it sent no ID token. */
  said?: Said
}

/** What a renewed ID token must still say: whom it's about, as whom they signed in. */
export interface Renewing {
  subject?: string
  name: string
  nonce: string
}

/**
 * The provider won't renew a session's tokens (the person was disabled or removed, or signed out
 * there), or what it sent instead doesn't check out: the session ends.
 */
export class RenewalRefused extends Error {}

/** A sign-in on its way through the provider. */
export interface PendingSignIn {
  state: string
  verifier: string
  nonce: string
  /** Where in the app to go once signed in. */
  then: string
}

const TIMEOUT_MS = 20_000

const random = () => randomBytes(32).toString('base64url')

const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

export class OidcClient {
  #discovery?: Promise<Discovery>
  #keys?: Promise<Jwk[]>

  constructor(
    private readonly config: OidcConfig,
    /** Where the provider sends people back to. */
    private readonly redirectUri: string,
  ) {}

  /** Starts a sign-in: where to send the browser, and what to remember until it's back. */
  async start(then: string): Promise<{ url: string; pending: PendingSignIn }> {
    const pending = { state: random(), verifier: random(), nonce: random(), then }
    const url = new URL((await this.#discover()).authorization_endpoint)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.redirectUri,
      scope: this.config.scopes,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString()
    return { url: url.href, pending }
  }

  /**
   * Finishes a sign-in: trades the code for tokens, and says who the ID
   * token names (and, with forwardToken, which token their requests carry).
   */
  async finish(code: string, pending: PendingSignIn): Promise<SignedIn> {
    const tokens = await this.#token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      code_verifier: pending.verifier,
    })
    const claims = await this.#verified(tokens, pending.nonce, false)
    const name = claims[this.config.usernameClaim]
    if (typeof name !== 'string' || name === '') {
      throw new Error(`The ID token has no ${this.config.usernameClaim} claim to name the user by`)
    }
    const forwarded = this.#forwarded(tokens)
    const { refreshToken, ...said } = await this.#said(claims, name, tokens)
    return {
      ...said,
      ...forwarded,
      ...(refreshToken ? { refreshToken } : {}),
      ...(typeof claims.sub === 'string' ? { subject: claims.sub } : {}),
      nonce: pending.nonce,
    }
  }

  /**
   * Renews it all: a new token to pass on, and who the provider says they are now. Throws
   * RenewalRefused when it won't, or what it sends doesn't check out; anything else (it can't
   * be reached, it failed) may pass.
   */
  async renew(refreshToken: string, renewing: Renewing): Promise<Renewed> {
    let tokens: TokenResponse
    try {
      tokens = await this.#token({ grant_type: 'refresh_token', refresh_token: refreshToken })
    } catch (error) {
      // It said no (invalid_grant, say), rather than failing to answer.
      if (error instanceof Answered && error.status < 500 && error.status !== 429) {
        throw new RenewalRefused(error.message)
      }
      throw error
    }
    // Providers that don't rotate refresh tokens keep taking the same one.
    const next = text(tokens.refresh_token) ?? refreshToken
    try {
      // A renewal is an access token (OAuth's must): anything less isn't one.
      if (typeof tokens.access_token !== 'string') {
        throw new Error('The provider’s renewal has no access token')
      }
      const forwarded = this.#forwarded(tokens)
      // No ID token (some providers send none on a renewal): renewed, but not who they are.
      if (tokens.id_token === undefined) return { ...forwarded, refreshToken: next }
      const claims = await this.#verified(tokens, renewing.nonce, true)
      if (claims.sub !== renewing.subject || claims[this.config.usernameClaim] !== renewing.name) {
        throw new Error('The provider renewed it for someone else')
      }
      const { refreshToken: renews, ...said } = await this.#said(
        claims,
        renewing.name,
        tokens,
        next,
      )
      return { ...forwarded, refreshToken: renews ?? next, said }
    } catch (error) {
      throw new RenewalRefused((error as Error).message)
    }
  }

  /** The ID token, checked: signed by the provider, for Lumovi, from this sign-in. */
  async #verified(tokens: TokenResponse, nonce: string, renewed: boolean): Promise<Claims> {
    if (typeof tokens.id_token !== 'string') throw new Error('The provider sent no ID token')
    const token = tokens.id_token
    let keys = await this.#jwks()
    // A provider that rotated its keys signs with one not seen yet.
    if (!keys.some((key) => keyId(token) === undefined || key.kid === keyId(token))) {
      keys = await this.#jwks(true)
    }
    return verifyIdToken(token, keys, {
      issuer: this.config.issuer,
      audience: this.config.clientId,
      nonce,
      renewed,
    })
  }

  /**
   * Who the ID token says they are: their groups from it, or from Microsoft Graph when they're
   * in too many for it; and what renews it all, if reading them took a newer one.
   */
  async #said(
    claims: Claims,
    name: string,
    tokens: TokenResponse,
    refreshToken = text(tokens.refresh_token),
  ): Promise<Said & { refreshToken?: string }> {
    const idExpires = (claims.exp as number) * 1000
    const claim = this.config.groupsClaim
    const elsewhere = claims._claim_names
    // Put elsewhere (a distributed claim): what Microsoft Entra ID does past 200 groups.
    if (
      claims[claim] === undefined &&
      typeof elsewhere === 'object' &&
      elsewhere !== null &&
      Object.hasOwn(elsewhere, claim)
    ) {
      const { groups, unread, refreshToken: newer } = await this.#overage(tokens, refreshToken)
      const renews = newer ?? refreshToken
      return {
        user: { name, groups },
        ...(unread ? { groupsUnread: unread } : {}),
        idExpires,
        ...(renews ? { refreshToken: renews } : {}),
      }
    }
    const groups = ([] as unknown[]).concat(claims[claim] ?? [])
    return {
      user: { name, groups: groups.filter((group): group is string => typeof group === 'string') },
      idExpires,
      ...(refreshToken ? { refreshToken } : {}),
    }
  }

  /**
   * Their groups from Microsoft Graph (never from where the token points: Graph, as it's set),
   * with the sign-in's own token, or one for Graph from what renews it; none when they can't be
   * read, and why.
   */
  async #overage(
    tokens: TokenResponse,
    refreshToken: string | undefined,
  ): Promise<{ groups: string[]; unread?: string; refreshToken?: string }> {
    const graph = this.config.graphUrl
    if (!graph) {
      return {
        groups: [],
        unread:
          'The provider put their groups outside the ID token, and Lumovi reads them only from Microsoft Graph, for Microsoft Entra ID (LUMOVI_OIDC_GRAPH_URL).',
      }
    }
    let newer: string | undefined
    try {
      const own = text(tokens.access_token)
      if (own) {
        try {
          return { groups: await memberGroups(graph, own) }
        } catch (error) {
          if (!(error instanceof GraphRefused) || !refreshToken) throw error
        }
      } else if (!refreshToken) {
        throw new Error('The provider gave no token to read them with')
      }
      // The sign-in's token is for something else (the cluster, say): one for Graph instead.
      const forGraph = await this.#token({
        grant_type: 'refresh_token',
        refresh_token: refreshToken!,
        scope: `${new URL(graph).origin}/User.Read`,
      })
      newer = text(forGraph.refresh_token)
      const token = text(forGraph.access_token)
      if (!token) throw new Error('The provider gave no token for Microsoft Graph')
      return { groups: await memberGroups(graph, token), ...(newer ? { refreshToken: newer } : {}) }
    } catch (error) {
      return {
        groups: [],
        unread: `Lumovi couldn’t read their groups from Microsoft Graph: ${(error as Error).message}`,
        ...(newer ? { refreshToken: newer } : {}),
      }
    }
  }

  /** The token requests carry, if Lumovi passes one on: the one forwardToken names. */
  #forwarded(tokens: TokenResponse): Forwarded {
    const which = this.config.forwardToken
    if (!which) return {}
    const token = which === 'id' ? tokens.id_token : tokens.access_token
    if (typeof token !== 'string') throw new Error(`The provider sent no ${which} token to pass on`)
    return { token, expires: expiryOf(token) }
  }

  /** Asks the provider's token endpoint, as this client (HTTP Basic unless it only takes the body). */
  async #token(grant: Record<string, string>): Promise<TokenResponse> {
    const discovery = await this.#discover()
    return (await this.#post(discovery, discovery.token_endpoint, grant)) as TokenResponse
  }

  /**
   * Lets go of a refresh token at the provider, where it can (RFC 7009): as a session ends, so
   * none is left that still works. Best-effort: whatever goes wrong is only logged.
   */
  async revoke(refreshToken: string): Promise<void> {
    const discovery = await this.#discover()
    if (!discovery.revocation_endpoint) return
    await this.#post(discovery, discovery.revocation_endpoint, {
      token: refreshToken,
      token_type_hint: 'refresh_token',
    })
  }

  /**
   * Posts to one of the provider's endpoints as this client (HTTP Basic unless it only takes the
   * body): over https whenever the issuer is, and to there only (never redirected on).
   */
  async #post(discovery: Discovery, endpoint: string, form: Record<string, string>) {
    if (this.config.issuer.startsWith('https:') && !endpoint.startsWith('https:')) {
      throw new Error(`The provider’s ${new URL(endpoint).pathname} isn’t https`)
    }
    const body = new URLSearchParams({ ...form, client_id: this.config.clientId })
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
    const { clientSecret } = this.config
    if (clientSecret) {
      if (
        discovery.token_endpoint_auth_methods_supported?.includes('client_secret_basic') === false
      ) {
        body.set('client_secret', clientSecret)
      } else {
        const credentials = `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(clientSecret)}`
        headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`
      }
    }
    return fetchJson(endpoint, { method: 'POST', headers, body, redirect: 'error' })
  }

  #discover(): Promise<Discovery> {
    this.#discovery ??= (
      fetchJson(`${this.config.issuer}/.well-known/openid-configuration`) as Promise<Discovery>
    ).catch((error: unknown) => {
      // Asked again next time: the provider may just have been down.
      this.#discovery = undefined
      throw error
    })
    return this.#discovery
  }

  #jwks(refresh = false): Promise<Jwk[]> {
    if (refresh || !this.#keys) {
      this.#keys = this.#discover()
        .then((discovery) => fetchJson(discovery.jwks_uri) as Promise<{ keys: Jwk[] }>)
        .then(({ keys }) => keys)
      this.#keys.catch(() => (this.#keys = undefined))
    }
    return this.#keys
  }
}

/** The provider answered, but not with what was asked: how. */
class Answered extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(
    (error: Error) => {
      throw new Error(`Couldn’t reach ${url}: ${fetchFailure(error)}`)
    },
  )
  if (!response.ok) {
    throw new Answered(
      `${url} answered ${response.status}${await errorOf(response)}`,
      response.status,
    )
  }
  // (A revocation answers 200 with nothing.)
  const text = await response.text()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    // (Not what the parser would say: it quotes the body.)
    throw new Error(`${url} answered ${response.status} with something that isn’t JSON`)
  }
}

/**
 * What an endpoint said went wrong: its `error` code (`: invalid_grant`), kept short and plain,
 * and nothing else of it (its description, or a body, can echo what it was sent).
 */
async function errorOf(response: Response): Promise<string> {
  let error: unknown
  try {
    error = (JSON.parse(await response.text()) as { error?: unknown }).error
  } catch {
    return ''
  }
  return typeof error === 'string' ? `: ${error.replace(/[^\w.-]/g, '').slice(0, 60)}` : ''
}

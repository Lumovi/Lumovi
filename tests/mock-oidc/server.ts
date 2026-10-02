/**
 * A small OpenID Connect provider for the server's tests: discovery, an
 * authorization endpoint that signs the configured person in at once (or
 * says no), the token endpoint (authorization code with PKCE), and its keys.
 * Tests change what it does next: who signs in, a tampered ID token, an
 * endpoint that fails, keys that rotate. It also renews tokens (refresh
 * tokens), and tells the tests each token it issues, for a mock cluster
 * that trusts it to accept.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface MockOidcOptions {
  clientId: string
  clientSecret?: string
  /** What the provider says it takes at its token endpoint (client_secret_basic by default). */
  authMethods?: string[]
  /** How it signs ID tokens. */
  algorithm?: 'RS256' | 'ES256'
  /** How long its tokens last, in seconds (300 unless set). */
  lifetime?: number
  /** Access tokens as JWTs (the default, as Okta and Entra ID issue them), or opaque strings. */
  accessTokens?: 'jwt' | 'opaque'
  /** Refresh tokens: a new one each time (the default), the same one again, or none at all. */
  refreshTokens?: 'rotate' | 'keep' | 'none'
}

/** A change to the next ID token. */
export interface Tamper {
  claims?: Record<string, unknown>
  header?: Record<string, unknown>
  /** Signed with a key the provider doesn't publish. */
  foreignKey?: boolean
  /** Sent instead of an ID token. */
  idToken?: unknown
  /** Sent instead of an access token. */
  accessToken?: unknown
  /** Changes to the access token's claims. */
  accessClaims?: Record<string, unknown>
}

export interface MockOidc {
  issuer: string
  /** The claims of whoever signs in next. */
  person: Record<string, unknown>
  /** Whether the authorization endpoint says no (access_denied) next. */
  refuse: boolean
  tamper?: Tamper
  /** Endpoints that answer 500 until removed. */
  failing: Set<'discovery' | 'jwks' | 'token'>
  /** Signs with a new key from now on, and publishes only that one. */
  rotateKeys(): void
  /** What the token endpoint was sent. */
  tokenRequests: { authorization?: string; body: URLSearchParams }[]
  /** Called with each ID and access token it issues, which one it is, and the person's claims. */
  issued?: (token: string, kind: 'id' | 'access', claims: Record<string, unknown>) => void
  close(): Promise<void>
}

interface Key {
  kid: string
  privateKey: KeyObject
  publicKey: KeyObject
}

function newKey(algorithm: 'RS256' | 'ES256'): Key {
  const pair =
    algorithm === 'RS256'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { kid: randomBytes(6).toString('hex'), ...pair }
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

export async function startMockOidc(options: MockOidcOptions): Promise<MockOidc> {
  const algorithm = options.algorithm ?? 'RS256'
  let key = newKey(algorithm)
  const foreign = newKey(algorithm)
  /** Codes handed out, and what they stand for. */
  const codes = new Map<string, { challenge: string; nonce: string; redirectUri: string }>()
  /** Refresh tokens handed out, and whose they are. */
  const refreshTokens = new Map<string, Record<string, unknown>>()

  /** A signed token for `person`, for `audience`. */
  const jwt = (
    person: Record<string, unknown>,
    audience: string,
    extra: Record<string, unknown>,
    tamper: Tamper = {},
  ) => {
    const now = Math.floor(Date.now() / 1000)
    const header = { alg: algorithm, typ: 'JWT', kid: key.kid, ...tamper.header }
    const claims = {
      iss: provider.issuer,
      aud: audience,
      iat: now,
      exp: now + (options.lifetime ?? 300),
      ...extra,
      ...person,
      ...tamper.claims,
    }
    const signed = `${encode(header)}.${encode(claims)}`
    const signer = tamper.foreignKey ? foreign.privateKey : key.privateKey
    const signature = sign('sha256', Buffer.from(signed), {
      key: signer,
      ...(algorithm === 'ES256' ? { dsaEncoding: 'ieee-p1363' as const } : {}),
    })
    return `${signed}.${signature.toString('base64url')}`
  }

  /** What the token endpoint answers: an ID token, an access token, and maybe a refresh token. */
  const issue = (
    person: Record<string, unknown>,
    extra: Record<string, unknown>,
    withRefreshToken: boolean,
    tamper: Tamper = {},
  ) => {
    const idToken =
      'idToken' in tamper ? tamper.idToken : jwt(person, options.clientId, extra, tamper)
    const accessToken =
      'accessToken' in tamper
        ? tamper.accessToken
        : options.accessTokens === 'opaque'
          ? randomBytes(16).toString('hex')
          : jwt(person, 'kubernetes', {}, { claims: tamper.accessClaims })
    for (const [token, kind] of [
      [idToken, 'id'],
      [accessToken, 'access'],
    ] as const) {
      if (typeof token === 'string') provider.issued?.(token, kind, person)
    }
    const refreshToken = withRefreshToken ? randomBytes(16).toString('hex') : undefined
    if (refreshToken) refreshTokens.set(refreshToken, person)
    return {
      token_type: 'Bearer',
      expires_in: options.lifetime ?? 300,
      id_token: idToken,
      access_token: accessToken,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, provider.issuer)
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    }
    const failing = (what: 'discovery' | 'jwks' | 'token') => {
      if (!provider.failing.has(what)) return false
      json(500, { error: 'server_error' })
      return true
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      if (failing('discovery')) return
      json(200, {
        issuer: provider.issuer,
        authorization_endpoint: `${provider.issuer}/authorize`,
        token_endpoint: `${provider.issuer}/token`,
        jwks_uri: `${provider.issuer}/keys`,
        ...(options.authMethods
          ? { token_endpoint_auth_methods_supported: options.authMethods }
          : {}),
      })
    } else if (url.pathname === '/keys') {
      if (failing('jwks')) return
      json(200, {
        keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: key.kid, use: 'sig' }],
      })
    } else if (url.pathname === '/authorize') {
      const params = url.searchParams
      const back = new URL(params.get('redirect_uri')!)
      back.searchParams.set('state', params.get('state')!)
      if (provider.refuse) {
        provider.refuse = false
        back.searchParams.set('error', 'access_denied')
      } else {
        const code = randomBytes(16).toString('base64url')
        codes.set(code, {
          challenge: params.get('code_challenge')!,
          nonce: params.get('nonce')!,
          redirectUri: params.get('redirect_uri')!,
        })
        back.searchParams.set('code', code)
      }
      res.writeHead(302, { Location: back.href }).end()
    } else if (url.pathname === '/token' && req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
        provider.tokenRequests.push({ authorization: req.headers.authorization, body })
        if (failing('token')) return
        const basic = `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`
        const authenticated =
          options.clientSecret === undefined ||
          req.headers.authorization === basic ||
          body.get('client_secret') === options.clientSecret
        // A refresh token: the same person, signed in still (no nonce: that was the sign-in's).
        if (body.get('grant_type') === 'refresh_token') {
          const person = refreshTokens.get(body.get('refresh_token') ?? '')
          if (!person || !authenticated) {
            json(400, { error: 'invalid_grant' })
            return
          }
          // Rotating: a new one each time, and the old one stops working.
          const rotate = (options.refreshTokens ?? 'rotate') === 'rotate'
          if (rotate) refreshTokens.delete(body.get('refresh_token')!)
          json(200, issue(person, {}, rotate))
          return
        }
        const grant = codes.get(body.get('code') ?? '')
        codes.delete(body.get('code') ?? '')
        const verifier = createHash('sha256')
          .update(body.get('code_verifier') ?? '')
          .digest('base64url')
        if (
          !grant ||
          !authenticated ||
          grant.challenge !== verifier ||
          grant.redirectUri !== body.get('redirect_uri')
        ) {
          json(400, { error: 'invalid_grant' })
          return
        }
        const tamper = provider.tamper
        provider.tamper = undefined
        json(
          200,
          issue(provider.person, { nonce: grant.nonce }, options.refreshTokens !== 'none', tamper),
        )
      })
    } else {
      json(404, { error: 'not_found' })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  const provider: MockOidc = {
    issuer: `http://127.0.0.1:${port}`,
    person: {},
    refuse: false,
    failing: new Set(),
    tokenRequests: [],
    rotateKeys() {
      key = newKey(algorithm)
    },
    close() {
      server.closeAllConnections()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
  return provider
}

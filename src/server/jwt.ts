/** Checks an OpenID Connect ID token: its signature, issuer, audience, time and nonce. */
import { constants, createPublicKey, verify, type JsonWebKeyInput } from 'node:crypto'

/** A provider's public key, as its JWKS document lists it. */
export type Jwk = JsonWebKeyInput['key'] & { kid?: string }

/** How each signature algorithm verifies (none, and HMACs, never do). */
const ALGORITHMS: Record<
  string,
  { hash: string; padding?: number; saltLength?: number; dsaEncoding?: 'ieee-p1363' }
> = {
  RS256: { hash: 'sha256' },
  RS384: { hash: 'sha384' },
  RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
  PS384: { hash: 'sha384', padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 },
  PS512: { hash: 'sha512', padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 },
  ES256: { hash: 'sha256', dsaEncoding: 'ieee-p1363' },
  ES384: { hash: 'sha384', dsaEncoding: 'ieee-p1363' },
  ES512: { hash: 'sha512', dsaEncoding: 'ieee-p1363' },
}

/** Clocks disagree a little. */
const LEEWAY_SECONDS = 60

export type Claims = Record<string, unknown>

export interface Expected {
  issuer: string
  audience: string
  nonce: string
}

/** The token's parts, decoded; throws when it isn't a JWT. */
function decode(
  token: string,
  what = 'The ID token',
): {
  header: { alg?: string; kid?: string }
  claims: Claims
  signed: string
  signature: Buffer
} {
  const [header, claims, signature] = token.split('.')
  if (!header || !claims || signature === undefined) throw new Error(`${what} isn’t a JWT`)
  const json = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  return {
    header: json(header),
    claims: json(claims),
    signed: `${header}.${claims}`,
    signature: Buffer.from(signature, 'base64url'),
  }
}

/**
 * When a token passed on to the API server expires (ms since the epoch);
 * throws when it isn't a JWT (which the API server couldn't check) or doesn't say.
 */
export function expiryOf(token: string): number {
  const { exp } = decode(token, 'The token to pass on').claims
  if (typeof exp !== 'number') throw new Error('The token to pass on doesn’t say when it expires')
  return exp * 1000
}

/** The key that signed the token, by its id (or the provider's only key). */
export function keyId(token: string): string | undefined {
  return decode(token).header.kid
}

/** The token's claims, once it checks out; throws saying why it doesn't. */
export function verifyIdToken(token: string, keys: Jwk[], expected: Expected): Claims {
  const { header, claims, signed, signature } = decode(token)
  const algorithm = ALGORITHMS[header.alg ?? '']
  if (!algorithm)
    throw new Error(`The ID token is signed with ${header.alg}, which isn’t supported`)
  const jwk = keys.find((key) => header.kid === undefined || key.kid === header.kid)
  if (!jwk) throw new Error(`The provider has no key ${header.kid}`)
  const { hash, ...options } = algorithm
  if (
    !verify(
      hash,
      Buffer.from(signed),
      { key: createPublicKey({ key: jwk, format: 'jwk' }), ...options },
      signature,
    )
  ) {
    throw new Error('The ID token’s signature doesn’t match')
  }
  const now = Date.now() / 1000
  const audiences = ([] as unknown[]).concat(claims.aud)
  if (claims.iss !== expected.issuer) throw new Error(`The ID token is from ${String(claims.iss)}`)
  if (!audiences.includes(expected.audience)) throw new Error('The ID token is for another client')
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_SECONDS < now) {
    throw new Error('The ID token has expired')
  }
  if (claims.nonce !== expected.nonce) throw new Error('The ID token is from another sign-in')
  return claims
}

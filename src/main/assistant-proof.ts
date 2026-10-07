/**
 * How Lumovi's stdio bridge knows it's Lumovi listening on the assistants' port before it sends
 * Lumovi's token there: while Lumovi isn't running, any other program on the computer (another
 * person's, on a shared one) could listen on that port, and would be given the token. The bridge
 * sends a challenge, and only what holds the token can answer it: a keyed hash of the challenge,
 * which says nothing of the token itself.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** The bridge's challenge, and the server's answer to it. */
export const CHALLENGE = 'lumovi-challenge'
export const PROOF = 'lumovi-proof'

/** A challenge, as the bridge makes them: 32 hexadecimal digits. */
export const isChallenge = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)

/** The answer to `challenge`, from what holds `token`. */
export const proofOf = (token: string, challenge: string): string =>
  createHmac('sha256', token).update(`lumovi-mcp ${challenge}`).digest('hex')

/** Whether `given` answers `challenge` as only what holds `token` could. */
export function proves(given: string | null, token: string, challenge: string): boolean {
  const a = Buffer.from(given ?? '')
  const b = Buffer.from(proofOf(token, challenge))
  return a.length === b.length && timingSafeEqual(a, b)
}

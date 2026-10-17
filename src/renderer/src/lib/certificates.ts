/**
 * How the certificates in a Secret stand (LMV-194), as the backend said what they say: the one
 * that needs looking at soonest, and its words, alike in the Secrets list, a Secret's panel and
 * Needs attention. A bundle of roots, or a certificate Lumovi couldn't read, is never flagged.
 */
import type { CertificateSummary } from '@shared/api'
import type { Health, Status } from '@shared/health'
import { withTime } from '@renderer/lib/time'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
/** A certificate this close to its end is flagged. */
export const EXPIRES_SOON_MS = 14 * DAY

/** A certificate that was read, and said what it says. */
export type ReadCertificate = Extract<CertificateSummary, { as: 'certificate' }>

export type CertificateState = 'expired' | 'not-yet-valid' | 'expires-soon' | 'valid'

/** When a value's certificate is good from and until: until its chain's end, where that's sooner. */
export interface Validity {
  notBefore: number
  notAfter: number
}

export function validityOf(certificate: ReadCertificate): Validity {
  const own = Date.parse(certificate.notAfter)
  const chain = certificate.chainEnds ? Date.parse(certificate.chainEnds.notAfter) : Infinity
  return { notBefore: Date.parse(certificate.notBefore), notAfter: Math.min(own, chain) }
}

export function stateOf({ notBefore, notAfter }: Validity, now: number): CertificateState {
  if (notAfter <= now) return 'expired'
  if (notBefore > now) return 'not-yet-valid'
  return notAfter - now <= EXPIRES_SOON_MS ? 'expires-soon' : 'valid'
}

const STATE_RANK: Record<CertificateState, number> = {
  expired: 0,
  'not-yet-valid': 1,
  'expires-soon': 2,
  valid: 3,
}

/** Of a Secret's certificates, the one to look at first: the worst off, then the soonest to end. */
export function soonestOf(
  summaries: readonly CertificateSummary[] | undefined,
  now: number,
): { validity: Validity; state: CertificateState } | undefined {
  let soonest: { validity: Validity; state: CertificateState } | undefined
  for (const summary of summaries ?? []) {
    if (summary.as !== 'certificate') continue
    const validity = validityOf(summary)
    const state = stateOf(validity, now)
    if (
      !soonest ||
      STATE_RANK[state] < STATE_RANK[soonest.state] ||
      (state === soonest.state && validity.notAfter < soonest.validity.notAfter)
    ) {
      soonest = { validity, state }
    }
  }
  return soonest
}

/**
 * A while, short and in whole units, as a list's cell says it: "9d", "5h", "12m"; past two years,
 * years and days, as an Age says them ("9y364d").
 */
function shortWhile(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  const days = Math.floor(minutes / (24 * 60))
  if (days >= 730) return `${Math.floor(days / 365)}y${days % 365}d`
  if (days >= 1) return `${days}d`
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h`
  return `${Math.max(minutes, 0)}m`
}

/** From now to `time`: "in 9d", "3d ago". */
export const fromNow = (time: number, now: number) =>
  time <= now ? `${shortWhile(now - time)} ago` : `in ${shortWhile(time - now)}`

/** A date as the app writes one: "Nov 1, 2026". */
export const dateOf = (time: number) =>
  new Date(time).toLocaleDateString(undefined, withTime({ dateStyle: 'medium' }))

/** A while, in words: "9 days", "5 hours", "less than an hour". */
function inWords(ms: number): string {
  const days = Math.floor(ms / DAY)
  if (days >= 1) return `${days} ${days === 1 ? 'day' : 'days'}`
  const hours = Math.floor(ms / HOUR)
  if (hours >= 1) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  return 'less than an hour'
}

/** What each state is called, where it's flagged: the same words everywhere. */
export const STATE_NAMES: Record<Exclude<CertificateState, 'valid'>, string> = {
  'expires-soon': 'Expires soon',
  expired: 'Expired',
  'not-yet-valid': 'Not yet valid',
}

/** How bad each state is, as a status pill says. */
export const STATE_HEALTH: Record<CertificateState, Health> = {
  expired: 'critical',
  // (Refused by a client as an expired one is: broken now, not soon.)
  'not-yet-valid': 'critical',
  'expires-soon': 'warning',
  valid: 'healthy',
}

/**
 * A Secret's status by its certificates, as Needs attention says it: none where it holds no
 * certificate that was read.
 */
export function certificateStatus(
  summaries: readonly CertificateSummary[] | undefined,
  now: number,
): Status | null {
  const soonest = soonestOf(summaries, now)
  if (!soonest) return null
  const { state, validity } = soonest
  if (state === 'valid') return { health: 'healthy', label: 'Valid' }
  const detail =
    state === 'expired'
      ? `Certificate expired ${inWords(now - validity.notAfter)} ago`
      : state === 'not-yet-valid'
        ? `Certificate not valid until ${dateOf(validity.notBefore)}`
        : `Certificate expires in ${inWords(validity.notAfter - now)}`
  return { health: STATE_HEALTH[state], label: STATE_NAMES[state], detail }
}

/** The Secrets list's Expires cell: "in 87d", "3d ago", "Not yet valid"; none without one. */
export function expiresCell(
  summaries: readonly CertificateSummary[] | undefined,
  now: number,
): { text: string; state: CertificateState; sort: number } | undefined {
  const soonest = soonestOf(summaries, now)
  if (!soonest) return undefined
  const { state, validity } = soonest
  const text = state === 'not-yet-valid' ? 'Not yet valid' : fromNow(validity.notAfter, now)
  return { text, state, sort: validity.notAfter }
}

/**
 * A Secret's level among its list's chips: where its certificate's flagged, and none else. (Its
 * critical chip, "Not valid", counts the expired and those not valid yet.)
 */
export function certificateLevel(
  summaries: readonly CertificateSummary[] | undefined,
  now: number,
): Health | undefined {
  const state = soonestOf(summaries, now)?.state
  if (!state || state === 'valid') return undefined
  return STATE_HEALTH[state]
}

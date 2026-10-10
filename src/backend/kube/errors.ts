import type { KubeError, KubeErrorCause, KubeErrorCode } from '@shared/api'

/** An error with a known cause, safe to show to the user as-is. */
export class KubeRequestError extends Error {
  constructor(
    readonly code: KubeErrorCode,
    message: string,
    readonly status?: number,
    /** What the API server found wrong, field by field, where it said. */
    readonly causes?: KubeErrorCause[],
  ) {
    super(message)
    this.name = 'KubeRequestError'
  }
}

/** How many causes of one refusal are kept, and how much of each: it's the cluster's text. */
const CAUSES_MAX = 50
const CAUSE_TEXT_MAX = 1000

/** A Status' `details.causes`, as far as they're what they should be. */
function causesOf(details: unknown): KubeErrorCause[] | undefined {
  const causes = (details as { causes?: unknown } | null | undefined)?.causes
  if (!Array.isArray(causes)) return undefined
  const text = (value: unknown) =>
    typeof value === 'string' ? value.slice(0, CAUSE_TEXT_MAX) : undefined
  const kept = causes.slice(0, CAUSES_MAX).flatMap((cause: unknown): KubeErrorCause[] => {
    const { field, message, reason } = Object(cause) as Record<string, unknown>
    const said = text(message)
    if (said === undefined) return []
    const where = text(field)
    const why = text(reason)
    return [{ ...(where ? { field: where } : {}), message: said, ...(why ? { reason: why } : {}) }]
  })
  return kept.length > 0 ? kept : undefined
}

export const TLS_ERROR = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/

/** A certificate signed by an authority that isn't trusted (a proxy inspecting HTTPS, say). */
const UNTRUSTED = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
])

/**
 * Why a TLS connection failed, and what usually makes it so: a certificate nobody here
 * trusts (a proxy that inspects HTTPS signs with its own), one expired, or one for another
 * name.
 */
export function tlsReason(code: string, message: string): string {
  if (UNTRUSTED.has(code)) {
    return `Its certificate isn’t signed by a certificate authority Lumovi trusts (${message}). Behind a proxy that inspects HTTPS, its certificate authority must be trusted: in the system’s certificates, or LUMOVI_CA_FILE on a server; for a cluster, its kubeconfig’s certificate-authority must be the one that signed it.`
  }
  if (code === 'CERT_HAS_EXPIRED') return `Its certificate has expired (${message}).`
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return `Its certificate is for another name (${message}).`
  }
  return `TLS handshake failed: ${message}`
}

const STATUS_CODES: Record<number, KubeErrorCode> = {
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
  409: 'conflict',
  422: 'invalid',
}

/** Maps a non-2xx API response onto a `KubeRequestError`. */
export function statusError(status: number, body: string): KubeRequestError {
  let message = `The API server responded with HTTP ${status}`
  let causes: KubeErrorCause[] | undefined
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown; details?: unknown }
    causes = causesOf(parsed.details)
    // Kubernetes Status objects have a message; Prometheus' API errors have an error.
    if (typeof parsed.message === 'string') message = parsed.message
    else if (typeof parsed.error === 'string') message = parsed.error
  } catch {
    // Not a Kubernetes Status object (e.g. an HTML error page from a proxy).
  }
  return new KubeRequestError(STATUS_CODES[status] ?? 'server', message, status, causes)
}

/** Normalises anything thrown while talking to a cluster into a serialisable `KubeError`. */
/** What a proxy's refusal to open a tunnel is said as: which, and to where, when it's known. */
export function proxyRefusal(status: number | undefined, proxy?: string, target?: string): string {
  const which = proxy ? `The proxy ${proxy}` : 'The proxy'
  const to = target ? ` to ${target}` : ''
  return status === 407
    ? `${which} needs credentials${to} (407): give them in its URL, as http://user:password@host:port.`
    : `${which} didn’t open a tunnel${to} (it answered ${status}).`
}

/**
 * The status a proxy refused with, as what reached it says: undici's tunnel (fetch) or its
 * forwarding (a 407 to plain http, Node 26), or hpagent's (clusters' connections).
 */
export function proxyRefused(message: string): number | undefined {
  const status =
    /Proxy response \((\d+)\)|Proxy Authentication Required \((407)\)|^Bad response: (\d+)$/.exec(
      message,
    )
  return status ? Number(status[1] ?? status[2] ?? status[3]) : undefined
}

export function toKubeError(error: unknown): KubeError {
  if (error instanceof KubeRequestError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      ...(error.causes ? { causes: error.causes } : {}),
    }
  }
  const { message, code } = error as NodeJS.ErrnoException
  if (code && TLS_ERROR.test(code)) return { code: 'tls', message: tlsReason(code, message) }
  const refused = proxyRefused(message)
  if (refused) return { code: 'unreachable', message: proxyRefusal(refused) }
  return { code: 'unreachable', message }
}

/**
 * Whether changes to a context are refused: no, yes, or yes and why (a server says who made it
 * read-only for everyone, and when).
 */
export type ReadOnlyCheck = (context: string) => boolean | string

/** What's said of a change refused where it's read-only. */
export function readOnlyRefusal(context: string, why: boolean | string): KubeRequestError {
  return new KubeRequestError(
    'read-only',
    typeof why === 'string'
      ? why
      : `${context} is read-only in Lumovi. Allow changes to it to continue.`,
  )
}

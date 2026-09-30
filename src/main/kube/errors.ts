import type { KubeError, KubeErrorCode } from '@shared/api'

/** An error with a known cause, safe to show to the user as-is. */
export class KubeRequestError extends Error {
  constructor(
    readonly code: KubeErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'KubeRequestError'
  }
}

const TLS_ERROR = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/

const STATUS_CODES: Record<number, KubeErrorCode> = {
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not-found',
}

/** Maps a non-2xx API response onto a `KubeRequestError`. */
export function statusError(status: number, body: string): KubeRequestError {
  let message = `The API server responded with HTTP ${status}`
  try {
    const parsed = JSON.parse(body) as { message?: unknown }
    if (typeof parsed.message === 'string') message = parsed.message
  } catch {
    // Not a Kubernetes Status object (e.g. an HTML error page from a proxy).
  }
  return new KubeRequestError(STATUS_CODES[status] ?? 'server', message, status)
}

/** Normalises anything thrown while talking to a cluster into a serialisable `KubeError`. */
export function toKubeError(error: unknown): KubeError {
  if (error instanceof KubeRequestError) {
    return { code: error.code, message: error.message, status: error.status }
  }
  const { message, code } = error as NodeJS.ErrnoException
  if (code && TLS_ERROR.test(code)) {
    return { code: 'tls', message: `TLS handshake failed: ${message}` }
  }
  return { code: 'unreachable', message }
}

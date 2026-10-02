/** Small helpers for the server's HTTP side: answers, cookies, bodies and origins. */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Sent with every answer: no framing, no sniffing, no referrers. */
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

/** How large a request body may be (a token, mostly). */
const MAX_BODY = 64 * 1024

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

export function redirect(
  res: ServerResponse,
  location: string,
  headers: Record<string, string | string[]> = {},
): void {
  res.writeHead(302, {
    ...SECURITY_HEADERS,
    Location: location,
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end()
}

/** A JSON request body; `undefined` when it isn't one, or is too large. */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) return undefined
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY) return undefined
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/** The request's cookies. Their values are the server's own, never encoded, so none fails to read. */
export function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .map((pair) => pair.trim().split(/=(.*)/, 2))
      .filter(([name, value]) => name && value !== undefined),
  )
}

export interface CookieOptions {
  path: string
  /** Seconds; 0 removes the cookie. */
  maxAge: number
  secure: boolean
}

/** A cookie with a value that needs no encoding: base64url, or a word. */
export function cookie(name: string, value: string, options: CookieOptions): string {
  return [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    'SameSite=Lax',
    'HttpOnly',
    ...(options.secure ? ['Secure'] : []),
  ].join('; ')
}

/**
 * Whether a request comes from the server's own pages: browsers name the
 * page's origin on every request that changes something, and on WebSockets.
 */
export function sameOrigin(req: IncomingMessage, publicUrl?: URL): boolean {
  const origin = req.headers.origin
  if (!origin || !URL.canParse(origin)) return false
  return new URL(origin).host === req.headers.host || origin === publicUrl?.origin
}

/** Whether the browser reached the server over HTTPS, at the proxy (or ingress) in front of it. */
export function secure(req: IncomingMessage, publicUrl?: URL): boolean {
  return publicUrl?.protocol === 'https:' || req.headers['x-forwarded-proto'] === 'https'
}

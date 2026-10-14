import http from 'node:http'
import https from 'node:https'
import { createGunzip } from 'node:zlib'
import type { KubeConfig } from '@kubernetes/client-node'
import { KubeRequestError, statusError } from './errors'

/**
 * The URL of `path` on the cluster behind `kc`'s current context, refusing
 * plain HTTP the cluster didn't opt into.
 */
export function serverUrl(kc: KubeConfig, path: string): URL {
  const cluster = kc.getCurrentCluster()!
  // Keep any path prefix on the server URL (e.g. Rancher's /k8s/clusters/<id>). The path
  // always starts with a slash, so it can't name another host (`@elsewhere/…`).
  const url = new URL(`${cluster.server.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`)
  if (url.protocol === 'http:' && !cluster.skipTLSVerify) {
    // Same policy as the official client: unencrypted connections must be opted into.
    throw new KubeRequestError(
      'insecure',
      'This cluster uses plain HTTP. Set "insecure-skip-tls-verify: true" on it in your kubeconfig to allow unencrypted connections.',
    )
  }
  return url
}

/** Adds credentials to a request, explaining credential plugin failures. */
export async function authorize(kc: KubeConfig, request: https.RequestOptions): Promise<void> {
  try {
    await kc.applyToHTTPSOptions(request)
  } catch (error) {
    const { message } = error as Error
    const plugin = /spawn (\S+) ENOENT/.exec(message)?.[1]
    throw new KubeRequestError(
      'auth',
      plugin
        ? `The credential plugin “${plugin}” wasn’t found. Install it, or make sure it’s on your PATH.`
        : `Could not get credentials: ${message}`,
    )
  }
}

export interface RequestOptions {
  timeoutMs: number
  /** GET unless set. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Sent as JSON. */
  body?: unknown
  /** The body's media type; JSON unless set (patches have their own). */
  contentType?: string
  /** What to ask for instead of JSON, e.g. discovery documents or tables. */
  accept?: string
}

/**
 * Sends a request to the cluster behind `kc`'s current context and resolves
 * with the response body. Non-2xx responses reject with a
 * `KubeRequestError`; transport failures reject with the underlying error.
 */
export async function kubeRequest(
  kc: KubeConfig,
  path: string,
  options: RequestOptions,
): Promise<string> {
  const url = serverUrl(kc, path)
  const payload =
    options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), 'utf8')
  const request: https.RequestOptions = {
    method: options.method ?? 'GET',
    // Like kubectl: JSON for API objects, anything for subresources such as pod logs.
    headers: {
      Accept: options.accept ?? 'application/json, */*',
      'Accept-Encoding': 'gzip',
      ...(payload
        ? {
            'Content-Type': options.contentType ?? 'application/json',
            'Content-Length': payload.length,
          }
        : {}),
    },
  }
  await authorize(kc, request)

  // For plain HTTP endpoints (e.g. `kubectl proxy`) the client hands us an http.Agent.
  const transport = url.protocol === 'http:' ? http : https

  return new Promise((resolve, reject) => {
    const req = transport.request(url, request, (res) => {
      const body = res.headers['content-encoding'] === 'gzip' ? res.pipe(createGunzip()) : res
      const chunks: Buffer[] = []
      body.on('data', (chunk: Buffer) => chunks.push(chunk))
      body.on('error', reject)
      body.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const status = res.statusCode!
        if (status >= 200 && status < 300) resolve(text)
        else reject(statusError(status, text))
      })
    })
    req.setTimeout(options.timeoutMs, () => {
      req.destroy(
        new KubeRequestError(
          'timeout',
          `The API server didn’t respond within ${options.timeoutMs / 1000}s`,
        ),
      )
    })
    req.on('error', reject)
    req.end(payload)
  })
}

/** A response being streamed, and a way to stop it. */
export interface KubeStream {
  body: NodeJS.ReadableStream
  abort(): void
}

/**
 * GETs a path whose response keeps coming (followed pod logs, a watched list): resolves once
 * the API server accepts the request, with its body as it arrives. Only the wait for that answer
 * can time out; a stream may then be quiet for hours.
 */
export async function kubeStream(
  kc: KubeConfig,
  path: string,
  options: { timeoutMs: number; accept?: string },
): Promise<KubeStream> {
  const url = serverUrl(kc, path)
  const request: https.RequestOptions = {
    method: 'GET',
    headers: { Accept: options.accept ?? '*/*' },
  }
  await authorize(kc, request)
  const transport = url.protocol === 'http:' ? http : https
  return new Promise((resolve, reject) => {
    const req = transport.request(url, request, (res) => {
      req.setTimeout(0)
      const status = res.statusCode!
      if (status >= 200 && status < 300) {
        resolve({ body: res, abort: () => req.destroy() })
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => reject(statusError(status, Buffer.concat(chunks).toString('utf8'))))
    })
    req.setTimeout(options.timeoutMs, () => {
      req.destroy(
        new KubeRequestError(
          'timeout',
          `The API server didn’t respond within ${options.timeoutMs / 1000}s`,
        ),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

/** What a server behind the API server's service proxy answered, within Lumovi's limits. */
export type ProxyAnswer =
  | {
      status: number
      /** Its media type as it said it, lowercased, without its parameters. */
      type: string
      body: string
    }
  /** It answered more than Lumovi takes: nothing of it is kept. */
  | { tooBig: true }

/**
 * GETs a path of a server in the cluster through the API server's service proxy, for a plugin's
 * tool: only JSON asked for and nothing else of Lumovi's sent but its credentials for the API
 * server, no redirect followed, and all of the answer within `timeoutMs` (past it, a
 * `KubeRequestError` 'timeout') and `maxBytes`, unpacked.
 */
export async function kubeProxyGet(
  kc: KubeConfig,
  path: string,
  options: { timeoutMs: number; maxBytes: number },
): Promise<ProxyAnswer> {
  const url = serverUrl(kc, path)
  const request: https.RequestOptions = { method: 'GET', headers: { Accept: 'application/json' } }
  await authorize(kc, request)
  const transport = url.protocol === 'http:' ? http : https
  return new Promise((resolve, reject) => {
    const req = transport.request(url, request, (res) => {
      const packed = res.headers['content-encoding']
      const body = packed === 'gzip' ? res.pipe(createGunzip()) : res
      const chunks: Buffer[] = []
      let bytes = 0
      body.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > options.maxBytes) {
          clearTimeout(timer)
          req.destroy()
          resolve({ tooBig: true })
          return
        }
        chunks.push(chunk)
      })
      body.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      body.on('end', () => {
        clearTimeout(timer)
        resolve({
          status: res.statusCode!,
          type: (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase(),
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    // (All of it within the time: a server that trickles its answer is as late as a silent one.)
    const timer = setTimeout(() => {
      req.destroy(
        new KubeRequestError('timeout', `It didn’t answer within ${options.timeoutMs / 1000}s`),
      )
    }, options.timeoutMs)
    req.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    req.end()
  })
}

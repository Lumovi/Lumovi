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
  // Keep any path prefix on the server URL (e.g. Rancher's /k8s/clusters/<id>).
  const url = new URL(cluster.server.replace(/\/+$/, '') + path)
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
        ? `The credential plugin “${plugin}” was not found. Install it, or make sure it is on your PATH.`
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
          `The API server did not respond within ${options.timeoutMs / 1000}s`,
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
 * GETs a path whose response keeps coming (followed pod logs): resolves once
 * the API server accepts the request, with its body as it arrives. Only the
 * wait for that answer can time out; a stream may then be quiet for hours.
 */
export async function kubeStream(
  kc: KubeConfig,
  path: string,
  options: { timeoutMs: number },
): Promise<KubeStream> {
  const url = serverUrl(kc, path)
  const request: https.RequestOptions = { method: 'GET', headers: { Accept: '*/*' } }
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
          `The API server did not respond within ${options.timeoutMs / 1000}s`,
        ),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

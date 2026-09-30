import http from 'node:http'
import https from 'node:https'
import { createGunzip } from 'node:zlib'
import type { KubeConfig } from '@kubernetes/client-node'
import { KubeRequestError, statusError } from './errors'

export interface RequestOptions {
  timeoutMs: number
}

/**
 * Performs a GET against the cluster behind `kc`'s current context and
 * resolves with the response body. Non-2xx responses reject with a
 * `KubeRequestError`; transport failures reject with the underlying error.
 */
export async function kubeGet(
  kc: KubeConfig,
  path: string,
  options: RequestOptions,
): Promise<string> {
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
  const request: https.RequestOptions = {
    method: 'GET',
    // Like kubectl: JSON for API objects, anything for subresources such as pod logs.
    headers: { Accept: 'application/json, */*', 'Accept-Encoding': 'gzip' },
  }
  try {
    await kc.applyToHTTPSOptions(request)
  } catch (error) {
    throw new KubeRequestError('auth', `Could not get credentials: ${(error as Error).message}`)
  }

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
    req.end()
  })
}

/**
 * The KubeStacks server: the page and its files, signing in and out, and a
 * WebSocket for each page, all below the configured base path.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { PATHS, SESSION_ENDED, THEME_COOKIE } from '@shared/server'
import { Auth } from './auth'
import type { HostedCluster } from './cluster'
import type { ServerConfig } from './config'
import { PageConnection } from './connection'
import { cookies, redirect, sameOrigin, SECURITY_HEADERS, sendJson } from './http'
import { OidcClient } from './oidc'
import { acceptedEncoding, CONTENT_SECURITY_POLICY, Pages } from './pages'
import { Sessions } from './sessions'

export interface RunningServer {
  /** Where it listens, e.g. http://127.0.0.1:8080/. */
  url: string
  /** Closes every page's connection (they reconnect to the next server), then stops. */
  close(): Promise<void>
}

export interface ServerOptions {
  config: ServerConfig
  cluster: HostedCluster
  env: NodeJS.ProcessEnv
  version: string
}

/** Large enough for Helm values and YAML edits, small enough not to be a way to fill memory. */
const MAX_MESSAGE = 8 * 1024 * 1024

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { config, cluster } = options
  const base = config.basePath
  const pages = new Pages(config.rendererDir, base)
  /** Each page's socket, with its session, so its pages can be told when it ends. */
  const sockets = new Map<WebSocket, { session?: string; alive: boolean }>()
  const sessions = new Sessions(config.sessionHours, (ended, how) => {
    for (const [socket, { session }] of sockets) {
      if (session === ended) socket.close(SESSION_ENDED, how)
    }
  })
  const oidc =
    config.auth.mode === 'oidc'
      ? new OidcClient(config.auth, new URL(`${base}${PATHS.callback}`, config.publicUrl).href)
      : undefined
  const auth = new Auth(config, cluster, sessions, oidc)

  /**
   * A request's address (null when it isn't one), and its path below the base
   * path (undefined when the request isn't for the server).
   */
  const address = (req: IncomingMessage) => {
    const url = URL.parse(req.url!, 'http://kubestacks')
    const path = url?.pathname.startsWith(base) ? url.pathname.slice(base.length) : undefined
    return { url, path }
  }

  async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { url, path } = address(req)
    if (path === undefined) {
      // The base path without its trailing slash, as people type it.
      if (`${url?.pathname}/` === base) redirect(res, base)
      else sendJson(res, 404, { error: `KubeStacks is at ${base}` })
      return
    }
    const route = `${req.method} ${path}`
    if (route === `GET ${PATHS.health}`) {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok')
    } else if (route === `GET ${PATHS.session}`) {
      auth.describe(req, res)
    } else if (route === `POST ${PATHS.session}` && config.auth.mode === 'token') {
      await auth.signInWithToken(req, res)
    } else if (route === `DELETE ${PATHS.session}`) {
      auth.signOut(req, res)
    } else if (route === `GET ${PATHS.signIn}` && oidc) {
      await auth.startSignIn(req, res, url!)
    } else if (route === `GET ${PATHS.callback}` && oidc) {
      await auth.finishSignIn(req, res, url!)
    } else if (path.startsWith('api/') || path.startsWith('auth/')) {
      sendJson(res, 404, { error: `There’s no ${route}` })
    } else if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Only GET' }, { Allow: 'GET, HEAD' })
    } else if (pages.isFile(path)) {
      await file(req, res, path)
    } else {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
        'Cache-Control': 'no-store',
      })
      res.end(req.method === 'HEAD' ? undefined : pages.page(cookies(req)[THEME_COOKIE]))
    }
  }

  async function file(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const found = pages.file(path)
    if (!found) {
      sendJson(res, 404, { error: `There’s no ${path}` })
      return
    }
    const encoding = found.compressible
      ? acceptedEncoding(req.headers['accept-encoding'])
      : undefined
    const body = await found.body(encoding)
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': found.type,
      'Content-Length': body.length,
      'Cache-Control': found.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      Vary: 'Accept-Encoding',
      ...(encoding ? { 'Content-Encoding': encoding } : {}),
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  const server = http.createServer((req, res) => {
    // Answering only fails when the connection did; there's nobody to tell.
    answer(req, res).catch(res.destroy.bind(res))
  })

  const pageSockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE,
    // Lists of thousands of objects compress well.
    perMessageDeflate: { threshold: 4096, zlibDeflateOptions: { level: 3 } },
  })
  server.on('upgrade', (req, socket, head) => {
    const caller =
      address(req).path === PATHS.socket && sameOrigin(req, config.publicUrl)
        ? auth.identify(req)
        : undefined
    if (!caller || !('identity' in caller)) {
      // The page then asks for its session to learn why.
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    pageSockets.handleUpgrade(req, socket, head, (ws) => {
      sockets.set(ws, { session: caller.session, alive: true })
      // Its protocol errors (a message that's too large, say) close it, and nothing else.
      ws.on('error', () => ws.terminate())
      ws.on('pong', () => (sockets.get(ws)!.alive = true))
      ws.on('close', () => sockets.delete(ws))
      new PageConnection(ws, {
        ...options,
        identity: caller.identity,
        rejected: () => sessions.end(caller.session!, 'expired'),
      })
    })
  })

  // Pings keep proxies from closing quiet connections, and find ones that went away.
  const heartbeat = setInterval(() => {
    for (const [socket, state] of sockets) {
      if (!state.alive) {
        socket.terminate()
        continue
      }
      state.alive = false
      socket.ping()
    }
  }, config.heartbeatSeconds * 1000)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.address, resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://${config.address ?? 'localhost'}:${port}${base}`,
    async close() {
      clearInterval(heartbeat)
      // Pages reconnect, to whichever server is next.
      const closed = [...sockets.keys()].map(
        (socket) =>
          new Promise((resolve) => {
            socket.once('close', resolve)
            socket.close(1001, 'The server is restarting')
          }),
      )
      server.close()
      server.closeAllConnections()
      await Promise.race([
        Promise.all(closed),
        new Promise((resolve) => setTimeout(resolve, 2000).unref()),
      ])
    },
  }
}

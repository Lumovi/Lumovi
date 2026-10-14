/**
 * The proxy the screenshots' clusters are reached through (their kubeconfig's proxy-url), so
 * they can go by the names a real cluster would (api.prod.eu-west-1.example.com) and still be
 * the mock clusters on this computer: nothing looks those names up, and nothing system-wide is
 * changed. Lumovi takes a cluster's proxy-url, and so does kubectl in its terminal.
 *
 * It listens on 127.0.0.1 only, tunnels each of those names' port 443 to its cluster's port
 * there, and refuses anything else. Where a name's cluster doesn't answer (the one that's
 * offline), the connection just closes, as it would to a cluster that doesn't answer.
 */
import http from 'node:http'
import net, { type AddressInfo, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

export interface NamesProxy {
  /** Its address, for a kubeconfig's proxy-url. */
  url: string
  close(): Promise<void>
}

/** Starts the proxy: `to` is each name's port on 127.0.0.1. */
export async function startNamesProxy(to: Readonly<Record<string, number>>): Promise<NamesProxy> {
  const open = new Set<Duplex>()
  const kept = (socket: Duplex) => {
    open.add(socket)
    socket.once('close', () => open.delete(socket))
    // (A tunnel that breaks is closed, at both ends; nothing's said.)
    socket.on('error', () => socket.destroy())
  }
  // Only tunnels: anything asked of it as a web server is refused.
  const server = http.createServer((_request, response) => response.writeHead(405).end())
  server.on('connect', (request: http.IncomingMessage, client: Duplex, head: Buffer) => {
    kept(client)
    const [, name, port] = /^([a-z0-9.-]+):(\d+)$/.exec(request.url ?? '') ?? []
    const target = name && port === '443' && Object.hasOwn(to, name) ? to[name] : undefined
    if (target === undefined) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const cluster: Socket = net.connect(target, '127.0.0.1')
    kept(cluster)
    // Either end gone without ending (reset, refused), the other goes with it at once; one that
    // ended has ended the other through the pipe, with all it had sent.
    cluster.once('close', () => {
      if (!cluster.readableEnded) client.destroy()
    })
    client.once('close', () => {
      if (!client.readableEnded) cluster.destroy()
    })
    cluster.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) cluster.write(head)
      cluster.pipe(client)
      client.pipe(cluster)
    })
  })
  await new Promise<void>((started, failed) => {
    server.once('error', failed)
    server.listen(0, '127.0.0.1', started)
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((closed) => {
        for (const socket of open) socket.destroy()
        // (And what was asked of it as a web server, kept alive after its 405.)
        server.closeAllConnections()
        server.close(() => closed())
      }),
  }
}

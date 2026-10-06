/**
 * A forward proxy, as a company's is: requests for http by their whole URL, and tunnels
 * (CONNECT) for anything else. Every name it's asked for is this computer (the mocks run
 * here), so tests reach them by names no DNS knows (hooks.test), as only through a proxy. It
 * records what went through it, and can ask for credentials.
 */
import { createServer, request, type IncomingMessage } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'

export interface MockProxy {
  /** http://127.0.0.1:12345 */
  url: string
  /** What went through it, oldest first: "CONNECT hooks.test:8080", "GET http://charts.test/…". */
  seen: string[]
  close(): Promise<void>
}

export async function startMockProxy(
  options: {
    /** Asked for, as user:password (anything else is refused with 407). */
    credentials?: string
  } = {},
): Promise<MockProxy> {
  const seen: string[] = []
  const sockets = new Set<Socket>()
  const allowed = (req: IncomingMessage) =>
    !options.credentials ||
    req.headers['proxy-authorization'] ===
      `Basic ${Buffer.from(options.credentials).toString('base64')}`
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    if (!allowed(req)) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="mock"' }).end()
      return
    }
    // A request by its whole URL: sent on, to this computer.
    const target = new URL(req.url!)
    const headers = { ...req.headers }
    delete headers['proxy-authorization']
    const forwarded = request(
      {
        host: '127.0.0.1',
        port: target.port || 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode!, answer.headers)
        answer.pipe(res)
      },
    )
    forwarded.on('error', () => res.writeHead(502).end())
    req.pipe(forwarded)
  })
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    seen.push(`CONNECT ${req.url}`)
    if (!allowed(req)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n')
      return
    }
    const [, port] = /:(\d+)$/.exec(req.url!)!
    const upstream = connect(Number(port), '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(client).pipe(upstream)
    })
    for (const socket of [client, upstream]) {
      sockets.add(socket)
      socket.on('error', () => {
        client.destroy()
        upstream.destroy()
      })
      socket.on('close', () => sockets.delete(socket))
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise((done) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => done())
        server.closeAllConnections()
      }),
  }
}

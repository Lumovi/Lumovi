/**
 * A proxy in front of a Lumovi server that keeps what arrives: for the tests that ask what a
 * server itself was asked, which no stand-in at another address can say.
 */
import http from 'node:http'
import net from 'node:net'

export interface Arrived {
  how: string
  cookie: boolean
  site: string | undefined
  origin: string | undefined
  status?: number
}

/**
 * A plain proxy in front of a Lumovi server, at the address the server is told is its own: it
 * keeps what each request carried and how the server answered it, sockets among them, and
 * changes nothing.
 */
export async function recording(port: number, server: URL) {
  const arrived: Arrived[] = []
  /** Sockets handed on: a server's close doesn't end them. */
  const open = new Set<net.Socket>()
  const noted = (request: http.IncomingMessage): Arrived => {
    const entry: Arrived = {
      how: `${request.method} ${request.url}`,
      cookie: request.headers.cookie !== undefined,
      site: request.headers['sec-fetch-site'] as string | undefined,
      origin: request.headers.origin,
    }
    arrived.push(entry)
    return entry
  }
  const proxy = http.createServer((request, answer) => {
    const entry = noted(request)
    const onward = http.request(
      {
        host: server.hostname,
        port: server.port,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (answered) => {
        entry.status = answered.statusCode
        answer.writeHead(answered.statusCode!, answered.headers)
        answered.pipe(answer)
      },
    )
    onward.on('error', () => answer.destroy())
    request.pipe(onward)
  })
  proxy.on('upgrade', (request, socket, head) => {
    const entry = noted(request)
    const onward = net.connect(Number(server.port), server.hostname, () => {
      for (const each of [socket as net.Socket, onward]) {
        open.add(each)
        each.on('close', () => open.delete(each))
      }
      const headers = Object.entries(request.headers)
        .map(([name, value]) => `${name}: ${String(value)}\r\n`)
        .join('')
      onward.write(`${request.method} ${request.url} HTTP/1.1\r\n${headers}\r\n`)
      onward.write(head)
      onward.once('data', (first: Buffer) => {
        entry.status = Number(/^HTTP\/1\.1 (\d+)/.exec(first.toString())?.[1])
      })
      onward.pipe(socket)
      socket.pipe(onward)
    })
    onward.on('error', () => socket.destroy())
    socket.on('error', () => onward.destroy())
  })
  await new Promise<void>((listening) => proxy.listen(port, '127.0.0.1', listening))
  return {
    url: `http://127.0.0.1:${port}/`,
    arrived,
    close: () =>
      new Promise<void>((closed) => {
        for (const each of open) each.destroy()
        proxy.closeAllConnections()
        proxy.close(() => closed())
      }),
  }
}

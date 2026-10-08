/**
 * A stand-in for Lumovi/main-sponsor as GitHub serves it (LUMOVI_SPONSOR_URL): sponsor.json
 * and the pictures next to it, with ETags as GitHub's. What it's asked is kept, with the
 * requests' headers, and it can be made to fail as GitHub can.
 *
 * Its pictures (fixtures/): Acme's from the design repo, and made for the tests from three
 * striped 408 × 136 frames: still WebPs (cwebp, lossy and lossless); animated WebPs (img2webp:
 * -loop 1 -d 500, the same with -loop 0, and one of 6 s); a GIF that plays once and the same set
 * to loop (NETSCAPE2.0); an animated PNG (acTL); a PNG of the wrong size; and Acme's light one
 * with a bit depth PNG doesn't have (7), which only drawing it finds.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { join } from 'node:path'

const FIXTURES = join(import.meta.dirname, 'fixtures')

/** A picture the tests serve, by its name in fixtures/. */
export const picture = (name: string): Buffer => readFileSync(join(FIXTURES, name))

/** Acme, a placeholder sponsor (acme.example is a domain for examples), as sponsor.json says it. */
export const ACME = {
  name: 'Acme',
  description: 'Rockets, anvils and other gear.',
  link: 'https://acme.example/',
  alt: 'Acme',
  image: { light: 'acme-light.png', dark: 'acme-dark.png' },
}

/** sponsor.json, as its text. */
export const sponsorJson = (file: object): string => JSON.stringify({ version: 1, ...file })

export interface MockSponsor {
  /** Where the files are, e.g. http://127.0.0.1:12345/ */
  url: string
  /** The files it serves, by name: sponsor.json and the pictures. */
  files: Map<string, string | Buffer>
  /** What it was asked, oldest first. */
  requests: { path: string; headers: IncomingHttpHeaders }[]
  /** How it fails: answering with an error (500), or not at all (the connection dropped). */
  fail?: 'error' | 'drop'
  /** Serves Acme's card, in light and dark. */
  serveAcme(extra?: Partial<typeof ACME> & { until?: string }): void
  close(): Promise<void>
}

export async function startMockSponsor(): Promise<MockSponsor> {
  const sockets = new Set<Socket>()
  const mock: MockSponsor = {
    url: '',
    files: new Map(),
    requests: [],
    serveAcme(extra = {}) {
      this.files.set('acme-light.png', picture('example-light.png'))
      this.files.set('acme-dark.png', picture('example-dark.png'))
      this.files.set(
        'sponsor.json',
        sponsorJson({ mode: 'sponsor', sponsor: { ...ACME, ...extra } }),
      )
    },
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done())
        for (const socket of sockets) socket.destroy()
      }),
  }
  const server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname
    mock.requests.push({ path, headers: req.headers })
    if (mock.fail === 'drop') {
      req.socket.destroy()
      return
    }
    if (mock.fail === 'error') {
      res.writeHead(500).end()
      return
    }
    const file = mock.files.get(path.slice(1))
    if (file === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('404: Not Found')
      return
    }
    const etag = `"${createHash('sha256').update(file).digest('hex')}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag }).end()
      return
    }
    // Whatever it says the type is, Lumovi goes by what the file is.
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', etag }).end(file)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  return mock
}

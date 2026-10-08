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

/** A RIFF file's chunks (a WebP's), as fourcc and data, and put together again. */
const riff = {
  chunks(file: Buffer): [string, Buffer][] {
    const chunks: [string, Buffer][] = []
    for (let at = 12; at < file.length;) {
      const size = file.readUInt32LE(at + 4)
      chunks.push([file.toString('latin1', at, at + 4), file.subarray(at + 8, at + 8 + size)])
      at += 8 + size + (size % 2)
    }
    return chunks
  },
  join(chunks: [string, Buffer][]): Buffer {
    const body = Buffer.concat(
      chunks.map(([type, data]) => {
        const head = Buffer.alloc(8)
        head.write(type, 'latin1')
        head.writeUInt32LE(data.length, 4)
        return Buffer.concat([head, data, Buffer.alloc(data.length % 2)])
      }),
    )
    const head = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1')
    head.writeUInt32LE(body.length + 4, 4)
    return Buffer.concat([head, body])
  },
}

/** animated.gif's first frame's descriptor (after its header, palette and timing). */
const FIRST_FRAME = 6 + 7 + 4 * 3 + 8

/**
 * Pictures whose structure is wrong where only reading it all finds it: each must be refused,
 * not read past its end or taken for what it says.
 */
export const CRAFTED: Record<string, () => Buffer> = {
  'a PNG cut short': () => picture('example-light.png').subarray(0, 200),
  'a PNG chunk longer than the file': () => {
    const png = Buffer.from(picture('example-light.png'))
    // The first chunk after the header (IHDR's 25 bytes).
    png.writeUInt32BE(0x7fffffff, 8 + 25)
    return png
  },
  'a WebP whose size isn’t its length': () => {
    const webp = Buffer.from(picture('still-lossless.webp'))
    webp.writeUInt32LE(webp.readUInt32LE(4) + 2, 4)
    return webp
  },
  'a GIF without its trailer': () => picture('animated.gif').subarray(0, -1),
  'a GIF frame larger than the picture': () => {
    const gif = Buffer.from(picture('animated.gif'))
    if (gif[FIRST_FRAME] !== 0x2c) throw new Error('animated.gif changed')
    gif.writeUInt16LE(60_000, FIRST_FRAME + 5)
    return gif
  },
  'a GIF frame with nothing in it': () => {
    const gif = Buffer.from(picture('animated.gif'))
    gif.writeUInt16LE(0, FIRST_FRAME + 5)
    return gif
  },
  'a WebP frame too short to be one': () =>
    riff.join(
      riff
        .chunks(picture('animated.webp'))
        .map(([type, data], i, all) =>
          type === 'ANMF' && all.findIndex(([t]) => t === 'ANMF') === i
            ? [type, Buffer.alloc(8)]
            : [type, data],
        ),
    ),
}

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

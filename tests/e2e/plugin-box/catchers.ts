/**
 * What catches anything that leaves a plugin's box in a test: a stand-in for any other host
 * (requests, and connections that send nothing), one for an API of Lumovi's own, and a UDP
 * port. What they saw is the truth of a try; what the code in the box thinks happened isn't.
 * All on this computer: nothing is looked up.
 */
import { createSocket, type Socket } from 'node:dgram'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { servedBy } from '../../temp-folders.ts'

export interface Caught {
  /**
   * Requests that arrived, by which stand-in and for what; with where the page that asked was
   * (Origin, or Referer), and its browser, as it said them.
   */
  http: { server: 'other' | 'same'; method: string; path: string; from?: string; agent?: string }[]
  /** Connections made to the other host, whatever was sent on them. */
  connections: number
  /** UDP packets. */
  packets: number
}

/**
 * The other host under a name that's one try's own, for a run whose browser keeps its own log of
 * its network (net-log.ts): a look-up of that name is then that try's, and in the log. A
 * browser resolves every name under `localhost` to this computer by itself, so no name server is
 * asked either way.
 */
export const nameFor = (id: string) => `${id.toLowerCase()}.tried.localhost`

export interface Catchers {
  /**
   * What a try is told of where things are (`ways-out.js`'s context, for the try `id`); `named`,
   * the other host goes by the try's own name (`nameFor`), not `localhost`.
   */
  context(id: string, role?: 'first' | 'second', named?: boolean): Record<string, unknown>
  /** What was caught since the last reset. */
  caught(): Caught
  reset(): void
  close(): Promise<void>
}

/**
 * Where the catchers listen: below every system's own ports, the ones a server asking for any
 * port is given (Linux's 32768–60999, macOS's and Windows' 49152–65535), as every Lumovi a test
 * serves is; and clear of every port Lumovi and its tests fix. So a page another test left
 * behind, still asking its own Lumovi, can never reach a catcher that took that Lumovi's port
 * after it (LMV-413). Another run's catchers may hold one, or Windows may keep it for itself
 * (Hyper-V's and Docker's excluded ranges, refused as EACCES): then another is tried, and after
 * `TRIES`, the run stops, saying so. Never a port of the system's choosing.
 */
export const CATCHER_PORTS = { from: 20_000, to: 31_999 } as const
const TRIES = 20

/** A port of CATCHER_PORTS that `listen` could have, or a failure saying none was free. */
export async function lowPort(listen: (port: number) => Promise<void>): Promise<number> {
  const { from, to } = CATCHER_PORTS
  for (let tried = 0; tried < TRIES; tried++) {
    const port = from + Math.floor(Math.random() * (to - from + 1))
    try {
      await listen(port)
      return port
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error
    }
  }
  throw new Error(`No port of ${from}–${to} was free for a catcher in ${TRIES} tries.`)
}

/** `server` listening on 127.0.0.1 at `port`, or why it can't. */
const listening = (server: Server, port: number) =>
  new Promise<void>((done, failed) => {
    server.once('error', failed)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', failed)
      done()
    })
  })

export async function startCatchers(): Promise<Catchers> {
  let caught: Caught = { http: [], connections: 0, packets: 0 }
  const seen = (server: 'other' | 'same', req: IncomingMessage, method = req.method ?? '') =>
    caught.http.push({
      server,
      method,
      path: req.url ?? '',
      from: req.headers.origin ?? req.headers.referer,
      agent: req.headers['user-agent'],
    })
  const stand = (server: 'other' | 'same'): Server => {
    const made = createServer((req, res) => {
      seen(server, req)
      const script = (req.url ?? '').includes('.js')
      res.writeHead(200, {
        'content-type': script ? 'text/javascript' : 'text/html',
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
      })
      res.end(script ? '/* caught */' : '<!doctype html><title>caught</title>')
    })
    made.on('upgrade', (req, socket) => {
      seen(server, req, 'UPGRADE')
      socket.destroy()
    })
    return made
  }
  const other = stand('other')
  other.on('connection', () => caught.connections++)
  const same = stand('same')
  const otherPort = await lowPort((port) => listening(other, port))
  const sameUrl = `http://127.0.0.1:${await lowPort((port) => listening(same, port))}`
  // (A UDP socket whose bind failed is done with: each try is a socket of its own.)
  let udp!: Socket
  await lowPort(
    (port) =>
      new Promise<void>((done, failed) => {
        udp = createSocket('udp4')
        udp.once('error', (error) => {
          udp.close()
          failed(error)
        })
        udp.bind(port, '127.0.0.1', () => {
          udp.removeAllListeners('error')
          done()
        })
      }),
  )
  udp.on('message', () => caught.packets++)
  return {
    context: (id, role, named = false) => {
      const otherName = named ? nameFor(id) : 'localhost'
      const otherUrl = `http://${otherName}:${otherPort}`
      return {
        id,
        role,
        same: sameUrl,
        other: otherUrl,
        otherName,
        otherPort,
        // (An address, named or not: a packet is what its catcher sees.)
        udpName: '127.0.0.1',
        udpPort: udp.address().port,
        leak: `${otherUrl}/catch/${id}?d=SECRET`,
        api: `${sameUrl}/api/session/${id}?d=SECRET`,
      }
    },
    caught: () => caught,
    reset: () => {
      caught = { http: [], connections: 0, packets: 0 }
    },
    close: async () => {
      other.closeAllConnections()
      same.closeAllConnections()
      await Promise.all([
        new Promise((done) => other.close(done)),
        new Promise((done) => same.close(done)),
        new Promise<void>((done) => udp.close(done)),
      ])
    },
  }
}

/** What of a try got out, in words; empty when nothing did. */
export function gotOut(id: string, caught: Caught): string {
  const mine = caught.http.filter((hit) => hit.path.includes(id))
  const parts: string[] = []
  const out = mine.filter((hit) => hit.server === 'other')
  if (out.length)
    parts.push(`a request to another host (${out.map((hit) => hit.method).join(', ')})`)
  const api = mine.filter((hit) => hit.server === 'same')
  if (api.length)
    parts.push(`a request to Lumovi’s own API (${api.map((hit) => hit.method).join(', ')})`)
  if (!out.length && caught.connections > 0) parts.push('a connection to another host')
  if (caught.packets > 0) parts.push('a UDP packet')
  return parts.join('; ')
}

/**
 * Where a request came from, as its page said, and whose that page was where the run can tell
 * (the test that served Lumovi at its port): what explains a request no try answers for, and
 * never excuses one.
 */
export function whose({ from, agent }: { from?: string; agent?: string }): string {
  if (from === undefined && agent === undefined) return ''
  let port: number | undefined
  try {
    port = from === undefined ? undefined : Number(new URL(from).port) || undefined
  } catch {
    port = undefined
  }
  const by = port === undefined ? undefined : servedBy(port)
  const parts = [
    from === undefined ? undefined : `from ${from}`,
    by === undefined ? undefined : `a page of the Lumovi “${by}” served`,
    agent === undefined ? undefined : agent.slice(0, 80),
  ].filter((part) => part !== undefined)
  return ` (${parts.join('; ')})`
}

/**
 * A run of tries, with nothing of what's caught lost between them. Each try's catch is read a
 * moment after it and cleared before the next: so whatever comes after a reading, and a request
 * that comes with a try and doesn't name it (another's come late, or nobody's), would be no
 * try's to answer for. Kept here instead, in words, each with the try it came with or after;
 * and after the last try there's a wait and one more look.
 */
export function keeping(catchers: Catchers) {
  const unowned: string[] = []
  // (Each of them with where its page was, and whose: for whoever reads a failure, never for
  // what a test excuses, which reads `unowned` alone. A page's address can hold a try's name.)
  const explained: string[] = []
  const keep = (what: string, hit?: Caught['http'][number]) => {
    unowned.push(what)
    explained.push(hit ? `${what}${whose(hit)}` : what)
  }
  let last: { id: string; read: Caught } | undefined
  const said = (hit: Caught['http'][number]) => `${hit.method} ${hit.server} ${hit.path}`
  /** What came since the last try was read. */
  const since = () => {
    if (!last) return
    const { id, read } = last
    const now = catchers.caught()
    for (const hit of now.http.slice(read.http.length)) keep(`after ${id}: ${said(hit)}`, hit)
    if (now.connections > read.connections) keep(`after ${id}: a connection`)
    if (now.packets > read.packets) keep(`after ${id}: a UDP packet`)
    last = undefined
  }
  return {
    /** Before a try: what came since the last was read is kept, and the catchers cleared. */
    next(): void {
      since()
      catchers.reset()
    },
    /** A try's catch, read: what of it got out (`gotOut`); a request that doesn't name it is kept. */
    read(id: string): string {
      const now = catchers.caught()
      const read = { http: [...now.http], connections: now.connections, packets: now.packets }
      for (const hit of read.http) {
        if (!hit.path.includes(id)) keep(`with ${id}: ${said(hit)}`, hit)
      }
      last = { id, read }
      return gotOut(id, read)
    },
    /**
     * After the last try: a wait, one more look, and everything no try answered for. (A wait
     * of a fixed length sees what comes within it and no later, as the moment after each try
     * does. Chromium's own log of its network, read once it has closed, has no such end.)
     */
    async end(waitMs = 1_000): Promise<string[]> {
      await new Promise((done) => setTimeout(done, waitMs))
      since()
      return unowned
    },
    /** The same, each with where its page was and whose (`whose`): to read, never to match. */
    explained(): string[] {
      return [...explained]
    },
  }
}

/**
 * What catches anything that leaves a plugin's box in a test: a stand-in for any other host
 * (requests, and connections that send nothing), one for an API of Lumovi's own, and a UDP
 * port. What they saw is the truth of a try; what the code in the box thinks happened isn't.
 * All on this computer: nothing is looked up.
 */
import { createSocket } from 'node:dgram'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Caught {
  /** Requests that arrived, by which stand-in and for what. */
  http: { server: 'other' | 'same'; method: string; path: string }[]
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

export async function startCatchers(): Promise<Catchers> {
  let caught: Caught = { http: [], connections: 0, packets: 0 }
  const seen = (server: 'other' | 'same', req: IncomingMessage, method = req.method ?? '') =>
    caught.http.push({ server, method, path: req.url ?? '' })
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
  const udp = createSocket('udp4')
  udp.on('message', () => caught.packets++)
  await Promise.all([
    new Promise<void>((done) => other.listen(0, '127.0.0.1', done)),
    new Promise<void>((done) => same.listen(0, '127.0.0.1', done)),
    new Promise<void>((done) => udp.bind(0, '127.0.0.1', done)),
  ])
  const otherPort = (other.address() as AddressInfo).port
  const sameUrl = `http://127.0.0.1:${(same.address() as AddressInfo).port}`
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

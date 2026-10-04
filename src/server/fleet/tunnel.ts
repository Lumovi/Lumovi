/**
 * Many TCP streams over one WebSocket: how a hub reaches a cluster through
 * its agent. The hub opens a stream for each connection it would make to the
 * cluster's API server; the agent connects it there and relays bytes both
 * ways. TLS runs inside, from the hub to the API server: the agent only ever
 * sees what it can't read.
 *
 * Each binary frame is [kind: 1 byte][stream: 4 bytes][payload]. Text frames
 * are the agent's and hub's own messages (JSON).
 */
import { Duplex } from 'node:stream'
import type { WebSocket } from 'ws'

const OPEN = 1
const DATA = 2
const END = 3
const RESET = 4
const HEADER = 5

/** One frame. */
function frame(kind: number, id: number, payload?: Buffer): Buffer {
  const header = Buffer.alloc(HEADER)
  header.writeUInt8(kind, 0)
  header.writeUInt32BE(id, 1)
  return payload ? Buffer.concat([header, payload]) : header
}

/** A callback for what needs one, and nothing done: a send's, or an error's whose close follows. */
export const ignore = (): undefined => undefined

export class Tunnel {
  readonly #streams = new Map<number, Duplex>()
  #next = 1

  /**
   * `accept`, on the agent's side, connects each stream the hub opens;
   * `text` gets the other side's own messages.
   */
  constructor(
    private readonly socket: WebSocket,
    private readonly handlers: {
      accept?: (stream: Duplex) => void
      text: (message: string) => void
    },
  ) {
    socket.on('message', (data: Buffer, binary) => {
      if (binary) this.#receive(data)
      else handlers.text(String(data))
    })
    socket.on('close', () => {
      const streams = [...this.#streams.values()]
      // Gone with the tunnel: nothing to tell the other side.
      this.#streams.clear()
      for (const stream of streams) stream.destroy(new Error('The tunnel closed.'))
    })
  }

  /** The hub's side: a new connection to the cluster's API server. */
  open(): Duplex {
    const id = this.#next++
    const stream = this.#stream(id)
    this.#send(frame(OPEN, id), ignore)
    return stream
  }

  /** Sends one of this side's own messages (ws drops it once the socket closed). */
  say(message: unknown): void {
    this.socket.send(JSON.stringify(message), ignore)
  }

  #stream(id: number): Duplex {
    const stream = new Duplex({
      write: (chunk: Buffer, _encoding, done) => this.#send(frame(DATA, id, chunk), done),
      final: (done) => this.#send(frame(END, id), done),
      read: () => undefined,
      destroy: (error, done) => {
        // Gone from both sides: the other side's reset, or this one's.
        if (this.#streams.delete(id)) this.#send(frame(RESET, id), ignore)
        done(error)
      },
    })
    // A reset or a closed tunnel is its user's to handle (TLS's, a pipe's): with none, it
    // mustn't end the process.
    stream.on('error', ignore)
    this.#streams.set(id, stream)
    return stream
  }

  #receive(data: Buffer): void {
    if (data.length < HEADER) return
    const kind = data.readUInt8(0)
    const id = data.readUInt32BE(1)
    if (kind === OPEN && this.handlers.accept) {
      this.handlers.accept(this.#stream(id))
      return
    }
    const stream = this.#streams.get(id)
    if (!stream) return
    if (kind === DATA) stream.push(data.subarray(HEADER))
    else if (kind === END) stream.push(null)
    else if (kind === RESET) {
      this.#streams.delete(id)
      stream.destroy(new Error('The connection was reset.'))
    }
  }

  /** Sends a frame; `done` once it's on its way, or with why not (ws: the socket closed). */
  #send(data: Buffer, done: (error?: Error | null) => void): void {
    this.socket.send(data, { binary: true }, done)
  }
}

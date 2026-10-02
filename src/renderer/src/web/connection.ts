/**
 * The page's WebSocket to the KubeStacks server: calls and their answers,
 * events, and connecting again when the connection drops (the server
 * restarting, a laptop waking up). Calls made meanwhile wait for it.
 */
import { create } from 'zustand'
import {
  SESSION_ENDED,
  type ClientMessage,
  type ServerMessage,
  type SessionEnd,
} from '@shared/server'

/**
 * `connecting` the first time, `open`, `reconnecting` after it dropped, and
 * `ended` once the session has (signed out, or expired).
 */
export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'ended'

export const useConnection = create<{
  state: ConnectionState
  /** How the session ended, once it has (undefined when the server stopped knowing it). */
  ended?: SessionEnd
  /** Attempts to connect again that failed, since it last was. */
  failures: number
}>(() => ({ state: 'connecting', failures: 0 }))

/** How long to wait before each attempt to connect again, the last one repeating. */
const RETRY_MS = [250, 1000, 2000, 5000]
/** How long a call waits for the connection before it fails. */
const WAIT_MS = 30_000

export const LOST = 'Lost the connection to KubeStacks.'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class Connection {
  #socket?: WebSocket
  #nextId = 1
  /** Calls sent, waiting for their answers. */
  readonly #calls = new Map<number, Pending>()
  /** Calls waiting for the connection, sent once it opens. */
  #queued: (() => void)[] = []
  readonly #listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  constructor(
    private readonly url: string,
    /** The first message on each connection. */
    private readonly greeting: () => ClientMessage,
    /** Whether the session is still on, asked when the server refuses a connection. */
    private readonly signedIn: () => Promise<boolean>,
    /** Called when the connection drops: whatever streamed over it has stopped. */
    private readonly dropped: () => void,
  ) {}

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const send = () => {
        const id = this.#nextId++
        this.#calls.set(id, { resolve, reject })
        this.#write({ type: 'invoke', id, channel, args })
      }
      if (this.#socket?.readyState === WebSocket.OPEN) {
        send()
        return
      }
      this.#queued.push(send)
      this.#connect()
      setTimeout(() => {
        if (!this.#queued.includes(send)) return
        this.#queued = this.#queued.filter((queued) => queued !== send)
        reject(new Error(LOST))
      }, WAIT_MS)
    })
  }

  /** A one-way message; dropped while there's no connection (whatever it was for is gone). */
  send(channel: string, ...args: unknown[]): void {
    this.#writeIfOpen({ type: 'send', channel, args })
  }

  on(channel: string, listener: (...args: unknown[]) => void): () => void {
    const listeners = this.#listeners.get(channel) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(channel, listeners)
    return () => void listeners.delete(listener)
  }

  /** Calls the listeners of `channel` as the server would. */
  emit(channel: string, ...args: unknown[]): void {
    this.#listeners.get(channel)?.forEach((listener) => listener(...args))
  }

  /** Tells the server again what the greeting says (another tab changed the preferences). */
  greet(): void {
    this.#writeIfOpen(this.greeting())
  }

  #connect(): void {
    if (this.#socket || useConnection.getState().state === 'ended') return
    const socket = new WebSocket(this.url)
    this.#socket = socket
    let opened = false
    socket.onopen = () => {
      opened = true
      useConnection.setState({ state: 'open', failures: 0 })
      this.#write(this.greeting())
      const queued = this.#queued
      this.#queued = []
      for (const send of queued) send()
    }
    socket.onmessage = (event) => this.#receive(JSON.parse(event.data as string) as ServerMessage)
    socket.onclose = (event) => void this.#closed(event, opened)
  }

  async #closed({ code, reason }: CloseEvent, opened: boolean): Promise<void> {
    this.#socket = undefined
    for (const call of this.#calls.values()) call.reject(new Error(LOST))
    this.#calls.clear()
    if (opened) this.dropped()
    // Refused at the door: maybe because the session is over.
    if (code === SESSION_ENDED || (!opened && !(await this.signedIn()))) {
      // Without a reason, the server no longer knew the session (it restarted, say).
      useConnection.setState({ state: 'ended', ended: (reason || 'expired') as SessionEnd })
      return
    }
    useConnection.setState((now) => ({
      state: 'reconnecting',
      failures: opened ? 0 : now.failures + 1,
    }))
    const { failures } = useConnection.getState()
    const delay = RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]
    // Calls wait for the connection; so do the pages' listeners.
    setTimeout(() => this.#connect(), delay)
  }

  #receive(message: ServerMessage): void {
    if (message.type === 'event') {
      this.emit(message.channel, ...message.args)
      return
    }
    const call = this.#calls.get(message.id)!
    this.#calls.delete(message.id)
    if (message.error === undefined) call.resolve(message.value)
    else call.reject(new Error(message.error))
  }

  #write(message: ClientMessage): void {
    this.#socket!.send(JSON.stringify(message))
  }

  #writeIfOpen(message: ClientMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#write(message)
  }
}

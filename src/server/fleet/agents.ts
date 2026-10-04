/**
 * The hub's side of agents: clusters in networks the hub can't reach, whose
 * agents connect to it instead (LUMOVI_FLEET_AGENTS says which may). Each
 * connected agent's tunnel leads to its cluster's API server.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import https from 'node:https'
import { createServer } from 'node:net'
import tls from 'node:tls'
import type { WebSocket } from 'ws'
import type { AgentConfig } from '../config'
import { log } from '../log'
import type { FleetCluster } from './clusters'
import { ignore, Tunnel } from './tunnel'

/** What an agent says once connected, and again when its token changes. */
interface AgentHello {
  type: 'hello'
  version: string
  /** Its API server's certificate authority (PEM, base64), to check it end to end. */
  ca: string
  /** Its service account's token: it may only impersonate. */
  token: string
}

/** Where an agent's cluster is, as the hub reaches it: through the tunnel, by this name. */
export const AGENT_SERVER = 'https://kubernetes.default.svc'

/** The WebSocket close code that tells an agent another connected as it. */
export const AGENT_REPLACED = 4409

interface Connected {
  socket: WebSocket
  tunnel: Tunnel
  hello?: AgentHello
}

export class Agents {
  readonly #connected = new Map<string, Connected>()

  constructor(
    private readonly configs: AgentConfig[],
    /** How often agents are pinged: they take silence for a lost connection. */
    private readonly heartbeatSeconds: number,
    /** Called when the clusters they make available change. */
    private readonly changed: () => void,
  ) {}

  /** The agent a name and token belong to, if they do. */
  admit(name: string, token: string): AgentConfig | undefined {
    const digest = createHash('sha256').update(token).digest()
    return this.configs.find(
      (config) =>
        config.name === name && timingSafeEqual(digest, Buffer.from(config.tokenSha256, 'hex')),
    )
  }

  /** An admitted agent's connection: its tunnel, until it closes or another takes over. */
  attach(config: AgentConfig, socket: WebSocket): void {
    const previous = this.#connected.get(config.name)
    const connected: Connected = {
      socket,
      tunnel: new Tunnel(socket, { text: (text) => this.#said(config, connected, text) }),
    }
    this.#connected.set(config.name, connected)
    previous?.socket.close(AGENT_REPLACED, 'Another connection of this agent took over.')
    socket.on('close', () => {
      if (this.#connected.get(config.name) !== connected) return
      this.#connected.delete(config.name)
      log(`The agent of ${config.name} disconnected`)
      this.changed()
    })
    connected.tunnel.say({
      type: 'welcome',
      cluster: config.name,
      heartbeatSeconds: this.heartbeatSeconds,
    })
  }

  /** The clusters agents make available: reachable once their agent said hello. */
  clusters(): FleetCluster[] {
    return this.configs.map((config): FleetCluster => {
      const hello = this.#connected.get(config.name)?.hello
      const cluster: FleetCluster = {
        name: config.name,
        source: 'LUMOVI_FLEET_AGENTS',
        labels: config.labels,
        groups: config.groups,
        forwardToken: config.forwardToken,
        agent: config.name,
      }
      return hello
        ? {
            ...cluster,
            cluster: {
              name: config.name,
              server: AGENT_SERVER,
              caData: hello.ca,
              skipTLSVerify: false,
            },
            account: { name: config.name, token: hello.token },
          }
        : { ...cluster, problem: 'Its agent isn’t connected.' }
    })
  }

  /** An https.Agent whose connections lead through `name`'s tunnel (it must be connected). */
  httpsAgent(name: string): https.Agent {
    const tunnel = this.#connected.get(name)!.tunnel
    return new TunnelAgent(tunnel)
  }

  /**
   * A port on 127.0.0.1 whose connections lead through `name`'s tunnel, for a
   * helm run (helm, a program of its own, can't use the server's tunnel).
   */
  async loopback(name: string): Promise<{ port: number; close(): void }> {
    const tunnel = this.#connected.get(name)!.tunnel
    const server = createServer((socket) => {
      const stream = tunnel.open()
      socket.pipe(stream).pipe(socket)
      socket.on('error', ignore)
      socket.on('close', () => stream.destroy())
      stream.on('close', () => socket.destroy())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return {
      port: (server.address() as { port: number }).port,
      close: () => server.close(),
    }
  }

  /** Closes every agent's connection: they connect again, to the next server. */
  close(): void {
    for (const { socket } of this.#connected.values()) socket.close(1001, 'The hub is restarting.')
  }

  /** What an agent says: hello, at first and when its token changes. */
  #said(config: AgentConfig, connected: Connected, text: string): void {
    let hello: Partial<AgentHello> | null | undefined
    try {
      hello = JSON.parse(text) as Partial<AgentHello> | null
    } catch {
      hello = undefined
    }
    if (hello?.type !== 'hello' || !HELLO.every((key) => typeof hello[key] === 'string')) {
      connected.socket.close(1008, 'Not a Lumovi agent message.')
      return
    }
    const first = !connected.hello
    connected.hello = hello as AgentHello
    if (first) log(`The agent of ${config.name} connected (Lumovi ${hello.version})`)
    this.changed()
  }
}

/** What a hello must have. */
const HELLO = ['version', 'ca', 'token'] as const

/** Connections to an agent's cluster: TLS to its API server, inside the tunnel. */
class TunnelAgent extends https.Agent {
  constructor(private readonly tunnel: Tunnel) {
    super({ keepAlive: true })
  }

  override createConnection(options: tls.ConnectionOptions): tls.TLSSocket {
    return tls.connect({ ...options, socket: this.tunnel.open() })
  }
}

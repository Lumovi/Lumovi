/**
 * The hub's side of agents: clusters in networks the hub can't reach, whose
 * agents connect to it instead (LUMOVI_FLEET_AGENTS says which may). Each
 * connected agent's tunnel leads to its cluster's API server.
 *
 * What an agent says its cluster's certificate authority is decides who the hub
 * takes for its API server, so it's trusted only as LUMOVI_FLEET_AGENTS names it
 * (caSha256), or as the agent first said it (kept with what a restart mustn't lose,
 * and recorded): one it sends later that isn't that one is refused, until an admin
 * trusts it.
 */
import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto'
import https from 'node:https'
import { createServer } from 'node:net'
import tls from 'node:tls'
import type { WebSocket } from 'ws'
import type { AuditActor } from '@shared/audit'
import type { AuditLog } from '@backend/audit/log'
import { KubeRequestError } from '@backend/kube/errors'
import { SERVER_ACTOR } from '../audit'
import type { AgentConfig } from '../config'
import { log } from '../log'
import type { ServerState } from '../state'
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
  /** Its certificate authority, as trusted: what of it the hub trusts (PEM, base64), or why none. */
  trusted?: { ca: string } | { refused: string; untrusted: 'named' | 'first' }
  /** The certificate authority last refused (each is said once). */
  refusedSent?: string
}

/** The certificate authority an agent first sent, as kept: its certificates' SHA-256. */
interface Pin {
  ca: string[]
  at: string
}

/** The certificates in a PEM bundle, each with its SHA-256 (hex), as openssl's -fingerprint has it. */
function certificatesOf(bundle: string): { pem: string; sha256: string }[] {
  const blocks = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
  return blocks.flatMap((pem) => {
    try {
      return [
        { pem, sha256: new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase() },
      ]
    } catch {
      return []
    }
  })
}

/** SHA-256s as people compare them: the start of each. */
const shown = (sha256s: string[]) => sha256s.map((sha256) => `${sha256.slice(0, 16)}…`).join(', ')

export class Agents {
  readonly #connected = new Map<string, Connected>()
  /** Where what agents first sent is kept, and where what's trusted is recorded. */
  #trust?: { state: ServerState; audit: AuditLog }

  constructor(
    private readonly configs: AgentConfig[],
    /** How often agents are pinged: they take silence for a lost connection. */
    private readonly heartbeatSeconds: number,
    /** Called when the clusters they make available change. */
    private readonly changed: () => void,
  ) {}

  /** Where what agents first sent is kept, and recorded: the server's, before agents connect. */
  trustWith(trust: { state: ServerState; audit: AuditLog }): void {
    this.#trust = trust
  }

  /**
   * Lets `name`'s agent be trusted with a certificate authority other than the one it first
   * sent: the one it's sending now (or the next it sends). An admin's, as `actor`.
   */
  trust(name: string, actor: AuditActor): void {
    const config = this.configs.find((c) => c.name === name)
    if (!config)
      throw new KubeRequestError('not-found', `This server has no agent called “${name}”.`)
    if (config.caSha256) {
      throw new KubeRequestError(
        'invalid',
        `LUMOVI_FLEET_AGENTS says which certificate authority ${name}’s agent must send: it’s changed there.`,
      )
    }
    this.#trust?.state.delete('agents', name)
    void this.#trust?.state.flush()
    this.#trust?.audit.record({
      action: 'agent.trusted',
      outcome: 'success',
      actor,
      cluster: name,
      summary: `Let the agent of ${name} be trusted with the certificate authority it sends now`,
    })
    const connected = this.#connected.get(name)
    if (connected?.hello) this.#check(config, connected)
    this.changed()
  }

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
      const trusted = this.#connected.get(config.name)?.trusted
      if (!hello || !trusted) return { ...cluster, problem: 'Its agent isn’t connected.' }
      if ('refused' in trusted) {
        return { ...cluster, problem: trusted.refused, untrusted: trusted.untrusted }
      }
      return {
        ...cluster,
        cluster: {
          name: config.name,
          server: AGENT_SERVER,
          // Only what of its certificate authority is trusted: whatever else it sent isn't.
          caData: trusted.ca,
          skipTLSVerify: false,
        },
        account: { name: config.name, token: hello.token },
      }
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
    this.#check(config, connected)
    this.changed()
  }

  /**
   * Which of the certificates an agent sent as its cluster's authority are trusted: those
   * LUMOVI_FLEET_AGENTS names, or those it sent first (as it first connects, they're kept, and
   * recorded). None: it's refused, which it and the audit log are told once.
   */
  #check(config: AgentConfig, connected: Connected): void {
    const sent = certificatesOf(Buffer.from(connected.hello!.ca, 'base64').toString())
    const { name } = config
    let trusted = config.caSha256
    if (!trusted) {
      const pin = this.#trust?.state.get<Pin>('agents', name)
      trusted = pin?.ca
      if (!trusted && sent.length) {
        trusted = sent.map((c) => c.sha256)
        this.#trust?.state.set('agents', name, { ca: trusted, at: new Date().toISOString() })
        void this.#trust?.state.flush()
        this.#trust?.audit.record({
          action: 'agent.pinned',
          outcome: 'success',
          actor: SERVER_ACTOR,
          cluster: name,
          summary: `Trusted the certificate authority the agent of ${name} first sent`,
          details: { sha256: trusted },
        })
        log(
          `Trusting the certificate authority the agent of ${name} first sent (SHA-256 ${shown(trusted)})`,
        )
      }
    }
    const kept = sent.filter((c) => trusted?.includes(c.sha256))
    if (kept.length) {
      connected.trusted = { ca: Buffer.from(kept.map((c) => c.pem).join('\n')).toString('base64') }
      connected.refusedSent = undefined
      return
    }
    const sha256s = sent.map((c) => c.sha256)
    const what = sent.length
      ? `a certificate authority (SHA-256 ${shown(sha256s)})`
      : 'no certificate authority Lumovi can read'
    const refused = config.caSha256
      ? `Its agent sent ${what} other than the one LUMOVI_FLEET_AGENTS names for it.`
      : `Its agent sent ${what} other than the one it sent when it first connected. If its cluster’s changed, an admin can trust the new one.`
    connected.trusted = { refused, untrusted: config.caSha256 ? 'named' : 'first' }
    const key = sha256s.join(',')
    if (connected.refusedSent === key) return
    connected.refusedSent = key
    this.#trust?.audit.record({
      action: 'agent.refused',
      outcome: 'refused',
      actor: SERVER_ACTOR,
      cluster: name,
      summary: `Refused the certificate authority the agent of ${name} sent`,
      details: { sha256: sha256s },
      error: refused,
    })
    log(`The agent of ${name}: ${refused}`)
    connected.tunnel.say({ type: 'refused', message: refused })
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

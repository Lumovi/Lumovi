import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { PassThrough, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { Exec, PortForward as Forwarder, type KubeConfig } from '@kubernetes/client-node'
import type {
  ForwardKind,
  KubeObject,
  PortForward,
  PortForwardRequest,
  Result,
  ShellExit,
  ShellRequest,
} from '@shared/api'
import { authorize, kubeRequest, serverUrl } from './client'
import { KubeRequestError, toKubeError } from './errors'
import type { ClusterConfigs } from './kubeconfig'
import { assertIntegerInRange, assertOneOf, assertQuery, assertString, invalid } from './validate'

/** Starts bash when the container has it, and sh otherwise, like `kubectl debug` users do by hand. */
const SHELL = ['sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh']
const FORWARD_KINDS: readonly ForwardKind[] = ['Pod', 'Service']
const TIMEOUT_MS = 20_000

interface Dependencies {
  store: ClusterConfigs
  envReady: Promise<void>
  isReadOnly: (context: string) => boolean
}

/** The part of the connection checks the WebSocket client doesn't make itself. */
async function prepare(kc: KubeConfig): Promise<void> {
  serverUrl(kc, '/')
  await authorize(kc, {})
}

/** Terminal output that the exec client can also read the terminal's size from. */
class TerminalOutput extends Writable {
  columns = 80
  rows = 24
  // A chunk can end in the middle of a character.
  readonly #decoder = new StringDecoder('utf8')

  constructor(private readonly onData: (text: string) => void) {
    super({ decodeStrings: false })
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: () => void) {
    this.onData(this.#decoder.write(chunk))
    done()
  }

  resize(columns: number, rows: number) {
    this.columns = columns
    this.rows = rows
    this.emit('resize')
  }
}

interface Session {
  input: PassThrough
  output: TerminalOutput
  close(): void
}

/** How an exec status reads: an exit code, or why the command couldn't run. */
function exitOf(status: {
  status?: string
  message?: string
  reason?: string
  details?: { causes?: { reason?: string; message?: string }[] }
}): ShellExit {
  if (status.status === 'Success') return { code: 0 }
  const code = status.details?.causes?.find((cause) => cause.reason === 'ExitCode')?.message
  return code === undefined ? { message: status.message } : { code: Number(code) }
}

/** Interactive shells in containers, streamed to the page (`kubectl exec -it`). */
export class Terminals {
  readonly #sessions = new Map<string, Session>()
  /** Sessions closed while they were still connecting. */
  readonly #abandoned = new Set<string>()
  readonly #connecting = new Set<string>()

  constructor(
    private readonly deps: Dependencies,
    private readonly emit: {
      data: (id: string, data: string) => void
      exit: (id: string, exit: ShellExit) => void
    },
  ) {}

  async open(id: unknown, request: unknown): Promise<Result<null>> {
    try {
      if (
        typeof id !== 'string' ||
        !/^[\w-]{8,64}$/.test(id) ||
        this.#sessions.has(id) ||
        this.#connecting.has(id)
      ) {
        throw invalid('A new session needs a new id')
      }
      const r = assertQuery<ShellRequest>(request)
      assertString(r.context, 'context')
      assertString(r.namespace, 'namespace')
      assertString(r.pod, 'pod')
      assertString(r.container, 'container')
      if (this.deps.isReadOnly(r.context)) {
        throw new KubeRequestError(
          'read-only',
          `${r.context} is read-only in KubeStacks, so shells, which can change containers, are turned off.`,
        )
      }
      const kc = this.deps.store.forContext(r.context)
      this.#connecting.add(id)
      try {
        await this.#connect(id, kc, r)
      } finally {
        this.#connecting.delete(id)
        this.#abandoned.delete(id)
      }
      return { ok: true, data: null }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  async #connect(id: string, kc: KubeConfig, r: ShellRequest): Promise<void> {
    await this.deps.envReady
    await prepare(kc)
    const input = new PassThrough()
    const output = new TerminalOutput((text) => this.emit.data(id, text))
    let ended = false
    const end = (exit: ShellExit) => {
      if (ended) return
      ended = true
      this.#sessions.delete(id)
      this.emit.exit(id, exit)
    }
    const socket = await new Exec(kc).exec(
      r.namespace,
      r.pod,
      r.container,
      SHELL,
      output,
      output,
      input,
      true,
      (status) => end(exitOf(status)),
    )
    socket.on('close', () => end({ message: 'The connection to the container closed.' }))
    // Nobody is waiting for it any more: don't leave a shell running in the container.
    if (this.#abandoned.has(id)) socket.close()
    else this.#sessions.set(id, { input, output, close: () => socket.close() })
  }

  write(id: unknown, data: unknown): void {
    if (typeof data === 'string') this.#sessions.get(String(id))?.input.write(data)
  }

  resize(id: unknown, columns: unknown, rows: unknown): void {
    if (Number.isInteger(columns) && Number.isInteger(rows)) {
      this.#sessions.get(String(id))?.output.resize(columns as number, rows as number)
    }
  }

  close(id: unknown): void {
    const key = String(id)
    if (this.#connecting.has(key)) this.#abandoned.add(key)
    this.#sessions.get(key)?.close()
  }

  closeAll(): void {
    for (const session of this.#sessions.values()) session.close()
  }
}

interface Forward extends PortForward {
  server: net.Server
  sockets: Set<net.Socket>
}

/** Local ports forwarded to pods (`kubectl port-forward`), until stopped or the app quits. */
export class Forwards {
  readonly #forwards = new Map<string, Forward>()

  constructor(
    private readonly deps: Dependencies,
    private readonly changed: (forwards: PortForward[]) => void,
  ) {}

  list(): PortForward[] {
    return [...this.#forwards.values()].map(
      ({ server: _server, sockets: _sockets, ...forward }) => forward,
    )
  }

  async start(request: unknown): Promise<Result<PortForward>> {
    try {
      const r = assertQuery<PortForwardRequest>(request)
      assertString(r.context, 'context')
      assertString(r.namespace, 'namespace')
      assertOneOf(r.kind, 'kind', FORWARD_KINDS)
      assertString(r.name, 'name')
      assertIntegerInRange(r.port, 'port', 1, 65_535)
      if (r.localPort !== undefined) assertIntegerInRange(r.localPort, 'localPort', 1, 65_535)
      const kc = this.deps.store.forContext(r.context)
      await this.deps.envReady
      await prepare(kc)
      const { pod, podPort } = await this.#target(kc, r)
      const server = net.createServer()
      await new Promise<void>((resolve, reject) => {
        server.once('error', (error: NodeJS.ErrnoException) =>
          reject(
            invalid(
              `Port ${r.localPort} on this computer can’t be used (${error.code}). Pick another one.`,
            ),
          ),
        )
        server.listen(r.localPort ?? 0, '127.0.0.1', () => resolve())
      })
      const forward: Forward = {
        id: randomUUID(),
        context: r.context,
        namespace: r.namespace,
        kind: r.kind,
        name: r.name,
        port: r.port,
        pod,
        podPort,
        localPort: (server.address() as net.AddressInfo).port,
        connections: 0,
        server,
        sockets: new Set(),
      }
      server.on('connection', (socket) => void this.#connect(kc, forward, socket))
      this.#forwards.set(forward.id, forward)
      this.#notify()
      return { ok: true, data: this.list().find((f) => f.id === forward.id)! }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  stop(id: unknown): void {
    const forward = this.#forwards.get(String(id))
    if (!forward) return
    this.#forwards.delete(forward.id)
    for (const socket of forward.sockets) socket.destroy()
    forward.server.close()
    this.#notify()
  }

  stopAll(): void {
    for (const id of [...this.#forwards.keys()]) this.stop(id)
  }

  /** The pod and container port that traffic for a pod or a service goes to. */
  async #target(kc: KubeConfig, r: PortForwardRequest): Promise<{ pod: string; podPort: number }> {
    const get = async <T>(path: string) =>
      JSON.parse(await kubeRequest(kc, path, { timeoutMs: TIMEOUT_MS })) as T
    const ns = `/api/v1/namespaces/${encodeURIComponent(r.namespace)}`
    if (r.kind === 'Pod') {
      await get<KubeObject>(`${ns}/pods/${encodeURIComponent(r.name)}`)
      return { pod: r.name, podPort: r.port }
    }
    // Like kubectl: a service's port resolves to its target port on the first ready pod.
    const service = await get<KubeObject>(`${ns}/services/${encodeURIComponent(r.name)}`)
    const selector = Object.entries((service.spec.selector ?? {}) as Record<string, string>)
    if (selector.length === 0) throw invalid(`${r.name} has no selector, so no pods to forward to`)
    const port = (service.spec.ports as { port: number; targetPort?: number | string }[]).find(
      (p) => p.port === r.port,
    )
    if (!port) throw invalid(`${r.name} has no port ${r.port}`)
    const labelSelector = selector.map(([key, value]) => `${key}=${value}`).join(',')
    const pods = await get<{ items: KubeObject[] }>(
      `${ns}/pods?${new URLSearchParams({ labelSelector })}`,
    )
    const ready = pods.items.find((p) =>
      p.status?.conditions?.some(
        (c: { type: string; status: string }) => c.type === 'Ready' && c.status === 'True',
      ),
    )
    if (!ready) throw invalid(`${r.name} has no ready pods to forward to`)
    // The API server always fills in targetPort, as a number or a container port's name.
    const target = port.targetPort!
    const podPort =
      typeof target === 'number'
        ? target
        : (ready.spec.containers as { ports?: { name?: string; containerPort: number }[] }[])
            .flatMap((c) => c.ports)
            .find((p) => p?.name === target)?.containerPort
    if (podPort === undefined)
      throw invalid(`No container in ${ready.metadata.name} has a port named ${target}`)
    return { pod: ready.metadata.name, podPort }
  }

  async #connect(kc: KubeConfig, forward: Forward, socket: net.Socket): Promise<void> {
    forward.sockets.add(socket)
    forward.connections++
    this.#notify()
    // Listened for now: the local end can close while the tunnel is still opening.
    const closed = new Promise<void>((resolve) => socket.once('close', resolve))
    void closed.then(() => {
      forward.sockets.delete(socket)
      forward.connections--
      this.#notify()
    })
    try {
      const ws = (await new Forwarder(kc).portForward(
        forward.namespace,
        forward.pod,
        [forward.podPort],
        socket,
        null,
        socket,
      )) as { close(): void; on(event: 'close', listener: () => void): void }
      void closed.then(() => ws.close())
      ws.on('close', () => socket.end())
      if (forward.error) {
        delete forward.error
        this.#notify()
      }
    } catch (error) {
      forward.error = toKubeError(error).message
      socket.destroy()
      this.#notify()
    }
  }

  #notify(): void {
    this.changed(this.list())
  }
}

import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { PassThrough, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { Exec, PortForward as Forwarder, type KubeConfig } from '@kubernetes/client-node'
import type {
  ContainerShellRequest,
  ForwardKind,
  KubeObject,
  NodeShellRequest,
  NodeShellSetting,
  PortForward,
  PortForwardRequest,
  Result,
  ShellExit,
  ShellRequest,
} from '@shared/api'
import { outcomeOf } from '../audit/describe'
import type { Recorder } from '../audit/recorder'
import { kubectl } from '@shared/kubectl'
import { authorize, kubeRequest, serverUrl } from './client'
import { KubeRequestError, toKubeError } from './errors'
import type { ClusterConfigs } from './kubeconfig'
import { createNodeShell, deleteNodeShell, nodeShellCommand, waitForNodeShell } from './node-shell'
import { assertIntegerInRange, assertOneOf, assertQuery, assertString, invalid } from './validate'

/** Starts bash when the container has it, and sh otherwise, like `kubectl debug` users do by hand. */
const SHELL = ['sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh']
const FORWARD_KINDS: readonly ForwardKind[] = ['Pod', 'Service']
const TIMEOUT_MS = 20_000

interface Dependencies {
  store: ClusterConfigs
  envReady: Promise<void>
  isReadOnly: (context: string) => boolean
  /** The audit log, as the page's person records to it. */
  audit: Recorder
}

/** How long something ran, as people say it: 45s, 3m 12s, 2h 5m. */
export function took(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** A shell, as the audit log has it: where, and what does the same. */
function shellRecord(r: ContainerShellRequest | NodeShellRequest) {
  return r.target === 'node'
    ? {
        cluster: r.context,
        target: { kind: 'Node', name: r.node },
        what: `a shell on Node ${r.node}${r.mode === 'node' ? ', as root' : ', in a pod with its files'}`,
      }
    : {
        cluster: r.context,
        target: { kind: 'Pod', name: r.pod, namespace: r.namespace },
        what: `a shell in Pod ${r.pod} (${r.container})`,
        // Its flags before `--`: what's after it is the shell's.
        command: `${kubectl(r.context, r.namespace, 'exec', '-it', r.pod, '-c', r.container)} -- sh`,
      }
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

/** What a shell runs in: a container of a pod. */
interface ExecTarget {
  namespace: string
  pod: string
  container: string
}

/** A line of the terminal's own, before the shell's: dim, like a comment. */
const note = (text: string) => `\x1b[2m› ${text}\x1b[0m\r\n`

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

/**
 * Interactive shells streamed to the page: in containers (`kubectl exec -it`),
 * and on nodes, through a pod that's deleted when the shell ends.
 */
export class Terminals {
  readonly #sessions = new Map<string, Session>()
  /** Sessions closed while they were still connecting. */
  readonly #abandoned = new Set<string>()
  readonly #connecting = new Set<string>()
  /** Node shells' pods being deleted. */
  readonly #cleaning = new Set<Promise<unknown>>()
  /** What each shell is, for the audit log: once it's open, since when; a node shell's pod. */
  readonly #audited = new Map<
    string,
    { request: ContainerShellRequest | NodeShellRequest; since?: number; pod?: string }
  >()

  constructor(
    private readonly deps: Dependencies & {
      /** Where `context`'s node shells run, or null where they're turned off. */
      nodeShell: (context: string) => NodeShellSetting | null
      timeoutMs: number
    },
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
      if (r.target === 'container') {
        assertString(r.namespace, 'namespace')
        assertString(r.pod, 'pod')
        assertString(r.container, 'container')
      } else if (r.target === 'node') {
        assertString(r.node, 'node')
        assertOneOf(r.mode, 'mode', ['node', 'pod'] as const)
      } else {
        throw invalid('A shell here is in a container or on a node')
      }
      this.#audited.set(id, { request: r })
      if (this.deps.isReadOnly(r.context)) {
        throw new KubeRequestError(
          'read-only',
          `${r.context} is read-only in Lumovi, so shells, which can change ${r.target === 'node' ? 'nodes' : 'containers'}, are turned off.`,
        )
      }
      const setting = this.deps.nodeShell(r.context)
      if (r.target === 'node' && !setting) {
        throw new KubeRequestError(
          'forbidden',
          'Node shells are turned off on this Lumovi server (LUMOVI_NODE_SHELL=off).',
        )
      }
      const kc = this.deps.store.forContext(r.context)
      this.#connecting.add(id)
      try {
        await this.deps.envReady
        await prepare(kc)
        if (r.target === 'node') await this.#node(id, kc, r, setting!)
        else await this.#exec(id, kc, r, SHELL)
      } finally {
        this.#connecting.delete(id)
        this.#abandoned.delete(id)
      }
      return { ok: true, data: null }
    } catch (error) {
      const failure = { ok: false as const, error: toKubeError(error) }
      // Recorded once it's one at all (a shell, somewhere).
      const audited = typeof id === 'string' ? this.#audited.get(id) : undefined
      if (audited && audited.since === undefined) {
        this.#audited.delete(id as string)
        this.#record(audited, 'open', outcomeOf(failure))
      }
      return failure
    }
  }

  #record(
    {
      request,
      since,
      pod,
    }: { request: ContainerShellRequest | NodeShellRequest; since?: number; pod?: string },
    stage: 'open' | 'close',
    outcome: ReturnType<typeof outcomeOf>,
    exit?: ShellExit,
  ) {
    const { what, ...where } = shellRecord(request)
    const ran = since === undefined ? '' : `, after ${took(Date.now() - since)}`
    this.deps.audit.record({
      action: `${request.target === 'node' ? 'node-shell' : 'shell'}.${stage}`,
      ...outcome,
      ...where,
      summary:
        stage === 'open'
          ? `${outcome.outcome === 'success' ? 'Opened' : 'Open'} ${what}`
          : `Closed ${what}${ran}${exit?.code !== undefined ? `: it exited with ${exit.code}` : ''}`,
      details: {
        ...(request.target === 'node' ? { mode: request.mode } : { container: request.container }),
        ...(pod ? { pod } : {}),
        ...(stage === 'close' && since !== undefined
          ? { seconds: Math.round((Date.now() - since) / 1000) }
          : {}),
        ...(exit?.message ? { exit: exit.message } : {}),
        ...(exit?.left ? { left: exit.left } : {}),
      },
    })
  }

  /** A shell's connection is open: it's recorded as opened. */
  #began(id: string) {
    const audited = this.#audited.get(id)!
    audited.since = Date.now()
    this.#record(audited, 'open', { outcome: 'success' })
  }

  /** A shell ended (however it did): it's recorded as closed. */
  #ended(id: string, exit: ShellExit) {
    const audited = this.#audited.get(id)!
    this.#audited.delete(id)
    this.#record(audited, 'close', { outcome: 'success' }, exit)
  }

  /**
   * A shell on a node: its pod is created, started, and, however the shell
   * ends, deleted. What happens meanwhile shows in the terminal.
   */
  async #node(
    id: string,
    kc: KubeConfig,
    r: NodeShellRequest,
    setting: NodeShellSetting,
  ): Promise<void> {
    const say = (text: string) => this.emit.data(id, note(text))
    const { timeoutMs } = this.deps
    say(`Starting a pod on ${r.node} from ${setting.image}, in ${setting.namespace}…`)
    const name = await createNodeShell(kc, r.node, setting, timeoutMs)
    this.#audited.get(id)!.pod = `${setting.namespace}/${name}`
    const remove = () => deleteNodeShell(kc, setting.namespace, name, timeoutMs)
    const started = await waitForNodeShell(
      kc,
      { node: r.node, namespace: setting.namespace, name, image: setting.image },
      // Pulling an image takes longer than answering a request.
      {
        timeoutMs: timeoutMs * 6,
        requestTimeoutMs: timeoutMs,
        stop: () => this.#abandoned.has(id),
      },
    ).catch(async (error: unknown) => {
      // What went wrong, and its pod if it's left.
      const left = await remove()
      if (!left) throw error
      const kubeError = toKubeError(error)
      throw new KubeRequestError(kubeError.code, `${kubeError.message} ${left}`, kubeError.status)
    })
    if (!started) {
      await remove()
      // Closed before its pod started: nothing ran, but a pod was made (and deleted).
      const audited = this.#audited.get(id)!
      this.#audited.delete(id)
      this.#record(audited, 'open', {
        outcome: 'cancelled',
        error: 'It was closed before its pod started.',
      })
      return
    }
    say(
      r.mode === 'node'
        ? `You’re root on ${r.node}. ${setting.namespace}/${name} is deleted when this shell ends.`
        : `You’re in ${setting.namespace}/${name}, with ${r.node}’s files under /host. It’s deleted when this shell ends.`,
    )
    await this.#exec(
      id,
      kc,
      { namespace: setting.namespace, pod: name, container: 'shell' },
      nodeShellCommand(r.mode),
      remove,
    )
  }

  async #exec(
    id: string,
    kc: KubeConfig,
    where: ExecTarget,
    command: string[],
    /** What to do once the shell ended: delete a node shell's pod. */
    /** After the shell: resolves with what to say if it didn't go as it should. */
    cleanup?: () => Promise<string | undefined>,
  ): Promise<void> {
    const input = new PassThrough()
    const output = new TerminalOutput((text) => this.emit.data(id, text))
    // Once, whichever ends it first: the shell, its connection, or the page.
    let cleaned: Promise<string | undefined> | undefined
    const clean = () => {
      if (!cleanup) return Promise.resolve(undefined)
      if (!cleaned) {
        const cleaning = cleanup().finally(() => this.#cleaning.delete(cleaning))
        this.#cleaning.add(cleaning)
        cleaned = cleaning
      }
      return cleaned
    }
    let ended = false
    const end = (exit: ShellExit) => {
      if (ended) return
      ended = true
      this.#sessions.delete(id)
      // Said once it's cleaned up (a node shell's pod deleted), or said that it couldn't be.
      void clean().then((left) => {
        const ended = left ? { ...exit, left } : exit
        this.#ended(id, ended)
        this.emit.exit(id, ended)
      })
    }
    const socket = await new Exec(kc)
      .exec(
        where.namespace,
        where.pod,
        where.container,
        command,
        output,
        output,
        input,
        true,
        (status) => end(exitOf(status)),
      )
      .catch(async (error: unknown) => {
        void clean()
        throw error
      })
    this.#began(id)
    socket.on('close', () => end({ message: 'The connection to the container closed.' }))
    const close = () => {
      socket.close()
      void clean()
    }
    // Nobody is waiting for it any more: don't leave a shell running in the container.
    if (this.#abandoned.has(id)) close()
    else this.#sessions.set(id, { input, output, close })
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

  /** Ends every shell; resolves once the node shells' pods are deleted. */
  async closeAll(): Promise<void> {
    for (const session of this.#sessions.values()) session.close()
    await Promise.all(this.#cleaning)
  }

  /** Whether node shells' pods are still being deleted (quitting waits for them). */
  get cleaning(): boolean {
    return this.#cleaning.size > 0
  }
}

interface Forward extends PortForward {
  server: net.Server
  sockets: Set<net.Socket>
  /** When it started, for the audit log. */
  since: number
}

/** A forward, as the audit log has it. */
const forwardRecord = (r: PortForwardRequest, localPort?: number) => ({
  cluster: r.context,
  target: { kind: r.kind, name: r.name, namespace: r.namespace },
  what: `port ${localPort ?? r.localPort ?? '(any)'} on this computer to ${r.kind} ${r.name}:${r.port}`,
  command: kubectl(
    r.context,
    r.namespace,
    'port-forward',
    `${r.kind.toLowerCase()}/${r.name}`,
    `${localPort ?? r.localPort ?? ''}:${r.port}`,
  ),
})

/** Local ports forwarded to pods (`kubectl port-forward`), until stopped or the app quits. */
export class Forwards {
  readonly #forwards = new Map<string, Forward>()

  constructor(
    private readonly deps: Dependencies,
    private readonly changed: (forwards: PortForward[]) => void,
  ) {}

  list(): PortForward[] {
    return [...this.#forwards.values()].map(
      ({ server: _server, sockets: _sockets, since: _since, ...forward }) => forward,
    )
  }

  async start(request: unknown): Promise<Result<PortForward>> {
    let asked: PortForwardRequest | undefined
    try {
      const r = assertQuery<PortForwardRequest>(request)
      assertString(r.context, 'context')
      assertString(r.namespace, 'namespace')
      assertOneOf(r.kind, 'kind', FORWARD_KINDS)
      assertString(r.name, 'name')
      assertIntegerInRange(r.port, 'port', 1, 65_535)
      if (r.localPort !== undefined) assertIntegerInRange(r.localPort, 'localPort', 1, 65_535)
      asked = r
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
        since: Date.now(),
      }
      server.on('connection', (socket) => void this.#connect(kc, forward, socket))
      this.#forwards.set(forward.id, forward)
      this.#notify()
      const { what, ...where } = forwardRecord(r, forward.localPort)
      this.deps.audit.record({
        action: 'port-forward.open',
        outcome: 'success',
        ...where,
        summary: `Forwarded ${what}`,
        details: { pod, podPort, localPort: forward.localPort },
      })
      return { ok: true, data: this.list().find((f) => f.id === forward.id)! }
    } catch (error) {
      const failure = { ok: false as const, error: toKubeError(error) }
      if (asked) {
        const { what, ...where } = forwardRecord(asked)
        this.deps.audit.record({
          action: 'port-forward.open',
          ...outcomeOf(failure),
          ...where,
          summary: `Forward ${what}`,
        })
      }
      return failure
    }
  }

  stop(id: unknown): void {
    const forward = this.#forwards.get(String(id))
    if (!forward) return
    this.#forwards.delete(forward.id)
    for (const socket of forward.sockets) socket.destroy()
    forward.server.close()
    this.#notify()
    const { what, ...where } = forwardRecord(forward, forward.localPort)
    const ms = Date.now() - forward.since
    this.deps.audit.record({
      action: 'port-forward.close',
      outcome: 'success',
      ...where,
      summary: `Stopped forwarding ${what}, after ${took(ms)}`,
      details: { seconds: Math.round(ms / 1000), localPort: forward.localPort },
    })
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

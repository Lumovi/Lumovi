import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { PassThrough, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { Attach, Exec, PortForward as Forwarder, type KubeConfig } from '@kubernetes/client-node'
import type {
  ContainerAttachRequest,
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
import { whose } from '@shared/plugins'
import { outcomeOf } from '../audit/describe'
import { knownVia, type PluginLookup, type Via } from './plugin-via'
import type { Recorder } from '../audit/recorder'
import { kubectl } from '@shared/kubectl'
import type { AccessGuard } from '@shared/access'
import { authorize, kubeRequest, serverUrl } from './client'
import { KubeRequestError, toKubeError, type ReadOnlyCheck } from './errors'
import type { ClusterConfigs } from './kubeconfig'
import { createNodeShell, deleteNodeShell, nodeShellCommand, waitForNodeShell } from './node-shell'
import {
  assertDnsName,
  assertIntegerInRange,
  assertName,
  assertNamespace,
  assertOneOf,
  assertQuery,
  assertString,
  invalid,
} from './validate'

/** Starts bash when the container has it, and sh otherwise, like `kubectl debug` users do by hand. */
const SHELL = ['sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh']
const FORWARD_KINDS: readonly ForwardKind[] = ['Pod', 'Service']
const TIMEOUT_MS = 20_000

interface Dependencies {
  store: ClusterConfigs
  envReady: Promise<void>
  isReadOnly: ReadOnlyCheck
  /** The audit log, as the page's person records to it. */
  audit: Recorder
  /** A server's: what its person may do (the desktop app has none). */
  guard?: AccessGuard
  /**
   * A plugin Lumovi has in use, by its name, as the backend knows it: what the history names
   * when a plugin's link brought the person to a shell or a forward, never what a page says.
   */
  plugin?: PluginLookup
}

const DURATION = new Intl.DurationFormat('en', { style: 'narrow', secondsDisplay: 'always' })

/** How long something ran, as people say it: 45s, 3m 12s, 2h 5m 0s. */
export function took(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return DURATION.format({
    hours: Math.floor(seconds / 3600),
    minutes: Math.floor(seconds / 60) % 60,
    seconds: seconds % 60,
  })
}

/** A shell, as the audit log has it: where, and what does the same. */
/** How a shell or a forward a plugin's link brought the person to is said, after what it is. */
const fromPage = (via: Via) => `, from the plugin ${whose(via.label)} page`

/** What a terminal of a container's or a node's is, as the history says it. */
type Audited = ContainerShellRequest | ContainerAttachRequest | NodeShellRequest

function shellRecord(r: Audited, input?: boolean) {
  if (r.target === 'node') {
    return {
      cluster: r.context,
      target: { kind: 'Node', name: r.node },
      what: `a shell on Node ${r.node}${r.mode === 'node' ? ', as root' : ', in a pod with its files'}`,
    }
  }
  if (r.target === 'attach') {
    return {
      cluster: r.context,
      target: { kind: 'Pod', name: r.pod, namespace: r.namespace },
      what: `Pod ${r.pod} (${r.container})${input === false ? ', its output only' : ''}`,
      // (Where it takes no input, what's seen of it: its output.)
      command: kubectl(
        r.context,
        r.namespace,
        'attach',
        ...(input === false ? [] : ['-it']),
        r.pod,
        '-c',
        r.container,
      ),
    }
  }
  return {
    cluster: r.context,
    target: { kind: 'Pod', name: r.pod, namespace: r.namespace },
    what: `a shell in Pod ${r.pod} (${r.container})`,
    // Its flags before `--`: what's after it is the shell's.
    command: `${kubectl(r.context, r.namespace, 'exec', '-it', r.pod, '-c', r.container)} -- sh`,
  }
}

/** The part of the connection checks the WebSocket client doesn't make itself. */
export async function prepare(kc: KubeConfig): Promise<void> {
  serverUrl(kc, '/')
  await authorize(kc, {})
}

/**
 * A pod's path as the WebSocket client makes it (its parts as they are, not escaped): its
 * namespace and name held to Kubernetes' rules, whoever named them (a pod a port forward found
 * is the cluster's answer), and the path to what every request's is, before it's asked.
 */
export function podSocket(kc: KubeConfig, namespace: string, pod: string, what: string): void {
  assertNamespace(namespace)
  assertDnsName(pod, 'a pod’s name')
  serverUrl(kc, `/api/v1/namespaces/${namespace}/pods/${pod}/${what}`)
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
  /** None where what's typed goes nowhere: attached to a process that takes no input. */
  input?: PassThrough
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
export function exitOf(status: {
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
    {
      request: Audited
      since?: number
      pod?: string
      via?: Via
      /** Attached: whether what's typed goes to the process. */
      input?: boolean
    }
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
      if (r.target === 'container' || r.target === 'attach') {
        assertNamespace(r.namespace)
        assertDnsName(r.pod, 'a pod’s name')
        assertString(r.container, 'container')
      } else if (r.target === 'node') {
        assertDnsName(r.node, 'a node’s name')
        assertOneOf(r.mode, 'mode', ['node', 'pod'] as const)
      } else {
        throw invalid('A shell here is in a container or on a node')
      }
      const via = r.target === 'container' ? await knownVia(this.deps.plugin, r.via) : undefined
      this.#audited.set(id, { request: r, ...(via ? { via } : {}) })
      // (Attaching is as a shell is, to Lumovi's access: what's typed goes into the container.)
      if (r.target === 'node') {
        await this.deps.guard?.require(r.context, 'nodeShells', 'on', undefined, 'open node shells')
      } else if (r.target === 'attach') {
        await this.deps.guard?.require(
          r.context,
          'shells',
          'on',
          r.namespace,
          'attach to containers',
        )
      } else {
        await this.deps.guard?.require(r.context, 'shells', 'on', r.namespace, 'open shells')
      }
      const readOnly = this.deps.isReadOnly(r.context)
      if (readOnly) {
        const changes = r.target === 'node' ? 'nodes' : 'containers'
        const off =
          r.target === 'attach'
            ? 'attaching, which sends what you type to a container’s process, is'
            : `shells, which can change ${changes}, are`
        throw new KubeRequestError(
          'read-only',
          typeof readOnly === 'string'
            ? `${readOnly} ${off[0]!.toUpperCase()}${off.slice(1)} turned off.`
            : `${r.context} is read-only in Lumovi, so ${off} turned off.`,
        )
      }
      const setting = this.deps.nodeShell(r.context)
      if (r.target === 'node' && !setting) {
        throw new KubeRequestError(
          'forbidden',
          'Node shells are turned off on this Lumovi server (LUMOVI_NODE_SHELL=off).',
        )
      }
      this.#connecting.add(id)
      try {
        await this.deps.envReady
        const kc = this.deps.store.forContext(r.context)
        await prepare(kc)
        if (r.target === 'node') await this.#node(id, kc, r, setting!)
        else if (r.target === 'attach') await this.#attach(id, kc, r)
        else await this.#exec(id, kc, r, SHELL)
      } finally {
        this.#connecting.delete(id)
        this.#abandoned.delete(id)
      }
      return { ok: true, data: null }
    } catch (error) {
      const failure = { ok: false as const, error: toKubeError(error) }
      // Recorded once it's one at all (a shell, somewhere): it fails before it begins, or not at all.
      const audited = this.#audited.get(id as string)
      if (audited) {
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
      via,
      input,
    }: {
      request: Audited
      since?: number
      pod?: string
      via?: Via
      input?: boolean
    },
    stage: 'open' | 'close',
    outcome: ReturnType<typeof outcomeOf>,
    exit?: ShellExit,
  ) {
    const { what, ...where } = shellRecord(request, input)
    const ran = since === undefined ? '' : `, after ${took(Date.now() - since)}`
    const attach = request.target === 'attach'
    this.deps.audit.record({
      action: `${request.target === 'node' ? 'node-shell' : attach ? 'attach' : 'shell'}.${stage}`,
      ...outcome,
      ...where,
      summary: attach
        ? stage === 'open'
          ? `${outcome.outcome === 'success' ? 'Attached' : 'Attach'} to ${what}`
          : `Detached from ${what}${ran}`
        : stage === 'open'
          ? `${outcome.outcome === 'success' ? 'Opened' : 'Open'} ${what}${via ? fromPage(via) : ''}`
          : `Closed ${what}${ran}${exit?.code !== undefined ? `: it exited with ${exit.code}` : ''}`,
      details: {
        ...(request.target === 'node' ? { mode: request.mode } : { container: request.container }),
        ...(input !== undefined ? { input } : {}),
        ...via?.details,
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
    podSocket(kc, where.namespace, where.pod, 'exec')
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

  /**
   * Attached to a container's main process, as `kubectl attach -it` is: what it prints, and what's
   * typed, where its stdin is open. Where its stdin closes after one session (`stdinOnce`), the
   * process would end with this one: it's sent nothing, and what it prints is shown. Detaching
   * (the page closing it) leaves the process running.
   */
  async #attach(id: string, kc: KubeConfig, r: ContainerAttachRequest): Promise<void> {
    const say = (text: string) => this.emit.data(id, note(text))
    const pod = JSON.parse(
      await kubeRequest(
        kc,
        `/api/v1/namespaces/${encodeURIComponent(r.namespace)}/pods/${encodeURIComponent(r.pod)}`,
        { timeoutMs: this.deps.timeoutMs },
      ),
    ) as KubeObject
    const spec = (
      [...(pod.spec?.containers ?? []), ...(pod.spec?.ephemeralContainers ?? [])] as {
        name?: string
        stdin?: boolean
        stdinOnce?: boolean
        tty?: boolean
      }[]
    ).find((container) => container.name === r.container)
    if (!spec) {
      throw new KubeRequestError('not-found', `Pod ${r.pod} has no container ${r.container}.`)
    }
    const takes = spec.stdin === true && spec.stdinOnce !== true
    const tty = spec.tty === true
    this.#audited.get(id)!.input = takes
    if (spec.stdin !== true) {
      say(`${r.container} takes no input (its stdin isn’t open): this shows what it prints.`)
    } else if (spec.stdinOnce === true) {
      say(
        `${r.container}’s input closes when one session ends, which would end its process: this shows what it prints, and sends it nothing.`,
      )
    } else {
      say(
        `What you type goes to ${r.container}’s main process, Ctrl+C and Ctrl+D included, which can end it. To leave it running, close this.`,
      )
    }
    const input = takes ? new PassThrough() : undefined
    const output = new TerminalOutput((text) => this.emit.data(id, text))
    let ended = false
    const end = (exit: ShellExit) => {
      if (ended) return
      ended = true
      this.#sessions.delete(id)
      this.#ended(id, exit)
      this.emit.exit(id, exit)
    }
    // (A terminal's output is one stream: with a TTY, the API server takes no stderr.)
    podSocket(kc, r.namespace, r.pod, 'attach')
    const socket = await new Attach(kc).attach(
      r.namespace,
      r.pod,
      r.container,
      output,
      tty ? null : output,
      input ?? null,
      tty,
    )
    this.#began(id)
    socket.on('close', () => end({ message: 'The connection to the container closed.' }))
    const close = () => socket.close()
    // Nobody is waiting for it any more: let go of it at once.
    if (this.#abandoned.has(id)) close()
    else this.#sessions.set(id, { ...(input ? { input } : {}), output, close })
  }

  write(id: unknown, data: unknown): void {
    if (typeof data === 'string') this.#sessions.get(String(id))?.input?.write(data)
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
      assertNamespace(r.namespace)
      assertOneOf(r.kind, 'kind', FORWARD_KINDS)
      assertName(r.name)
      assertIntegerInRange(r.port, 'port', 1, 65_535)
      if (r.localPort !== undefined) assertIntegerInRange(r.localPort, 'localPort', 1, 65_535)
      asked = r
      await this.deps.envReady
      const kc = this.deps.store.forContext(r.context)
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
      const via = await knownVia(this.deps.plugin, r.via)
      this.deps.audit.record({
        action: 'port-forward.open',
        outcome: 'success',
        ...where,
        summary: `Forwarded ${what}${via ? fromPage(via) : ''}`,
        details: {
          pod,
          podPort,
          localPort: forward.localPort,
          ...via?.details,
        },
      })
      return { ok: true, data: this.list().find((f) => f.id === forward.id)! }
    } catch (error) {
      const failure = { ok: false as const, error: toKubeError(error) }
      if (asked) {
        const { what, ...where } = forwardRecord(asked)
        const via = await knownVia(this.deps.plugin, asked.via)
        this.deps.audit.record({
          action: 'port-forward.open',
          ...outcomeOf(failure),
          ...where,
          summary: `Forward ${what}${via ? fromPage(via) : ''}`,
          ...(via ? { details: via.details } : {}),
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
      podSocket(kc, forward.namespace, forward.pod, 'portforward')
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

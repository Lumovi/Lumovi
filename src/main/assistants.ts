/**
 * The desktop app's MCP server, for AI assistants on this computer (Claude
 * Code, Claude Desktop, Cursor, VS Code…): on a port of 127.0.0.1, for those
 * that send its token. Each assistant that connects has a session of its own;
 * the changes they ask for wait in the window for the person's answer.
 *
 * Browsers can't reach it: a page's requests come with an Origin (they're
 * refused), and one that rebinds a name of its own to this computer has a Host
 * other than this computer's (refused too).
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { IPC, type Result } from '@shared/api'
import type {
  AssistantClient,
  AssistantsStatus,
  ChangeProposal,
  ConnectedAssistant,
} from '@shared/assistants'
import { Approvals } from '@backend/mcp/approvals'
import { assistantName, createMcpServer } from '@backend/mcp/server'
import { toKubeError } from '@backend/kube/errors'
import type { KubeService } from '@backend/kube/service'
import type { SettingsStore } from './settings'

/** The largest message an assistant may send (a manifest to apply, say). */
const MAX_BODY = 4 * 1024 * 1024
/** Sessions with no request for this long are let go: their assistant has gone (an env for tests). */
const IDLE_MS = Number(process.env.LUMOVI_ASSISTANTS_IDLE_MS) || 6 * 60 * 60_000

export interface AssistantsDeps {
  settings: SettingsStore
  kube: KubeService
  version: string
  /** Tells the page. */
  send(channel: string, ...args: unknown[]): void
  /** Draws the person to a change waiting for their answer. */
  attention(proposal: ChangeProposal): void
  /** Opens an install link in the assistant it's for. */
  open(url: string): Promise<void>
  /** How Claude Desktop starts Lumovi to talk to it (`Lumovi --mcp-stdio`, or run as Node). */
  stdio: { command: string; args: string[]; env?: Record<string, string> }
  /** Claude Desktop's settings file, where it's installed (macOS and Windows). */
  claudeDesktopConfig?: string
}

interface Session {
  transport: StreamableHTTPServerTransport
  server: McpServer
  /** Who it is, once it has said (it's shown from then on). */
  name?: string
  lastSeen: number
}

export class Assistants {
  readonly approvals: Approvals
  #server?: Server
  #listening = false
  #error?: string
  readonly #sessions = new Map<string, Session>()
  readonly #idle: ReturnType<typeof setInterval>

  constructor(private readonly deps: AssistantsDeps) {
    this.approvals = new Approvals((proposal) => {
      deps.send(IPC.assistantsProposal, proposal)
      deps.attention(proposal)
    })
    this.#idle = setInterval(() => this.#letGoIdle(), Math.min(60_000, IDLE_MS))
    this.#idle.unref()
  }

  get #setting() {
    return this.deps.settings.get().assistants!
  }

  get #url() {
    return `http://127.0.0.1:${this.#setting.port}/mcp`
  }

  status(): AssistantsStatus {
    const { enabled, port, token } = this.#setting
    const clients: ConnectedAssistant[] = [...this.#sessions]
      .filter(([, session]) => session.name)
      .map(([id, session]) => ({ id, name: session.name! }))
    return {
      enabled,
      port,
      ...(enabled ? { token } : {}),
      ...(this.#listening ? { url: this.#url } : {}),
      ...(this.#error ? { error: this.#error } : {}),
      clients,
      installable: [
        ...(this.deps.claudeDesktopConfig ? (['claude-desktop'] as const) : []),
        'cursor',
        'vscode',
      ],
    }
  }

  /** Listens, if it's on: when the app starts, and again when it's changed. */
  async start(): Promise<void> {
    await this.stop()
    const { enabled, port } = this.#setting
    if (!enabled) return
    if (!this.#setting.token) this.#newToken()
    const server = createServer((req, res) => void this.#handle(req, res))
    this.#server = server
    await new Promise<void>((resolve) => {
      server.once('error', (error) => {
        // Taken by another program, mostly (EADDRINUSE), which the message says.
        this.#error = `Lumovi can’t use port ${port} (${error.message}): choose another one.`
        resolve()
      })
      server.listen(port, '127.0.0.1', () => {
        this.#listening = true
        resolve()
      })
    })
    this.#changed()
  }

  /** Stops listening, and lets every assistant go: what they asked for is withdrawn. */
  async stop(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    this.#listening = false
    this.#error = undefined
    this.approvals.withdrawAll()
    await Promise.all([...this.#sessions.values()].map(({ transport }) => transport.close()))
    this.#sessions.clear()
    if (server) {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  }

  async configure(change: { enabled?: boolean; port?: number }): Promise<AssistantsStatus> {
    this.deps.settings.update({ assistants: { ...this.#setting, ...change } })
    await this.start()
    return this.status()
  }

  /** A new token: assistants set up with the old one are let go, and set up again. */
  async resetToken(): Promise<AssistantsStatus> {
    this.#newToken()
    await this.start()
    return this.status()
  }

  /** Sets an assistant up to connect: Claude Desktop's settings, or an install link. */
  async install(client: Exclude<AssistantClient, 'claude-code'>): Promise<Result<string>> {
    const headers = { Authorization: `Bearer ${this.#setting.token}` }
    const installers = {
      'claude-desktop': () => this.#installClaudeDesktop(),
      cursor: async () => {
        const config = Buffer.from(JSON.stringify({ url: this.#url, headers })).toString('base64')
        await this.deps.open(
          `cursor://anysphere.cursor-deeplink/mcp/install?name=lumovi&config=${encodeURIComponent(config)}`,
        )
        return 'Cursor asks you to add Lumovi.'
      },
      vscode: async () => {
        const server = { name: 'lumovi', type: 'http', url: this.#url, headers }
        await this.deps.open(`vscode:mcp/install?${encodeURIComponent(JSON.stringify(server))}`)
        return 'VS Code asks you to add Lumovi.'
      },
    }
    try {
      return { ok: true, data: await installers[client]() }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  async #installClaudeDesktop(): Promise<string> {
    const file = this.deps.claudeDesktopConfig!
    if (!existsSync(dirname(file))) {
      throw new Error('Claude Desktop isn’t installed on this computer.')
    }
    let config: { mcpServers?: Record<string, unknown> } = {}
    if (existsSync(file)) {
      try {
        config = JSON.parse(await readFile(file, 'utf8'))
      } catch {
        throw new Error(
          `Claude Desktop’s settings (${file}) aren’t valid JSON, so Lumovi left them alone.`,
        )
      }
    }
    // Claude Desktop starts Lumovi to talk to it over stdio; Lumovi finds the port and the
    // token itself, so a new one doesn't need setting up again.
    config.mcpServers = { ...config.mcpServers, lumovi: this.deps.stdio }
    // Written whole or not at all: never half of the person's settings.
    const next = `${file}.lumovi-${process.pid}`
    await writeFile(next, `${JSON.stringify(config, null, 2)}\n`)
    await rename(next, file)
    return 'Added to Claude Desktop: quit and open it again to use Lumovi there.'
  }

  #newToken(): void {
    this.deps.settings.update({
      assistants: { ...this.#setting, token: randomBytes(32).toString('base64url') },
    })
  }

  #changed(): void {
    this.deps.send(IPC.assistantsStatusChanged, this.status())
  }

  #letGoIdle(): void {
    const now = Date.now()
    for (const [id, session] of this.#sessions) {
      if (now - session.lastSeen > IDLE_MS)
        void session.transport.close().then(() => this.#forget(id))
    }
  }

  #forget(id: string): void {
    if (this.#sessions.delete(id)) this.#changed()
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { port, token } = this.#setting
    const path = new URL(req.url!, 'http://127.0.0.1').pathname
    if (path !== '/mcp') return refuse(res, 404, 'Lumovi’s MCP server is at /mcp.')
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(String(req.headers.host))) {
      return refuse(res, 403, 'Only this computer may connect.')
    }
    if (req.headers.origin !== undefined) {
      return refuse(res, 403, 'Web pages may not connect to Lumovi.')
    }
    if (!matches(req.headers.authorization, `Bearer ${token}`)) {
      return refuse(res, 401, 'Lumovi needs its token: set this assistant up again from Lumovi.')
    }
    let body: unknown
    if (req.method === 'POST') {
      try {
        body = JSON.parse(await read(req))
      } catch (error) {
        return error === TOO_LARGE
          ? refuse(res, 413, `That’s more than Lumovi takes: ${MAX_BODY / 1024 / 1024} MB at most.`)
          : refuse(res, 400, 'That isn’t a JSON-RPC message.', -32700)
      }
    }
    const id = req.headers['mcp-session-id']
    let session = typeof id === 'string' ? this.#sessions.get(id) : undefined
    if (!session) {
      // A session Lumovi no longer has (it restarted, say): the assistant starts a new one.
      if (id !== undefined) return refuse(res, 404, 'That session has ended: start a new one.')
      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        return refuse(res, 400, 'Start a session first (initialize).')
      }
      session = await this.#open()
    }
    session.lastSeen = Date.now()
    await session.transport.handleRequest(req, res, body)
  }

  async #open(): Promise<Session> {
    const { kube, settings, version } = this.deps
    const server = createMcpServer(version, {
      kube,
      policy: () => ({ mine: settings.aiPermissions(), admin: [] }),
      approvals: this.approvals,
      outcome: (outcome) => this.deps.send(IPC.assistantsOutcome, outcome),
    })
    const session: Session = {
      server,
      lastSeen: Date.now(),
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void this.#sessions.set(id, session),
      }),
    }
    // Shown once it has said who it is.
    server.server.oninitialized = () => {
      session.name = assistantName(server)
      this.#changed()
    }
    session.transport.onclose = () => this.#forget(session.transport.sessionId!)
    await server.connect(session.transport)
    return session
  }
}

/** Whether a header is what's expected, in constant time. */
function matches(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? '')
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const TOO_LARGE = new Error('Too large')

/** A request's body; one that's too large is read to its end (for the answer to be heard), and dropped. */
function read(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      chunks.push(chunk)
      if (size > MAX_BODY) chunks.length = 0
    })
    req.on('end', () =>
      size > MAX_BODY ? reject(TOO_LARGE) : resolve(Buffer.concat(chunks).toString('utf8')),
    )
    req.on('error', reject)
  })
}

/** A refusal, as JSON-RPC errors are. */
function refuse(res: ServerResponse, status: number, message: string, code = -32000): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
  })
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }))
}

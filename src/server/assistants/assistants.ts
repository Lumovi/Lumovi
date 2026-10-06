/**
 * AI assistants on a Lumovi server: Claude Code, Cursor, VS Code and the rest
 * connect to its MCP endpoint, signed in as someone (see oauth.ts), and read
 * the clusters they can, with the same tools as the desktop app's. The changes
 * they ask for wait on that person's own pages for their answer, as the
 * server's administrator says (LUMOVI_ASSISTANT_CHANGES); their RBAC decides
 * the rest.
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { IPC } from '@shared/api'
import type { AiPermissionsView } from '@shared/ai-permissions'
import type { ProposalOutcome, ServerAssistantsStatus } from '@shared/assistants'
import type { AuditActor } from '@shared/audit'
import { describePermissions } from '@backend/audit/describe'
import type { AuditLog } from '@backend/audit/log'
import { recorder } from '@backend/audit/recorder'
import { checkedDecision } from '@backend/mcp/approvals'
import { assistantName, createMcpServer } from '@backend/mcp/server'
import { KubeService } from '@backend/kube/service'
import { origin, sessionTag } from '../audit'
import type { Hosted, Identity } from '../cluster'
import type { ServerConfig } from '../config'
import { readJson, sameOrigin, secure, sendJson } from '../http'
import { log } from '../log'
import type { Sessions } from '../sessions'
import { Grants, type Endpoints, type Grant, type Signer } from './oauth'
import { People } from './people'
import type { PermissionsStore } from './permissions'

/** Paths below the server's base path. */
const PATHS = {
  mcp: 'mcp',
  register: 'oauth/register',
  token: 'oauth/token',
  revoke: 'oauth/revoke',
  /** Lumovi's page that asks the person, and what it asks the server. */
  authorize: 'authorize',
  authorizeApi: 'api/assistants/authorize',
  resourceMetadata: '.well-known/oauth-protected-resource',
  serverMetadata: '.well-known/oauth-authorization-server',
}
/** What's assistants' alone, below the base path: with them off, there's nothing there. */
const THEIRS = new Set([
  PATHS.mcp,
  PATHS.register,
  PATHS.token,
  PATHS.revoke,
  PATHS.authorizeApi,
  PATHS.resourceMetadata,
  `${PATHS.resourceMetadata}/${PATHS.mcp}`,
  PATHS.serverMetadata,
])
/** The largest message an assistant may send (a manifest to apply, say). */
const MAX_BODY = 4 * 1024 * 1024
/** Sessions with no request for this long are let go: their assistant has gone (an env for tests). */
const IDLE_MS = Number(process.env.LUMOVI_ASSISTANTS_IDLE_MS) || 6 * 60 * 60_000

/** How an outcome reads in the server's log. */
const OUTCOMES: Record<ProposalOutcome['status'], string> = {
  applied: 'made',
  failed: 'failed',
  rejected: 'rejected',
  expired: 'not answered in time',
  withdrawn: 'withdrawn',
}

interface Session {
  transport: StreamableHTTPServerTransport
  server: McpServer
  grant: string
  lastSeen: number
}

export class ServerAssistants {
  readonly #people = new People()
  readonly #grants: Grants
  readonly #sessions = new Map<string, Session>()
  /** Each grant's connection to its person's clusters. */
  readonly #kube = new Map<string, KubeService>()
  /** The changes each grant's assistant asked for: withdrawn when it ends. */
  readonly #asked = new Map<string, Set<string>>()
  readonly #idle: ReturnType<typeof setInterval>

  constructor(
    private readonly deps: {
      config: ServerConfig
      hosted: Hosted
      sessions: Sessions
      version: string
      /** Nobody changes anything (LUMOVI_READ_ONLY). */
      readOnly: boolean
      /** What each person lets their assistants do (none while assistants are off). */
      permissions?: PermissionsStore
      audit: AuditLog
    },
  ) {
    this.#grants = new Grants({
      audit: deps.audit,
      sessions: deps.sessions,
      sessionHours: deps.config.sessionHours,
      redirectHosts: deps.config.assistants.redirectHosts,
      changed: (grant) => this.#people.changed(grant.person),
      // Its assistant's connections close, and what it asked for is withdrawn.
      ended: (grant) => {
        this.#disconnect(grant)
        const approvals = this.#people.approvals(grant.person)
        for (const id of this.#asked.get(grant.id) ?? []) approvals.withdraw(id)
        this.#asked.delete(grant.id)
        this.#people.changed(grant.person)
      },
    })
    this.#idle = setInterval(
      () => {
        this.#letGoIdle()
        this.#grants.sweep()
      },
      Math.min(60_000, IDLE_MS),
    )
    this.#idle.unref()
  }

  get enabled(): boolean {
    return this.deps.config.assistants.enabled
  }

  /** What `person` lets their assistants do, under the administrator's rules, and where it's kept. */
  #permissions(person: string): AiPermissionsView {
    const store = this.deps.permissions
    if (!store) throw new Error('This server’s administrator has turned AI assistants off.')
    return { mine: store.get(person), admin: this.deps.config.assistants.rules, kept: store.kept }
  }

  /** Where everything is, as the person (or their assistant) reached the server. */
  endpoints(req: IncomingMessage): Endpoints {
    const { publicUrl, basePath } = this.deps.config
    const origin =
      publicUrl?.origin ?? `${secure(req, publicUrl) ? 'https' : 'http'}://${req.headers.host}`
    const at = `${origin}${basePath}`
    return {
      resource: `${at}${PATHS.mcp}`,
      issuer: at.replace(/\/$/, ''),
      authorize: `${at}${PATHS.authorize}`,
      token: `${at}${PATHS.token}`,
      register: `${at}${PATHS.register}`,
      revoke: `${at}${PATHS.revoke}`,
      resourceMetadata: `${at}${PATHS.resourceMetadata}/${PATHS.mcp}`,
    }
  }

  /**
   * Answers what's an assistant's to ask, below the base path (`path`); false
   * when it isn't one of theirs. `signer` is who the request is from, for
   * Lumovi's own page.
   */
  async answer(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    url: URL,
    signer: () => Signer | undefined,
  ): Promise<boolean> {
    if (!this.enabled) {
      if (!THEIRS.has(path)) return false
      sendJson(res, 404, { error: 'This server’s administrator has turned AI assistants off.' })
      return true
    }
    const route = `${req.method} ${path}`
    const endpoints = () => this.endpoints(req)
    if (
      route === `GET ${PATHS.resourceMetadata}` ||
      route === `GET ${PATHS.resourceMetadata}/${PATHS.mcp}`
    ) {
      this.#grants.resourceMetadata(res, endpoints())
    } else if (route === `GET ${PATHS.serverMetadata}`) {
      this.#grants.serverMetadata(res, endpoints())
    } else if (route === `POST ${PATHS.register}`) {
      await this.#grants.register(req, res)
    } else if (route === `POST ${PATHS.token}`) {
      await this.#grants.token(req, res)
    } else if (route === `POST ${PATHS.revoke}`) {
      await this.#grants.revoke(req, res)
    } else if (path === PATHS.authorizeApi) {
      const who = signer()
      if (!who) sendJson(res, 401, { error: 'Sign in to Lumovi first.' })
      else if (req.method === 'GET') this.#grants.describe(res, url.searchParams, endpoints(), who)
      // Only from Lumovi's own page: a site can't allow an assistant as someone.
      else if (!sameOrigin(req, this.deps.config.publicUrl)) {
        sendJson(res, 403, { error: 'Allow assistants from Lumovi’s own page.' })
      } else await this.#grants.decide(req, res, endpoints(), who)
    } else if (path === PATHS.mcp) {
      await this.#mcp(req, res)
    } else {
      return false
    }
    return true
  }

  /**
   * The metadata, at the root of the server's origin, where clients look for
   * it first (RFC 8414's and RFC 9728's well-known paths, with the base path
   * after them): false for anything else.
   */
  answerAtRoot(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if (!this.enabled || req.method !== 'GET') return false
    const base = this.deps.config.basePath
    if (pathname === `/${PATHS.serverMetadata}${base.replace(/\/$/, '')}`) {
      this.#grants.serverMetadata(res, this.endpoints(req))
    } else if (pathname === `/${PATHS.resourceMetadata}${base}${PATHS.mcp}`) {
      this.#grants.resourceMetadata(res, this.endpoints(req))
    } else {
      return false
    }
    return true
  }

  /** A session ended: its assistants can't act as its person any more. */
  sessionEnded(session: string): void {
    this.#grants.sessionEnded(session)
  }

  /**
   * A page of `identity`'s: shown their assistants' changes, and told what
   * became of them. Its calls, and what to call once it's gone.
   */
  page(
    identity: Identity,
    req: IncomingMessage,
    /** Who the page's person is to the audit log, and where from. */
    actor: AuditActor,
    emit: (channel: string, ...args: unknown[]) => void,
  ) {
    const person = identity.user.name
    // Behind a proxy, the assistants they allowed act as who it says they are now: their
    // connections close, and they start again as that.
    for (const grant of this.#grants.reidentify(identity)) this.#disconnect(grant)
    const status = (): ServerAssistantsStatus => ({
      enabled: this.enabled,
      url: this.endpoints(req).resource,
      clients: this.#grants.of(person),
    })
    const detach = this.#people.attach(person, {
      emit,
      changed: () => emit(IPC.serverAssistantsStatusChanged, status()),
    })
    const approvals = () => this.#people.approvals(person)
    return {
      detach,
      readOnly: (contexts: string[]) => this.#people.setReadOnly(person, contexts),
      invoke: {
        [IPC.serverAssistantsStatus]: status,
        [IPC.serverAssistantsRevoke]: (id: unknown) => {
          if (typeof id !== 'string') throw new Error('Expected an assistant’s id')
          this.#grants.letGo(person, id)
          return status()
        },
        [IPC.assistantsPending]: () => approvals().pending(),
        [IPC.assistantsDecide]: (id: unknown, decision: unknown) =>
          approvals().decide(...checkedDecision(id, decision)),
        [IPC.aiPermissionsGet]: () => this.#permissions(person),
        // Kept for every page of theirs, and their assistants follow them at once.
        [IPC.aiPermissionsSet]: async (given: unknown) => {
          this.#permissions(person)
          await this.deps.permissions!.set(person, given)
          const view = this.#permissions(person)
          this.deps.audit.record({ ...describePermissions(view.mine), actor })
          this.#people.tell(person, IPC.aiPermissionsChanged, view)
          return view
        },
      },
    }
  }

  /** `mcp`: an assistant's requests, as the person it's signed in as. */
  async #mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const signedIn = this.#grants.verify(req)
    if (!signedIn) {
      sendJson(
        res,
        401,
        { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Sign in to Lumovi.' } },
        {
          'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${this.endpoints(req).resourceMetadata}"`,
        },
      )
      return
    }
    const { grant, identity } = signedIn
    let body: unknown
    if (req.method === 'POST') {
      body = await readJson(req, MAX_BODY)
      if (body === undefined) {
        this.#refuse(res, 400, 'That isn’t a JSON-RPC message (or it’s more than 4 MB).', -32700)
        return
      }
    }
    const id = req.headers['mcp-session-id']
    let session = typeof id === 'string' ? this.#sessions.get(id) : undefined
    // Only its own assistant's: another's session is as good as gone.
    if (session && session.grant !== grant.id) session = undefined
    if (!session) {
      if (id !== undefined)
        return this.#refuse(res, 404, 'That session has ended: start a new one.')
      if (req.method !== 'POST' || !isInitializeRequest(body)) {
        return this.#refuse(res, 400, 'Start a session first (initialize).')
      }
      session = await this.#open(grant, identity, this.endpoints(req), req)
    }
    session.lastSeen = Date.now()
    await session.transport.handleRequest(req, res, body)
  }

  async #open(
    grant: Grant,
    identity: Identity,
    endpoints: Endpoints,
    req: IncomingMessage,
  ): Promise<Session> {
    const { hosted, readOnly, version } = this.deps
    const person = grant.person
    let kube = this.#kube.get(grant.id)
    if (!kube) {
      // Changing nothing where nobody may, nor where its person said not to.
      kube = new KubeService(
        hosted.configsFor(identity),
        Promise.resolve(),
        (context) => readOnly || this.#people.isReadOnly(person, context),
      )
      this.#kube.set(grant.id, kube)
    }
    const approvals = this.#people.approvals(person)
    const asked = this.#asked.get(grant.id) ?? new Set<string>()
    this.#asked.set(grant.id, asked)
    const server = createMcpServer(version, {
      kube,
      policy: () => {
        const { mine, admin } = this.#permissions(person)
        return { mine, admin }
      },
      // Its person's, each kept as this assistant's, to be withdrawn when it's let go.
      approvals: {
        ask: (proposal, settle) => {
          asked.add(proposal.id)
          approvals.ask(proposal, settle)
        },
        wait: (id, signal) => approvals.wait(id, signal),
      },
      outcome: (outcome) => {
        this.#people.tell(person, IPC.assistantsOutcome, outcome)
        const { proposal, status, error } = outcome
        log(
          `${person}’s ${proposal.client}: ${proposal.title} in ${proposal.context}, ${OUTCOMES[status]}${outcome.unasked ? ' without asking' : ''}${error ? `: ${error}` : ''}`,
        )
      },
      appUrl: endpoints.issuer,
      // As the person, through this assistant (named as it is when it's recorded), from where.
      audit: recorder(this.deps.audit, () => ({
        user: person,
        ...(identity.user.groups.length ? { groups: identity.user.groups } : {}),
        via: 'assistant',
        assistant: grant.name,
        session: sessionTag(grant.id),
        ...origin(req),
      })),
    })
    const session: Session = {
      server,
      grant: grant.id,
      lastSeen: Date.now(),
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void this.#sessions.set(id, session),
      }),
    }
    // Named as it calls itself, once it has said.
    server.server.oninitialized = () => this.#grants.rename(grant, assistantName(server))
    session.transport.onclose = () => void this.#sessions.delete(session.transport.sessionId!)
    await server.connect(session.transport)
    return session
  }

  /** Closes a grant's connections, and lets go of its connection to the clusters. */
  #disconnect(grant: Grant): void {
    for (const session of this.#sessions.values()) {
      if (session.grant === grant.id) void session.transport.close()
    }
    this.#kube.delete(grant.id)
  }

  #letGoIdle(): void {
    const now = Date.now()
    for (const session of this.#sessions.values()) {
      if (now - session.lastSeen > IDLE_MS) void session.transport.close()
    }
  }

  #refuse(res: ServerResponse, status: number, message: string, code = -32000): void {
    sendJson(res, status, { jsonrpc: '2.0', id: null, error: { code, message } })
  }

  /** Lets every assistant go, as the server stops (what they're waiting for is withdrawn). */
  async close(): Promise<void> {
    clearInterval(this.#idle)
    await Promise.all([...this.#sessions.values()].map(({ transport }) => transport.close()))
  }
}

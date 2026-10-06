/**
 * AI assistants that use Lumovi through MCP (the Model Context Protocol):
 * Claude Code, Claude Desktop, Cursor, VS Code… They read clusters with
 * Lumovi's tools, and ask to change them: each change is shown in Lumovi, as
 * the diff it makes and its kubectl command, for the person to approve.
 */
import type { KubeObject } from './api'
import type { ResourceKind } from './resources'

/** Whether assistants' changes to a cluster are asked about, made without asking, or refused. */
export type AiChanges = 'ask' | 'allow' | 'never'

export const isAiChanges = (value: unknown): value is AiChanges =>
  value === 'ask' || value === 'allow' || value === 'never'

/** Where assistants connect to the desktop app, on this computer only, unless set otherwise. */
export const DEFAULT_ASSISTANTS_PORT = 47_830

/** The desktop app's MCP server, as stored with its settings. */
export interface AssistantsSetting {
  enabled: boolean
  port: number
  /** What assistants send to be let in (a bearer token): made the first time it's turned on. */
  token?: string
  /** How the app was last started: Claude Desktop's bridge starts it so when it isn't running. */
  launch?: string[]
}

export const isPort = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1_024 && (value as number) <= 65_535

/** What a token looks like: a random one, URL-safe. */
export const isToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w-]{32,}$/.test(value)

/** The assistants Lumovi shows how to connect, and sets up where it can. */
export type AssistantClient = 'claude-code' | 'claude-desktop' | 'cursor' | 'vscode'

/** An assistant that's connected now. */
export interface ConnectedAssistant {
  /** Its MCP session. */
  id: string
  /** As Lumovi shows it: "Claude Code". */
  name: string
}

/** Whether assistants can connect, where, and which have. */
export interface AssistantsStatus {
  enabled: boolean
  port: number
  /** http://127.0.0.1:47830/mcp, while it listens. */
  url?: string
  token?: string
  /** Why it isn't listening although it's on (the port is taken, say). */
  error?: string
  clients: ConnectedAssistant[]
  /** Assistants Lumovi can set up here with a click (the others, with what to paste). */
  installable: AssistantClient[]
}

/** An assistant someone allowed to use a Lumovi server as them. */
export interface ServerAssistant {
  /** What they allowed: revoked by it. */
  id: string
  /** As Lumovi shows it: "Claude Code". */
  name: string
  /** When they allowed it, and when it last asked anything. */
  since: number
  lastUsed?: number
}

/** A server's MCP server, for its pages: where assistants connect, and what they may change. */
export interface ServerAssistantsStatus {
  /** Whether the server lets assistants connect (LUMOVI_ASSISTANTS). */
  enabled: boolean
  /** Where assistants connect: https://lumovi.example.com/mcp. */
  url: string
  /** The person's own: each they allowed, until they revoke it or their session ends. */
  clients: ServerAssistant[]
  /** What assistants' changes do, as the server's administrator set it: each cluster's, or `default`. */
  changes: AiChangesPolicy
}

/** What assistants' changes do on each cluster, unless a cluster has its own. */
export interface AiChangesPolicy {
  default: AiChanges
  clusters: Record<string, AiChanges>
}

/** What an assistant asked to do. */
export type ProposalAction = 'apply' | 'scale' | 'restart' | 'delete'

/** A change an assistant asked for, waiting for the person to approve it. */
export interface ChangeProposal {
  id: string
  /** The assistant that asked: "Claude Code". */
  client: string
  context: string
  action: ProposalAction
  target: { kind: ResourceKind; name: string; namespace?: string }
  /** What it would do: "Scale Deployment checkout to 5 replicas". */
  title: string
  /** And, once done, for the activity log: "Scaled checkout to 5 replicas". */
  done: string
  /** Why, in the assistant's words. */
  reason: string
  /** The object as it is, and as it would be (from a dry run): null where there's none. */
  before: KubeObject | null
  after: KubeObject | null
  /** The kubectl command that does the same. */
  command: string
  /** What's applied, for `apply`: the manifest as the assistant gave it. */
  manifest?: string
  /** Fields it takes over from other managers (Helm, Argo CD…), in the API server's words. */
  takesOver?: string
  /** When it's no longer waited for (the assistant is told it wasn't approved). */
  expiresAt: number
}

export type ProposalDecision = { approved: true } | { approved: false; note?: string }

/** What became of a change an assistant asked for, or made where it may without asking. */
export interface ProposalOutcome {
  proposal: ChangeProposal
  status: 'applied' | 'failed' | 'rejected' | 'expired' | 'withdrawn'
  /** Made without asking: the cluster allows its assistants' changes. */
  unasked?: boolean
  error?: string
}

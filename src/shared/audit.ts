/**
 * Lumovi's audit log: who did what, where, how, and what came of it. One
 * event for each change made through Lumovi (by a person, or an AI assistant
 * as them), each sign-in and sign-out, each shell, port-forward and read of
 * logs or Secrets, each change to settings that decide what may be done.
 *
 * Events are versioned (`version`), and chained: each carries the hash of the
 * one before it, so a gap or an edit shows. Secret values, tokens and
 * manifests' contents are never in them.
 */

export const AUDIT_TYPE = 'lumovi.audit'
export const AUDIT_VERSION = 1

/** What an event is about, broadly: what the page filters by first. */
export type AuditCategory = 'change' | 'access' | 'sign-in' | 'assistant' | 'settings' | 'server'

export const AUDIT_CATEGORIES: { value: AuditCategory; label: string }[] = [
  { value: 'change', label: 'Changes' },
  { value: 'access', label: 'Access' },
  { value: 'sign-in', label: 'Sign-ins' },
  { value: 'assistant', label: 'AI assistants' },
  { value: 'settings', label: 'Settings' },
  { value: 'server', label: 'Server' },
]

/** What happened, by its category: `resource.delete`, `shell.open`, `session.sign-in`… */
export const AUDIT_ACTIONS = {
  // Changes to clusters.
  'resource.create': 'change',
  'resource.apply': 'change',
  'resource.replace': 'change',
  'resource.patch': 'change',
  'resource.scale': 'change',
  'resource.restart': 'change',
  'resource.delete': 'change',
  'resource.evict': 'change',
  'resource.debug': 'change',
  'helm.install': 'change',
  'helm.upgrade': 'change',
  'helm.rollback': 'change',
  'helm.uninstall': 'change',
  // What was opened, or read, that could show what shouldn't be.
  'shell.open': 'access',
  'shell.close': 'access',
  'node-shell.open': 'access',
  'node-shell.close': 'access',
  'port-forward.open': 'access',
  'port-forward.close': 'access',
  'logs.read': 'access',
  'secret.read': 'access',
  'helm.values.read': 'access',
  // Signing in to a server, and out.
  'session.sign-in': 'sign-in',
  'session.sign-out': 'sign-in',
  'session.expired': 'sign-in',
  // AI assistants: allowed to act as someone, what they asked, what they read.
  'assistant.allowed': 'assistant',
  'assistant.denied': 'assistant',
  'assistant.ended': 'assistant',
  'assistant.tool': 'assistant',
  // What decides what may be done.
  'permissions.changed': 'settings',
  'read-only.changed': 'settings',
  'node-shell.changed': 'settings',
  // A fleet's agents: whose cluster's certificate authority is trusted.
  'agent.pinned': 'server',
  'agent.refused': 'server',
  'agent.trusted': 'settings',
  // Clusters connected from the Fleet page: their agents' join tokens.
  'agent.join-created': 'settings',
  'agent.join-cancelled': 'settings',
  'agent.joined': 'server',
  'agent.join-refused': 'server',
  'cluster.removed': 'settings',
  'metrics-source.changed': 'settings',
  'assistants.changed': 'settings',
  'access.changed': 'settings',
  // The server itself, and its audit log.
  'server.started': 'server',
  'server.stopped': 'server',
  'audit.dropped': 'server',
} as const satisfies Record<string, AuditCategory>

export type AuditAction = keyof typeof AUDIT_ACTIONS

export const isAuditAction = (value: unknown): value is AuditAction =>
  typeof value === 'string' && Object.hasOwn(AUDIT_ACTIONS, value)

/**
 * How it came out: done; failed (the cluster, or Lumovi, couldn't); refused (not allowed: by
 * the cluster, Lumovi's rules, or the person); or cancelled (nobody answered in time, or the
 * assistant gave up waiting).
 */
export type AuditOutcome = 'success' | 'failure' | 'refused' | 'cancelled'

export const AUDIT_OUTCOMES: { value: AuditOutcome; label: string }[] = [
  { value: 'success', label: 'Done' },
  { value: 'failure', label: 'Failed' },
  { value: 'refused', label: 'Refused' },
  { value: 'cancelled', label: 'Cancelled' },
]

/** Who did it, and through what. */
export interface AuditActor {
  /** Who: as the cluster knows them on a server; the computer's account in the desktop app. */
  user: string
  groups?: string[]
  /** Through Lumovi's page, an AI assistant acting as them, or the server itself. */
  via: 'ui' | 'assistant' | 'server'
  /** The assistant, as Lumovi names it: "Claude Code". */
  assistant?: string
  /** Which of their sessions (or assistants' grants), by a hash: never the session itself. */
  session?: string
  /** Where from: the connection's address, and what a proxy says it forwarded for. */
  address?: string
  forwardedFor?: string
  userAgent?: string
  /** In the desktop app: the kubeconfig's user for the cluster. */
  kubeUser?: string
}

/** What it was done to. */
export interface AuditTarget {
  kind: string
  name?: string
  namespace?: string
  uid?: string
}

/** For a change an assistant asked for: what the person decided, and when. */
export interface AuditApproval {
  status: 'approved' | 'unasked' | 'rejected' | 'expired' | 'withdrawn'
  /** Who answered (approved or rejected it). */
  by?: string
  note?: string
  /** How long it waited for its answer. */
  waitedMs?: number
}

export type AuditDetail = string | number | boolean | null | string[]

export interface AuditEvent {
  /** What every audit event says it is, wherever it's sent: lines without it are something else. */
  type: typeof AUDIT_TYPE
  version: typeof AUDIT_VERSION
  id: string
  /**
   * Which chain it's in: one goes on as long as its history does (a server with no volume starts
   * one each time it starts; each replica has its own). Check each on its own, by seq.
   */
  chain: string
  /** Its place in the chain: one after the event before it. */
  seq: number
  /** When, to the millisecond (ISO 8601, UTC). */
  time: string
  category: AuditCategory
  action: AuditAction
  outcome: AuditOutcome
  actor: AuditActor
  cluster?: string
  target?: AuditTarget
  /** What happened, in a sentence: "Scaled Deployment cart to 3 replicas". */
  summary: string
  /** The kubectl command that does the same, for a change. */
  command?: string
  approval?: AuditApproval
  /** What else is worth knowing, the action's own: the fields a change set, a shell's container… */
  details?: Record<string, AuditDetail>
  error?: string
  /** The hash of the event before it (empty for the first), and its own. */
  prev: string
  hash: string
}

/** What's recorded, as its source gives it: the log adds the id, place, time and hashes. */
export type AuditInput = Omit<
  AuditEvent,
  'type' | 'version' | 'id' | 'chain' | 'seq' | 'time' | 'category' | 'prev' | 'hash'
>

/** How much is recorded: changes (and sign-ins, settings, the server), or what's opened and read too. */
export type AuditLevel = 'changes' | 'access'

export const isAuditLevel = (value: unknown): value is AuditLevel =>
  value === 'changes' || value === 'access'

/**
 * Whether it's recorded at a level. An assistant's tool calls are kept at access; but one that
 * changes, refused (where its namespace is hidden, say), is a change asked for: kept at changes.
 */
export const recordedAt = (
  level: AuditLevel,
  { action, outcome, details }: Pick<AuditInput, 'action' | 'outcome' | 'details'>,
): boolean =>
  level === 'access' ||
  (action === 'assistant.tool'
    ? outcome === 'refused' && details?.changing === true
    : AUDIT_ACTIONS[action] !== 'access')

// ——— Finding events ———

/** What the page asks for: events matching all of what's given, the newest first. */
export interface AuditQuery {
  /** ISO times: from (inclusive), to (exclusive). */
  from?: string
  to?: string
  users?: string[]
  clusters?: string[]
  namespaces?: string[]
  kinds?: string[]
  categories?: AuditCategory[]
  actions?: AuditAction[]
  outcomes?: AuditOutcome[]
  /** Through the page, an assistant (any, or these by name). */
  via?: ('ui' | 'assistant' | 'server')[]
  assistants?: string[]
  /** One object's: by kind and name (and namespace), or its uid. */
  target?: AuditTarget
  /** Words that must all be in its summary, who, where, or what it was done to. */
  text?: string
  /** Where the last page ended: its `next`. */
  after?: string
  /** How many, at most (100 unless given; 1,000 at most). */
  limit?: number
}

/** The words a search looks for an event by. */
const searchable = (event: AuditEvent) =>
  [
    event.summary,
    event.action,
    event.actor.user,
    event.actor.assistant,
    event.cluster,
    event.target?.kind,
    event.target?.namespace,
    event.target?.name,
    event.command,
    event.error,
    event.approval?.note,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()

const same = (a: string | undefined, b: string | undefined) => a?.toLowerCase() === b?.toLowerCase()

/** Whether an event is one a query asks for (all of what it gives must hold). */
export function matches(query: AuditQuery, event: AuditEvent, words: string[]): boolean {
  const { target } = query
  return (
    (!query.from || event.time >= query.from) &&
    (!query.to || event.time < query.to) &&
    (!query.users?.length || query.users.includes(event.actor.user)) &&
    (!query.clusters?.length || query.clusters.includes(event.cluster ?? '')) &&
    (!query.namespaces?.length || query.namespaces.includes(event.target?.namespace ?? '')) &&
    (!query.kinds?.length || query.kinds.some((kind) => same(kind, event.target?.kind))) &&
    (!query.categories?.length || query.categories.includes(event.category)) &&
    (!query.actions?.length || query.actions.includes(event.action)) &&
    (!query.outcomes?.length || query.outcomes.includes(event.outcome)) &&
    (!query.via?.length || query.via.includes(event.actor.via)) &&
    (!query.assistants?.length || query.assistants.includes(event.actor.assistant ?? '')) &&
    (!target ||
      (target.uid && event.target?.uid
        ? target.uid === event.target.uid
        : same(target.kind, event.target?.kind) &&
          target.name === event.target?.name &&
          (target.namespace ?? '') === (event.target?.namespace ?? ''))) &&
    (words.length === 0 || words.every((word) => searchable(event).includes(word)))
  )
}

/** A search's words, as `matches` takes them: lower case, each on its own. */
export const wordsOf = (text: string | undefined) =>
  (text ?? '').toLowerCase().split(/\s+/).filter(Boolean)

export interface AuditPage {
  events: AuditEvent[]
  /** Where the next page starts (pass it as `after`): none when there's no more. */
  next?: string
  /**
   * How many events were looked through for it (a filter that matches few looks through more):
   * said to an auditor alone, since it counts everyone's.
   */
  scanned?: number
  /** It stopped looking before the page filled (it looked through as many as it does): `next` looks further back. */
  stopped?: boolean
}

/** What the page says about the log, and what its reader may see. */
export interface AuditInfo {
  /** Where history is kept: files (a volume's, or the desktop app's folder), or memory since it started. */
  kept: 'files' | 'memory'
  /** How long it's kept, in days (files only). */
  retentionDays?: number
  /** Why it's kept in memory, where it would have been kept in files (the desktop app's folder). */
  unkept?: string
  level: AuditLevel
  /** Whether the reader sees everyone's events (an auditor), or their own. */
  everyone: boolean
  /**
   * Where events go: the history itself, the server's output, a webhook. With how many
   * couldn't be kept or sent since Lumovi started, and why the last couldn't.
   */
  sinks: { name: string; dropped: number; problem?: string }[]
  /** The oldest event kept. */
  oldest?: string
  /** How many events an export holds, at most. */
  exportLimit: number
}

/** What checking the chain found: that it holds, or every place it doesn't. */
export interface AuditVerification {
  /** How many events were read, and checked. */
  checked: number
  from?: string
  to?: string
  /**
   * The newest: compared with a copy kept somewhere else (the server's output, a webhook's, an
   * export), it shows nothing after it was removed, and nothing before it rewritten.
   */
  last?: { seq: number; hash: string }
  /** Each event (or line) that doesn't follow from the one before it, oldest first: 100 at most. */
  breaks: { seq: number; time: string; reason: string }[]
  /** How many more don't, past those listed. */
  more: number
}

/** How many events an export holds, at most, unless a server says otherwise. */
export const AUDIT_EXPORT_LIMIT = 50_000

/** The history's name, among where events go. */
export const HISTORY = 'history'

/** What's said of events a sink couldn't keep or send: "3 audit events couldn’t be sent to …". */
export const lostText = (count: number, sink: string) =>
  `${count.toLocaleString('en')} audit ${count === 1 ? 'event' : 'events'} couldn’t be ${sink === HISTORY ? 'kept in the history' : `sent to ${sink}`}`

/** The fields an export's CSV has, in order. */
export const AUDIT_CSV_COLUMNS = [
  'time',
  'user',
  'via',
  'assistant',
  'action',
  'outcome',
  'cluster',
  'namespace',
  'kind',
  'name',
  'summary',
  'command',
  'approval',
  'error',
  'id',
  'chain',
  'seq',
  'hash',
] as const

/** An event as one CSV row: what a spreadsheet needs, quoted as RFC 4180 has it. */
export function auditCsvRow(event: AuditEvent): string {
  const values: Record<(typeof AUDIT_CSV_COLUMNS)[number], string | number | undefined> = {
    time: event.time,
    user: event.actor.user,
    via: event.actor.via,
    assistant: event.actor.assistant,
    action: event.action,
    outcome: event.outcome,
    cluster: event.cluster,
    namespace: event.target?.namespace,
    kind: event.target?.kind,
    name: event.target?.name,
    summary: event.summary,
    command: event.command,
    approval: event.approval?.status,
    error: event.error,
    id: event.id,
    chain: event.chain,
    seq: event.seq,
    hash: event.hash,
  }
  return AUDIT_CSV_COLUMNS.map((column) => csvField(values[column])).join(',')
}

const csvField = (value: string | number | undefined) => {
  const text = value === undefined ? '' : String(value)
  // A formula's first character, as text: what's exported can't run in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

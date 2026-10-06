/**
 * The Audit page's model: its filters (kept in the address, so a view of
 * the log can be shared as a link), the search they make, and how each
 * kind of event is shown.
 */
import {
  ArrowUpDown,
  Ban,
  Bug,
  Cable,
  CircleCheck,
  CircleDashed,
  CircleX,
  FilePlus2,
  KeyRound,
  Lock,
  LogIn,
  LogOut,
  Package,
  PencilLine,
  Power,
  PowerOff,
  RotateCw,
  ScrollText,
  Server,
  ShieldCheck,
  ShieldX,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  TimerOff,
  Trash2,
  TriangleAlert,
  Unplug,
  Upload,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type {
  AuditAction,
  AuditCategory,
  AuditEvent,
  AuditOutcome,
  AuditQuery,
  AuditTarget,
} from '@shared/audit'

export type Via = AuditEvent['actor']['via']

/** How far back: the last hour, day, week, month, or everything kept. */
export const RANGES = [
  { value: '1h', label: 'Last hour', ms: 3_600_000 },
  { value: '24h', label: 'Last 24 hours', ms: 86_400_000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
  { value: '30d', label: 'Last 30 days', ms: 30 * 86_400_000 },
  { value: 'all', label: 'All kept' },
] as const

export type Range = (typeof RANGES)[number]['value']

export interface AuditFilters {
  text: string
  range: Range
  categories: AuditCategory[]
  outcomes: AuditOutcome[]
  users: string[]
  clusters: string[]
  via: Via[]
  /** One object's events. */
  target?: AuditTarget
}

const listOf = <T extends string>(params: URLSearchParams, key: string, allowed?: readonly T[]) =>
  params
    .getAll(key)
    .flatMap((value) => value.split(','))
    .filter((value): value is T => value !== '' && (!allowed || allowed.includes(value as T)))

const CATEGORIES: AuditCategory[] = [
  'change',
  'access',
  'sign-in',
  'assistant',
  'settings',
  'server',
]
const OUTCOMES: AuditOutcome[] = ['success', 'failure', 'refused', 'cancelled']
const VIAS: Via[] = ['ui', 'assistant', 'server']

/** The filters an address says: what isn't one is left out. */
export function filtersOf(params: URLSearchParams): AuditFilters {
  const range = params.get('range')
  const kind = params.get('kind')
  const name = params.get('name')
  return {
    text: params.get('q') ?? '',
    range: RANGES.some((r) => r.value === range) ? (range as Range) : '7d',
    categories: listOf(params, 'category', CATEGORIES),
    outcomes: listOf(params, 'outcome', OUTCOMES),
    users: listOf(params, 'user'),
    clusters: listOf(params, 'cluster'),
    via: listOf(params, 'via', VIAS),
    target:
      kind && name
        ? {
            kind,
            name,
            ...(params.get('ns') ? { namespace: params.get('ns')! } : {}),
          }
        : undefined,
  }
}

/** The address that says them (only what isn't the default). */
export function paramsOf(filters: AuditFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.text) params.set('q', filters.text)
  if (filters.range !== '7d') params.set('range', filters.range)
  for (const [key, values] of [
    ['category', filters.categories],
    ['outcome', filters.outcomes],
    ['user', filters.users],
    ['cluster', filters.clusters],
    ['via', filters.via],
  ] as const) {
    for (const value of values) params.append(key, value)
  }
  if (filters.target) {
    params.set('kind', filters.target.kind)
    params.set('name', filters.target.name!)
    if (filters.target.namespace) params.set('ns', filters.target.namespace)
  }
  return params
}

/** How many filters narrow it, besides the time and the words. */
export const narrowing = (f: AuditFilters) =>
  f.categories.length +
  f.outcomes.length +
  f.users.length +
  f.clusters.length +
  f.via.length +
  (f.target ? 1 : 0)

/** From when a range is, as of `now`: nothing for all of it. */
export function fromOf(range: Range, now: number): string | undefined {
  const found = RANGES.find((r) => r.value === range)!
  return 'ms' in found ? new Date(now - found.ms).toISOString() : undefined
}

/** The search the filters make, but how far back (that's as of when it's made: see fromOf). */
export function queryOf(filters: AuditFilters): AuditQuery {
  return {
    ...(filters.text.trim() ? { text: filters.text.trim() } : {}),
    ...(filters.categories.length ? { categories: filters.categories } : {}),
    ...(filters.outcomes.length ? { outcomes: filters.outcomes } : {}),
    ...(filters.users.length ? { users: filters.users } : {}),
    ...(filters.clusters.length ? { clusters: filters.clusters } : {}),
    ...(filters.via.length ? { via: filters.via } : {}),
    ...(filters.target ? { target: filters.target } : {}),
  }
}

export const CATEGORY_LABELS: Record<AuditCategory, string> = {
  change: 'Changes',
  access: 'Access',
  'sign-in': 'Sign-ins',
  assistant: 'AI assistants',
  settings: 'Settings',
  server: 'Server',
}

export const OUTCOME_STYLES: Record<
  AuditOutcome,
  { label: string; icon: LucideIcon; className: string; badge: string }
> = {
  success: {
    label: 'Done',
    icon: CircleCheck,
    // What went as it should doesn't stand out: what didn't does.
    className: 'text-ink-2',
    badge: 'bg-good/10 text-good-text',
  },
  failure: {
    label: 'Failed',
    icon: CircleX,
    className: 'text-critical-text',
    badge: 'bg-critical/10 text-critical-text',
  },
  refused: {
    label: 'Refused',
    icon: Ban,
    className: 'text-warn-text',
    badge: 'bg-warn/10 text-warn-text',
  },
  cancelled: {
    label: 'Cancelled',
    icon: CircleDashed,
    className: 'text-ink-3',
    badge: 'bg-surface-3 text-ink-2',
  },
}

export const VIA_LABELS: Record<Via, string> = {
  ui: 'Lumovi’s page',
  assistant: 'An AI assistant',
  server: 'Lumovi itself',
}

/** Each kind of event: what it's called, and its icon. */
export const ACTIONS: Record<AuditAction, { label: string; icon: LucideIcon }> = {
  'resource.create': { label: 'Created an object', icon: FilePlus2 },
  'resource.apply': { label: 'Applied an object', icon: Upload },
  'resource.replace': { label: 'Replaced an object', icon: PencilLine },
  'resource.patch': { label: 'Changed an object', icon: PencilLine },
  'resource.scale': { label: 'Scaled a workload', icon: ArrowUpDown },
  'resource.restart': { label: 'Restarted a workload', icon: RotateCw },
  'resource.delete': { label: 'Deleted an object', icon: Trash2 },
  'resource.evict': { label: 'Evicted a pod', icon: LogOut },
  'resource.debug': { label: 'Added a debug container', icon: Bug },
  'helm.install': { label: 'Installed a Helm release', icon: Package },
  'helm.upgrade': { label: 'Upgraded a Helm release', icon: Package },
  'helm.rollback': { label: 'Rolled a Helm release back', icon: Package },
  'helm.uninstall': { label: 'Uninstalled a Helm release', icon: Package },
  'shell.open': { label: 'Opened a shell', icon: SquareTerminal },
  'shell.close': { label: 'Closed a shell', icon: SquareTerminal },
  'node-shell.open': { label: 'Opened a node shell', icon: Server },
  'node-shell.close': { label: 'Closed a node shell', icon: Server },
  'port-forward.open': { label: 'Forwarded a port', icon: Cable },
  'port-forward.close': { label: 'Stopped forwarding a port', icon: Cable },
  'logs.read': { label: 'Read logs', icon: ScrollText },
  'secret.read': { label: 'Read a Secret', icon: KeyRound },
  'session.sign-in': { label: 'Signed in', icon: LogIn },
  'session.sign-out': { label: 'Signed out', icon: LogOut },
  'session.expired': { label: 'Session ended', icon: TimerOff },
  'assistant.allowed': { label: 'Allowed an AI assistant', icon: ShieldCheck },
  'assistant.denied': { label: 'Didn’t allow an AI assistant', icon: ShieldX },
  'assistant.ended': { label: 'An AI assistant was let go', icon: Unplug },
  'assistant.tool': { label: 'An AI assistant’s tool call', icon: Wrench },
  'permissions.changed': { label: 'Changed AI permissions', icon: Sparkles },
  'read-only.changed': { label: 'Changed read-only', icon: Lock },
  'assistants.changed': { label: 'Changed AI assistants', icon: SlidersHorizontal },
  'server.started': { label: 'Lumovi started', icon: Power },
  'server.stopped': { label: 'Lumovi stopped', icon: PowerOff },
  'audit.dropped': { label: 'Audit events lost', icon: TriangleAlert },
}

/** A person's initial, for their avatar: their name's first letter (or digit). */
export const initials = (name: string) =>
  name
    .replace(/[^\p{L}\p{N}]/gu, '')
    .slice(0, 1)
    .toUpperCase()

/** A day's heading: Today, Yesterday, or its date. */
export function dayOf(time: string, now: Date): string {
  const day = new Date(time)
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((start(now) - start(day)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return day.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(day.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
}

export const clock = (time: string) =>
  new Date(time).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

const DURATION = new Intl.DurationFormat(undefined, { style: 'narrow', secondsDisplay: 'always' })

/** How long something waited, as people say it: 45s, 3m 12s, 1h 2m 0s. */
export function waited(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return DURATION.format({
    hours: Math.floor(seconds / 3600),
    minutes: Math.floor(seconds / 60) % 60,
    seconds: seconds % 60,
  })
}

/**
 * Links to a view of the desktop app, `lumovi://cluster/<context>/<page>?<view>&at=<cluster>`:
 * what one may carry, read with care, and made from where the app is.
 *
 * A link is a way in from outside (any page or program can open one), so it only says where to
 * go: a page, an object, a reading tab and how the view is filtered, from a list of what pages
 * keep in their address. Never a credential, a user, a file, a command, a form, a terminal, nor
 * what only focuses a switch. What isn't on the list is left out, and said; what doesn't parse
 * is refused whole.
 */
import { builtinResource, isBuiltinKind, resourceByPlural } from './resources'

export const LINK_SCHEME = 'lumovi'
/** The most a link may be, in characters. */
export const LINK_MAX = 4_096

/** A link, as read: where it goes, and what of it was left out. */
export interface Link {
  /** The context the link calls the cluster: which one it is here is matched by `at`. */
  context: string
  /** The cluster's fingerprint (see `clusterFingerprint`), where the link has one. */
  at?: string
  /** The page below the cluster, as the app's address has it ('' for its overview, 'pods'). */
  page: string
  /** What the page keeps in its address, as given and allowed. */
  view: [string, string][]
  /** The detail tab to show the opened object at: only one that reads. */
  tab?: ReadingTab
  /** What was left out, as the page calls it. */
  left: string[]
}

/** The detail tabs a link may open at: those that only read. Never a shell, attach, a forward. */
export const READING_TABS = [
  'overview',
  'pods',
  'logs',
  'metrics',
  'events',
  'map',
  'audit',
  'yaml',
] as const
export type ReadingTab = (typeof READING_TABS)[number]

/** The pages of a cluster a link may go to, past its lists (by plural) and custom kinds' (`r/…`). */
const PAGES = new Set([
  '',
  'workloads',
  'metrics',
  'metrics/right-sizing',
  'alerts',
  'helm',
  'api-resources',
  'plugins',
])

/** What a view keeps in the address that a link may carry, each checked, and as people call it. */
const VIEW: Record<string, { said: string; ok: (value: string) => boolean }> = {
  open: { said: 'the object opened', ok: (value) => objectRef(value) !== undefined },
  q: { said: 'the filter', ok: (value) => value.length <= 200 && plain(value) },
  labels: { said: 'the label selector', ok: (value) => value.length <= 1_024 && isSelector(value) },
  namespaces: { said: 'the namespaces', ok: (value) => value.split(',').every(isNamespace) },
  ns: { said: 'the namespace listed', ok: isNamespace },
  health: { said: 'the health filter', ok: (value) => /^[a-z]+(,[a-z]+)*$/.test(value) },
  sort: { said: 'the order', ok: (value) => /^[\w.-]{1,64}$/.test(value) },
  desc: { said: 'the order', ok: (value) => value === '1' || value === 'true' },
  page: { said: 'the page of the list', ok: (value) => /^\d{1,6}$/.test(value) },
  size: { said: 'the rows per page', ok: (value) => /^\d{1,4}$/.test(value) },
  name: { said: 'the object listed', ok: isObjectName },
  plugin: { said: 'the plugin', ok: isPluginName },
  as: { said: 'the timeline', ok: (value) => value === 'timeline' || value === 'list' },
  metric: { said: 'the metric', ok: (value) => /^[a-z]{1,16}$/.test(value) },
  by: { said: 'the grouping', ok: (value) => /^[a-z]{1,16}$/.test(value) },
  top: { said: 'the series shown', ok: (value) => /^\d{1,3}$/.test(value) },
  view: { said: 'the chart', ok: (value) => /^[a-z]{1,16}$/.test(value) },
  range: { said: 'the time range', ok: (value) => /^\d{1,3}[mhd]$/.test(value) },
  from: { said: 'the time range', ok: (value) => /^\d{1,15}$/.test(value) },
  to: { said: 'the time range', ok: (value) => /^\d{1,15}$/.test(value) },
  back: { said: 'the time range', ok: (value) => /^\d{1,3}[mhd]$/.test(value) },
  alert: { said: 'the alert opened', ok: (value) => value.length <= 253 && plain(value) },
  release: { said: 'the release opened', ok: (value) => value.length <= 253 && plain(value) },
}

/** A range back from now (`15m`, `6h`, `7d`), in milliseconds. */
function spanOf(back: string): number {
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[back.at(-1) as 'm' | 'h' | 'd']
  return Number(back.slice(0, -1)) * unit
}

/** No control characters (bidi and zero-width ones are shown as their text where they're said). */
function plain(value: string): boolean {
  return ![...value].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
}

/** A namespace's name: a DNS label. */
export function isNamespace(value: string): boolean {
  return /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(value)
}

/** An object's name, as the API server takes them at most: no slash, nothing that hides. */
export function isObjectName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 253 &&
    !value.includes('/') &&
    plain(value) &&
    value !== '.' &&
    value !== '..'
  )
}

function isPluginName(value: string): boolean {
  return /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(value)
}

/** A kind Lumovi lists: a built-in one, or a custom one as `Kind.group`. */
const isKind = (value: string) =>
  isBuiltinKind(value) ||
  /^[A-Z][A-Za-z0-9]{0,62}\.[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(value)

/** `open`'s `Kind/namespace/name`, each part checked. */
export function objectRef(
  value: string,
): { kind: string; namespace?: string; name: string } | undefined {
  const parts = value.split('/')
  if (parts.length !== 3) return undefined
  const [kind, namespace, name] = parts as [string, string, string]
  if (!isKind(kind) || !isObjectName(name) || (namespace !== '' && !isNamespace(namespace))) {
    return undefined
  }
  return { kind, ...(namespace ? { namespace } : {}), name }
}

const LABEL_KEY =
  /^([a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/
const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/

/** Whether `value` is a label selector as Kubernetes takes them (`app=web,tier in (a,b),!old`). */
export function isSelector(value: string): boolean {
  // Requirements, split at the commas outside a set's parentheses.
  const requirements: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++
    else if (value[i] === ')') depth--
    else if (value[i] === ',' && depth === 0) {
      requirements.push(value.slice(start, i))
      start = i + 1
    }
    if (depth < 0 || depth > 1) return false
  }
  if (depth !== 0) return false
  requirements.push(value.slice(start))
  return requirements.every((requirement) => {
    const text = requirement.trim()
    const set = /^(\S+)\s+(in|notin)\s+\(([^()]*)\)$/.exec(text)
    if (set) {
      return LABEL_KEY.test(set[1]!) && set[3]!.split(',').every((v) => LABEL_VALUE.test(v.trim()))
    }
    const equal = /^([^=!\s]+)\s*(==|=|!=)\s*(\S*)$/.exec(text)
    if (equal) return LABEL_KEY.test(equal[1]!) && LABEL_VALUE.test(equal[3]!)
    return LABEL_KEY.test(text.replace(/^!/, ''))
  })
}

/** Whether `page` (below the cluster) is one a link may go to; a plugin's own pages take no view. */
function pageOf(segments: string[]): { page: string; plugin: boolean } | undefined {
  const page = segments.join('/')
  if (PAGES.has(page)) return { page, plugin: false }
  const [first, second, third, ...rest] = segments
  if (segments.length === 1 && resourceByPlural(first!)) return { page, plugin: false }
  if (first === 'r' && segments.length === 2 && isKind(second!) && !builtinResource(second!)) {
    return { page, plugin: false }
  }
  if (first === 'plugins' && isPluginName(second ?? '') && rest.length === 0) {
    if (third === undefined || /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(third)) {
      return { page, plugin: true }
    }
  }
  return undefined
}

/** A link refused, and why, in a sentence. */
export class LinkRefused extends Error {}

/** Reads a link: where it goes and what of it is left out. Throws `LinkRefused` with the reason. */
export function parseLink(text: string): Link {
  if (text.length > LINK_MAX) throw new LinkRefused('it’s longer than 4 KB.')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new LinkRefused('it isn’t written as a link is.')
  }
  if (url.protocol !== `${LINK_SCHEME}:`) throw new LinkRefused('it isn’t a link to a cluster.')
  if (url.username || url.password) throw new LinkRefused('it names a user or a password.')
  if (url.port) throw new LinkRefused('it names a port, and a link never does.')
  if (url.hostname !== 'cluster') throw new LinkRefused('it isn’t a link to a cluster.')
  let segments: string[]
  try {
    // Each part as it's given, decoded once: a context's name may hold a slash (an ARN).
    segments = url.pathname.split('/').slice(1).map(decodeURIComponent)
  } catch {
    throw new LinkRefused('it isn’t written as a link is.')
  }
  const [context, ...below] = segments
  if (!context || context.length > 512 || !plain(context)) {
    throw new LinkRefused('its cluster isn’t named as Lumovi names one.')
  }
  // A trailing slash, as some places add to a link: the same page.
  if (below.at(-1) === '') below.pop()
  if (below.some((segment) => segment === '' || segment.includes('/') || !plain(segment))) {
    throw new LinkRefused('its page isn’t one a link can open.')
  }
  const found = pageOf(below)
  if (!found) throw new LinkRefused('its page isn’t one a link can open.')

  const at = url.searchParams.get('at') ?? undefined
  if (at !== undefined && !/^[0-9a-f]{12}$/.test(at)) {
    throw new LinkRefused('it isn’t written as a link is.')
  }
  const view: [string, string][] = []
  const left = new Set<string>()
  let tab: ReadingTab | undefined
  for (const [key, value] of url.searchParams) {
    if (key === 'at') continue
    // (What the link wrote is never said back: a key or a tab Lumovi doesn't know is said in
    // Lumovi's words alone, or the card would say what a link chose, as if Lumovi did.)
    if (key === 'tab') {
      if ((READING_TABS as readonly string[]).includes(value)) tab = value as ReadingTab
      else left.add('a tab Lumovi doesn’t open')
      continue
    }
    // (An object Kubernetes couldn't have: refused whole, as a link that isn't written as one.)
    if (key === 'open' && objectRef(value) === undefined) {
      throw new LinkRefused('an object’s name in it isn’t one Kubernetes allows.')
    }
    const allowed = VIEW[key]
    // A plugin's own page gets nothing but its name and its page.
    if (!found.plugin && allowed?.ok(value) && !view.some(([k]) => k === key)) {
      view.push([key, value])
    } else {
      left.add(allowed?.said ?? 'a part Lumovi doesn’t know')
    }
  }
  // A zoomed time range is within the range it was zoomed from, as the page's own is: or it's
  // left out whole (a `from` of decades ago would ask the metrics source for decades).
  const timed = view.filter(([key]) => key === 'from' || key === 'to' || key === 'back')
  if (timed.length > 0) {
    const at = (key: string) => timed.find(([k]) => k === key)?.[1]
    const [from, to, back] = [Number(at('from')), Number(at('to')), at('back')]
    const span = back ? spanOf(back) : 0
    if (!(from > 0 && to > from && to - from <= span)) {
      for (const each of timed) view.splice(view.indexOf(each), 1)
      left.add('the time range')
    }
  }
  if (tab && !view.some(([key]) => key === 'open')) {
    left.add('the tab')
    tab = undefined
  }
  return {
    context,
    ...(at ? { at } : {}),
    page: found.page,
    view,
    ...(tab ? { tab } : {}),
    left: [...left],
  }
}

/**
 * The link to a view of the app, from its address (`/cluster/<context>/<page>?<query>`), cut to
 * what a link may carry; with the tab its object shows and the cluster's fingerprint.
 */
export function linkFor(address: string, options: { at?: string; tab?: string } = {}): string {
  const [path = '', query = ''] = address.split('?')
  const segments = path.split('/').slice(1)
  if (segments[0] !== 'cluster' || !segments[1]) throw new LinkRefused('it isn’t a cluster’s view.')
  const link = new URL(`${LINK_SCHEME}://cluster/${segments.slice(1).join('/')}`)
  for (const [key, value] of new URLSearchParams(query)) link.searchParams.append(key, value)
  if (options.tab) link.searchParams.set('tab', options.tab)
  if (options.at) link.searchParams.set('at', options.at)
  // What a link may carry, and nothing else: read back as it would be read.
  const read = parseLink(link.href)
  const made = new URL(`${LINK_SCHEME}://cluster/${segments.slice(1).join('/')}`)
  for (const [key, value] of read.view) made.searchParams.append(key, value)
  if (read.tab) made.searchParams.set('tab', read.tab)
  if (read.at) made.searchParams.set('at', read.at)
  return made.href
}

/** Where a link goes in the app's address: its page and its view, without the tab or `at`. */
export function addressOf(link: Link, context: string): string {
  const query = new URLSearchParams(link.view).toString()
  const page = link.page ? `/${link.page}` : ''
  return `/cluster/${encodeURIComponent(context)}${page}${query ? `?${query}` : ''}`
}

/** Which cluster here a link names: by its fingerprint, then by its name. */
export type LinkMatch =
  /** The one with its fingerprint (of several, the one of its name). */
  | { found: 'one'; context: string }
  /** Several with its fingerprint, none of its name: the person chooses. */
  | { found: 'several'; contexts: string[] }
  /** None with its fingerprint (or it has none), but one of its name: at another address. */
  | { found: 'elsewhere'; context: string }
  | { found: 'none' }

/** A link handed to Lumovi, as the window in front gets it: read and matched, or refused. */
export type LinkArrival = ({ refused: string } | { link: Link; match: LinkMatch }) & {
  /**
   * Its window wasn't the one in use as it came (another app was, where the person may be
   * typing): the card waits to be gone to, with ⌘L or a click.
   */
  elsewhere?: true
}

/** A link handed over by a second Lumovi, from what it read of its own command line. */
export function handedLink(data: unknown): string | undefined {
  const link = typeof data === 'object' && data !== null ? (data as { link?: unknown }).link : null
  return typeof link === 'string' && link.toLowerCase().startsWith(`${LINK_SCHEME}:`)
    ? link
    : undefined
}

/** The cluster here that `link` names, of `here` (each context, and its cluster's fingerprint). */
export function matchLink(link: Link, here: readonly { name: string; at?: string }[]): LinkMatch {
  const same = link.at ? here.filter((context) => context.at === link.at) : []
  const named = here.find((context) => context.name === link.context)
  if (same.length === 1) return { found: 'one', context: same[0]!.name }
  if (same.length > 1) {
    return named && same.includes(named)
      ? { found: 'one', context: named.name }
      : { found: 'several', contexts: same.map((context) => context.name) }
  }
  return named ? { found: 'elsewhere', context: named.name } : { found: 'none' }
}

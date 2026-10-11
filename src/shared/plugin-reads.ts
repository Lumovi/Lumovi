/**
 * The door, for reading: what a plugin's code may ask Lumovi to read from the cluster, and what
 * it's handed. Three things, all plain:
 *
 * - the grammar of an ask (`readAsk`): a list kept up to date, one object, an object's events,
 *   its usage; or the end of one, or a refresh. Anything else stops the plugin;
 * - the grant's check (`granted`): a plugin's file says what it reads (`spec.reads`), kind by
 *   kind; what isn't said there is refused, where the read is made and never on the page;
 * - the picking (`picked`): of an object of Kubernetes' own, a plugin is handed the fields its
 *   file names and nothing else, so the page never holds more than the plugin may have.
 *
 * And the counting (`PageReads`): how many lists a page keeps, how fast it asks.
 */
import type { Step } from './jsonpath'
import type { Stopped } from './plugin-door'
import { isCustomGroup } from './resources'

/**
 * What reading is held to. First lines, as the door's own: what settles them is a real plugin's
 * page on a large cluster. Over any of them the plugin is stopped.
 */
export const READ_LIMITS = {
  /** Lists kept up to date at once: by one page, and by all of a plugin's pages. */
  listsAPage: 8,
  listsAPlugin: 16,
  /** Everything a page keeps going at once: lists, objects, events and usage together. (Each
   *  is a watch on the cluster in the person's name.) */
  keptAPage: 50,
  keptAPlugin: 100,
  /** Asks in a second, and asks not yet answered. */
  asksASecond: 10,
  waiting: 20,
  /** A refresh a plugin asks for: no oftener than this, a page. (One too soon isn't made; it
   *  doesn't stop the plugin: a person's second press mustn't end a page. It's still one of its
   *  second's asks, so it can't be used to knock on the door without end.) */
  refreshEveryMs: 10_000,
} as const

/** What a plugin's file says it reads of one kind (the file checker makes these). */
export interface Granted {
  /** Each path as written, and its steps: field names only. */
  fields: readonly { path: string; steps: readonly Step[] }[]
  /** The object's status as Lumovi shows it. */
  status: boolean
  /** The events of an object of this kind. */
  events: boolean
  /** Its usage as Lumovi shows it. */
  usage: boolean
}

/** What a plugin may read: its own kinds whole, and of Kubernetes' own what its file names. */
export interface Grant {
  /** The kinds it claims (`group/Kind`): read whole. */
  own: readonly string[]
  /** By kind (`group/Kind`; the core group: `/Kind`). */
  reads: Readonly<Record<string, Granted>>
}

/** What a plugin's code asks. `read` is the ask's own number: new, as a part's is. */
export type ReadAsk =
  /** Every object of a kind (in a namespace, or all it may see), kept up to date. */
  | { read: number; what: 'list'; kind: string; namespace?: string }
  /** One object, kept up to date. */
  | { read: number; what: 'object'; kind: string; namespace?: string; name: string }
  /** The events, or the usage, of an object Lumovi handed it: named by Lumovi's token for it. */
  | { read: number; what: 'events' | 'usage'; of: string }
  /** The end of a read it began. */
  | { stop: number }
  /** Its lists read again from the cluster. */
  | { refresh: true }

/** `group/Kind`: a group's name (none for the core group), a slash, a kind's. */
const KIND = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)?\/[A-Z][A-Za-z0-9]{0,62}$/
/** A namespace's or an object's name, as Kubernetes has them. */
const NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/
/** An object's token, as the door gives them out. */
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const has = (value: object, ...keys: string[]) => {
  const own = Object.keys(value)
  return own.every((key) => keys.includes(key))
}
const notAllowed = (what: string): Stopped => ({ why: 'not-allowed', what })
const tooMuch = (what: string, most: number): Stopped => ({
  why: 'too-much',
  what: `${what}: more than ${most.toLocaleString('en-US')}`,
})

/**
 * A message of a plugin's (read from its text already) as an ask to read, or why it isn't one.
 * Exactly the keys an ask has, each of its kind: nothing is guessed and nothing is passed on.
 */
export function readAsk(message: unknown): ReadAsk | Stopped {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return notAllowed('an ask that isn’t one')
  }
  const said = message as Record<string, unknown>
  if (Object.hasOwn(said, 'stop')) {
    return has(said, 'stop') && isNumber(said.stop)
      ? { stop: said.stop }
      : notAllowed('ends a read it doesn’t name')
  }
  if (Object.hasOwn(said, 'refresh')) {
    return has(said, 'refresh') && said.refresh === true
      ? { refresh: true }
      : notAllowed('an ask that isn’t one')
  }
  if (!Object.hasOwn(said, 'read') || !isNumber(said.read)) {
    return notAllowed('an ask that isn’t one')
  }
  const read = said.read
  switch (Object.hasOwn(said, 'what') ? said.what : undefined) {
    case 'list':
    case 'object': {
      const one = said.what === 'object'
      if (!has(said, 'read', 'what', 'kind', 'namespace', ...(one ? ['name'] : []))) {
        return notAllowed('an ask with something it doesn’t take')
      }
      if (typeof said.kind !== 'string' || !KIND.test(said.kind)) {
        return notAllowed('asks for a kind that isn’t one')
      }
      const namespace = Object.hasOwn(said, 'namespace') ? said.namespace : undefined
      if (namespace !== undefined && (typeof namespace !== 'string' || !NAME.test(namespace))) {
        return notAllowed('asks in a namespace that isn’t one')
      }
      const within = namespace === undefined ? {} : { namespace }
      if (!one) return { read, what: 'list', kind: said.kind, ...within }
      const name = Object.hasOwn(said, 'name') ? said.name : undefined
      if (typeof name !== 'string' || !NAME.test(name)) {
        return notAllowed('asks for an object by a name that isn’t one')
      }
      return { read, what: 'object', kind: said.kind, ...within, name }
    }
    case 'events':
    case 'usage': {
      if (!has(said, 'read', 'what', 'of')) {
        return notAllowed('an ask with something it doesn’t take')
      }
      const of = Object.hasOwn(said, 'of') ? said.of : undefined
      if (typeof of !== 'string' || !TOKEN.test(of)) {
        return notAllowed('asks about an object Lumovi didn’t hand it')
      }
      return { read, what: said.what as 'events' | 'usage', of }
    }
    default:
      return notAllowed('an ask that isn’t one')
  }
}

/**
 * A kind as Lumovi resolved it: the resource it will really read, never the text of an ask.
 * Every rule about a kind here is asked of one of these. (An ask says "group/Kind" in a
 * plugin's own spelling; what that names in the cluster is Lumovi's to find, and a rule asked
 * of the spelling is a rule a second spelling walks round.)
 */
export interface ResolvedKind {
  /** The resource's API group, as the cluster serves it; none for the core group. */
  readonly group: string
  readonly kind: string
  readonly [RESOLVED]: true
}
declare const RESOLVED: unique symbol

/**
 * Says a kind is resolved. Only where Lumovi has looked the resource up (the main process, the
 * server), with the group and kind the cluster gave: never with what a plugin wrote.
 */
export const resolvedAs = (group: string, kind: string) => ({ group, kind }) as ResolvedKind

/** A resolved kind as a grant names it: `group/Kind`. */
const idOf = ({ group, kind }: ResolvedKind) => `${group}/${kind}`

/** Never read by a plugin's code, whatever a file says: checked here as well as there. */
const never = (kind: ResolvedKind) => kind.group === '' && kind.kind === 'Secret'

/** What a plugin is handed of a kind's objects: all of each, or the fields its file names. */
export type Handed = { whole: true } | { whole: false; granted: Granted }

/**
 * Whether `grant` lets a plugin have `what` of `kind`'s objects, and then how much of each:
 * `objects` is a list or one object; `status`, `events` and `usage` are those of an object.
 * Nothing means no: what a file doesn't say is refused. (Refused, with a code: not a reason to
 * stop the plugin. One written for a newer grant than its file's shouldn't lose its page for
 * asking.)
 */
export function granted(
  grant: Grant,
  kind: ResolvedKind,
  what: 'objects' | 'status' | 'events' | 'usage',
): Handed | undefined {
  if (never(kind)) return undefined
  const id = idOf(kind)
  // Its own kinds, whole: everything of them. A tool's kinds only: one of Kubernetes' own is
  // never whole, whatever claims it.
  if (isCustomGroup(kind.group) && grant.own.includes(id)) return { whole: true }
  const said = Object.hasOwn(grant.reads, id) ? grant.reads[id] : undefined
  // Events, status and usage are read only of things whose objects it may see at all.
  if (!said || said.fields.length === 0) return undefined
  return what === 'objects' || said[what] ? { whole: false, granted: said } : undefined
}

/** A step that's never taken, in any path: the names every object answers to. */
const NEVER_STEPS = new Set(['__proto__', 'constructor', 'prototype'])
/**
 * What's never in what's handed over, at any depth, whoever names it: a container's environment
 * (the commonest place a credential sits outside a Secret), who manages which field, and the
 * annotations a tool keeps for itself, the one that holds the object as it was last applied
 * among them (for a ConfigMap its data, for a Pod its environment).
 */
const NEVER_HANDED = new Set(['env', 'managedFields'])
const NEVER_ANNOTATIONS = /^(?:kubectl\.kubernetes\.io|control-plane\.alpha\.kubernetes\.io)\//
const neverHanded = (key: string) =>
  NEVER_HANDED.has(key) || NEVER_STEPS.has(key) || NEVER_ANNOTATIONS.test(key)
/**
 * Where a path can't end: it would hand over far more than it names. All of an object's
 * metadata or annotations (one annotation by its key is fine), all of a spec, a list of
 * containers, a template.
 */
const NEVER_WHOLE = new Set([
  'metadata',
  'annotations',
  'spec',
  'containers',
  'initContainers',
  'ephemeralContainers',
  'template',
  'jobTemplate',
])

/** Whether a path may be handed over at all (the file checker refuses these; so does the door). */
function mayBePicked(
  steps: readonly Step[],
  kind: ResolvedKind,
): steps is readonly { key: string }[] {
  if (steps.length === 0) return false
  if (!steps.every((step) => 'key' in step && !neverHanded(step.key))) return false
  const keys = (steps as readonly { key: string }[]).map((step) => step.key)
  // (What a ConfigMap holds is a permission of its own, which no file can say yet.)
  const held = kind.group === '' && kind.kind === 'ConfigMap'
  if (held && (keys[0] === 'data' || keys[0] === 'binaryData')) return false
  return !NEVER_WHOLE.has(keys.at(-1)!)
}

/** The paths a plugin may have, as a tree of field names: `whole` where one ends. */
interface Named {
  whole: boolean
  under: Map<string, Named>
}

/** A copy of `value` with nothing in it that's never handed over. */
function handedOver(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(handedOver)
  if (typeof value !== 'object' || value === null) return value
  const copy: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    if (!neverHanded(key)) copy[key] = handedOver((value as Record<string, unknown>)[key])
  }
  return copy
}

/**
 * Of `value`, what `named` names. A step into a list is taken of each item: the list's shape is
 * kept, and of each item only what's named.
 */
function pick(value: unknown, named: Named): unknown {
  if (named.whole) return handedOver(value)
  if (Array.isArray(value)) return value.map((item) => pick(item, named) ?? {})
  if (typeof value !== 'object' || value === null) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, under] of named.under) {
    if (!Object.hasOwn(value, key)) continue
    const found = pick((value as Record<string, unknown>)[key], under)
    if (found !== undefined) out[key] = found
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Of `object` (one of `kind`), the fields `granted` names and nothing else: built from what the
 * plugin may see, field by field, never from the object with things taken out. A copy, so
 * nothing that holds it holds what was read. Own fields only; a path that isn't there leaves
 * nothing.
 */
export function picked(
  object: unknown,
  kind: ResolvedKind,
  { fields }: Granted,
): Record<string, unknown> {
  if (never(kind) || Array.isArray(object)) return {}
  const root: Named = { whole: false, under: new Map() }
  for (const { steps } of fields) {
    if (!mayBePicked(steps, kind)) continue
    let at = root
    for (const { key } of steps) {
      let next = at.under.get(key)
      if (!next) at.under.set(key, (next = { whole: false, under: new Map() }))
      at = next
    }
    // (Where a path and one under it are both named, the shorter one has it all.)
    at.whole = true
  }
  return (pick(object, root) as Record<string, unknown> | undefined) ?? {}
}

/** What all of a plugin's pages keep between them: counted in one place. */
export interface PluginCount {
  lists: number
  /** Everything kept going: lists, objects, events and usage together. */
  kept: number
}

/**
 * A page's reads, counted: which are going, how fast it asks. `now` is a clock in milliseconds
 * that only goes forward.
 */
export class PageReads {
  readonly #plugin: PluginCount
  readonly #now: () => number
  /** Reads going, by their number: whether each is a list kept up to date. */
  readonly #going = new Map<number, { list: boolean; answered: boolean }>()
  #newest = 0
  #second = { since: 0, asks: 0 }
  #refreshed: number | undefined

  constructor(plugin: PluginCount, now: () => number = () => performance.now()) {
    this.#plugin = plugin
    this.#now = now
  }

  /**
   * Counts an ask: nothing if it may be made, `'too-soon'` for a refresh that isn't made, or why
   * the plugin is stopped.
   */
  take(ask: ReadAsk): undefined | 'too-soon' | Stopped {
    const now = this.#now()
    if (now - this.#second.since >= 1000 || now < this.#second.since) {
      this.#second = { since: now, asks: 0 }
    }
    if (++this.#second.asks > READ_LIMITS.asksASecond) {
      return tooMuch('asks in a second', READ_LIMITS.asksASecond)
    }
    if ('refresh' in ask) {
      if (this.#refreshed !== undefined && now - this.#refreshed < READ_LIMITS.refreshEveryMs) {
        return 'too-soon'
      }
      this.#refreshed = now
      return undefined
    }
    if ('stop' in ask) {
      // A read never asked for can't be ended. One that was, and isn't going any more (Lumovi
      // refused it, or it was ended already), has nothing to end: messages cross.
      if (ask.stop > this.#newest) return notAllowed('ends a read it never asked for')
      this.#forget(ask.stop)
      return undefined
    }
    if (ask.read <= this.#newest) return notAllowed('asks under a number that isn’t new')
    this.#newest = ask.read
    const waiting = [...this.#going.values()].filter((read) => !read.answered).length
    if (waiting >= READ_LIMITS.waiting) return tooMuch('asks not yet answered', READ_LIMITS.waiting)
    if (this.#going.size >= READ_LIMITS.keptAPage) {
      return tooMuch('reads a page keeps going', READ_LIMITS.keptAPage)
    }
    if (this.#plugin.kept >= READ_LIMITS.keptAPlugin) {
      return tooMuch('reads a plugin keeps going', READ_LIMITS.keptAPlugin)
    }
    const list = ask.what === 'list'
    if (list) {
      const mine = [...this.#going.values()].filter((read) => read.list).length
      if (mine >= READ_LIMITS.listsAPage)
        return tooMuch('lists a page keeps', READ_LIMITS.listsAPage)
      if (this.#plugin.lists >= READ_LIMITS.listsAPlugin) {
        return tooMuch('lists a plugin keeps', READ_LIMITS.listsAPlugin)
      }
      this.#plugin.lists++
    }
    this.#plugin.kept++
    this.#going.set(ask.read, { list, answered: false })
    return undefined
  }

  /** A read has its first answer: it no longer waits. */
  answered(read: number): void {
    const going = this.#going.get(read)
    if (going) going.answered = true
  }

  /**
   * A read that was refused, or failed: it isn't going. (An ask for what a file doesn't grant
   * is refused with a code and counted among its second's asks; it doesn't stop the plugin: one
   * written for a newer grant than its file's shouldn't lose its page for asking.)
   */
  refused(read: number): void {
    this.#forget(read)
  }

  /** The page is gone: nothing of it is going, and its lists are no longer the plugin's. */
  close(): void {
    for (const read of [...this.#going.keys()]) this.#forget(read)
  }

  #forget(read: number): void {
    const going = this.#going.get(read)
    if (!going) return
    if (going.list) this.#plugin.lists--
    this.#plugin.kept--
    this.#going.delete(read)
  }
}

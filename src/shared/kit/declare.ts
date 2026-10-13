/**
 * How a part of the kit is declared: what a plugin may say to have Lumovi draw one. A
 * declaration is data and nothing else, so the same one is read by the door (which checks what
 * a plugin's code sends, as it arrives), by the checker of plugins, by the kit's own types
 * (`PropsOf`, worked out from it and never written beside it) and by the pages for whoever
 * writes a plugin.
 *
 * A part's properties are each one of a small set of kinds, every one with its limits. Nothing
 * a plugin sends is a class, a style, an address, markup or code: there's no kind for them.
 */

import { HEALTH_RANK, type Health } from '../health'
import { NAMESPACE_NAME } from '../node-shell'
import { quotedBack } from './characters'

/** A kind of value a property (or what a call carries) can be. */
export type Kind =
  /** Plain text, at most `max` characters. */
  | { kind: 'text'; max: number }
  /** A number from `min` to `max`; a whole one, if `whole`. */
  | { kind: 'number'; min: number; max: number; whole?: boolean }
  | { kind: 'yes-or-no' }
  /** One of a set Lumovi lists. */
  | { kind: 'one-of'; values: readonly string[] }
  /** A moment, as text (RFC 3339): Lumovi draws how long ago it was, a plugin never does. */
  | { kind: 'time' }
  /** An object in the cluster, as Lumovi named it to the plugin: its token, nothing more. */
  | { kind: 'object' }
  /** A Secret Lumovi shows by reference: on the wire a token of its own sort, never an object's. */
  | { kind: 'secret' }
  /**
   * A read Lumovi cut at its limit, as the door named it in the read's answer: its token, never
   * numbers a plugin wrote. Lumovi says what was cut, from the door's own.
   */
  | { kind: 'cut' }
  /**
   * A list of Lumovi's own a part opens: one kind, with a health filter or a label selector, as a
   * plugin writes it (`{ list: 'karpenter.sh/NodePool', health: ['critical'] }`). Or one of
   * Lumovi's own places for an object the page was handed, where its file says its pages link
   * to it (`{ object: <token>, at: 'shell', container: 'postgres' }`). The part is handed a
   * destination the door made (`ListDestination`, `ReachDestination`), never the plugin's words;
   * no address, path, namespace or field selector is any part of it.
   */
  | { kind: 'destination' }
  /** A handler: when it's called, the plugin is told, with what the part's event says. */
  | { kind: 'handler'; event: string }
  /** A list of one kind, at most `max` long. */
  | { kind: 'list'; of: Kind; max: number }
  /** Named values, each of its kind; one not in `required` may be left out. */
  | { kind: 'record'; fields: Readonly<Record<string, Kind>>; required?: readonly string[] }
  /**
   * One of several records, told apart by the text in its `by` field (a cell that's a text, a
   * number or a meter, say): each choice's own named values beside it, all of them required
   * unless the choice's `optional` names them.
   */
  | {
      kind: 'choice'
      by: string
      of: Readonly<Record<string, Readonly<Record<string, Kind>>>>
      optional?: Readonly<Record<string, readonly string[]>>
    }

/** A part, declared. */
export interface Part {
  /** Its name, as a plugin says it. */
  name: string
  /** What may be inside it: nothing, text, or parts (any, or only those named). */
  holds: 'nothing' | 'text' | 'parts' | readonly string[]
  /**
   * How many it may hold at once, where that's fewer than any part may: a card holds one thing.
   * One more is refused, as anything a page can't say is: a part never draws some of what it
   * holds and leaves the rest.
   */
  holdsMost?: number
  /**
   * How many it holds at the least, on the page: a pair is two. Asked of a commit when it's
   * whole (what it holds is put in one step at a time), and of what's on the page: one that's
   * still being put together, off it, holds what it holds so far.
   */
  holdsLeast?: number
  /** Its properties: each a kind; one not in `required` may be left out. */
  props: Readonly<Record<string, Kind>>
  required?: readonly string[]
  /** What its handlers are called with, by event: named values, each of its kind. */
  events?: Readonly<Record<string, Readonly<Record<string, Kind>>>>
  /**
   * What the kinds can't say, of properties that already passed them: one thing agreeing with
   * another (a cell for every column, a key used once). What's wrong, or nothing. Whatever a
   * part would throw on is refused here or by a kind: a description that passes and still makes
   * a part fail is a fault of Lumovi's, and a plugin must never be able to cause one.
   */
  also?: (props: Readonly<Record<string, unknown>>) => string | undefined
  /**
   * Whether a press may go to the plugin, by what the part was drawn with: what an event carries
   * can pass its kinds and still name what isn't there to press now (a button that's off, or
   * gone). Without it, every press its kinds pass may.
   */
  heeds?: (props: Readonly<Record<string, unknown>>, event: string, carries: unknown) => boolean
  /**
   * How many of it one page may have, made and not yet taken away, where that's fewer than any
   * part may: one that's heavy to draw, or reads something of its own for each.
   */
  most?: number
  /** A ceiling it counts against with other parts (`shared`). */
  counts?: Shared
}

/**
 * A ceiling parts count against together: how many of all of them one page may have, made and
 * not yet taken away (the live things they each open, say). Known by its name, which is also how
 * a page that goes over it is told: parts that name one ceiling count against one, and must say
 * the same of it (`wrongWithParts`).
 */
export interface Shared {
  readonly name: string
  readonly most: number
}
export const shared = (name: string, most: number): Shared => Object.freeze({ name, most })

/**
 * A text, `max` characters at most. Any character is taken (most of a page's texts are what's in
 * the cluster); a part draws a text of a plugin's in pieces (`inPieces`), so one that can't be
 * seen shows as a mark of Lumovi's.
 */
export const text = (max: number) => ({ kind: 'text', max }) as const
export const number = (min: number, max: number, whole = false) =>
  ({ kind: 'number', min, max, ...(whole && { whole }) }) as { kind: 'number' } & Kind
export const yesOrNo = { kind: 'yes-or-no' } as const
export const oneOf = <const V extends readonly string[]>(values: V) =>
  ({ kind: 'one-of', values }) as const
export const time = { kind: 'time' } as const
export const object = { kind: 'object' } as const
export const secret = { kind: 'secret' } as const
export const cut = { kind: 'cut' } as const
export const destination = { kind: 'destination' } as const
export const handler = <const E extends string>(event: E) => ({ kind: 'handler', event }) as const
/**
 * A list. (Of objects, an item whose token the page doesn't hold is left out, so the list can
 * be shorter than it was written: never pair one list's places with another's. Where a place
 * matters, a record per place keeps it and only loses the field.)
 */
export const list = <const K extends Kind>(of: K, max: number) =>
  ({ kind: 'list', of, max }) as const
/** (Which are required is kept in its type: a part is handed them as always there.) */
export const record = <
  const F extends Record<string, Kind>,
  const R extends readonly (keyof F & string)[] = readonly [],
>(
  fields: F,
  required: R = [] as unknown as R,
) => ({ kind: 'record', fields, required }) as const
export const choice = <
  const By extends string,
  const Of extends Record<string, Record<string, Kind>>,
  const O extends { readonly [W in keyof Of]?: readonly (keyof Of[W] & string)[] } = Record<
    never,
    never
  >,
>(
  by: By,
  of: Of,
  optional: O = {} as O,
  // (Its type taken from what's written alone: inside a record's fields, a choice left to its
  // default would otherwise take the fields' own wide type, and hand every value as maybe missing.)
) => ({ kind: 'choice', by, of, optional: optional as NoInfer<O> }) as const

/** An object in the cluster as a part of Lumovi's is handed it: never what a plugin wrote. */
export interface ObjectRef {
  kind: string
  name: string
  namespace?: string
}

/** A Secret as a part that shows one is handed it: which, and the keys it may show. */
export interface SecretRef {
  namespace: string
  name: string
  keys: readonly string[]
  /**
   * What named it: the object (of one of the plugin's own kinds, in the Secret's namespace) and
   * the path its file declares. A press sends it, and the backend holds the read to it: that
   * object names this Secret there, and only that item's keys are read.
   */
  namedBy?: SecretNamedBy
}

/** A read cut at Lumovi's limit, as the door made it: how many were read, of how many there are. */
export interface CutRef {
  readonly at: number
  readonly of?: number
}

/** The object that names a Secret, by Lumovi's name for its kind, and the declared path. */
export interface SecretNamedBy {
  kind: string
  name: string
  path: string
}

/**
 * What the door puts in the place of what a plugin could only name: the object for an object's
 * token, the Secret for a Secret's, a function for a handler's handle. Each gives nothing for a
 * token this page doesn't hold (made up, or gone with the read that brought it): the property
 * is then simply absent, as if the plugin hadn't said it.
 */
export interface Swap {
  object(token: string): ObjectRef | undefined
  secret(token: string): SecretRef | undefined
  cut(token: string): CutRef | undefined
  /**
   * Nothing for a kind its plugin's file doesn't name; nor for a place its file doesn't say its
   * pages link to, or an object that place isn't for.
   */
  destination(
    said: WrittenDestination | WrittenReach,
  ): ListDestination | ReachDestination | undefined
  handler(handle: string, event: string): ((carries: unknown) => void) | undefined
}

/** A list of Lumovi's own, as a part is handed it: made by the door, frozen, and opened by `go`. */
export interface ListDestination {
  to: 'list'
  /** The kind, as Lumovi names it (`NodePool.karpenter.sh`, `Node`). */
  kind: string
  health?: readonly Health[]
  /** Label selector terms: a key (objects that have it), or `key=value`. */
  labels?: readonly string[]
  /**
   * One object of it, by its exact name, and its namespace where the plugin says one: a list of
   * that one alone, for a kind its plugin's file says its pages open (`spec.opens`).
   */
  name?: string
  namespace?: string
}

/**
 * Lumovi's own places a plugin's page may link to, for an object it was handed, where its file
 * says so (`spec.links`): the object's Logs tab, its Shell tab, its Port forward dialog. Each is
 * Lumovi's to open as it does today, and the person does there what they do: nothing starts on
 * a link alone.
 */
export const REACHES = ['logs', 'shell', 'port-forward'] as const
export type Reach = (typeof REACHES)[number]

/**
 * One of Lumovi's own places for one object, as a part is handed it: made by the door, frozen,
 * and opened by `go`. The object is one the door handed the page.
 */
export interface ReachDestination {
  to: 'reach'
  at: Reach
  object: ObjectRef
  /** The container picked there (Logs, Shell), as the plugin named it. */
  container?: string
  /** The port filled in (a forward). */
  port?: number
}

/** A link to one of Lumovi's own places, as a plugin writes it: the object by its token. */
export interface WrittenReach {
  object: string
  at: string
  container?: string
  port?: number
}

/** A list to open, as a plugin writes it. */
export interface WrittenDestination {
  list: string
  health?: readonly string[]
  labels?: readonly string[]
  name?: string
  namespace?: string
}

/**
 * A name an object of any kind can have, as Kubernetes' API takes it in a path: 1 to 253
 * characters, not `.` or `..`, nothing unseen, no space, `/` or `%`. (Most kinds are stricter; a
 * role's, `system:controller:…`, isn't.)
 */
export const OBJECT_NAME = /^(?!\.\.?$)[^/%\s\p{C}]{1,253}$/u

/** The levels a list can be filtered by, worst first: Lumovi's own, one list of them. */
const HEALTHS: readonly string[] = Object.keys(HEALTH_RANK)
/** `group/Kind`: a group's name (none for the core group), a slash, a kind's. */
const KIND = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)?\/[A-Z][A-Za-z0-9]{0,62}$/
/** A label's name, or its value, as Kubernetes has them. */
const LABEL_NAME = '[A-Za-z0-9](?:[-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?'
/**
 * A label selector's term, as Kubernetes writes one: a key, its prefix a DNS subdomain if it has
 * one (objects that have it), or `key=value` (the value may be empty). A read's label selector
 * takes the same terms.
 */
export const LABEL_TERM = new RegExp(
  `^(?:[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?/)?${LABEL_NAME}(?:=(?:${LABEL_NAME})?)?$`,
)

/** A container's name, as Kubernetes has one: a DNS label. */
const CONTAINER = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/

/** What's wrong with a link to one of Lumovi's own places, as a plugin wrote it, or nothing. */
function reachProblem(said: Record<string, unknown>, where: string): string | undefined {
  for (const key of Object.keys(said)) {
    if (!['object', 'at', 'container', 'port'].includes(key)) {
      return `${where}: takes nothing named ${quotedBack(key)}`
    }
  }
  if (typeof said.object !== 'string' || !TOKEN.test(said.object)) {
    return `${where}.object: should be an object’s token, as Lumovi handed it`
  }
  if (!REACHES.includes(said.at as Reach)) {
    return `${where}.at: should be one of ${REACHES.join(', ')}`
  }
  if (Object.hasOwn(said, 'container')) {
    if (said.at === 'port-forward') return `${where}.container: goes with logs or shell`
    if (typeof said.container !== 'string' || !CONTAINER.test(said.container)) {
      return `${where}.container: should be a container’s name`
    }
  }
  if (Object.hasOwn(said, 'port')) {
    if (said.at !== 'port-forward') return `${where}.port: goes with port-forward`
    if (
      !Number.isInteger(said.port) ||
      (said.port as number) < 1 ||
      (said.port as number) > 65535
    ) {
      return `${where}.port: should be a port, 1 to 65535`
    }
  }
  return undefined
}

/** What's wrong with a list to open, or a link, as a plugin wrote it, or nothing. */
function destinationProblem(value: unknown, where: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `${where}: should be a list to open, as { list: group/Kind }, or a place for an object, as { object, at }`
  }
  const said = value as Record<string, unknown>
  if (Object.hasOwn(said, 'object')) return reachProblem(said, where)
  for (const key of Object.keys(said)) {
    if (!['list', 'health', 'labels', 'name', 'namespace'].includes(key)) {
      return `${where}: takes nothing named ${quotedBack(key)}`
    }
  }
  if (typeof said.list !== 'string' || !KIND.test(said.list)) {
    return `${where}.list: should be a kind, as group/Kind`
  }
  const some = (items: unknown, most: number) =>
    Array.isArray(items) &&
    items.length >= 1 &&
    items.length <= most &&
    new Set(items).size === items.length
  if (Object.hasOwn(said, 'health')) {
    const health = said.health
    if (
      !some(health, 5) ||
      !(health as unknown[]).every((level) => HEALTHS.includes(level as string))
    ) {
      return `${where}.health: should be one to five of ${HEALTHS.join(', ')}, each once`
    }
  }
  if (Object.hasOwn(said, 'labels')) {
    const labels = said.labels
    if (!some(labels, 4)) return `${where}.labels: should be one to four label terms, each once`
    const wrong = (labels as unknown[]).findIndex(
      (term) => typeof term !== 'string' || !LABEL_TERM.test(term),
    )
    if (wrong >= 0) return `${where}.labels[${wrong}]: isn’t a label, as key or key=value`
  }
  // At one object: its exact name, and its namespace beside it; no other filter.
  if (Object.hasOwn(said, 'name')) {
    if (typeof said.name !== 'string' || !OBJECT_NAME.test(said.name)) {
      return `${where}.name: should be an object’s name, as Kubernetes has one`
    }
    if (Object.hasOwn(said, 'health') || Object.hasOwn(said, 'labels')) {
      return `${where}: a list opened at one name takes no health or labels`
    }
  }
  if (Object.hasOwn(said, 'namespace')) {
    if (!Object.hasOwn(said, 'name')) {
      return `${where}.namespace: goes with a name: a list opens in one namespace only at one object`
    }
    if (typeof said.namespace !== 'string' || !NAMESPACE_NAME.test(said.namespace)) {
      return `${where}.namespace: should be a namespace’s name`
    }
  }
  return undefined
}

/** A moment as Lumovi takes one: a date and a time with its zone, to the second or finer. */
const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/
/** An object's token, or a handler's handle, as the door gives them out: never a name or a path. */
export const TOKEN = /^[A-Za-z0-9_-]{1,64}$/
/** A name a part, a property or an event can have. */
const NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/
/** Never a property's name, whoever declares it: what every object has. */
const NEVER = new Set(['__proto__', 'constructor', 'prototype'])

/** How deep a value may be nested, whatever its kind says: a declaration can't ask for more. */
const DEEPEST = 6

/**
 * What's wrong with `value` as `kind`, or nothing. `where` is said first ("columns[2].label").
 * Only own, plain data passes: what came up the channel was text, read as JSON, so a value is
 * a string, a number, true or false, null, a list or a plain object, and nothing else.
 */
export function wrongWith(
  value: unknown,
  kind: Kind,
  where: string,
  depth = 0,
): string | undefined {
  if (depth > DEEPEST) return `${where}: is nested deeper than anything a part takes`
  switch (kind.kind) {
    case 'text':
      if (typeof value !== 'string') return `${where}: should be text`
      return value.length > kind.max ? `${where}: is longer than ${kind.max} characters` : undefined
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value))
        return `${where}: should be a number`
      if (kind.whole && !Number.isInteger(value)) return `${where}: should be a whole number`
      return value < kind.min || value > kind.max
        ? `${where}: should be from ${kind.min} to ${kind.max}`
        : undefined
    case 'yes-or-no':
      return typeof value === 'boolean' ? undefined : `${where}: should be true or false`
    case 'one-of':
      return typeof value === 'string' && kind.values.includes(value)
        ? undefined
        : `${where}: should be one of ${kind.values.join(', ')}`
    case 'time':
      return typeof value === 'string' && MOMENT.test(value) && !Number.isNaN(Date.parse(value))
        ? undefined
        : `${where}: should be a moment, as 2026-10-12T08:30:00Z`
    case 'cut':
      return typeof value === 'string' && TOKEN.test(value)
        ? undefined
        : `${where}: isn’t a cut Lumovi handed this page`
    case 'destination':
      return destinationProblem(value, where)
    case 'object':
    case 'secret':
    case 'handler':
      return typeof value === 'string' && TOKEN.test(value)
        ? undefined
        : `${where}: should be ${kind.kind === 'handler' ? 'a handler' : kind.kind === 'object' ? 'an object Lumovi named' : 'a Secret Lumovi named'}`
    case 'list': {
      if (!Array.isArray(value)) return `${where}: should be a list`
      if (value.length > kind.max) return `${where}: is longer than ${kind.max}`
      for (let i = 0; i < value.length; i++) {
        const wrong = wrongWith(value[i], kind.of, `${where}[${i}]`, depth + 1)
        if (wrong) return wrong
      }
      return undefined
    }
    case 'record':
      return wrongWithFields(value, kind.fields, kind.required ?? [], where, depth + 1)
    case 'choice': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return `${where}: should be named values`
      }
      const which = Object.hasOwn(value, kind.by)
        ? (value as Record<string, unknown>)[kind.by]
        : undefined
      if (typeof which !== 'string' || !Object.hasOwn(kind.of, which)) {
        return `${where}.${kind.by}: should be one of ${Object.keys(kind.of).join(', ')}`
      }
      const fields = { ...kind.of[which], [kind.by]: { kind: 'text', max: 40 } as Kind }
      const optional = kind.optional?.[which] ?? []
      const required = Object.keys(fields).filter((key) => !optional.includes(key))
      return wrongWithFields(value, fields, required, where, depth + 1)
    }
  }
}

/** What's wrong with `value` as named values of `fields`: every one declared, of its kind. */
export function wrongWithFields(
  value: unknown,
  fields: Readonly<Record<string, Kind>>,
  required: readonly string[],
  where: string,
  depth = 0,
): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `${where}: should be named values`
  }
  const at = (key: string) => (where ? `${where}.${key}` : key)
  for (const key of Object.keys(value)) {
    // (A name a plugin chose is quoted, never said as it wrote it.)
    if (NEVER.has(key) || !Object.hasOwn(fields, key)) {
      return `${where || 'it'}: takes nothing named ${quotedBack(key)}`
    }
    const wrong = wrongWith((value as Record<string, unknown>)[key], fields[key]!, at(key), depth)
    if (wrong) return wrong
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return `${at(key)}: is required`
  }
  return undefined
}

/**
 * What's wrong with a page's parts as declared, or nothing: each part's own declaration, and
 * what they say together (a shared ceiling the same wherever it's named).
 */
export function wrongWithParts(parts: Readonly<Record<string, Part>>): string | undefined {
  const ceilings = new Map<string, { most: number; by: string }>()
  for (const part of Object.values(parts)) {
    const wrong = wrongWithPart(part)
    if (wrong) return wrong
    if (!part.counts) continue
    const { name, most } = part.counts
    const named = ceilings.get(name)
    if (named && named.most !== most) {
      return `${part.name}: ${name} is ${most} here and ${named.most} where ${named.by} names it, and a shared ceiling has one number`
    }
    if (!named) ceilings.set(name, { most, by: part.name })
  }
  return undefined
}

/**
 * What's wrong with a declaration itself, or nothing: checked (with the others, `wrongWithParts`)
 * by the door before it starts a page, and in Lumovi's own tests, so a part that's declared
 * carelessly never reaches a plugin.
 */
/** The kinds the door puts something else in the place of, which may then be nothing. */
const SWAPPED = new Set<Kind['kind']>(['object', 'secret', 'cut', 'destination'])

export function wrongWithPart(part: Part): string | undefined {
  if (!NAME.test(part.name)) return `${part.name}: isn’t a part’s name`
  const whole = (most: number) => Number.isSafeInteger(most) && most > 0
  if (part.most !== undefined && !whole(part.most)) {
    return `${part.name}: how many a page may have should be a whole number, 1 or more`
  }
  for (const holds of [part.holdsMost, part.holdsLeast]) {
    if (holds === undefined) continue
    if (part.holds === 'nothing') {
      return `${part.name}: holds nothing, so it can’t say how many it holds`
    }
    if (!whole(holds)) return `${part.name}: how many it holds should be a whole number, 1 or more`
  }
  if (part.holdsLeast !== undefined && part.holdsLeast > (part.holdsMost ?? Infinity)) {
    return `${part.name}: holds ${part.holdsLeast} at least and ${part.holdsMost} at most`
  }
  if (part.counts && !whole(part.counts.most)) {
    return `${part.name}: how many of ${part.counts.name} a page may have should be a whole number, 1 or more`
  }
  const kindProblem = (kind: Kind, where: string, depth = 0): string | undefined => {
    if (depth > DEEPEST) return `${where}: is declared deeper than anything is checked`
    if (kind.kind === 'text' && !(kind.max > 0)) return `${where}: a text needs a greatest length`
    if (kind.kind === 'number' && !(kind.min <= kind.max)) return `${where}: least above greatest`
    if (kind.kind === 'one-of' && kind.values.length === 0) return `${where}: lists nothing`
    if (kind.kind === 'handler' && !Object.hasOwn(part.events ?? {}, kind.event)) {
      return `${where}: calls ${kind.event}, which the part doesn’t declare`
    }
    if (kind.kind === 'list') {
      if (!(kind.max > 0)) return `${where}: a list needs a greatest length`
      return kindProblem(kind.of, `${where}[]`, depth + 1)
    }
    if (kind.kind === 'record') return fieldsProblem(kind.fields, kind.required, where, depth + 1)
    if (kind.kind === 'choice') {
      if (!NAME.test(kind.by)) return `${where}: ${kind.by} isn’t a property’s name`
      if (Object.keys(kind.of).length === 0) return `${where}: chooses between nothing`
      for (const [which, fields] of Object.entries(kind.of)) {
        if (Object.hasOwn(fields, kind.by)) return `${where}.${which}: declares ${kind.by} itself`
        const wrong = fieldsProblem(
          fields,
          kind.optional?.[which],
          `${where}.${which}`,
          depth + 1,
          true,
        )
        if (wrong) return wrong
        // (In a choice, what isn't optional is required.)
        const optional = kind.optional?.[which] ?? []
        const swapped = Object.keys(fields).find(
          (key) => !optional.includes(key) && SWAPPED.has(fields[key]!.kind),
        )
        if (swapped)
          return `${where}.${which}.${swapped}: an object, a Secret or a list to open can’t be required`
      }
    }
    return undefined
  }
  const fieldsProblem = (
    fields: Readonly<Record<string, Kind>>,
    required: readonly string[] | undefined,
    where: string,
    depth = 0,
    optional = false,
  ): string | undefined => {
    for (const [key, kind] of Object.entries(fields)) {
      if (!NAME.test(key) || NEVER.has(key)) return `${where}.${key}: isn’t a property’s name`
      const wrong = kindProblem(kind, `${where}.${key}`, depth)
      if (wrong) return wrong
    }
    const missing = (required ?? []).find((key) => !Object.hasOwn(fields, key))
    if (missing) return `${where}.${missing}: is required and not declared`
    // What the door swaps can turn out to be nothing (a token gone with its read, or made up):
    // a part is always written to draw without it.
    // (For a choice the list is of what's optional: it's checked there.)
    const swapped = optional
      ? undefined
      : (required ?? []).find((key) => SWAPPED.has(fields[key]!.kind))
    return swapped
      ? `${where}.${swapped}: an object, a Secret or a list to open can’t be required`
      : undefined
  }
  for (const [event, carries] of Object.entries(part.events ?? {})) {
    if (!NAME.test(event)) return `${part.name}: ${event} isn’t an event’s name`
    // (What a call carries is Lumovi's to say: no handler inside it.)
    const wrong = fieldsProblem(carries, undefined, `${part.name}.${event}`)
    if (wrong) return wrong
    if (JSON.stringify(carries).includes('"kind":"handler"')) {
      return `${part.name}.${event}: a call can’t carry a handler`
    }
  }
  return fieldsProblem(part.props, part.required, part.name)
}

/**
 * A text that isn't Lumovi's, as a part is handed it: not a string, so that nothing draws it as
 * it stands. Only what makes such a text safe takes one (`TheirText`, or `spelled` where a mark
 * can't be drawn), and a part that writes it straight into its page doesn't compile.
 */
export interface Their {
  readonly their: string
}

/**
 * `value`, checked as `kind` already, as a part is handed it: every text in it a `Their`, and
 * with `swap` (the door's, where it knows what they stand for) an object, a Secret and a
 * function in place of the tokens and the handle a plugin wrote.
 */
export function handed(value: unknown, kind: Kind, swap?: Swap): unknown {
  switch (kind.kind) {
    case 'text':
      return Object.freeze({ their: value as string })
    case 'object':
      return swap ? swap.object(value as string) : value
    case 'secret':
      return swap ? swap.secret(value as string) : value
    case 'cut':
      return swap ? swap.cut(value as string) : value
    case 'destination':
      return swap ? swap.destination(value as WrittenDestination | WrittenReach) : value
    case 'handler':
      return swap ? swap.handler(value as string, kind.event) : value
    case 'list':
      return Object.freeze(
        (value as unknown[])
          .map((item) => handed(item, kind.of, swap))
          .filter((item) => item !== undefined),
      )
    case 'record':
      return handedFields(value as Record<string, unknown>, kind.fields, swap)
    case 'choice': {
      const which = (value as Record<string, string>)[kind.by]!
      return Object.freeze({
        ...handedFields(value as Record<string, unknown>, kind.of[which]!, swap),
        [kind.by]: which,
      })
    }
    default:
      return value
  }
}

/** Named values, checked already, as a part is handed them. */
export function handedFields(
  value: Readonly<Record<string, unknown>>,
  fields: Readonly<Record<string, Kind>>,
  swap?: Swap,
): Readonly<Record<string, unknown>> {
  const all: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) continue
    const given = handed(value[key], fields[key]!, swap)
    // (A token the page doesn't hold: the property isn't there.)
    if (given !== undefined) all[key] = given
  }
  return Object.freeze(all)
}

/**
 * The TypeScript type of a value of a kind, as a part of Lumovi's is handed it. Some aren't what
 * came up the channel: a text is a `Their`; the door puts the object itself where a plugin could
 * only name the token Lumovi gave it, how a read was cut where it named the cut's token, a list
 * it made where a plugin wrote one to open, and a function where a plugin named a handler.
 */
export type ValueOf<K, P extends Part = Part> = K extends { kind: 'text' }
  ? Their
  : K extends { kind: 'time' }
    ? string
    : K extends { kind: 'object' }
      ? ObjectRef
      : K extends { kind: 'secret' }
        ? SecretRef
        : K extends { kind: 'cut' }
          ? CutRef
          : K extends { kind: 'destination' }
            ? ListDestination | ReachDestination
            : K extends { kind: 'handler'; event: infer E }
              ? (carries: CarriedBy<P, E>) => void
              : K extends { kind: 'number' }
                ? number
                : K extends { kind: 'yes-or-no' }
                  ? boolean
                  : K extends { kind: 'one-of'; values: readonly (infer V)[] }
                    ? V
                    : K extends { kind: 'list'; of: infer Of }
                      ? ValueOf<Of, P>[]
                      : K extends { kind: 'record'; fields: infer F }
                        ? HandedFields<
                            F,
                            K extends { required: readonly (infer R)[] } ? R : never,
                            P
                          >
                        : K extends { kind: 'choice'; by: infer By extends string; of: infer Of }
                          ? {
                              [W in keyof Of]: { [B in By]: W } & HandedFields<
                                Of[W],
                                Exclude<keyof Of[W], OptionalIn<K, W>>,
                                P
                              >
                            }[keyof Of]
                          : never

/**
 * Named values as a part is handed them: the ones its declaration requires always there (the
 * door refuses a description without one, and none of them is a token it could leave out), the
 * rest maybe.
 */
type HandedFields<F, R, P extends Part> = {
  [N in keyof F as N extends R ? N : never]: ValueOf<F[N], P>
} & { [N in keyof F as N extends R ? never : N]?: ValueOf<F[N], P> }

/** What a choice's `optional` names for one of its choices. */
type OptionalIn<K, W> = K extends { optional: infer O }
  ? W extends keyof O
    ? O[W] extends readonly (infer N)[]
      ? N
      : never
    : never
  : never

/** What a handler of a part is called with, for one of its events. */
type CarriedBy<P extends Part, E> = E extends keyof NonNullable<P['events']>
  ? { [N in keyof NonNullable<P['events']>[E]]: ValueOf<NonNullable<P['events']>[E][N], P> }
  : never

/** A part's properties as a component of Lumovi's takes them, worked out from its declaration. */
export type PropsOf<P extends Part> = HandedFields<
  P['props'],
  P extends { required: readonly (infer R)[] } ? R : never,
  P
>

/**
 * The TypeScript type of a value of a kind as a plugin writes it, before the door: a text, a
 * moment, an object's token, a Secret's and a handler's handle are each text. (The mirror of
 * `ValueOf`, kind for kind, so a kind added to `Kind` fails to compile in both.)
 */
export type WrittenOf<K> = K extends { kind: 'text' }
  ? string
  : K extends { kind: 'time' }
    ? string
    : K extends { kind: 'object' }
      ? string
      : K extends { kind: 'secret' }
        ? string
        : K extends { kind: 'cut' }
          ? string
          : K extends { kind: 'destination' }
            ? WrittenDestination
            : K extends { kind: 'handler' }
              ? string
              : K extends { kind: 'number' }
                ? number
                : K extends { kind: 'yes-or-no' }
                  ? boolean
                  : K extends { kind: 'one-of'; values: readonly (infer V)[] }
                    ? V
                    : K extends { kind: 'list'; of: infer Of }
                      ? WrittenOf<Of>[]
                      : K extends { kind: 'record'; fields: infer F }
                        ? { [N in keyof F]?: WrittenOf<F[N]> }
                        : K extends { kind: 'choice'; by: infer By extends string; of: infer Of }
                          ? {
                              [W in keyof Of]: { [B in By]: W } & {
                                [N in keyof Of[W]]?: WrittenOf<Of[W][N]>
                              }
                            }[keyof Of]
                          : never

/** A part's properties as a plugin writes them: worked out from its declaration. */
export type WrittenProps<P extends Part> = { [K in keyof P['props']]?: WrittenOf<P['props'][K]> }

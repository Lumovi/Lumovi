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
export const handler = <const E extends string>(event: E) => ({ kind: 'handler', event }) as const
/**
 * A list. (Of objects, an item whose token the page doesn't hold is left out, so the list can
 * be shorter than it was written: never pair one list's places with another's. Where a place
 * matters, a record per place keeps it and only loses the field.)
 */
export const list = <const K extends Kind>(of: K, max: number) =>
  ({ kind: 'list', of, max }) as const
export const record = <const F extends Record<string, Kind>>(
  fields: F,
  required: readonly (keyof F & string)[] = [],
) => ({ kind: 'record', fields, required }) as const
export const choice = <
  const By extends string,
  const Of extends Record<string, Record<string, Kind>>,
>(
  by: By,
  of: Of,
  optional: Readonly<Record<string, readonly string[]>> = {},
) => ({ kind: 'choice', by, of, optional }) as const

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
  handler(handle: string, event: string): ((carries: unknown) => void) | undefined
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
const SWAPPED = new Set<Kind['kind']>(['object', 'secret'])

export function wrongWithPart(part: Part): string | undefined {
  if (!NAME.test(part.name)) return `${part.name}: isn’t a part’s name`
  const whole = (most: number) => Number.isSafeInteger(most) && most > 0
  if (part.most !== undefined && !whole(part.most)) {
    return `${part.name}: how many a page may have should be a whole number, 1 or more`
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
        if (swapped) return `${where}.${which}.${swapped}: an object or a Secret can’t be required`
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
    return swapped ? `${where}.${swapped}: an object or a Secret can’t be required` : undefined
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
 * The TypeScript type of a value of a kind, as a part of Lumovi's is handed it. Three aren't
 * what came up the channel: a text is a `Their`; the door puts the object itself where a plugin could only name the token
 * Lumovi gave it, and a function where a plugin named a handler.
 */
export type ValueOf<K, P extends Part = Part> = K extends { kind: 'text' }
  ? Their
  : K extends { kind: 'time' }
    ? string
    : K extends { kind: 'object' }
      ? ObjectRef
      : K extends { kind: 'secret' }
        ? SecretRef
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
                    ? { [N in keyof F]?: ValueOf<F[N], P> }
                    : K extends { kind: 'choice'; by: infer By extends string; of: infer Of }
                      ? {
                          [W in keyof Of]: { [B in By]: W } & {
                            [N in keyof Of[W]]?: ValueOf<Of[W][N], P>
                          }
                        }[keyof Of]
                      : never

/** What a handler of a part is called with, for one of its events. */
type CarriedBy<P extends Part, E> = E extends keyof NonNullable<P['events']>
  ? { [N in keyof NonNullable<P['events']>[E]]: ValueOf<NonNullable<P['events']>[E][N], P> }
  : never

/** A part's properties as a component of Lumovi's takes them, worked out from its declaration. */
export type PropsOf<P extends Part> = { [K in keyof P['props']]?: ValueOf<P['props'][K], P> }

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
}

export const text = (max: number): Kind => ({ kind: 'text', max })
export const number = (min: number, max: number, whole = false): Kind =>
  whole ? { kind: 'number', min, max, whole } : { kind: 'number', min, max }
export const yesOrNo: Kind = { kind: 'yes-or-no' }
export const oneOf = <const V extends readonly string[]>(values: V) =>
  ({ kind: 'one-of', values }) as const
export const time: Kind = { kind: 'time' }
export const object: Kind = { kind: 'object' }
export const handler = (event: string): Kind => ({ kind: 'handler', event })
export const list = (of: Kind, max: number): Kind => ({ kind: 'list', of, max })
export const record = (fields: Record<string, Kind>, required: string[] = []): Kind => ({
  kind: 'record',
  fields,
  required,
})
export const choice = (
  by: string,
  of: Record<string, Record<string, Kind>>,
  optional: Record<string, string[]> = {},
): Kind => ({ kind: 'choice', by, of, optional })

/** An object in the cluster as a part of Lumovi's is handed it: never what a plugin wrote. */
export interface ObjectRef {
  kind: string
  name: string
  namespace?: string
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
    case 'handler':
      return typeof value === 'string' && TOKEN.test(value)
        ? undefined
        : `${where}: should be ${kind.kind === 'object' ? 'an object Lumovi named' : 'a handler'}`
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
    if (NEVER.has(key) || !Object.hasOwn(fields, key)) return `${at(key)}: isn’t something it takes`
    const wrong = wrongWith((value as Record<string, unknown>)[key], fields[key]!, at(key), depth)
    if (wrong) return wrong
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return `${at(key)}: is required`
  }
  return undefined
}

/**
 * What's wrong with a declaration itself, or nothing: checked as Lumovi starts and in its own
 * tests, so a part that's declared carelessly never reaches a plugin.
 */
export function wrongWithPart(part: Part): string | undefined {
  if (!NAME.test(part.name)) return `${part.name}: isn’t a part’s name`
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
        const wrong = fieldsProblem(fields, kind.optional?.[which], `${where}.${which}`, depth + 1)
        if (wrong) return wrong
      }
    }
    return undefined
  }
  const fieldsProblem = (
    fields: Readonly<Record<string, Kind>>,
    required: readonly string[] | undefined,
    where: string,
    depth = 0,
  ): string | undefined => {
    for (const [key, kind] of Object.entries(fields)) {
      if (!NAME.test(key) || NEVER.has(key)) return `${where}.${key}: isn’t a property’s name`
      const wrong = kindProblem(kind, `${where}.${key}`, depth)
      if (wrong) return wrong
    }
    const missing = (required ?? []).find((key) => !Object.hasOwn(fields, key))
    return missing ? `${where}.${missing}: is required and not declared` : undefined
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
 * The TypeScript type of a value of a kind, as a part of Lumovi's is handed it. Two aren't what
 * came up the channel: the door puts the object itself where a plugin could only name the token
 * Lumovi gave it, and a function where a plugin named a handler.
 */
export type ValueOf<K, P extends Part = Part> = K extends { kind: 'text' | 'time' }
  ? string
  : K extends { kind: 'object' }
    ? ObjectRef
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

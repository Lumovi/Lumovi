/**
 * Changes through the door: what a plugin's page may propose, as the door reads it. A page
 * proposes a change to one object of its plugin's own kinds, right after the person pressed one
 * of its buttons; Lumovi asks the cluster first, shows the change in its own dialog, and makes it,
 * as the person, only once they confirm there. Nothing of the plugin's runs between the press and
 * the confirm: the fields it asks for are filled in by Lumovi, into the places it marked.
 *
 * Plain functions: the door checks what came up the channel (`proposalProblem`), Lumovi fills the
 * person's values in (`filled`) and says what's wrong with one in its own words (`fieldWrong`).
 */
import type { Harm } from './plugins'
import {
  choice,
  list,
  number,
  record,
  text,
  TOKEN,
  wrongWith,
  yesOrNo,
  type Kind,
  type ObjectRef,
} from './kit/declare'

/** How much a proposal may hold. */
export const CHANGE_LIMITS = {
  /**
   * Fields the person sets, above the change, headings of sections among them: past a few, they
   * stand in sections, and the dialog's options scroll past its window.
   */
  fields: 24,
  /** What a list to pick several from offers. */
  picks: 200,
  /** A field's label, and its hint (about two lines), the plugin's words. */
  label: 40,
  hint: 160,
  /** The most a text field may take. */
  textMost: 256,
  /** A choice's options. */
  options: 20,
  /** The plugin's word on the button. */
  verb: 24,
  /** The patch or object, with the fields filled in: as JSON, how deep, and a key's length. */
  bytes: 16 * 1024,
  depth: 20,
  key: 253,
  /** How long a press's token is good for, from the press to the proposal reaching the door. */
  pressMs: 5_000,
} as const

/** What a page may ask to do to an object. */
export const CHANGE_ACTIONS = ['patch', 'create', 'delete', 'scale'] as const
export type ChangeAction = (typeof CHANGE_ACTIONS)[number]

/**
 * Words that read as the way out of the dialog: never a plugin's button, however it's cased or
 * marked ("Cancel…", "Not now!"), compared on its letters alone.
 */
const WAY_OUT = new Set([
  'cancel',
  'close',
  'back',
  'no',
  'keep',
  'ok',
  'okay',
  'done',
  'dont',
  'dismiss',
  'skip',
  'exit',
  'abort',
  'notnow',
  'nevermind',
  'gotit',
  'leave',
  'stop',
])
const lettersOf = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}]/gu, '')

const label = text(CHANGE_LIMITS.label)
const hint = text(CHANGE_LIMITS.hint)
const fieldKey = text(40)

/** A field the person sets, as a page describes it: its kind, its words, and where it starts. */
export const FIELD = choice(
  'kind',
  {
    text: {
      key: fieldKey,
      label,
      hint,
      most: number(1, CHANGE_LIMITS.textMost, true),
      required: yesOrNo,
      value: text(CHANGE_LIMITS.textMost),
    },
    number: {
      key: fieldKey,
      label,
      hint,
      min: number(-1e9, 1e9, true),
      max: number(-1e9, 1e9, true),
      value: number(-1e9, 1e9, true),
    },
    choice: {
      key: fieldKey,
      label,
      hint,
      options: list(record({ label }, ['label']), CHANGE_LIMITS.options),
      value: number(0, CHANGE_LIMITS.options - 1, true),
    },
    /**
     * Yes or no; `shows`, the fields after it that stand only while it's on (Retry's limit and
     * backoff): while it's off they're hidden and go into the change as nothing. `values`, what it
     * fills off and on instead of false and true (Apply only: `{ hook: … }` or `{ apply: … }`),
     * other fields' places in them filled too; `verb`, the button's word while it's on (Dry run).
     */
    switch: {
      key: fieldKey,
      label,
      hint,
      value: yesOrNo,
      shows: list(fieldKey, CHANGE_LIMITS.fields - 1),
      verb: text(CHANGE_LIMITS.verb),
    },
    /** A box: yes or no, among others in a section ("Prune", "Force"). */
    check: { key: fieldKey, label, hint, value: yesOrNo },
    /** Several of a list (the resources to sync): their values, in the list's order. */
    picks: {
      key: fieldKey,
      label,
      hint,
      options: list(record({ label }, ['label']), CHANGE_LIMITS.picks),
      value: list(number(0, CHANGE_LIMITS.picks - 1, true), CHANGE_LIMITS.picks),
    },
    /** A heading the fields after it stand under, until the next. It holds no value. */
    section: { label },
  },
  {
    text: ['hint', 'most', 'required', 'value'],
    number: ['hint', 'value'],
    choice: ['hint', 'value'],
    switch: ['hint', 'value', 'shows', 'verb'],
    check: ['hint', 'value'],
    picks: ['hint', 'value'],
  },
) satisfies Kind

/** A choice's option: its label, and the value it puts in (any JSON the page wrote). */
export interface FieldOption {
  label: string
  value: unknown
}
export type Field =
  | {
      kind: 'text'
      key: string
      label: string
      hint?: string
      most?: number
      required?: boolean
      value?: string
    }
  | {
      kind: 'number'
      key: string
      label: string
      hint?: string
      min: number
      max: number
      value?: number
    }
  | {
      kind: 'choice'
      key: string
      label: string
      hint?: string
      options: FieldOption[]
      value?: number
    }
  | {
      kind: 'switch'
      key: string
      label: string
      hint?: string
      value?: boolean
      shows?: string[]
      /** What it fills off and on: any JSON, other fields' places in them filled too. */
      values?: [unknown, unknown]
      /** The button's word while it's on. */
      verb?: string
    }
  | { kind: 'check'; key: string; label: string; hint?: string; value?: boolean }
  | {
      kind: 'picks'
      key: string
      label: string
      hint?: string
      options: FieldOption[]
      value?: number[]
    }
  | { kind: 'section'; label: string; key?: undefined }

/** A field that holds a value: every one but a section's heading. */
export type ValueField = Exclude<Field, { kind: 'section' }>
export const holdsValue = (field: Field): field is ValueField => field.kind !== 'section'

/** A field's value as the person has set it: what goes in where the page marked it. */
export type FieldValue = string | number | boolean | readonly number[] | undefined

/** The change a page proposes, once the door has read it. */
export interface Proposed {
  /** What its answer names. */
  id: number
  /** The press it follows: the token Lumovi handed with that press. */
  press: string
  /** The plugin's word for the button: never for a deletion, which is always Lumovi's. */
  verb?: string
  action: ChangeAction
  /** The object it's to (an object token): for all but a create. */
  target?: string
  /** A create's kind ("postgresql.cnpg.io/Backup"), and an object token whose namespace it's in. */
  kind?: string
  in?: string
  /** A patch's JSON merge patch, or a create's object: with `{ field: key }` where a value goes. */
  body?: unknown
  /** A scale's count, or the field it comes from. */
  replicas?: number | { field: string }
  fields: Field[]
  /**
   * What the page adds to what its file says does harm: a harm of its own (`says`, and a `verb`
   * for the button), or, at one of its file's harms' `path`, a `detail` under it (prune's list of
   * what it deletes). Never less than the file says: none of it takes a harm away.
   */
  harm?: { path?: string; says?: string; verb?: string; detail?: string }[]
}

/** A proposal as the page hands it to Lumovi's dialog: with the objects its tokens stood for. */
export interface PageProposal {
  proposed: Proposed
  /** The object it's to: for all but a create. */
  target?: ObjectRef
  /** A create's: the object whose namespace it's made in, where the page named one. */
  within?: ObjectRef
  /**
   * Told the moment the change is made, before Lumovi's dialog closes: the page holds the button
   * pressed for it busy from then. (The page's own, on its side: never sent anywhere.)
   */
  applied?: () => void
}

/** What became of a proposal, as the page is told: never the values typed, nor the object. */
export type ProposalOutcome = 'applied' | 'cancelled' | 'refused' | 'failed'

/** Longer than a proposal can be: its change at its biggest, its fields, and their words. */
export const PROPOSE_AT_MOST = 64 * 1024

/** A place a field's value goes: exactly `{ field: key }`. */
const placeOf = (value: unknown): string | undefined =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  typeof (value as { field?: unknown }).field === 'string'
    ? (value as { field: string }).field
    : undefined

/**
 * The only names a page's metadata may hold: a patch's, its labels and annotations; a create's,
 * also its name. Everything else of an object's metadata (its owners, finalizers, uid, version,
 * namespace, managers) is the cluster's or Lumovi's to set: a fence, never a list of what not to.
 */
const METADATA_WRITTEN: Record<ChangeAction, readonly string[]> = {
  patch: ['labels', 'annotations'],
  scale: [],
  delete: [],
  create: ['name', 'generateName', 'labels', 'annotations'],
}

/**
 * What's wrong with a page's proposal as it came up the channel, in the door's words; or the
 * proposal. (Whether its plugin may make it is its file's to say: `mayPropose`.)
 */
export function proposalProblem(said: unknown): string | Proposed {
  if (typeof said !== 'object' || said === null || Array.isArray(said)) {
    return 'propose: should be named values'
  }
  const { propose: id, press, verb, change, fields = [], harm } = said as Record<string, unknown>
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
    return 'propose: should be a whole number, which its answer names'
  }
  if (typeof press !== 'string' || !TOKEN.test(press)) {
    return 'propose.press: should be the token Lumovi handed with a press'
  }
  if (typeof change !== 'object' || change === null || Array.isArray(change)) {
    return 'propose.change: should be named values'
  }
  const {
    action,
    target,
    kind,
    in: within,
    patch,
    object,
    replicas,
  } = change as Record<string, unknown>
  if (typeof action !== 'string' || !(CHANGE_ACTIONS as readonly string[]).includes(action)) {
    return `propose.change.action: should be one of ${CHANGE_ACTIONS.join(', ')}`
  }
  if (verb !== undefined) {
    if (action === 'delete') return 'propose.verb: a deletion’s button is Lumovi’s own'
    const wrong = wrongWith(verb, text(CHANGE_LIMITS.verb), 'propose.verb')
    if (wrong) return wrong
    if ((verb as string).trim() === '' || /[\r\n]/.test(verb as string)) {
      return 'propose.verb: should be one line of words'
    }
    if (WAY_OUT.has(lettersOf(verb as string))) {
      return 'propose.verb: would read as the way out of the dialog (Cancel, Close, Back, Not now…)'
    }
  }
  // (A choice's options carry any JSON as their values: checked as JSON apart from their shape.)
  const shaped = Array.isArray(fields) ? fields.map(withoutOptionValues) : fields
  const fieldsWrong = wrongWith(shaped, list(FIELD, CHANGE_LIMITS.fields), 'propose.fields')
  if (fieldsWrong) return fieldsWrong
  const declared = fields as Field[]
  // (A section's heading holds no value, and has no key.)
  const keys = declared.filter(holdsValue).map((field) => field.key)
  if (new Set(keys).size !== keys.length) return 'propose.fields: each key once'
  for (const [i, field] of declared.entries()) {
    const wrong = fieldShapeProblem(field, `propose.fields[${i}]`)
    if (wrong) return wrong
  }
  // What a switch shows: fields after it, each shown by one switch at most, never a switch's own.
  const shownBy = new Map<string, number>()
  for (const [i, field] of declared.entries()) {
    if (field.kind !== 'switch') continue
    for (const key of field.shows ?? []) {
      const at = declared.findIndex((each) => holdsValue(each) && each.key === key)
      if (at < 0) return `propose.fields[${i}].shows: names no field ${key}`
      if (at <= i) return `propose.fields[${i}].shows: ${key} should come after the switch`
      if (shownBy.has(key)) return `propose.fields[${i}].shows: ${key} is shown by another switch`
      shownBy.set(key, i)
    }
  }
  // What a switch fills off and on: two values, plain JSON, whose places name other fields, filled
  // once (none a switch that fills values of its own); and its button's word, a line of words.
  const filling = new Set(
    declared.flatMap((field) => (field.kind === 'switch' && field.values ? [field.key] : [])),
  )
  for (const [i, field] of declared.entries()) {
    if (field.kind !== 'switch') continue
    const where = `propose.fields[${i}]`
    if (field.values !== undefined) {
      if (!Array.isArray(field.values) || field.values.length !== 2) {
        return `${where}.values: should be two, what it fills off and on`
      }
      for (const [at, value] of field.values.entries()) {
        const inner = keys.filter((key) => !filling.has(key))
        const wrong = jsonProblem(value, `${where}.values[${at}]`, 0, inner)
        if (wrong) {
          return [...placesOf(value)].some((place) => filling.has(place))
            ? `${where}.values[${at}]: names a switch that fills values of its own`
            : wrong
        }
      }
    }
    if (field.verb !== undefined) {
      if (field.verb.trim() === '' || /[\r\n]/.test(field.verb)) {
        return `${where}.verb: should be one line of words`
      }
      if (WAY_OUT.has(lettersOf(field.verb))) {
        return `${where}.verb: would read as the way out of the dialog (Cancel, Close, Back, Not now…)`
      }
      if (action === 'delete') return `${where}.verb: a deletion’s button is Lumovi’s own`
    }
  }
  const proposed: Proposed = { id, press, action: action as ChangeAction, fields: declared }
  if (harm !== undefined) {
    const harmWrong = wrongWith(
      harm,
      list(
        record({ path: text(253), says: hint, verb: text(CHANGE_LIMITS.verb), detail: hint }),
        8,
      ),
      'propose.harm',
    )
    if (harmWrong) return harmWrong
    for (const [i, each] of (harm as NonNullable<Proposed['harm']>).entries()) {
      const where = `propose.harm[${i}]`
      if (each.path !== undefined && !/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(each.path)) {
        return `${where}.path: should be names with dots between, as its file’s harm says it`
      }
      if (each.path === undefined && each.says === undefined) {
        return `${where}: says what harm it does, or names its file’s harm by its path`
      }
      if (each.verb !== undefined && WAY_OUT.has(lettersOf(each.verb))) {
        return `${where}.verb: would read as the way out of the dialog`
      }
    }
    proposed.harm = harm as NonNullable<Proposed['harm']>
  }
  if (verb !== undefined) proposed.verb = (verb as string).trim()
  if (action === 'create') {
    if (typeof kind !== 'string' || !/^[a-z0-9.-]+\/[A-Z][A-Za-z0-9]*$/.test(kind)) {
      return 'propose.change.kind: should be a kind of its own, as “group/Kind”'
    }
    proposed.kind = kind
    if (within !== undefined) {
      if (typeof within !== 'string' || !TOKEN.test(within)) {
        return 'propose.change.in: should be an object Lumovi named'
      }
      proposed.in = within
    }
    const wrong =
      bodyProblem(object, 'propose.change.object', keys) ?? writtenProblem(object, 'create')
    if (wrong) return wrong
    proposed.body = object
  } else {
    if (typeof target !== 'string' || !TOKEN.test(target)) {
      return 'propose.change.target: should be an object Lumovi named'
    }
    proposed.target = target
    if (action === 'patch') {
      const wrong =
        bodyProblem(patch, 'propose.change.patch', keys) ?? writtenProblem(patch, 'patch')
      if (wrong) return wrong
      proposed.body = patch
    }
    if (action === 'scale') {
      const place = placeOf(replicas)
      if (place !== undefined) {
        if (!keys.includes(place)) return `propose.change.replicas: names no field ${place}`
        proposed.replicas = { field: place }
      } else {
        const wrong = wrongWith(replicas, number(0, REPLICAS_MOST, true), 'propose.change.replicas')
        if (wrong) return wrong
        proposed.replicas = replicas as number
      }
    }
  }
  // Every field changes something: one that goes nowhere would ask the person for nothing.
  const used = placesIn(proposed)
  // (A switch that shows others is how they're asked for: it may go nowhere itself.)
  const shows = new Set(
    declared.flatMap((field) =>
      field.kind === 'switch' && field.shows?.length ? [field.key] : [],
    ),
  )
  const unused = keys.find((key) => !used.has(key) && !shows.has(key))
  if (unused !== undefined) return `propose.fields: ${unused} goes nowhere in the change`
  return proposed
}

/**
 * A field as its shape is checked: a choice's options without the values they put in, and a
 * switch without what it fills (each checked as JSON apart from it).
 */
function withoutOptionValues(field: unknown): unknown {
  if (
    typeof field === 'object' &&
    field !== null &&
    (field as { kind?: unknown }).kind === 'switch'
  ) {
    return Object.fromEntries(Object.entries(field).filter(([key]) => key !== 'values'))
  }
  if (
    typeof field !== 'object' ||
    field === null ||
    !['choice', 'picks'].includes((field as { kind?: unknown }).kind as string)
  ) {
    return field
  }
  const { options } = field as { options?: unknown }
  if (!Array.isArray(options)) return field
  return {
    ...field,
    options: options.map((option) =>
      typeof option === 'object' && option !== null && !Array.isArray(option)
        ? Object.fromEntries(Object.entries(option).filter(([key]) => key !== 'value'))
        : option,
    ),
  }
}

/** What's wrong with a field beyond its kind's shape: a number's bounds, a choice's options. */
function fieldShapeProblem(field: Field, where: string): string | undefined {
  if (!holdsValue(field)) return undefined
  if (!FIELD_KEY.test(field.key)) return `${where}.key: should be a name`
  if (field.kind === 'picks') {
    for (const [i, option] of field.options.entries()) {
      if (!Object.hasOwn(option, 'value')) return `${where}.options[${i}].value: is required`
      const wrong = jsonProblem(option.value, `${where}.options[${i}].value`, 0, [])
      if (wrong) return wrong
    }
    const picked = field.value ?? []
    if (new Set(picked).size !== picked.length) return `${where}.value: names an option twice`
    if (picked.some((at) => at >= field.options.length)) {
      return `${where}.value: should be its options’ places`
    }
  }
  if (field.kind === 'number') {
    if (field.min > field.max) return `${where}: its min is above its max`
    if (field.value !== undefined && (field.value < field.min || field.value > field.max)) {
      return `${where}.value: should be from ${field.min} to ${field.max}`
    }
  }
  if (
    field.kind === 'text' &&
    field.value !== undefined &&
    field.value.length > (field.most ?? CHANGE_LIMITS.textMost)
  ) {
    return `${where}.value: is longer than its most`
  }
  if (field.kind === 'choice') {
    if (field.options.length < 2) return `${where}.options: should be two at least`
    for (const [i, option] of field.options.entries()) {
      if (!Object.hasOwn(option, 'value')) return `${where}.options[${i}].value: is required`
      const wrong = jsonProblem(option.value, `${where}.options[${i}].value`, 0, [])
      if (wrong) return wrong
    }
    if (field.value !== undefined && field.value >= field.options.length) {
      return `${where}.value: should be one of its options’ places`
    }
  }
  return undefined
}

/**
 * What's wrong with a patch or an object as it's sent, whoever filled it in: named values, never
 * who owns it or who managed its fields, never its status, no deeper than a proposal may be; and a
 * create's with a name (or a generateName) and no namespace of its own. Asked of what a page wrote,
 * of what the person's values made of it, and again by the backend before anything is tried.
 */
export function writtenProblem(
  body: unknown,
  action: ChangeAction,
  where = 'propose.change',
): string | undefined {
  const at = `${where}.${action === 'create' ? 'object' : 'patch'}`
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return `${at}: should be named values`
  }
  if (Object.hasOwn(body, 'status')) return `${at}.status: isn’t a plugin’s to write`
  const meta = (body as { metadata?: unknown }).metadata
  if (meta !== undefined && (typeof meta !== 'object' || meta === null || Array.isArray(meta))) {
    return `${at}.metadata: should be named values`
  }
  if (meta) {
    const never = Object.keys(meta).find((name) => !METADATA_WRITTEN[action].includes(name))
    if (never !== undefined) {
      return `${at}.metadata: holds only ${METADATA_WRITTEN[action].join(', ')}: the rest is the cluster’s or Lumovi’s to set`
    }
  }
  if (action === 'create') {
    const { name, generateName } = (meta ?? {}) as Record<string, unknown>
    if (typeof name !== 'string' && typeof generateName !== 'string') {
      return `${at}.metadata: should have a name or a generateName`
    }
  }
  const deepest = (value: unknown, depth: number): number =>
    typeof value !== 'object' || value === null
      ? depth
      : Math.max(depth, ...Object.values(value).map((item) => deepest(item, depth + 1)))
  if (deepest(body, 0) > CHANGE_LIMITS.depth)
    return `${at}: is nested deeper than ${CHANGE_LIMITS.depth}`
  return undefined
}

/**
 * What's wrong with a patch or an object as the backend is asked to send it: what's wrong with
 * any written one, and besides, a place no value was put in, a key longer than a key may be, or
 * more than a proposal may send.
 */
export function sentProblem(body: unknown, action: ChangeAction): string | undefined {
  const wrong = writtenProblem(body, action, 'change')
  if (wrong) return wrong
  let found: string | undefined
  const walk = (value: unknown): void => {
    if (found !== undefined || typeof value !== 'object' || value === null) return
    if (placeOf(value) !== undefined) found = 'a field’s place is left in it'
    else if (Array.isArray(value)) value.forEach(walk)
    else {
      for (const [key, item] of Object.entries(value)) {
        if (key.length > CHANGE_LIMITS.key) found = `a key is longer than ${CHANGE_LIMITS.key}`
        if (key === '__proto__') found = 'it has a key no object may have'
        walk(item)
      }
    }
  }
  walk(body)
  if (found) return `change: ${found}`
  return new TextEncoder().encode(JSON.stringify(body)).length > CHANGE_LIMITS.bytes
    ? 'change: comes to more than a plugin may send'
    : undefined
}

/** A scale's count, as the door takes one. */
export const REPLICAS_MOST = 10_000

/** A field's key, as a page names it: what the audit keeps of the fields the person changed. */
export const FIELD_KEY = /^[A-Za-z][A-Za-z0-9]{0,39}$/

/**
 * What's wrong with a patch or an object a page wrote: what's wrong with it as sent, its places
 * each a field's, and none where a value could bring in what's never written (the whole of it, or
 * its metadata whole).
 */
function bodyProblem(body: unknown, where: string, keys: readonly string[]): string | undefined {
  if (placeOf(body) !== undefined) return `${where}: a field can’t stand for the whole of it`
  if (
    typeof body === 'object' &&
    body !== null &&
    placeOf((body as { metadata?: unknown }).metadata) !== undefined
  ) {
    return `${where}.metadata: a field can’t stand for the whole of it`
  }
  return jsonProblem(body, where, 0, keys)
}

/** What's wrong with plain JSON as a page wrote it: how deep, its keys, and each place's field. */
function jsonProblem(
  value: unknown,
  where: string,
  depth: number,
  keys: readonly string[],
): string | undefined {
  if (depth > CHANGE_LIMITS.depth) return `${where}: is nested deeper than ${CHANGE_LIMITS.depth}`
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined
  if (typeof value === 'number')
    return Number.isFinite(value) ? undefined : `${where}: should be a number`
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const wrong = jsonProblem(value[i], `${where}[${i}]`, depth + 1, keys)
      if (wrong) return wrong
    }
    return undefined
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    return `${where}: should be plain JSON`
  }
  const place = placeOf(value)
  if (place !== undefined) {
    return keys.includes(place) ? undefined : `${where}: names no field ${place}`
  }
  for (const [key, item] of Object.entries(value)) {
    if (key.length > CHANGE_LIMITS.key)
      return `${where}: has a key longer than ${CHANGE_LIMITS.key}`
    if (key === '__proto__') return `${where}: has a key no object may have`
    const wrong = jsonProblem(item, `${where}.${key}`, depth + 1, keys)
    if (wrong) return wrong
  }
  return undefined
}

/** The fields a proposal's change names. */
function placesIn(proposed: Proposed): Set<string> {
  const found = new Set<string>()
  const walk = (value: unknown): void => {
    for (const place of placesOf(value)) found.add(place)
  }
  walk(proposed.body)
  walk(proposed.replicas)
  // (And those in what a switch that's used fills.)
  for (const field of proposed.fields) {
    if (field.kind === 'switch' && field.values && found.has(field.key)) field.values.forEach(walk)
  }
  return found
}

/** The fields' places in a value as a page wrote it. */
function placesOf(value: unknown): Set<string> {
  const found = new Set<string>()
  const walk = (at: unknown): void => {
    const place = placeOf(at)
    if (place !== undefined) found.add(place)
    else if (Array.isArray(at)) at.forEach(walk)
    else if (typeof at === 'object' && at !== null) Object.values(at).forEach(walk)
  }
  walk(value)
  return found
}

/**
 * The field whose place the cluster's words name (`spec.replicas`, `operation.sync.revision`),
 * where they name one of the places the page marked: so its refusal is said under that field.
 */
export function fieldAt(proposed: Proposed, path: string): string | undefined {
  const named = path.replace(/^\./, '').replace(/\[(\d+)\]/g, '.$1')
  let found: string | undefined
  const walk = (value: unknown, at: string): void => {
    if (found !== undefined) return
    const place = placeOf(value)
    if (place !== undefined) {
      if (named === at || named.endsWith(`.${at}`) || at.endsWith(`.${named}`)) found = place
      return
    }
    if (Array.isArray(value)) value.forEach((item, i) => walk(item, at ? `${at}.${i}` : `${i}`))
    else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) walk(item, at ? `${at}.${key}` : key)
    }
  }
  walk(proposed.body, '')
  if (found === undefined && proposed.replicas !== undefined) {
    const place = placeOf(proposed.replicas)
    if (place !== undefined && /(^|\.)replicas$/.test(named)) found = place
  }
  return found
}

/**
 * A field's value as it goes in: a choice's is its option's value, a pick's its options' values
 * in the list's order, the rest as set.
 */
function valueOf(field: ValueField, value: FieldValue): unknown {
  if (field.kind === 'choice')
    return typeof value === 'number' ? field.options[value]?.value : undefined
  if (field.kind === 'picks') {
    const picked = new Set(Array.isArray(value) ? value : [])
    return field.options.flatMap((option, i) => (picked.has(i) ? [option.value] : []))
  }
  return value
}

/** The fields hidden as `values` stand: those a switch that's off shows. */
export function hiddenFields(
  fields: readonly Field[],
  values: Readonly<Record<string, FieldValue>>,
): Set<string> {
  const hidden = new Set<string>()
  for (const field of fields) {
    if (field.kind !== 'switch') continue
    // (One hidden itself hides what it shows, too.)
    if (values[field.key] !== true || hidden.has(field.key)) {
      for (const key of field.shows ?? []) hidden.add(key)
    }
  }
  return hidden
}

/** The change as it's to be sent: the patch or object, or a scale's count. */
export interface Filled {
  body?: unknown
  replicas?: number
}

/**
 * The change with the person's values in the places the page marked: each a JSON value of its
 * field's kind, never inside a key or a text around it. Or why not: a field's value is wrong
 * (`fields`), the change comes to more than a proposal may send (`too-big`), or to what no plugin
 * may write (`not-allowed`).
 */
export function filled(
  proposed: Proposed,
  values: Readonly<Record<string, FieldValue>>,
): Filled | 'fields' | 'too-big' | 'not-allowed' {
  const valued = proposed.fields.filter(holdsValue)
  const fields = new Map(valued.map((field) => [field.key, field]))
  // (A field a switch that's off hides goes in as nothing: it's left out of the change, and so is
  // an object only hidden fields stood in, up to the first that holds something else: Retry off
  // sends no `retry`. One the page wrote empty stays.)
  const hidden = hiddenFields(proposed.fields, values)
  for (const field of valued) {
    if (!hidden.has(field.key) && fieldWrong(field, values[field.key])) return 'fields'
  }
  const fill = (value: unknown): unknown => {
    const place = placeOf(value)
    if (place !== undefined) {
      if (hidden.has(place)) return undefined
      const field = fields.get(place)!
      // (What a switch fills is filled in turn: its fields fill only values, so once.)
      if (field.kind === 'switch' && field.values) {
        return fill(field.values[values[place] === true ? 1 : 0])
      }
      return valueOf(field, values[place])
    }
    if (Array.isArray(value)) return value.map(fill).filter((item) => item !== undefined)
    if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value)
      const kept = entries
        .map(([key, item]) => [key, fill(item)] as const)
        .filter(([, item]) => item !== undefined)
      return entries.length > 0 && kept.length === 0 ? undefined : Object.fromEntries(kept)
    }
    return value
  }
  const out: Filled = {}
  if (proposed.body !== undefined) {
    out.body = fill(proposed.body) ?? {}
    if (new TextEncoder().encode(JSON.stringify(out.body)).length > CHANGE_LIMITS.bytes) {
      return 'too-big'
    }
    // (What the person's values made of it, asked as what a page writes is: never what no plugin may.)
    if (writtenProblem(out.body, proposed.action)) return 'not-allowed'
  }
  if (proposed.replicas !== undefined) out.replicas = fill(proposed.replicas) as number
  return out
}

/**
 * Where each field starts: its value as the page wrote it; else a text empty and a switch off, and
 * a number or a choice not set yet (the person sets it).
 */
export function startingValues(fields: readonly Field[]): Record<string, FieldValue> {
  return Object.fromEntries(
    fields
      .filter(holdsValue)
      .map((field) => [
        field.key,
        field.value ??
          (field.kind === 'text'
            ? ''
            : field.kind === 'switch' || field.kind === 'check'
              ? false
              : field.kind === 'picks'
                ? []
                : undefined),
      ]),
  )
}

/** What's wrong with a field's value, in Lumovi's words by its kind; or nothing. */
export function fieldWrong(field: ValueField, value: FieldValue): string | undefined {
  switch (field.kind) {
    case 'check':
      return typeof value === 'boolean' ? undefined : 'Choose one.'
    case 'picks':
      return Array.isArray(value) &&
        value.every((at) => Number.isInteger(at) && at >= 0 && at < field.options.length)
        ? undefined
        : 'Choose from the list.'
    case 'text': {
      const typed = typeof value === 'string' ? value : ''
      if (field.required && typed.trim() === '') return 'Fill this in.'
      const most = field.most ?? CHANGE_LIMITS.textMost
      return typed.length > most ? `At most ${most} characters.` : undefined
    }
    case 'number':
      return typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= field.min &&
        value <= field.max
        ? undefined
        : `A whole number from ${field.min} to ${field.max}.`
    case 'choice':
      return typeof value === 'number' && value >= 0 && value < field.options.length
        ? undefined
        : 'Choose one.'
    case 'switch':
      return typeof value === 'boolean' ? undefined : 'Choose one.'
  }
}

/** The fields whose value the person changed from where it started: what the audit keeps. */
export function changedFields(
  fields: readonly Field[],
  values: Readonly<Record<string, FieldValue>>,
): string[] {
  const started = startingValues(fields)
  const same = (a: FieldValue, b: FieldValue) => JSON.stringify(a) === JSON.stringify(b)
  return fields
    .filter(holdsValue)
    .filter((field) => !same(values[field.key], started[field.key]))
    .map((field) => field.key)
}

/**
 * The harms a change does, as it's to be sent (`body`, filled in): those of `harms` (its plugin's
 * file's, for its kind) whose path in it holds the value that harms, or is there at all (and not
 * an empty list); in the file's order. Lumovi draws each in red, whatever the plugin's code says.
 */
/** What `body` holds at a path of names (`operation.sync.prune`), if it holds anything there. */
export function heldAt(body: unknown, path: string): { found: boolean; value?: unknown } {
  let at: unknown = body
  for (const name of path.split('.')) {
    if (typeof at !== 'object' || at === null || Array.isArray(at) || !Object.hasOwn(at, name)) {
      return { found: false }
    }
    at = (at as Record<string, unknown>)[name]
  }
  return { found: true, value: at }
}

/** Whether a harm's `unless` holds in what's sent, where the person may have set it. */
export function quieted(body: unknown, harm: Harm, quietable: (path: string) => boolean): boolean {
  if (!harm.unless || !quietable(harm.unless.path)) return false
  const at = heldAt(body, harm.unless.path)
  return at.found && JSON.stringify(at.value) === JSON.stringify(harm.unless.is)
}

export function harmsIn(
  body: unknown,
  harms: readonly Harm[],
  /** Where an `unless` may quiet a harm: none unless said (see harmsSent). */
  quietable: (path: string) => boolean = () => false,
): Harm[] {
  const valueAt = (path: string) => heldAt(body, path)
  return harms.filter((harm) => {
    // (Unless what's sent says it harms nothing, as its file says: a dry run; and only where the
    // person said so.)
    if (quieted(body, harm, quietable)) return false
    const at = valueAt(harm.path)
    if (!at.found) return false
    if (harm.contains !== undefined) {
      const wanted = JSON.stringify(harm.contains)
      return Array.isArray(at.value) && at.value.some((each) => JSON.stringify(each) === wanted)
    }
    if (harm.set) {
      return (
        at.value !== undefined &&
        at.value !== null &&
        !(Array.isArray(at.value) && at.value.length === 0)
      )
    }
    return JSON.stringify(at.value) === JSON.stringify(harm.is)
  })
}

/**
 * The harms a proposal's change does as it's sent (`body`, filled in from it), by its file's
 * `harms`. A harm's `unless` quiets it only where the person set what it names: the page wrote,
 * at just that path, a switch or a check of its own (a dry run's), never a value of its own or one
 * a switch fills. So a page can't make a change that harms look as if it didn't; and what quiets
 * it is in what's sent, as the person set it.
 */
export function harmsSent(proposed: Proposed, body: unknown, harms: readonly Harm[]): Harm[] {
  const kinds = new Map(
    proposed.fields.filter(holdsValue).map((field) => [field.key, field] as const),
  )
  const quietable = (path: string) => {
    let at: unknown = proposed.body
    for (const name of path.split('.')) {
      if (typeof at !== 'object' || at === null || Array.isArray(at) || !Object.hasOwn(at, name)) {
        return false
      }
      at = (at as Record<string, unknown>)[name]
    }
    const place = placeOf(at)
    const field = place === undefined ? undefined : kinds.get(place)
    return (field?.kind === 'switch' && field.values === undefined) || field?.kind === 'check'
  }
  return harmsIn(body, harms, quietable)
}

/**
 * The button's word as the person's values stand: the last switch that's on, shown, and says one
 * (Dry run); else the page's own.
 */
export function verbNow(
  proposed: Proposed,
  values: Readonly<Record<string, FieldValue>>,
): string | undefined {
  const hidden = hiddenFields(proposed.fields, values)
  const on = proposed.fields.filter(
    (field) =>
      field.kind === 'switch' && field.verb && values[field.key] === true && !hidden.has(field.key),
  )
  return (on.at(-1) as { verb?: string } | undefined)?.verb?.trim() ?? proposed.verb
}

/** A button's words where a change harms: its own verb, then each harm's ("Sync, prune and force"). */
export function harmedVerb(verb: string, harms: readonly { verb?: string }[]): string {
  const said = [verb]
  for (const harm of harms) {
    if (harm.verb && !said.some((one) => one.toLowerCase() === harm.verb!.toLowerCase())) {
      said.push(harm.verb)
    }
  }
  return said.length === 1 ? said[0]! : `${said.slice(0, -1).join(', ')} and ${said.at(-1)}`
}

/** Kubernetes' own groups: never written by a plugin, even where its file reads them. */
const KUBERNETES_GROUPS = /(^|\.)k8s\.io$|^(apps|batch|policy|autoscaling|extensions)$/

/**
 * Whether a plugin whose file says `changes` may propose `action` on `kind` (`group/Kind`): only
 * what its file says, and never one of Kubernetes' own kinds, whatever a file said.
 */
export function mayPropose(
  kind: string,
  action: ChangeAction,
  changes: readonly { kind: string; actions: readonly ChangeAction[] }[],
): boolean {
  const group = kind.slice(0, kind.indexOf('/'))
  if (group === '' || KUBERNETES_GROUPS.test(group)) return false
  return changes.some((granted) => granted.kind === kind && granted.actions.includes(action))
}

/**
 * What Lumovi's dialog asks the backend of a page's proposal: may it be asked at all (`check`),
 * what would the cluster make of it (`try`, a dry run), make it (`make`), or record that the
 * person cancelled it (`cancelled`). The plugin is named, with what its page was handed (as its
 * reads name it); what its file grants is the backend's own reading, never anything a page says.
 */
export interface PluginChangeRequest {
  step: 'check' | 'try' | 'make' | 'cancelled'
  plugin: string
  digest: string
  codeDigest: string
  context: string
  action: ChangeAction
  /** The object it's to (patch, delete, scale), as the page's token stood for it. */
  target?: ObjectRef
  /** A create's kind (`group/Kind`, as the page wrote it) and the namespace it's made in. */
  kind?: string
  namespace?: string
  /** The patch or the object, with the person's values in; a scale's count. */
  body?: unknown
  replicas?: number
  /**
   * For `make`: the object as the last try saw it, and what the change did to it there
   * (`effect`, the backend's own word for it): a change is made to that object, or to the object
   * as it is now only where it does the very same there.
   */
  seen?: { resourceVersion?: string; uid?: string; effect?: string }
  /** For `make` and `cancelled`: the fields the person changed from where they started. */
  fields?: string[]
}

/** What a person is told where the organization's policy lets no plugin propose a change. */
export const PROPOSALS_OFF = 'Your organization’s policy doesn’t let plugins propose changes.'

/** Why a proposal isn't asked, tried or made. */
export type ChangeRefusal =
  /** No plugin Lumovi has in use by that name whose code ran here, or its page's code changed. */
  | 'not-in-use'
  | 'changed'
  /** On a server: this browser isn't one Lumovi hands a plugin's code to. */
  | 'not-held'
  /** Its file doesn't say it proposes this change to this kind, or it's one of Kubernetes' own. */
  | 'not-granted'
  /** A scale of a kind that has no scale. */
  | 'no-scale'
  /** A create of a kind that's in a namespace, where the page names none and none is in view. */
  | 'no-namespace'
  /** The organization's policy lets no plugin propose a change (the desktop app's). */
  | 'off-by-policy'
  /** The cluster is read-only in Lumovi, or the person may not make changes there. */
  | 'read-only'
  | 'not-allowed'
  /** The object changed since the try the person saw: tried again, never made. */
  | 'conflict'
  /** The object isn't there, or the kind isn't served. */
  | 'not-found'
  /** The cluster refused it: its own words, and the field they name where they name one. */
  | 'invalid'
  | 'failed'

/** What the backend answers. A `try`'s answer is what the dialog shows. */
export type PluginChangeAnswer =
  | {
      ok: true
      /** The object as it is, and as the cluster says it would be (a create's: as made). */
      before?: unknown
      after?: unknown
      /**
       * A create's object as Lumovi sends it, in Kubernetes' order and with the generateName it
       * asks for (the name a dry run makes up is no name it will have): what the dialog shows.
       */
      sent?: unknown
      /** The kubectl command that makes the same change. */
      command?: string
      /** Who'd lose fields it sets, by the field: "operation" from "argocd-application-controller". */
      takesOver?: { field: string; manager: string }[]
      /** A deletion's: what the cluster waits for before it's gone. */
      finalizers?: string[]
      /** What `make` and the next try must name: the object as this try saw it, and the change's effect. */
      seen?: { resourceVersion?: string; uid?: string; effect?: string }
    }
  | {
      ok: false
      refused: ChangeRefusal
      /** The cluster's own words, where it said any. */
      said?: string
      /** The field its words name (`spec.revision`), where they name one. */
      field?: string
    }

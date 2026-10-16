/**
 * Fields Lumovi never shows nor hands over (a view's `withholds`): what a kind's objects hold
 * that nobody should read in Lumovi, like the line around a secret a scanner found. They're
 * taken out where objects leave the cluster's side (the backend, before the page, a plugin's
 * box or an assistant has them), and that fails closed:
 *
 * - a step into a list is taken of each item;
 * - where a step finds a value of another shape than a map, that whole value is taken out, at
 *   the deepest step reached; in a list, an item of another shape is taken out alone (null in
 *   its place, so the others keep theirs);
 * - a field that isn't there leaves the object as it is;
 * - and the annotation kubectl keeps an object in, which holds every field, goes too.
 *
 * What's withheld of a kind is what every plugin file Lumovi has says of it, together: a view
 * can only add to it. And while a file doesn't read whole, what it withholds can't be told:
 * nothing of the groups it names is shown (`groupsNamed`).
 */
import { parseAllDocuments } from 'yaml'
import { plain, type Plugin } from './plugins'
import type { ResourceKind } from './resources'

/** A field a view withholds. */
export interface WithheldField {
  /** Its path as Lumovi reads it: the keys, in order. */
  keys: readonly string[]
  /** The plugin whose file withholds it. */
  plugin: string
  /** What its file says of it: the plugin's words, never Lumovi's. */
  why?: string
}

/** What's withheld of each kind. */
export type WithheldKinds = ReadonlyMap<ResourceKind, readonly WithheldField[]>

/**
 * A plugin file that doesn't read whole (or at all): what it means to withhold can't be told, so
 * no object of its groups is shown. Of every group, where it can't even say its groups.
 */
export interface UnreadFile {
  file: string
  groups?: readonly string[]
}

/** What's withheld, and the files that may withhold what can't be told. */
export interface Withholding {
  kinds: WithheldKinds
  unread: readonly UnreadFile[]
}

/** Why no object of a kind a file that doesn't read may withhold fields of is shown. */
export const unreadSaid = (file: string) =>
  `This can’t be shown: ${plain(file)} doesn’t read, and it may withhold fields of it.`

/**
 * The API groups a file names, where it reads as YAML and names any: its `groups`, and every
 * kind's `group`. A file withholds fields of its own kinds alone, which are in its groups; so of
 * a file that doesn't read whole, these are the groups it may withhold fields of. Nothing, where
 * it doesn't say: then it may be any.
 */
export function groupsNamed(text: string): string[] | undefined {
  let read: unknown[]
  try {
    const documents = parseAllDocuments(text)
    if (documents.some((document) => document.errors.length > 0)) return undefined
    read = documents.map((document) => document.toJS() as unknown)
  } catch {
    return undefined
  }
  const found = new Set<string>()
  const walk = (value: unknown, key?: string) => {
    if (typeof value === 'string') {
      if (key === 'group' || key === 'groups') found.add(value)
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, key === 'groups' ? key : undefined)
    } else if (isMap(value)) {
      for (const [inner, item] of Object.entries(value)) walk(item, inner)
    }
  }
  read.forEach((document) => walk(document))
  // (The core group's kinds are Kubernetes' own, and never withheld.)
  found.delete('')
  return found.size > 0 ? [...found].sort() : undefined
}

/** Why an object that holds withheld fields isn't written whole in Lumovi. */
export const WITHHELD_EDIT =
  'Lumovi can’t edit this here: it holds fields Lumovi doesn’t show. Edit it with kubectl.'

/** Why a patch that would write, blank or read withheld fields isn't sent. */
export const WITHHELD_PATCH =
  'Lumovi can’t make this change here: it would change fields Lumovi doesn’t show. Make it with kubectl.'

/**
 * What Lumovi says where a field is withheld: its own sentence, whole without anything the
 * plugin says (`path` as Lumovi reads it, from `shownPath`).
 */
export const withheldSaid = (path: string, plugin: string) =>
  `Lumovi doesn’t show ${path} here: ${plugin}’s file withholds it.`

/** The annotation kubectl keeps the object it applied in: every field of it. */
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration'

/** Taken out: a sign, not a value. */
const GONE = Symbol('gone')

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `value` with `key` in place of what it held, or without it. (As pairs: never `value[key] =`.) */
const replaced = (value: Record<string, unknown>, key: string, inner: unknown) =>
  Object.fromEntries(
    Object.entries(value).flatMap(([each, held]) =>
      each !== key ? [[each, held]] : inner === GONE ? [] : [[each, inner]],
    ),
  )

/**
 * `value` without what `keys` lead to: a new value where anything is taken out, and `value`
 * itself where nothing is (it's never changed). GONE where `value` is itself taken out.
 */
function without(value: unknown, keys: readonly string[]): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) {
    let changed = false
    const items = value.map((item: unknown) => {
      const left = without(item, keys)
      if (left === item) return item
      changed = true
      return left === GONE ? null : left
    })
    return changed ? items : value
  }
  if (!isMap(value)) return GONE
  const [key, ...rest] = keys
  if (key === undefined || !Object.hasOwn(value, key)) return value
  const inner = rest.length > 0 ? without(value[key], rest) : GONE
  return inner === value[key] ? value : replaced(value, key, inner)
}

/**
 * `object` without the fields `withheld` names, nor the annotation that would hold them: a new
 * object where anything is taken out, and `object` itself where nothing is.
 */
export function withhold<T extends object>(
  object: T,
  withheld: readonly { keys: readonly string[] }[],
): T {
  if (withheld.length === 0) return object
  let left: unknown = object
  for (const { keys } of withheld) {
    const next = without(left, keys)
    left = next === GONE ? {} : next
  }
  const metadata = (left as { metadata?: unknown }).metadata
  if (
    isMap(metadata) &&
    isMap(metadata.annotations) &&
    Object.hasOwn(metadata.annotations, LAST_APPLIED)
  ) {
    left = replaced(left as Record<string, unknown>, 'metadata', {
      ...metadata,
      annotations: replaced(metadata.annotations, LAST_APPLIED, GONE),
    })
  }
  return left as T
}

/** Whether one path holds the other, or is it: what's written at either writes or blanks both. */
const overlap = (a: readonly string[], b: readonly string[]) =>
  a.slice(0, b.length).every((key, i) => key === b[i])

/** A JSON patch's path as keys, without its lists' indexes (a step into a list is any item). */
const pointerKeys = (pointer: string) =>
  pointer
    .split('/')
    .slice(1)
    .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'))
    .filter((key) => !/^(?:\d+|-)$/.test(key))

/** Whether a merge patch writes at `keys`, or a value in place of anything holding them. */
function writes(patch: unknown, keys: readonly string[]): boolean {
  // (A list, a value or null in place of a map holding them replaces or blanks them whole; and
  // a strategic merge's own directives say more than their keys.)
  if (!isMap(patch) || Object.keys(patch).some((key) => key.startsWith('$'))) return true
  const [key, ...rest] = keys
  if (key === undefined || !Object.hasOwn(patch, key)) return false
  return rest.length === 0 || writes(patch[key], rest)
}

/**
 * kubectl's annotation, as a field withheld of its own: it holds every field, the withheld ones
 * among them, and what's written there a later `kubectl apply` writes back.
 */
const LAST_APPLIED_KEYS = ['metadata', 'annotations', LAST_APPLIED]

/** The one JSON patch `test` Lumovi sends itself: that the object is still the version read. */
const VERSION_TEST = '/metadata/resourceVersion'

/**
 * Whether a patch of `type` would write a withheld field, blank it, or tell anything of it:
 * refused, as Lumovi can't show what it changed. kubectl's annotation is one of them. A JSON
 * patch of such a kind only adds, replaces and removes: its `copy`, `move` and `test` read
 * wherever their paths are, so each is refused (but the test of the object's version that Lumovi
 * sends with a change). A patch of other fields (labels, say) is not refused.
 */
export function patchTouches(
  type: string,
  patch: unknown,
  withheld: readonly { keys: readonly string[] }[],
): boolean {
  if (withheld.length === 0) return false
  const guarded = [...withheld.map(({ keys }) => keys), LAST_APPLIED_KEYS]
  if (type === 'json') {
    if (!Array.isArray(patch)) return true
    return patch.some((op: unknown) => {
      if (!isMap(op)) return true
      if (op.op === 'test') return op.path !== VERSION_TEST || op.from !== undefined
      if (op.op !== 'add' && op.op !== 'replace' && op.op !== 'remove') return true
      if (op.from !== undefined || typeof op.path !== 'string') return true
      const written = pointerKeys(op.path)
      return guarded.some((keys) => overlap(written, keys) || overlap(keys, written))
    })
  }
  return guarded.some((keys) => writes(patch, keys))
}

/**
 * A withheld field's path as Lumovi reads it, said to a person: `report.secrets[].match`, with
 * `[]` where `object` has a list at that step (an object without it says its keys alone).
 */
export function shownPath(keys: readonly string[], object?: unknown): string {
  let value = object
  return keys
    .map((key, i) => {
      const named = /^[\w-]+$/.test(key) ? `${i ? '.' : ''}${key}` : `[${JSON.stringify(key)}]`
      value = isMap(value) && Object.hasOwn(value, key) ? value[key] : undefined
      if (!Array.isArray(value)) return named
      value = value.find(isMap)
      return `${named}[]`
    })
    .join('')
}

/**
 * What every one of `plugins` withholds, by kind: together, each field once for each plugin that
 * says it. A plugin that withholds nothing of a kind adds nothing to it, and takes nothing away.
 */
export function withheldKinds(plugins: readonly Plugin[]): Map<ResourceKind, WithheldField[]> {
  const kinds = new Map<ResourceKind, WithheldField[]>()
  for (const plugin of plugins) {
    for (const view of plugin.views) {
      for (const { keys, why } of view.withholds ?? []) {
        for (const kind of view.kinds) {
          const said = kinds.get(kind) ?? []
          const same = said.some(
            (field) =>
              field.plugin === plugin.name && field.keys.join('\u0000') === keys.join('\u0000'),
          )
          if (!same) said.push({ keys, plugin: plugin.name, ...(why ? { why } : {}) })
          kinds.set(kind, said)
        }
      }
    }
  }
  return kinds
}

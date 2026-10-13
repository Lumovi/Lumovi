/**
 * What a person comes back to in a cluster: the objects they pinned (the first nine numbered,
 * opened with ⌥1–⌥9) and the views of a list they saved (its filter, health, labels, sort,
 * columns and namespaces). Kept per cluster. On the desktop they're the app's own, with its other
 * settings; on a server, each signed-in person's, kept by the server in its sealed state
 * (src/server/state.ts) and never in the browser, so a shared browser keeps nothing of anyone's.
 *
 * What's here is what both read: the shapes, the most there can be, and the check a server makes
 * of what a page sends it before it keeps it.
 */
import type { Health } from './health'
import { isResourceKind, type ResourceKind } from './resources'

/** A label or an annotation, made a column. */
export interface AddedColumn {
  from: 'label' | 'annotation'
  key: string
}

/**
 * What a person chose for a list's columns, as it's kept: with Lumovi's other settings on the
 * desktop, and inside a saved view, which a server keeps for each person. Applied by the page
 * (src/renderer/src/features/resources/column-choices.ts).
 */
export interface ColumnChoices {
  /** Columns by id, in the order chosen; any not named keep their places after them. */
  order?: string[]
  /** Columns hidden, by id. */
  hidden?: string[]
  /** Widths dragged to, in pixels, by id. */
  widths?: Record<string, number>
  /** Labels and annotations made columns, in the order added. */
  added?: AddedColumn[]
}

/** The most there can be, per person and cluster. */
export const MARKS_LIMITS = {
  /** Pinned objects; the first `numbered` have a number key. */
  pins: 20,
  numbered: 9,
  /** Saved views of one kind, and of every kind together. */
  viewsOfKind: 20,
  views: 50,
  /** Characters of a view's name. */
  viewName: 80,
  /** Characters of a view's text filter and label selector, and of its sort column's id. */
  text: 1_000,
  /** Namespaces a view keeps, and column ids in each of its column lists. */
  namespaces: 100,
  columns: 200,
} as const

/** An object pinned: its kind, name and namespace (none for one that's cluster-wide). */
export interface Pin {
  kind: ResourceKind
  name: string
  namespace?: string
}

/** What a list showed, kept under a name for its kind. */
export interface SavedView {
  name: string
  kind: ResourceKind
  q?: string
  health?: Health[]
  labels?: string
  sort?: string
  desc?: boolean
  /** The namespaces it showed; `null`, all of them. Restoring it never changes the cluster's own pick. */
  namespaces?: string[] | null
  columns?: ColumnChoices
}

/** One cluster's pins and views, as they're kept. */
export interface Marks {
  pins: Pin[]
  views: SavedView[]
}

export const NO_MARKS: Marks = Object.freeze({ pins: [], views: [] }) as unknown as Marks

/** The same object: what a pin is told apart by. */
export const samePin = (a: Pin, b: Pin) =>
  a.kind === b.kind && a.name === b.name && (a.namespace ?? '') === (b.namespace ?? '')

/*
 * Lumovi's words when one more is refused. `called` is how the page names the object ("Deployment
 * cart") or the kind's lists ("deployments").
 */
export const tooManyPins = (called: string) =>
  `${MARKS_LIMITS.pins} objects are pinned in this cluster, the most there can be. Unpin one to pin ${called}.`
export const tooManyViewsOfKind = (kinds: string) =>
  `${MARKS_LIMITS.viewsOfKind} views of ${kinds} are saved, the most there can be. Delete one to save this.`
export const tooManyViews = () =>
  `${MARKS_LIMITS.views} views of this cluster are saved, the most there can be. Delete one to save this.`

/** A namespace's name: a DNS label. */
const NAMESPACE = /^(?=.{1,63}$)[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
/** What can't be an object's name: a slash, "." or "..", a character that isn't one, or past 253. */
// eslint-disable-next-line no-control-regex
const NOT_A_NAME = /[/\u0000-\u001f\u007f]|^\.{1,2}$/
const isName = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 253 && !NOT_A_NAME.test(value)
const HEALTHS = new Set<string>(['healthy', 'progressing', 'warning', 'critical', 'neutral'])
const isText = (value: unknown, most: number) => typeof value === 'string' && value.length <= most
const isList = (value: unknown, most: number, each: (item: unknown) => boolean) =>
  Array.isArray(value) && value.length <= most && value.every(each)
const keysOnly = (value: object, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key))
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isColumns(value: unknown): boolean {
  if (!isRecord(value) || !keysOnly(value, ['order', 'hidden', 'widths', 'added'])) return false
  const ids = (list: unknown) =>
    list === undefined || isList(list, MARKS_LIMITS.columns, (id) => isText(id, 512))
  const widths = value.widths
  return (
    ids(value.order) &&
    ids(value.hidden) &&
    (widths === undefined ||
      (isRecord(widths) &&
        Object.keys(widths).length <= MARKS_LIMITS.columns &&
        Object.values(widths).every(
          (width) =>
            typeof width === 'number' && Number.isFinite(width) && width >= 0 && width <= 10_000,
        ))) &&
    (value.added === undefined ||
      isList(
        value.added,
        MARKS_LIMITS.columns,
        (added) =>
          isRecord(added) &&
          keysOnly(added, ['from', 'key']) &&
          (added.from === 'label' || added.from === 'annotation') &&
          isText(added.key, 317),
      ))
  )
}

function isPin(value: unknown): value is Pin {
  return (
    isRecord(value) &&
    keysOnly(value, ['kind', 'name', 'namespace']) &&
    isResourceKind(value.kind) &&
    isName(value.name) &&
    (value.namespace === undefined ||
      (typeof value.namespace === 'string' && NAMESPACE.test(value.namespace)))
  )
}

function isView(value: unknown): value is SavedView {
  if (!isRecord(value)) return false
  const keys = ['name', 'kind', 'q', 'health', 'labels', 'sort', 'desc', 'namespaces', 'columns']
  const { name, kind, q, health, labels, sort, desc, namespaces, columns } = value
  return (
    keysOnly(value, keys) &&
    typeof name === 'string' &&
    name.trim().length > 0 &&
    name.length <= MARKS_LIMITS.viewName &&
    isResourceKind(kind) &&
    (q === undefined || isText(q, MARKS_LIMITS.text)) &&
    (health === undefined || isList(health, HEALTHS.size, (level) => HEALTHS.has(String(level)))) &&
    (labels === undefined || isText(labels, MARKS_LIMITS.text)) &&
    (sort === undefined || isText(sort, MARKS_LIMITS.text)) &&
    (desc === undefined || typeof desc === 'boolean') &&
    (namespaces === undefined ||
      namespaces === null ||
      isList(
        namespaces,
        MARKS_LIMITS.namespaces,
        (ns) => typeof ns === 'string' && NAMESPACE.test(ns),
      )) &&
    (columns === undefined || isColumns(columns))
  )
}

/**
 * What's wrong with a cluster's pins and views as a page sent them, if anything: a server keeps
 * them only when there's nothing. The caps say so in Lumovi's words, as the page does before it
 * asks; anything else is a page that isn't Lumovi's, and is told only that.
 */
export function marksProblem(value: unknown): string | undefined {
  if (!isRecord(value) || !keysOnly(value, ['pins', 'views'])) return 'Isn’t what Lumovi keeps.'
  const { pins, views } = value
  if (!Array.isArray(pins) || !Array.isArray(views)) return 'Isn’t what Lumovi keeps.'
  if (pins.length > MARKS_LIMITS.pins) return tooManyPins('another')
  if (!pins.every(isPin)) return 'Isn’t what Lumovi keeps.'
  if (pins.some((pin, i) => pins.findIndex((other) => samePin(pin, other)) !== i)) {
    return 'Isn’t what Lumovi keeps.'
  }
  if (views.length > MARKS_LIMITS.views) return tooManyViews()
  if (!views.every(isView)) return 'Isn’t what Lumovi keeps.'
  const byKind = new Map<string, string[]>()
  for (const view of views) {
    const names = byKind.get(view.kind) ?? []
    // (A name is a view's own among its kind's.)
    if (names.includes(view.name)) return 'Isn’t what Lumovi keeps.'
    names.push(view.name)
    byKind.set(view.kind, names)
    if (names.length > MARKS_LIMITS.viewsOfKind) return tooManyViewsOfKind('one kind')
  }
  return undefined
}

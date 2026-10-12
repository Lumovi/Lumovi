/**
 * What a person chose for a list's columns: which show, in what order, how wide, and which labels
 * and annotations are columns too. Kept per kind and per cluster; applied to whatever columns a
 * list has (its own, a kind's, a plugin's), so the menu takes a list of columns and a place to keep
 * choices.
 */
import type { KubeObject } from '@shared/api'
import type { Column } from './columns'

/** A label or an annotation, made a column. */
export interface AddedColumn {
  from: 'label' | 'annotation'
  key: string
}

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

/** The column that can't be hidden or moved: a row is its object's name. */
export const ALWAYS_SHOWN = 'name'

/** The narrowest a column can be dragged to; the name's, which a row is. */
export const NARROWEST = 64
export const NARROWEST_NAME = 160

/** How far ⌥← and ⌥→ size a column. */
export const WIDTH_STEP = 16

/** How wide an added column starts. */
export const ADDED_WIDTH = 160

export const addedId = ({ from, key }: AddedColumn) => `${from}:${key}`

/** A label's or an annotation's value on an object, if it has one. */
export function addedValue(object: KubeObject, { from, key }: AddedColumn): string | undefined {
  const map = from === 'label' ? object.metadata.labels : object.metadata.annotations
  const value = map?.[key]
  return typeof value === 'string' ? value : undefined
}

/** A key's last part, after its last "/": what its column is headed. */
export const keyName = (key: string) => key.slice(key.lastIndexOf('/') + 1)

/**
 * The header an added column has: its key's last part; or its whole key where another added
 * column's last part is the same (cut in its middle where it's drawn).
 */
export function addedHeader(added: AddedColumn, all: readonly AddedColumn[]): string {
  const alike = all.filter((other) => keyName(other.key) === keyName(added.key)).length > 1
  return alike ? added.key : keyName(added.key)
}

/** A column of the menu: one of the list's, or one added; shown or not. */
export interface ColumnRow {
  column: Column
  shown: boolean
  added?: AddedColumn
}

/**
 * Every column a list could show, in the order chosen: the name first, then the order, then the
 * rest where they were (the list's, then those added). `made` makes an added column's cells.
 */
export function columnRows(
  columns: readonly Column[],
  choices: ColumnChoices | undefined,
  made: (added: AddedColumn, header: string) => Column,
): ColumnRow[] {
  const added = choices?.added ?? []
  const all: ColumnRow[] = [
    ...columns.map((column) => ({ column, shown: true })),
    ...added.map((each) => ({
      column: made(each, addedHeader(each, added)),
      shown: true,
      added: each,
    })),
  ].map((row) => ({
    ...row,
    shown: row.column.id === ALWAYS_SHOWN || !choices?.hidden?.includes(row.column.id),
  }))
  const order = choices?.order ?? []
  const placed = order.flatMap((id) => all.filter((row) => row.column.id === id))
  const rest = all.filter((row) => !order.includes(row.column.id))
  const ordered = [...placed, ...rest]
  const name = ordered.filter((row) => row.column.id === ALWAYS_SHOWN)
  return [...name, ...ordered.filter((row) => row.column.id !== ALWAYS_SHOWN)]
}

/** The columns a list shows, as chosen: in order, without the hidden, at the widths dragged to. */
export function shownColumns(
  rows: readonly ColumnRow[],
  choices: ColumnChoices | undefined,
): Column[] {
  return rows
    .filter((row) => row.shown)
    .map(({ column }) => {
      const width = choices?.widths?.[column.id]
      return width ? { ...column, width: `${Math.round(width)}px` } : column
    })
}

/** What's kept of a change: nothing, where it's taken a list back to Lumovi's. */
function tidy(choices: ColumnChoices): ColumnChoices | undefined {
  const kept: ColumnChoices = {
    ...(choices.order?.length ? { order: choices.order } : {}),
    ...(choices.hidden?.length ? { hidden: choices.hidden } : {}),
    ...(choices.widths && Object.keys(choices.widths).length ? { widths: choices.widths } : {}),
    ...(choices.added?.length ? { added: choices.added } : {}),
  }
  return Object.keys(kept).length ? kept : undefined
}

/** Shows a column, or hides it (never the name). */
export function toggled(choices: ColumnChoices | undefined, id: string): ColumnChoices | undefined {
  if (id === ALWAYS_SHOWN) return choices
  const hidden = choices?.hidden ?? []
  return tidy({
    ...choices,
    hidden: hidden.includes(id) ? hidden.filter((each) => each !== id) : [...hidden, id],
  })
}

/** Moves a column to a place among `rows` (never above the name, nor the name itself). */
export function moved(
  choices: ColumnChoices | undefined,
  rows: readonly ColumnRow[],
  id: string,
  to: number,
): ColumnChoices | undefined {
  const ids = rows.map((row) => row.column.id)
  const from = ids.indexOf(id)
  const floor = ids[0] === ALWAYS_SHOWN ? 1 : 0
  const place = Math.max(floor, Math.min(ids.length - 1, to))
  if (from < floor || from === place) return choices
  ids.splice(from, 1)
  ids.splice(place, 0, id)
  return tidy({ ...choices, order: ids })
}

/** Adds a label's or an annotation's column, last; one already there stays as it is. */
export function withAdded(
  choices: ColumnChoices | undefined,
  added: AddedColumn,
): ColumnChoices | undefined {
  const all = choices?.added ?? []
  if (all.some((each) => addedId(each) === addedId(added))) return choices
  return tidy({ ...choices, added: [...all, added] })
}

/** Takes an added column away, and what was chosen for it. */
export function withoutAdded(
  choices: ColumnChoices | undefined,
  id: string,
): ColumnChoices | undefined {
  const { [id]: _width, ...widths } = choices?.widths ?? {}
  return tidy({
    ...choices,
    added: choices?.added?.filter((each) => addedId(each) !== id),
    order: choices?.order?.filter((each) => each !== id),
    hidden: choices?.hidden?.filter((each) => each !== id),
    widths,
  })
}

/** Sizes a column; no width gives it its own back. */
export function sized(
  choices: ColumnChoices | undefined,
  id: string,
  width: number | undefined,
): ColumnChoices | undefined {
  const { [id]: _old, ...widths } = choices?.widths ?? {}
  return tidy({ ...choices, widths: width === undefined ? widths : { ...widths, [id]: width } })
}

/** The least a column's track takes, in px: what its width says first. */
export function leastWidth(column: Column): number {
  return Number(/(\d+)px/.exec(column.width)?.[1] ?? NARROWEST)
}

/**
 * The columns a list's width holds, in the person's order: the last ones that don't fit aren't
 * drawn (never the name), so a list never scrolls sideways. `unfit` are those left out.
 */
export function fitInOrder(
  columns: readonly Column[],
  width: number,
): { visible: Column[]; unfit: string[] } {
  const visible: Column[] = []
  const unfit: string[] = []
  let used = 0
  for (const column of columns) {
    const least = leastWidth(column)
    if (column.id === ALWAYS_SHOWN || (unfit.length === 0 && used + least <= width)) {
      visible.push(column)
      used += least
    } else unfit.push(column.id)
  }
  return { visible, unfit }
}

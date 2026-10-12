/**
 * A list as text, for copying its picked rows and saving it as CSV: its shown columns, in their
 * order, with their headers, and a row an object. A name column that names each object's
 * namespace is two columns here, Namespace and Name, as a spreadsheet wants them.
 *
 * Copy has each value as the list shows it, whole; a CSV has it as a spreadsheet reads it (a
 * column's `csv`): a time in full, a number bare, nothing where the list has a dash.
 */
import { isValidElement, type ReactNode } from 'react'
import type { KubeObject } from '@shared/api'
import type { CellContext, Column } from './columns'

/** What a list shows where an object has nothing. */
const DASH = '—'

/**
 * The words a cell shows: its text, wherever it is in the cell; a part that says its text in a
 * prop (`text`, a status's `label`) says that. Text beside text runs on ("Pod/web"); a part of
 * its own beside another is a word apart ("nginx:1.27 +1").
 */
export function textOf(node: ReactNode): string {
  const walk = (part: ReactNode): string => {
    if (part === null || part === undefined || typeof part === 'boolean') return ''
    if (typeof part === 'string' || typeof part === 'number') return String(part)
    if (Array.isArray(part)) {
      return part
        .map(
          (each, i) =>
            (i > 0 && (isValidElement(each) || isValidElement(part[i - 1])) ? ' ' : '') +
            walk(each),
        )
        .join('')
    }
    if (isValidElement(part)) {
      const props = part.props as { children?: ReactNode; text?: unknown; status?: unknown }
      if (typeof props.text === 'string') return props.text
      const label = (props.status as { label?: unknown } | undefined)?.label
      if (typeof label === 'string') return label
      return walk(props.children)
    }
    return ''
  }
  return walk(node).replace(/\s+/g, ' ').trim()
}

/** A column's words for an object: its own, or its cell's. */
export function cellText(column: Column, object: KubeObject, ctx: CellContext): string {
  return column.text ? column.text(object, ctx) : textOf(column.cell(object, ctx))
}

/** A column's value for an object in a CSV: a number as one, where the column knows it is. */
function csvValue(column: Column, object: KubeObject, ctx: CellContext): string | number {
  if (column.csv) return column.csv.value(object, ctx) ?? ''
  const text = cellText(column, object, ctx)
  return text === DASH ? '' : text
}

export interface ListTable<Cell = string> {
  header: string[]
  rows: Cell[][]
}

function tableOf<Cell extends string | number>(
  columns: readonly Column[],
  objects: readonly KubeObject[],
  header: (column: Column) => string,
  value: (column: Column, object: KubeObject) => Cell,
): ListTable<Cell | string> {
  return {
    header: columns.flatMap((column) =>
      column.namespaced ? ['Namespace', header(column)] : [header(column)],
    ),
    rows: objects.map((object) =>
      columns.flatMap((column): (Cell | string)[] =>
        column.namespaced
          ? [object.metadata.namespace ?? '', object.metadata.name]
          : [value(column, object)],
      ),
    ),
  }
}

/** Rows as Copy has them: each value as the list shows it, never cut. */
export function shownTable(
  columns: readonly Column[],
  objects: readonly KubeObject[],
  ctx: CellContext,
): ListTable {
  return tableOf<string>(
    columns,
    objects,
    (column) => column.header,
    (column, object) => cellText(column, object, ctx),
  )
}

/** Rows as a CSV has them: each value whole, as a spreadsheet reads it. */
export function csvTable(
  columns: readonly Column[],
  objects: readonly KubeObject[],
  ctx: CellContext,
): ListTable<string | number> {
  return tableOf(
    columns,
    objects,
    (column) => column.csv?.header ?? column.header,
    (column, object) => csvValue(column, object, ctx),
  )
}

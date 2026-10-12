/**
 * The kit's Table, as a plugin may say it: what Lumovi draws a list of things from. Data only,
 * every part of it something that survives being written as text and read back: no functions,
 * no nodes, no class, color or width. A plugin names its columns and gives its rows; Lumovi
 * lays them out, sorts them, cuts a long name, and draws ages, statuses and meters its own way.
 *
 * This is what the Table's component is given. Between a plugin and it stands the door: what a
 * row opens (`opens`) is, as a plugin says it, a token Lumovi gave the plugin with an object it
 * read, never a kind and a name the plugin wrote, and the door swaps the token for the reference
 * the component gets here. What a person can press is a handler (`TableCarries`), each called
 * with one object of what it carries.
 */
import type { Health } from '../health'
import type { ResourceKind } from '../resources'

/** How much may be said: counted where a description is taken in, not by the Table. */
export const TABLE_LIMITS = {
  /** Rows at the top level, groups' rows together. */
  rows: 5_000,
  /** Rows inside one row. */
  nested: 200,
  /** Columns after the lead. */
  columns: 8,
  /** Characters of a name, a word beside it, a heading or a cell's text. */
  text: 253,
  /** Characters of the line under a name, a note, or what a state says. */
  line: 500,
  /** Rows may hold rows, and those hold none. */
  depth: 1,
} as const

/**
 * An object in the cluster, as Lumovi names it: what a row opens. Lumovi's own to give: the
 * door makes it from the token a plugin was handed.
 */
export interface ObjectRef {
  kind: ResourceKind
  name: string
  namespace?: string
}

/**
 * How wide a column is, from the one scale: `narrow` (a count, an age), `normal` (a share of
 * what's left), `wide` (a share and a bit more), or `text`: as wide as its widest value, which
 * Lumovi measures over all the rows it was given. A status brings its own width.
 */
export type ColumnWidth = 'narrow' | 'normal' | 'wide' | 'text'

interface Column {
  /** What the column is called. Always given: a phone labels its facts with it, a screen reader says it. */
  name: string
  /** One of the scale; `normal` unless said. */
  width?: ColumnWidth
  /** Whether a person can sort by it. */
  sorts?: boolean
}

/** A column and the kind of thing its cells hold: one of these, and nothing free-form. */
export type TableColumn =
  | (Column & { kind: 'text' })
  /** A number, or a number with its unit as text ("7 nodes"): stands right, in tabular figures. */
  | (Column & { kind: 'number' })
  /** A moment: Lumovi says how long ago, or how soon. */
  | (Column & { kind: 'age' })
  /** A level and its word. Sorts worst first, by the level and not the word. */
  | (Column & { kind: 'status' })
  /** How much of something is used, as a bar with its words. */
  | (Column & { kind: 'meter' })

/** What a cell holds, by its column's kind; nothing at all is a cell of its own, `none`. */
export type TableCell =
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: number; text?: string }
  /** The moment, as text (RFC 3339): never "3 hours ago". */
  | { kind: 'age'; time: string }
  | { kind: 'status'; level: Health; word: string }
  /** `used` of `of` (no `of`: there's no limit); `text` says it ("24 of 64 cores"). */
  | { kind: 'meter'; label: string; used: number; of?: number; text: string }
  /** Nothing to say here: drawn as a dash. */
  | { kind: 'none' }

/** What a row is called: the first thing in it. */
export interface TableLead {
  /** A dot in this level; none, and the name keeps its place. */
  level?: Health
  name: string
  /** A quiet word beside the name (a namespace): gives way first when there's no room. */
  beside?: string
  /** One line under the name. */
  under?: string
}

/** A row inside a row: everything a row has, but rows of its own. */
export interface TableInnerRow {
  /** Its own among the table's rows, and the same from one description to the next. */
  key: string
  lead: TableLead
  /** One for each column, in the columns' order. */
  cells: TableCell[]
  /** Instead of its cells from this column on: words that take the rest of the row. */
  rest?: { from: number; text: string }
  /** Runs under the whole row, two lines at most. */
  note?: string
  /** The object it opens. A row with one is pressed whole. */
  opens?: ObjectRef
}

export interface TableRow extends TableInnerRow {
  /**
   * The group it's in. Rows that follow each other with the same one stand under one heading
   * of that name, with their count; a row with none stands under no heading.
   */
  group?: string
  /** Rows it holds: one level, and those hold none. */
  rows?: TableInnerRow[]
}

/** Nothing to list, and why: the plugin says which, and gives the words. */
export type TableState =
  /** Still being read. */
  | { is: 'busy' }
  /** Couldn't be read: in the cluster's own words, with a way to try again. */
  | { is: 'failed'; title: string; said: string }
  /** Nothing there, or nothing that matches. */
  | { is: 'empty'; title: string; line?: string }
  /** Nothing to list and nothing wrong: one calm line; `good` when that's good news. */
  | { is: 'quiet'; line: string; good?: boolean }

export interface Table {
  /** What the table is of: said above it, and what a screen reader calls it. */
  title: string
  columns: TableColumn[]
  /** Whether the columns' names show as headings; without them it's a list of rows. */
  headings: boolean
  /** Whether a person can sort by the rows' names. */
  nameSorts?: boolean
  rows: TableRow[]
  /** How many rows show at first; the rest wait behind "Show all". All of them, unless said. */
  shows?: number
  /** In place of rows, when there are none to show. */
  state?: TableState
}

/** What a person can press, and what each handler is called with. */
export interface TableCarries {
  /** Pressed a row that opens something (Lumovi opens the object itself): the row's key. */
  open: { row: string }
  /** Pressed "Try again" of a table that failed. */
  retry: Record<string, never>
}

/** A count with its noun: "1 cell", "6 columns". */
const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/** A kind of cell, as a sentence names it. */
const A_KIND = {
  text: 'text',
  number: 'a number',
  age: 'an age',
  status: 'a status',
  meter: 'a meter',
} as const

/**
 * What's wrong with a table that its kinds can't say, for whoever wrote it: where, counted from
 * 1 as they wrote it (both places, where two clash), then what, then what it should be. One
 * line of Lumovi's own words that quotes nothing the table holds: a key is named by where it
 * is, never by its text. Nothing, when the table can be drawn as it's described. Checked where
 * a description is taken in, so the component is only ever given one that passes.
 */
export function tableProblem(table: Table): string | undefined {
  const columns = table.columns.length
  const rows = new Map<string, number>()
  for (const [r, row] of table.rows.entries()) {
    const first = rows.get(row.key)
    if (first !== undefined) return `Rows ${first} and ${r + 1} have the same key.`
    rows.set(row.key, r + 1)
    const inner = new Map<string, number>()
    for (const [i, each] of [row, ...(row.rows ?? [])].entries()) {
      // (Its place: a row, or a row inside one.)
      const here = i === 0 ? `Row ${r + 1}` : `In row ${r + 1}, inner row ${i}`
      if (i > 0) {
        const same = inner.get(each.key)
        if (same !== undefined) {
          return `In row ${r + 1}, inner rows ${same} and ${i} have the same key.`
        }
        inner.set(each.key, i)
      }
      if (each.cells.length !== columns) {
        return `${here} has ${counted(each.cells.length, 'cell')}, and the table has ${counted(columns, 'column')}.`
      }
      for (const [c, cell] of each.cells.entries()) {
        const takes = table.columns[c]!.kind
        if (cell.kind !== 'none' && cell.kind !== takes) {
          // (By its own words only: a kind that isn't one of them is said to be none, whatever
          // was checked before this.)
          if (!Object.hasOwn(A_KIND, cell.kind) || !Object.hasOwn(A_KIND, takes)) {
            return `${here}, cell ${c + 1} isn’t a kind of cell.`
          }
          return `${here}, cell ${c + 1} is ${A_KIND[cell.kind]}, and its column takes ${A_KIND[takes]}.`
        }
      }
      if (each.rest) {
        const { from } = each.rest
        if (!Number.isInteger(from) || from < 0) {
          return `${here}’s rest doesn’t start at one of the table’s columns.`
        }
        if (from >= columns) {
          return `${here}’s rest starts at column ${from + 1}, and the table has ${counted(columns, 'column')}.`
        }
      }
    }
  }
  return undefined
}

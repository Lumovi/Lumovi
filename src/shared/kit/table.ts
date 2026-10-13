/**
 * The kit's Table, declared: what a plugin may say to have Lumovi draw a list of things. Data
 * only, every part of it something that survives being written as text and read back: no
 * functions, no nodes, no class, color or width. A plugin names its columns and gives its rows;
 * Lumovi lays them out, sorts them, cuts a long name, and draws ages, statuses and meters its own
 * way.
 *
 * One declaration (`table`), and everything else from it: the door's check of what a plugin's
 * code sends, the kit's types (`TableProps`, worked out from it), and what a table is refused
 * for that the kinds can't say (`tableProblem`). Between a plugin and the component stands the
 * door: every text a plugin wrote reaches the component as a `Their`, drawn in pieces; what a row
 * opens (`opens`) is, as a plugin says it, a token Lumovi gave the plugin with an object it read,
 * which the door swaps for the object; and what a person can press is a handler, called with what
 * its event carries.
 */
import type { Health } from '../health'
import {
  choice,
  cut,
  handler,
  list,
  number,
  object,
  oneOf,
  record,
  text,
  time,
  yesOrNo,
  type Part,
  type PropsOf,
  type Their,
  type WrittenProps,
} from './declare'

export type { ObjectRef } from './declare'

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

export const HEALTHS = [
  'healthy',
  'progressing',
  'warning',
  'critical',
  'neutral',
] as const satisfies readonly Health[]

/**
 * How wide a column is, from the one scale: `narrow` (a count, an age), `normal` (a share of
 * what's left), `wide` (a share and a bit more), or `text`: as wide as its widest value, which
 * Lumovi measures over all the rows it was given. A status brings its own width.
 */
export const COLUMN_WIDTHS = ['narrow', 'normal', 'wide', 'text'] as const
/** The kind of thing a column's cells hold: one of these, and nothing free-form. */
export const COLUMN_KINDS = ['text', 'number', 'age', 'status', 'meter'] as const

const name = text(TABLE_LIMITS.text)
const line = text(TABLE_LIMITS.line)
/** As large as a count or a size in a cluster comes. */
const LARGEST = Number.MAX_SAFE_INTEGER

/**
 * A column. Its name is always given: a phone labels its facts with it, and a screen reader says
 * it, whether or not headings show. `normal` unless said; sorts only where said.
 */
export const column = record(
  { name, kind: oneOf(COLUMN_KINDS), width: oneOf(COLUMN_WIDTHS), sorts: yesOrNo },
  ['name', 'kind'],
)

/** What a cell holds, by its column's kind; nothing at all is a cell of its own, `none`. */
export const cell = choice(
  'kind',
  {
    text: { text: name },
    /** A number, or a number with its unit as text ("7 nodes"): stands right, in tabular figures. */
    number: { value: number(-LARGEST, LARGEST), text: name },
    /** A moment, as text (RFC 3339): Lumovi says how long ago, or how soon, never the plugin. */
    age: { time },
    /** A level and its word. Sorts worst first, by the level and not the word. */
    status: { level: oneOf(HEALTHS), word: name },
    /** `used` of `of` (no `of`: there's no limit); `text` says it ("24 of 64 cores"). */
    meter: { label: name, used: number(0, LARGEST), of: number(0, LARGEST), text: name },
    /** Nothing to say here: drawn as a dash. */
    none: {},
  },
  { number: ['text'], meter: ['of'] },
)

/** What a row is called: a dot in its level, its name, a quiet word beside, a line under. */
export const lead = record({ level: oneOf(HEALTHS), name, beside: name, under: line }, ['name'])

/** What a row has, and a row inside one too. */
const ROW = {
  /** Its own among the table's rows (or its row's), and the same from one description to the next. */
  key: name,
  lead,
  /** One for each column, in the columns' order. */
  cells: list(cell, TABLE_LIMITS.columns),
  /**
   * Instead of its cells from this column on: words that take the rest of the row; with a
   * `time`, Lumovi says how long ago after them ("Launching · 3m").
   */
  rest: record({ from: number(0, TABLE_LIMITS.columns - 1, true), text: line, time }, [
    'from',
    'text',
  ]),
  /** Runs under the whole row, two lines at most. */
  note: line,
  /** The object it opens. A row with one is pressed whole. */
  opens: object,
} as const

/** A row inside a row: everything a row has, but rows of its own. */
const innerRow = record(ROW, ['key', 'lead', 'cells'])

const row = record(
  {
    ...ROW,
    /**
     * The group it's in. Rows that follow each other with the same one stand under one heading
     * of that name, with their count; a row with none stands under no heading.
     */
    group: name,
    /** Rows it holds: one level, and those hold none. */
    rows: list(innerRow, TABLE_LIMITS.nested),
  },
  ['key', 'lead', 'cells'],
)

/** Nothing to list, and why: the plugin says which, and gives the words. */
export const state = choice(
  'is',
  {
    /** Still being read. */
    busy: {},
    /** Couldn't be read: in the cluster's own words, with a way to try again. */
    failed: { title: name, said: line },
    /** Nothing there, or nothing that matches. */
    empty: { title: name, line },
    /** Nothing to list and nothing wrong: one calm line; `good` when that's good news. */
    quiet: { line, good: yesOrNo },
  },
  { empty: ['line'], quiet: ['good'] },
)

/** The Table, as a plugin says it. */
export const table = {
  name: 'Table',
  holds: 'nothing',
  props: {
    /** What the table is of: said above it, and what a screen reader calls it. */
    title: name,
    columns: list(column, TABLE_LIMITS.columns),
    /** Whether the columns' names show as headings; without them it's a list of rows. */
    headings: yesOrNo,
    /** Whether a person can sort by the rows' names. */
    nameSorts: yesOrNo,
    rows: list(row, TABLE_LIMITS.rows),
    /**
     * How many rows show at first, in each group alike; the rest of each wait behind its own
     * "Show all". All of them, unless said.
     */
    shows: number(1, TABLE_LIMITS.rows, true),
    /**
     * The read its rows are from was cut at Lumovi's limit: the token the door answered it with.
     * Lumovi says so above the rows, from the door's own numbers; a token it didn't make says
     * nothing.
     */
    cut,
    /** In place of rows, when there are none to show. */
    state,
    /** Pressed a row that opens something (Lumovi opens the object itself). */
    onOpen: handler('open'),
    /** Pressed "Try again" of a table that failed. */
    onRetry: handler('retry'),
  },
  required: ['title', 'columns', 'headings', 'rows'],
  events: { open: { row: name }, retry: {} },
  also: (props) => tableProblem(props),
} as const satisfies Part

/** The Table's properties, as its component takes them: worked out from `table`. */
export type TableProps = PropsOf<typeof table>
export type TableColumn = NonNullable<TableProps['columns']>[number]
export type TableRow = NonNullable<TableProps['rows']>[number]
export type TableInnerRow = NonNullable<TableRow['rows']>[number]
export type TableCell = NonNullable<TableRow['cells']>[number]
export type TableLead = NonNullable<TableRow['lead']>
export type TableState = NonNullable<TableProps['state']>

/**
 * A table as a plugin writes it, before the door hands it over: its texts as text, an object as
 * the token Lumovi gave it. What a description that holds a table's parts (a pick list's rows,
 * a page's frame) is written in.
 */
export type WrittenTable = WrittenProps<typeof table>
export type WrittenTableLead = NonNullable<NonNullable<WrittenTable['rows']>[number]['lead']>
export type WrittenTableState = NonNullable<WrittenTable['state']>

/** A count with its noun: "1 cell", "6 columns". */
const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/** A kind of cell, as a sentence names it. */
const A_KIND: Record<string, string> = {
  text: 'text',
  number: 'a number',
  age: 'an age',
  status: 'a status',
  meter: 'a meter',
}

/**
 * A row as Lumovi's Table draws it: a plugin's, or one of a graph's table, which only Lumovi
 * makes (never a plugin's to give), whose rows nest as deep as the graph's lines go, and one of
 * which may stand for a card listed already.
 */
export type DrawnRow = Omit<TableRow, 'rows'> & {
  rows?: readonly DrawnRow[]
  /**
   * Listed again: its lead only, and in place of its cells where it's first (`under` the row it's
   * first inside); pressed, it goes there. `first` is that first row's key.
   */
  again?: {
    first: string
    under?: Their
    /** For a line that turns back (a loop's): what's above it isn't kept for it by a filter. */
    back?: boolean
  }
}

/** A table as a plugin wrote it, as far as `tableProblem` reads it (its kinds already passed). */
interface Written {
  columns: { kind: string }[]
  rows: (WrittenRow & { rows?: WrittenRow[] })[]
}
interface WrittenRow {
  key: string
  cells: { kind: string }[]
  rest?: { from: number }
}

/**
 * What's wrong with a table that its kinds can't say, for whoever wrote it: where, counted from
 * 1 as they wrote it (both places, where two clash), then what, then what it should be. One
 * line of Lumovi's own words that quotes nothing the table holds: a key is named by where it
 * is, never by its text. Nothing, when the table can be drawn as it's described. Checked where
 * a description is taken in, so the component is only ever given one that passes. (A rest that
 * starts at no column at all is the kinds' to refuse: it's a whole number from 0.)
 */
export function tableProblem(written: Readonly<Record<string, unknown>>): string | undefined {
  const { columns, rows } = written as unknown as Written
  const keys = new Map<string, number>()
  for (const [r, row] of rows.entries()) {
    const first = keys.get(row.key)
    if (first !== undefined) return `Rows ${first} and ${r + 1} have the same key.`
    keys.set(row.key, r + 1)
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
      const wrong = cellsProblem(each, columns, here)
      if (wrong) return wrong
    }
  }
  return undefined
}

/**
 * What's wrong with a row's cells against its table's columns (`where` says whose: "Row 3",
 * "Card 3"): a cell for each column, each of its column's kind or nothing, and last words that
 * start at a column there is. Nothing, when they agree.
 */
export function cellsProblem(
  row: { cells: readonly { kind: string }[]; rest?: { from: number } },
  columns: readonly { kind: string }[],
  where: string,
): string | undefined {
  if (row.cells.length !== columns.length) {
    return `${where} has ${counted(row.cells.length, 'cell')}, and the table has ${counted(columns.length, 'column')}.`
  }
  for (const [c, cell] of row.cells.entries()) {
    const takes = columns[c]!.kind
    if (cell.kind !== 'none' && cell.kind !== takes) {
      // (By its own words only: a kind that isn't one of them is said to be none, whatever was
      // checked before this.)
      if (!Object.hasOwn(A_KIND, cell.kind) || !Object.hasOwn(A_KIND, takes)) {
        return `${where}, cell ${c + 1} isn’t a kind of cell.`
      }
      return `${where}, cell ${c + 1} is ${A_KIND[cell.kind]}, and its column takes ${A_KIND[takes]}.`
    }
  }
  if (row.rest && row.rest.from >= columns.length) {
    return `${where}’s rest starts at column ${row.rest.from + 1}, and the table has ${counted(columns.length, 'column')}.`
  }
  return undefined
}

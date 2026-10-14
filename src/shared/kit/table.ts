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
  destination,
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
  /** Characters of the lead column's heading: a column's heading, short. */
  leadHeading: 40,
  /** Characters of why a row's button can't be pressed now, as a header's button says it. */
  off: 80,
  /** Filters a table's bar has; the values a row gives them, all together; a filter's key. */
  filters: 8,
  facets: 32,
  filterKey: 40,
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
/**
 * The kind of thing a column's cells hold: one of these, and nothing free-form. A `button`
 * column holds a button a row's own (or a word where a row has none: "Current"), and a table
 * has one at most.
 */
export const COLUMN_KINDS = ['text', 'number', 'age', 'status', 'meter', 'button'] as const

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
    /**
     * Words; `mono` draws them in Lumovi's fixed-width type (a revision, an ID), and `full` is
     * the whole of what they stand for (a commit's whole hash behind its first seven): said in
     * its tooltip and to a screen reader, never in the cell.
     */
    text: { text: name, mono: yesOrNo, full: name },
    /** A number, or a number with its unit as text ("7 nodes"): stands right, in tabular figures. */
    number: { value: number(-LARGEST, LARGEST), text: name },
    /** A moment, as text (RFC 3339): Lumovi says how long ago, or how soon, never the plugin. */
    age: { time },
    /**
     * A level and its word. Sorts worst first, by the level and not the word. With `since` (a
     * moment, RFC 3339), how long what it says has gone on, after the word, counted by Lumovi
     * each second ("Syncing 1m 05s"), as a header's second status says it.
     */
    status: { level: oneOf(HEALTHS), word: name, since: time },
    /** `used` of `of` (no `of`: there's no limit); `text` says it ("24 of 64 cores"). */
    meter: { label: name, used: number(0, LARGEST), of: number(0, LARGEST), text: name },
    /**
     * Something a person can do with this row alone (Roll back… on a history's entry), as a
     * header's button is: `key` its own in its column, `changes` that it changes the cluster
     * (a phone doesn't draw it; only its press can propose a change), `asks` that it asks
     * first (its name ends in "…"), and `off` why it can't be pressed now (its tooltip). A row
     * with one is never pressed whole: it opens nothing.
     */
    button: {
      key: name,
      name,
      changes: yesOrNo,
      asks: yesOrNo,
      off: text(TABLE_LIMITS.off),
    },
    /** Nothing to say here: drawn as a dash. */
    none: {},
  },
  {
    text: ['mono', 'full'],
    number: ['text'],
    status: ['since'],
    meter: ['of'],
    button: ['changes', 'asks', 'off'],
  },
)

/** What a row is called: a dot in its level, its name, a quiet word beside, a line under. */
export const lead = record({ level: oneOf(HEALTHS), name, beside: name, under: line }, ['name'])

/** A filter's key: what a row's values name it by, and a link to the page sets it by. */
const filterKey = text(TABLE_LIMITS.filterKey)

/**
 * One of the filters in a table's bar, Lumovi's own: a menu of the values the rows have, with how
 * many have each. Values in one filter are either; filters together are all. `more`, it's under
 * More filters; `level`, its values are the rows' own levels (their lead's), in Lumovi's words,
 * and no row gives it any.
 */
const filter = record({ key: filterKey, name, more: yesOrNo, level: yesOrNo }, ['key', 'name'])

/** A row's value for one of its table's filters: several for one filter, each is one it has. */
const facet = record({ filter: filterKey, value: name }, ['filter', 'value'])

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
  /**
   * Or a list of Lumovi's own it goes to, as a tile does: one object of a kind its plugin's file
   * says its pages open, say, where the plugin read no object to open. Pressed whole, as one that
   * opens.
   */
  goes: destination,
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
    /** Its values for the table's filters: what the filters' menus count, and keep it by. */
    facets: list(facet, TABLE_LIMITS.facets),
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
    /** The lead column's heading, where its rows aren't things with names: "Name" unless said. */
    leadHeading: text(TABLE_LIMITS.leadHeading),
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
    /**
     * The bar above its rows, Lumovi's alone: these filters, each a menu of the values its rows
     * give it. What's set or typed there is never told to the plugin; a link to its page may set
     * it as the page opens.
     */
    filters: list(filter, TABLE_LIMITS.filters),
    /** A field in the bar that keeps the rows whose name, or the word beside it, has what's typed. */
    search: yesOrNo,
    /**
     * Rows that open an object can be ticked, with a box at each and one in the headings for all
     * shown. Lumovi's own bar then offers its file's actions that say `bulk` for them; the plugin
     * is told nothing of what's ticked, and starts nothing.
     */
    ticks: yesOrNo,
    /** Pressed a row that opens something (Lumovi opens the object itself). */
    onOpen: handler('open'),
    /** Pressed "Try again" of a table that failed. */
    onRetry: handler('retry'),
    /** Pressed a row's button: the row's key, and the button's. */
    onPress: handler('press'),
  },
  required: ['title', 'columns', 'headings', 'rows'],
  events: { open: { row: name }, retry: {}, press: { row: name, button: name } },
  also: (props) => tableProblem(props),
  heeds: (props, event, carries) => event !== 'press' || rowButton(props, carries) !== undefined,
  changes: (props, event, carries) =>
    event === 'press' && rowButton(props, carries)?.changes === true,
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

/**
 * The button a row's press names, as the table was drawn: one that's there, in a row that's
 * there, and not off. Nothing for any other press, however it came about: it tells the plugin
 * nothing.
 */
export function rowButton(
  props: Readonly<Record<string, unknown>>,
  carries: unknown,
): { changes?: boolean } | undefined {
  const { row, button } = (carries ?? {}) as { row?: unknown; button?: unknown }
  const rows = props.rows as
    readonly { key?: unknown; cells?: readonly Record<string, unknown>[] }[] | undefined
  const found = rows?.find((each) => each.key === row)
  const cell = found?.cells?.find(
    (each) => each.kind === 'button' && each.key === button && each.off === undefined,
  )
  return cell as { changes?: boolean } | undefined
}

/** A count with its noun: "1 cell", "6 columns". */
const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/** A kind of cell, as a sentence names it. */
const A_KIND: Record<string, string> = {
  text: 'text',
  number: 'a number',
  age: 'an age',
  status: 'a status',
  meter: 'a meter',
  button: 'a button',
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
  rows: (WrittenRow & { rows?: WrittenRow[]; facets?: { filter: string }[] })[]
  filters?: { key: string; level?: boolean }[]
}
interface WrittenRow {
  key: string
  cells: { kind: string }[]
  rest?: { from: number }
  opens?: unknown
  goes?: unknown
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
  const { columns, rows, filters = [] } = written as unknown as Written
  // A filter's key is its own; a row's values are for filters the table has, never a level's.
  const filterAt = new Map<string, { at: number; level: boolean }>()
  for (const [f, each] of filters.entries()) {
    const first = filterAt.get(each.key)
    if (first !== undefined) return `Filters ${first.at} and ${f + 1} have the same key.`
    filterAt.set(each.key, { at: f + 1, level: each.level === true })
  }
  for (const [r, row] of rows.entries()) {
    for (const [v, facet] of (row.facets ?? []).entries()) {
      const its = filterAt.get(facet.filter)
      if (its === undefined) {
        return `Row ${r + 1}, value ${v + 1} is for a filter the table hasn’t: name it under filters.`
      }
      if (its.level) {
        return `Row ${r + 1}, value ${v + 1} is for filter ${its.at}, which goes by the rows’ own levels: a row gives no value for it.`
      }
    }
  }
  const buttons = columns.flatMap((column, c) => (column.kind === 'button' ? [c + 1] : []))
  if (buttons.length > 1) {
    return `Columns ${buttons[0]} and ${buttons[1]} both hold buttons: a table has one such column.`
  }
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
      if (each.opens !== undefined && each.goes !== undefined) {
        return `${here} opens an object and goes to a list: a row is pressed for one of them.`
      }
      if (each.cells.some((cell) => cell.kind === 'button')) {
        if (i > 0) return `${here} has a button: only a table’s own rows have them.`
        if (each.opens !== undefined || each.goes !== undefined) {
          return `${here} has a button and opens something: a row with a button opens nothing.`
        }
      }
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
    // (A button's column says a word where its row has no button: "Current".)
    const word = takes === 'button' && cell.kind === 'text'
    if (cell.kind !== 'none' && cell.kind !== takes && !word) {
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

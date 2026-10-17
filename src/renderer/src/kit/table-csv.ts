/**
 * A plugin's table saved as CSV, as Lumovi saves its own lists: Lumovi writes the file from what
 * it drew, so nothing the plugin couldn't read (nor a field its file withholds) can be in it. Its
 * rows as filtered and sorted, all of them (past Show all and every page, with the rows a row
 * holds after it), every column but a button's; each text spelled, as a place that can't draw
 * Lumovi's marks has it, and a cell a spreadsheet would read as a formula taken as text
 * (`toCsv`).
 */
import { createContext } from 'react'
import { spelled } from '@shared/kit/characters'
import type { Their } from '@shared/kit/declare'
import type { DrawnRow, TableCell, TableColumn } from '@shared/kit/table'

/**
 * Whose table it is, as a CSV's name begins: the plugin's label, as its file names it (Lumovi's to
 * say, never its code's). Unset outside a plugin's page or tab.
 */
export const TableOwner = createContext<string | undefined>(undefined)

/** A text of the plugin's, as a file has it. */
const words = (text: Their | undefined) => (text?.their ? spelled(text.their).trim() : '')

/** A moment, as a CSV has it: whole, in UTC. */
function moment(time: string | undefined): string {
  if (!time) return ''
  const at = Date.parse(time)
  return Number.isNaN(at) ? '' : new Date(at).toISOString()
}

/** What a column takes in a file: one value, or two (a meter's used and of, a status and since). */
interface Place {
  headers: string[]
  values: (cell: TableCell | undefined) => (string | number)[]
}

/** A column's place: its heading over its value; a meter's two numbers; a status's word and since. */
function placeOf(column: TableColumn, rows: readonly DrawnRow[], c: number): Place {
  const heading = words(column.name)
  switch (column.kind) {
    case 'meter':
      return {
        headers: [`${heading} (used)`, `${heading} (of)`],
        values: (cell) => (cell?.kind === 'meter' ? [cell.used, cell.of ?? ''] : ['', '']),
      }
    case 'status': {
      const since = rows.some((row) => {
        const cell = row.cells?.[c]
        return cell?.kind === 'status' && Boolean(cell.since)
      })
      return {
        headers: since ? [heading, `${heading} (since)`] : [heading],
        values: (cell) => {
          const word = cell?.kind === 'status' ? words(cell.word) : ''
          return since ? [word, cell?.kind === 'status' ? moment(cell.since) : ''] : [word]
        },
      }
    }
    default:
      return { headers: [heading], values: (cell) => [value(cell)] }
  }
}

/** A cell that's one value: a number bare, a time whole in UTC, words as words. */
function value(cell: TableCell | undefined): string | number {
  switch (cell?.kind) {
    case 'text':
      return words(cell.full ?? cell.text)
    case 'number':
      return cell.value
    case 'age':
      return moment(cell.time)
    default:
      return ''
  }
}

/** Each line, in the order the table shows them: a row, then the rows it holds (folded or not). */
export function linesOf(
  rows: readonly DrawnRow[],
  partOf?: DrawnRow,
): { row: DrawnRow; partOf?: DrawnRow }[] {
  return rows.flatMap((row) => [
    { row, ...(partOf ? { partOf } : {}) },
    ...linesOf(row.rows ?? [], row),
  ])
}

/**
 * The header and the rows, as a spreadsheet reads them: every line standing on its own (sorted
 * or filtered, it still says what it is). In order: its Group, the row it's Part of, the lead's
 * name with its word beside and its line under, its level, the plugin's columns (a button's left
 * out; a meter as its two numbers; a status with its since), then its Note. A column that no row
 * fills isn't there.
 */
export function tableCsv(
  columns: readonly TableColumn[],
  leadHeading: string,
  /** What the lead's level is headed: the table's level filter's name, else "Health". */
  levelHeading: string,
  levelWord: (level: NonNullable<DrawnRow['lead']['level']>) => string,
  rows: readonly DrawnRow[],
): { header: string[]; rows: (string | number)[][] } {
  const lines = linesOf(rows)
  const all = lines.map((line) => line.row)
  const has = (some: (row: DrawnRow) => unknown) => all.some((row) => Boolean(some(row)))
  const grouped = has((row) => row.group?.their)
  const nested = lines.some((line) => line.partOf)
  const beside = has((row) => row.lead.beside?.their)
  const under = has((row) => row.lead.under?.their)
  const levelled = has((row) => row.lead.level)
  const noted = has((row) => row.note?.their)
  const places = columns.flatMap((column, c) =>
    column.kind === 'button' ? [] : [{ c, place: placeOf(column, all, c) }],
  )
  const header = [
    ...(grouped ? ['Group'] : []),
    ...(nested ? ['Part of'] : []),
    leadHeading,
    ...(beside ? [`${leadHeading} (beside)`] : []),
    ...(under ? [`${leadHeading} (under)`] : []),
    ...(levelled ? [levelHeading] : []),
    ...places.flatMap(({ place }) => place.headers),
    ...(noted ? ['Note'] : []),
  ]
  return {
    header,
    rows: lines.map(({ row, partOf }) => {
      // (Words that take the rest of the row stand in the first column they take, with their
      // time after them; the rest of what they take is empty.)
      const rest = row.rest
      const restText = rest ? [words(rest.text), moment(rest.time)].filter(Boolean).join(' · ') : ''
      return [
        ...(grouped ? [words(row.group)] : []),
        ...(nested ? [partOf ? words(partOf.lead.name) : ''] : []),
        words(row.lead.name),
        ...(beside ? [words(row.lead.beside)] : []),
        ...(under ? [words(row.lead.under)] : []),
        ...(levelled ? [row.lead.level ? levelWord(row.lead.level) : ''] : []),
        ...places.flatMap(({ c, place }) =>
          rest && c >= rest.from
            ? place.headers.map((_, n) => (c === rest.from && n === 0 ? restText : ''))
            : place.values(row.cells?.[c]),
        ),
        ...(noted ? [words(row.note)] : []),
      ]
    }),
  }
}

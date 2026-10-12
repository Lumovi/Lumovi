/**
 * A list as CSV: a header row, then a row an object, each cell quoted where it must be. A cell of
 * text that a spreadsheet would read as a formula (one starting with =, +, -, @, a tab or a
 * carriage return) is written so it's taken as text: a ' in front of it. A number Lumovi knows is
 * one is written as it is, a negative one too.
 */

/** U+FEFF, made from its number: a spreadsheet reads a file that starts with it as UTF-8. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)

/** What a spreadsheet takes as the start of a formula. */
const FORMULA = /^[=+\-@\t\r]/

/** One cell, as CSV has it. */
export function csvCell(value: string | number): string {
  if (typeof value === 'number') return String(value)
  const text = FORMULA.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * The whole file: the header, then the rows, a line each (CRLF, as CSV's own rule says), with a
 * byte order mark in front so a spreadsheet reads it as UTF-8.
 */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number)[])[],
): string {
  const line = (cells: readonly (string | number)[]) => cells.map(csvCell).join(',')
  return `${BYTE_ORDER_MARK}${[header, ...rows].map(line).join('\r\n')}\r\n`
}

/**
 * Rows as a clipboard holds a table: tab between cells, a line a row, a header first. A tab or a
 * line break inside a value becomes a space, so each value stays one cell; and as a spreadsheet
 * reads pasted rows as it reads a file, a formula's start is guarded as it is in one.
 */
export function toTabs(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const cell = (value: string) => {
    const text = value.replace(/\r\n|[\t\r\n]/g, ' ')
    return FORMULA.test(text) ? `'${text}` : text
  }
  return [header, ...rows].map((cells) => cells.map(cell).join('\t')).join('\n')
}

/** Names a file can't have on Windows, whatever follows them. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/**
 * A file's name for a list: "pods-shop-2026-10-12.csv", where is the one namespace picked, or the
 * cluster's name when there are several or all. Each is made safe for a file's: anything but
 * letters, digits, dots and hyphens is a hyphen (so no separator or control character is left),
 * no run of them, none at either end, at most 60, a name Windows keeps for itself taken as no
 * name; all lowercase.
 */
export function csvName(plural: string, where: string, date: Date): string {
  const safe = (text: string, otherwise: string) => {
    const name = text
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/[.-]{2,}/g, '-')
      .slice(0, 60)
      .replace(/^[.-]+|[.-]+$/g, '')
    return name && !RESERVED.test(name) ? name : otherwise
  }
  // (The day it is where the person is.)
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-')
  return `${safe(plural, 'list')}-${safe(where, 'cluster')}-${day}.csv`
}

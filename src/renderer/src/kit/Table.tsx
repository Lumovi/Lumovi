/**
 * The kit's Table: what a plugin lists things with, drawn by Lumovi from a description
 * (`@shared/kit/table`). A plugin names its columns and gives its rows; everything a person
 * sees of them is decided here: the widths, from one scale; the order, when a column sorts; how
 * a long name is cut; how an age, a status and a meter look; and what a phone makes of it.
 *
 * Every text in it is the plugin's, handed over as a `Their`: drawn in pieces (`TheirText`), so
 * what can't be seen or would turn text round is a mark of Lumovi's; spelled where a mark can't
 * be drawn (a tooltip, a name read out); and sorted as it was written. Whatever it isn't given
 * it draws without: a text as nothing, a list as none, a cell as a dash.
 *
 * It has the keys of Lumovi's own lists wherever both have the thing: one stop for all its
 * rows, with an active row that the arrows (and j, k, Home, End, Page Up and Page Down) move;
 * Enter opens; the headings that sort are stops after the rows. Right opens a row that holds
 * rows and left closes it. It's never paged, and nothing in it is picked.
 *
 * A plugin's rows hold rows one level deep, as its description allows. A graph's table (`Graph`)
 * is the one place rows nest deeper, as deep as its lines go, and lists a card it has listed
 * already as a row that says where it's first, and goes there (`DrawnRow`).
 */
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CornerDownLeft,
  Search,
  TriangleAlert,
} from 'lucide-react'
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type { Health } from '@shared/health'
import { inPieces, spelled, type Piece } from '@shared/kit/characters'
import type { Their } from '@shared/kit/declare'
import {
  COLUMN_KINDS,
  type ObjectRef,
  type TableCell,
  type TableColumn,
  type TableProps,
  type TableRow,
  type TableState,
  type WrittenTableState,
  type DrawnRow,
} from '@shared/kit/table'
import { Button } from '@renderer/components/Button'
import { Sheet } from '@renderer/components/Sheet'
import { HEALTH_STYLE } from '@renderer/components/Status'
import { cn } from '@renderer/lib/cn'
import { age } from '@renderer/lib/format'
import { useLayout } from '@renderer/lib/layout'
import { MARK_CLASS, Pieces, TheirText } from '@renderer/plugins/TheirText'
import { InCard } from './Card'
import { CARD, HEADING, Lead, said } from './Lead'
import { tooltip } from './MiddleCut'

/** A row of one line, one with a line under its name, and each line of a note. */
const ROW = 36
const ROW_WITH_LINE = 52
const ROW_WITH_METER = 40
const NOTE_LINE = 19
/** Between rows. */
const GAP = 2
/**
 * How far a row inside another is set in, at each level, and down to how deep: past it, a row is
 * set in no further (a graph's table may be as deep as it has cards). On a phone, its card.
 */
const INDENT = 26
const DEEPEST = 8
const PHONE_INDENT = 24
const PHONE_DEEPEST = 4
/** How many rows Page Up and Page Down move by, as in Lumovi's lists. */
const PAGE_JUMP = 10
/** Past this many rows, only the ones in view are drawn. */
const WINDOWED_FROM = 200
/** A status's own width, and a narrow column's. */
const WIDTHS = { narrow: '88px', normal: 'minmax(0,1fr)', wide: 'minmax(0,1.4fr)' } as const
const STATUS_WIDTH = '144px'
/** How bad a level is, least first: what a status sorts by, and not its word. */
const SEVERITY: Health[] = ['healthy', 'neutral', 'progressing', 'warning', 'critical']
/** In the sort, the row's name: the lead, which stands before the columns. */
const NAME = -1

/** A moment as Lumovi says it: how long ago, or how soon. */
function when(time: string, now = Date.now()): string {
  const at = Date.parse(time)
  // (A time that isn't one says nothing, as a cell with nothing in it.)
  if (Number.isNaN(at)) return '—'
  return at > now ? `in ${age(new Date(2 * now - at).toISOString(), now)}` : age(time, now)
}

/** A count as Lumovi writes one: "5,000". */
export const counted = (count: number) => count.toLocaleString('en-US')

/** A number and the word after it ("7.9 cores", "3 nodes"): kept on one line. */
const NUMBER_AND_UNIT = /\d[\d.,]*\s+\p{L}+/gu

/**
 * A plugin's words with each number kept beside its unit: one text, in one direction box (so a
 * right-to-left text reads as written), its pieces as ever, the pairs in spans that don't break.
 * Never a character put into its text.
 */
function Unbroken({ text }: { text?: Their }) {
  const said = text?.their ?? ''
  const parts: ReactNode[] = []
  let at = 0
  for (const found of said.matchAll(NUMBER_AND_UNIT)) {
    if (found.index > at) {
      parts.push(<Pieces key={at} pieces={inPieces(said.slice(at, found.index))} oneLine />)
    }
    parts.push(
      <span key={found.index} className="whitespace-nowrap">
        <Pieces pieces={inPieces(found[0])} oneLine />
      </span>,
    )
    at = found.index + found[0].length
  }
  if (at < said.length) parts.push(<Pieces key={at} pieces={inPieces(said.slice(at))} oneLine />)
  return (
    <bdi dir="auto" data-their-text="" className="text-left [overflow-wrap:anywhere]">
      {parts}
    </bdi>
  )
}

/**
 * A row's rest: its words, and, with a time, how long ago after them ("Launching · 3m"), in the
 * same ink, in tabular figures. Where it wraps (a phone), a number stays with its unit, and the
 * age with the word before it: "· 43s" is never a line alone.
 */
function Rest({ rest }: { rest?: TableRow['rest'] }) {
  return (
    <>
      <Unbroken text={rest?.text} />
      {rest?.time !== undefined && (
        <span className="whitespace-nowrap tabular-nums">{`\u00a0·\u00a0${when(rest.time)}`}</span>
      )}
    </>
  )
}

/**
 * Where a meter is against its limit, as Lumovi's own meters say it: critical from nine tenths, a
 * warning from three quarters; nothing below that, or with no limit.
 */
function meterLevel(cell: TableCell): 'warning' | 'critical' | undefined {
  if (cell.kind !== 'meter' || !cell.of || cell.used === undefined) return undefined
  const ratio = cell.used / cell.of
  return ratio >= 0.9 ? 'critical' : ratio >= 0.75 ? 'warning' : undefined
}

/** A meter's level beside its words on a phone: the status's own icon, in its colour. */
function LevelIcon({ level }: { level: 'warning' | 'critical' }) {
  const Icon = HEALTH_STYLE[level].icon
  return <Icon aria-hidden className="mr-1 inline size-3.5 align-[-2px]" strokeWidth={2.25} />
}

/**
 * What a cell says in words: what a phone shows of it, and how wide it is. The plugin's text
 * where it's the plugin's; Lumovi's own words for nothing, an age and a bare figure.
 */
function words(cell: TableCell): Their | string {
  switch (cell.kind) {
    case 'none':
      return '—'
    case 'text':
      return cell.text
    case 'number':
      return cell.text ?? String(cell.value)
    case 'age':
      return when(cell.time)
    case 'status':
      return cell.word
    case 'meter':
      return cell.text
  }
}

/**
 * What a cell sorts by: a number where it has one, a text as it was written. Nothing
 * (`undefined`) is last whichever way the rest is sorted.
 */
function rank(cell: TableCell): number | string | undefined {
  switch (cell.kind) {
    case 'none':
      return undefined
    case 'number':
      return cell.value
    // How long ago, or how soon: what's said, so the youngest and the soonest come first.
    case 'age': {
      const at = Date.parse(cell.time)
      return Number.isNaN(at) ? undefined : Math.abs(Date.now() - at)
    }
    case 'status':
      // (How bad it is: sorted descending first, so the worst is on top.)
      return SEVERITY.indexOf(cell.level)
    case 'meter':
      return cell.of ? cell.used / cell.of : undefined
    case 'text':
      return cell.text.their.toLowerCase()
  }
}

/** A row with fewer cells than columns has nothing in the rest. */
const NONE: TableCell = { kind: 'none' }
/** The kinds a cell can be: one of any other (none gets past the door) is nothing too. */
const CELL_KINDS = new Set<string>([...COLUMN_KINDS, 'none'])
/** A row's cell in a column. */
const cellAt = (row: Omit<TableRow, 'rows'>, c: number): TableCell => {
  const cell = row.cells[c]
  return cell && CELL_KINDS.has(cell.kind) ? cell : NONE
}
/** A row's key as it was written: what it's told apart by. */
export const keyOf = (row: { key: Their }) => row.key.their

/** A row and every row inside it, however deep: walked, never called for each level. */
function withInside(row: DrawnRow): DrawnRow[] {
  const all: DrawnRow[] = []
  const todo = [row]
  while (todo.length > 0) {
    const next = todo.pop()!
    all.push(next)
    const inside = next.rows ?? []
    for (let i = inside.length - 1; i >= 0; i--) todo.push(inside[i]!)
  }
  return all
}
/** A text that wasn't given. */
export const NOTHING_WRITTEN: Their = Object.freeze({ their: '' })

/** A text as it's drawn, in pieces: the plugin's from its characters, Lumovi's own as it is. */
const drawn = (text: Their | string | undefined): readonly Piece[] =>
  typeof text === 'string' ? [text] : inPieces(text?.their ?? '')

/** What's been measured, the newest few thousand: a table's texts change for as long as Lumovi runs. */
const measured = new Map<string, number>()
const MEASURED_AT_MOST = 4000

/** What stands either side of a mark's words in a shape: no letters can hold it, it's a mark. */
const NUL = '\u0000'

/** What a mark says, as `TheirText` draws it. */
const markWords = (piece: Exclude<Piece, string>) =>
  'unseen' in piece ? piece.unseen : `and ${piece.more.toLocaleString('en-US')} more`

/**
 * A text as it's drawn, as one string to measure it by: its letters as they run on (a line's end
 * a space), each mark's words between NULs, and every figure a 0. Figures in a tabular face, and
 * in a mark's, are all one width, so a text is measured by its shape and thousands of ages are a
 * handful of shapes.
 */
function shapeOf(pieces: readonly Piece[]): string {
  return pieces
    .map((piece) =>
      typeof piece === 'string' ? piece.replace(/[\n\t]/g, ' ') : `${NUL}${markWords(piece)}${NUL}`,
    )
    .join('')
    .replace(/\d/g, '0')
}

/**
 * How wide each of these is as the table draws it (`className`: its size, its figures), marks and
 * all, the widest of them: laid out once, unseen, and not drawn on a canvas, which knows nothing
 * of tabular figures or of a mark's box. (`fonts`: what was measured before the page's own fonts
 * were in isn't kept.)
 */
function widest(texts: readonly (readonly Piece[])[], className: string, fonts: number): number {
  const shapes = [...new Set(texts.map(shapeOf))]
  const unknown = shapes.filter((shape) => !measured.has(`${fonts}|${className}|${shape}`))
  if (unknown.length) {
    const box = document.createElement('div')
    box.className = 'pointer-events-none invisible absolute top-0 left-0 whitespace-nowrap'
    const spans = unknown.map((shape) => {
      const span = document.createElement('span')
      span.className = cn('block w-max', className)
      // Letters as text and each mark in its box: never markup.
      shape.split(NUL).forEach((part, i) => {
        if (i % 2 === 0) {
          span.append(part)
          return
        }
        const mark = document.createElement('span')
        mark.className = MARK_CLASS
        mark.dataset.mark = ''
        mark.textContent = part
        span.append(mark)
      })
      return box.appendChild(span)
    })
    document.body.appendChild(box)
    spans.forEach((span, i) =>
      measured.set(
        `${fonts}|${className}|${unknown[i]!}`,
        Math.ceil(span.getBoundingClientRect().width),
      ),
    )
    box.remove()
  }
  const width = Math.max(
    0,
    ...shapes.map((shape) => measured.get(`${fonts}|${className}|${shape}`) ?? 0),
  )
  // (The oldest go first; after the answer, so what was just measured is all there for it.)
  for (const key of measured.keys()) {
    if (measured.size <= MEASURED_AT_MOST) break
    measured.delete(key)
  }
  return width
}

/** How a cell's words are set, by its column's kind: what `Cell` draws them in. */
const SET = {
  age: 'text-xs tabular-nums',
  number: 'text-[13px] tabular-nums',
  text: 'text-[13px]',
  status: 'text-[13px]',
  meter: 'text-[11px] tabular-nums',
} as const
/** A fact on a phone's card. */
const FACT = 'text-xs tabular-nums'

/**
 * A line of what's drawn: a group's heading, or a row (one inside another is set in). Its key is
 * its own among the lines, whatever keys the rows were given: each kind of line has its own start.
 */
type Line =
  | { is: 'group'; key: string; name?: Their; count: number }
  /** Under a group showing fewer than it has: its own "Show all". */
  | { is: 'more'; key: string; group: number; count: number }
  | {
      is: 'row'
      key: string
      row: DrawnRow
      /** How far it's set in: 0 for a row of the table's own, 1 for one inside it, and so on. */
      depth: number
      holds: boolean
      open: boolean
    }

interface Sort {
  column: number
  down: boolean
}

/** How wide the screen is, kept as it turns or is resized: what a phone's cards are laid out by. */
function useScreenWidth(wanted: boolean): number {
  const [width, setWidth] = useState(() => document.documentElement.clientWidth)
  useEffect(() => {
    if (!wanted) return
    const measure = () => setWidth(document.documentElement.clientWidth)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [wanted])
  return width
}

function height(line: Line): number {
  if (line.is === 'group') return 28
  if (line.is === 'more') return 32
  if (line.row.again) return (line.row.lead?.under?.their ? ROW_WITH_LINE : ROW) + GAP
  // (A meter is its words over its bar: a row of one line with one is a little taller.)
  const meter = line.row.cells.some((cell) => cell.kind === 'meter')
  const base = line.row.lead?.under?.their ? ROW_WITH_LINE : meter ? ROW_WITH_METER : ROW
  return (line.row.note?.their ? base + 2 * NOTE_LINE + 2 : base) + GAP
}

export function Table({
  title,
  columns,
  headings,
  nameSorts,
  rows,
  shows,
  cut,
  state,
  go,
  onOpen,
  onRetry,
  bare: bareSaid,
  startOpen = false,
}: Omit<TableProps, 'rows'> & {
  /** A plugin's rows (`TableProps['rows']`), or a graph's, which nest deeper. */
  rows: readonly DrawnRow[]
  /** Opens the object a row names: Lumovi's own to do, never the plugin's (and not declared). */
  go?: (object: ObjectRef) => void
  /** Its rows alone, inside a part that's its own card and says its title and count (Graph). */
  bare?: boolean
  /** Rows that hold rows start open: where a filter has kept what's inside them (Graph). */
  startOpen?: boolean
}) {
  // Its rows alone too inside a card, which says the title.
  const inCard = useContext(InCard)
  const bare = inCard || bareSaid === true
  const id = useId()
  const phone = useLayout() === 'phone'
  const scroll = useRef<HTMLDivElement>(null)
  const [sort, setSort] = useState<Sort>()
  // The rows a person turned from how they start (closed, or all open): by their lines' keys.
  const [turned, setTurned] = useState<ReadonlySet<string>>(new Set())
  /**
   * A line's key: a row of the table's own by its key; one inside another by a short name given
   * to the pair of the line it's inside and its own key, the same on every draw. (Never the whole
   * way down: a graph's table may be thousands deep.)
   */
  const lineNames = useRef(new Map<string, string>())
  const lineKeyOf = useCallback((parent: string | undefined, key: string) => {
    if (parent === undefined) return `row:${key}`
    const pair = `${parent}\u0000${key}`
    let made = lineNames.current.get(pair)
    if (made === undefined) lineNames.current.set(pair, (made = `in:${lineNames.current.size}`))
    return made
  }, [])
  // The groups shown whole (by their place), or every one: past `shows`, each by its own press.
  const [whole, setWhole] = useState<ReadonlySet<number> | 'all'>(new Set())
  // The active row, by its key: it stays on its row as rows sort, open, or are told anew.
  const [activeKey, setActiveKey] = useState<string>()
  const [sorting, setSorting] = useState(false)
  /** A row being gone to: made active, and brought into view, once it's drawn. */
  const [going, setGoing] = useState<string>()
  // Measured again once the page's own fonts are in.
  const [fonts, setFonts] = useState(0)
  useEffect(() => {
    let gone = false
    void document.fonts.ready.then(() => {
      if (gone) return
      setFonts(1)
    })
    return () => {
      gone = true
    }
  }, [])

  /** What the table is called where a mark can't be drawn: what a screen reader says. */
  const named = spelled(title.their)
  // Rows that follow each other with the same group stand under one heading.
  const groups = useMemo(() => {
    const out: { by: string; name?: Their; rows: DrawnRow[] }[] = []
    for (const row of rows) {
      const by = row.group?.their ?? ''
      const last = out.at(-1)
      if (last && last.by === by) last.rows.push(row)
      else out.push({ by, name: row.group, rows: [row] })
    }
    return out
  }, [rows])
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0)
  /** Whether any of its rows hold rows. */
  const nests = groups.some((group) => group.rows.some((row) => row.rows?.length))
  /** Whether any rows stand under a heading: then each group has its own "Show all". */
  const grouped = groups.some((group) => group.by !== '')
  const limitOf = useCallback(
    (g: number) => (whole === 'all' || whole.has(g) || shows === undefined ? Infinity : shows),
    [whole, shows],
  )
  const showWhole = (g: number) => setWhole((was) => (was === 'all' ? was : new Set([...was, g])))

  // Sorted, then cut to what shows first: the same rows on every draw, whatever is scrolled.
  const lines = useMemo(() => {
    const ordered = (rows: DrawnRow[]) => {
      if (!sort) return rows
      // (A name or a text as it was written: never as its marks are spelled.)
      const by = (row: DrawnRow) =>
        sort.column === NAME ? row.lead.name.their.toLowerCase() : rank(cellAt(row, sort.column))
      return [...rows].sort((a, b) => {
        const [x, y] = [by(a), by(b)]
        if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1
        const order = x < y ? -1 : x > y ? 1 : 0
        return sort.down ? -order : order
      })
    }
    const out: Line[] = []
    for (const [g, group] of groups.entries()) {
      // (Each group alike shows `shows` rows, and has its own "Show all" for the rest.)
      const rows = ordered(group.rows).slice(0, limitOf(g))
      if (group.by)
        out.push({
          is: 'group',
          key: `group:${g}`,
          name: group.name,
          count: group.rows.length,
        })
      // Each row, and the rows inside it that are open, each told by the keys down to it: walked
      // with a stack of what's still to draw (the next on top), never called for each level.
      const todo: { row: DrawnRow; parent?: string; depth: number }[] = []
      for (let r = rows.length - 1; r >= 0; r--) todo.push({ row: rows[r]!, depth: 0 })
      while (todo.length > 0) {
        const { row, parent, depth } = todo.pop()!
        const key = lineKeyOf(parent, keyOf(row))
        const holds = Boolean(row.rows?.length)
        // (Rows start closed, or all open where they're told to; each press turns its own.)
        const open = holds && startOpen !== turned.has(key)
        out.push({ is: 'row', key, row, depth, holds, open })
        if (!open) continue
        const inside = row.rows!
        for (let n = inside.length - 1; n >= 0; n--) {
          todo.push({ row: inside[n]!, parent: key, depth: depth + 1 })
        }
      }
      if (grouped && rows.length < group.rows.length) {
        out.push({ is: 'more', key: `more:${g}`, group: g, count: group.rows.length })
      }
    }
    return out
  }, [groups, sort, turned, startOpen, limitOf, grouped, lineKeyOf])

  // A column that's as wide as its text is as wide as its widest value, as drawn: of all the rows
  // it was given, not of the ones drawn, so nothing shifts as a long table scrolls.
  const template = useMemo(() => {
    const everyRow = groups.flatMap((group) => group.rows.flatMap(withInside))
    return [
      'minmax(0,1.4fr)',
      ...columns.map((column, c) => {
        if (column.kind === 'status') return STATUS_WIDTH
        if (column.width !== 'text') return WIDTHS[column.width ?? 'normal']
        const width = Math.max(
          // (Its heading counts where headings show.)
          headings ? widest([drawn(column.name)], HEADING, fonts) : 0,
          widest(
            everyRow.map((row) => drawn(words(cellAt(row, c)))),
            SET[column.kind],
            fonts,
          ),
        )
        return `${width}px`
      }),
    ].join(' ')
  }, [columns, groups, headings, fonts])

  const active = useMemo(
    () => (activeKey === undefined ? -1 : lines.findIndex((line) => line.key === activeKey)),
    [lines, activeKey],
  )
  const setActive = (index: number) => setActiveKey(lines[index]?.key)
  /** Rows, as a screen reader counts them: a group's heading isn't one. */
  const rowNumbers = useMemo(() => {
    let rows = 0
    return lines.map((line) => (line.is === 'row' ? ++rows : rows))
  }, [lines])
  const rowCount = rowNumbers.at(-1) ?? 0

  // On a phone, facts stand side by side only when every value in the table fits a third on one
  // line; otherwise each takes a line, in every card of this table, its groups included. (By the
  // columns, never by the cells: a row may hold more or fewer than there are columns.)
  const screen = useScreenWidth(phone)
  const beside = useMemo(() => {
    if (!phone) return false
    // (Inside a card, its padding and border too: 16 px and 1 px each side.)
    const third = (screen - 32 - (inCard ? 34 : 0) - 28 - 18 - 24) / 3
    const everyRow = groups.flatMap((group) => group.rows.flatMap(withInside))
    return columns.every(
      (column, c) =>
        widest(
          [drawn(column.name), ...everyRow.map((row) => drawn(words(cellAt(row, c))))],
          FACT,
          fonts,
        ) <= third,
    )
  }, [phone, screen, inCard, groups, columns, fonts])

  const windowed = lines.length > WINDOWED_FROM
  // The React Compiler is not used, so the virtualizer's unmemoizable API is fine here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scroll.current,
    estimateSize: (index) => height(lines[index]!),
    overscan: 12,
    enabled: windowed && !phone,
  })

  const rowAt = (index: number) => {
    const line = lines[index]
    return line?.is === 'row' ? line : undefined
  }
  /** The nearest row at or after `index` going `step`: a group's heading is not a stop. */
  const stop = (index: number, step: 1 | -1) => {
    let at = Math.max(0, Math.min(lines.length - 1, index))
    while (lines[at] && lines[at]!.is !== 'row') at += step
    return lines[at] ? at : active
  }
  const move = (index: number, step: 1 | -1) => {
    const next = stop(index, step)
    setActive(next)
    if (windowed) virtualizer.scrollToIndex(next)
    else document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: 'nearest' })
  }
  useEffect(() => {
    if (going === undefined) return
    const index = lines.findIndex((line) => line.key === going)
    if (index === -1) return
    setGoing(undefined)
    setActiveKey(going)
    // (A row, and a phone's card, found by this table's own id: a page may have many tables.)
    if (windowed) virtualizer.scrollToIndex(index)
    else document.getElementById(`${id}-${index}`)?.scrollIntoView({ block: 'nearest' })
  }, [going, lines, windowed, virtualizer, id])
  const open = (line: Extract<Line, { is: 'row' }>) => {
    if (line.row.again) return goFirst(line.row.again.first)
    if (!line.row.opens) return
    go?.(line.row.opens)
    onOpen?.({ row: line.row.key })
  }
  /**
   * To where a row listed again is first: the rows it's inside opened, and it the active row,
   * brought into view once it's drawn.
   */
  const goFirst = (first: string) => {
    // Found by walking the rows, never by a call for each level; then the rows above it, each
    // by the one it's inside.
    const seen: { key: string; parent: number }[] = []
    const todo = groups
      .flatMap((group) => group.rows)
      .reverse()
      .map((row) => ({ row, parent: -1 }))
    let found = -1
    while (todo.length > 0 && found === -1) {
      const { row, parent } = todo.pop()!
      const at = seen.push({ key: lineKeyOf(seen[parent]?.key, keyOf(row)), parent }) - 1
      if (keyOf(row) === first && !row.again) found = at
      const inside = row.rows ?? []
      for (let i = inside.length - 1; i >= 0; i--) todo.push({ row: inside[i]!, parent: at })
    }
    if (found === -1) return
    const above: string[] = []
    for (let at = seen[found]!.parent; at !== -1; at = seen[at]!.parent) above.push(seen[at]!.key)
    setTurned((was) => {
      const next = new Set(was)
      for (const key of above) {
        if (startOpen) next.delete(key)
        else next.add(key)
      }
      return next
    })
    // (Past the rows that show first, it shows them all.)
    setWhole('all')
    setGoing(seen[found]!.key)
  }
  const twist = (key: string, to: boolean) =>
    setTurned((was) => {
      const next = new Set(was)
      if (to !== startOpen) next.add(key)
      else next.delete(key)
      return next
    })

  const keys: Record<string, () => void> = {
    ArrowDown: () => move(active + 1, 1),
    j: () => move(active + 1, 1),
    ArrowUp: () => move(active - 1, -1),
    k: () => move(active - 1, -1),
    Home: () => move(0, 1),
    End: () => move(lines.length - 1, -1),
    PageDown: () => move(active + PAGE_JUMP, 1),
    PageUp: () => move(active - PAGE_JUMP, -1),
    Enter: () => rowAt(active) && open(rowAt(active)!),
    // A row that holds rows: right opens it and left closes it. On any other they do nothing.
    ArrowRight: () => rowAt(active)?.holds && twist(rowAt(active)!.key, true),
    ArrowLeft: () => rowAt(active)?.holds && twist(rowAt(active)!.key, false),
  }
  const onKeyDown = (event: KeyboardEvent) => {
    // Keys on a heading (Enter or Space to sort) are its own.
    if ((event.target as Element).closest('[role="columnheader"]')) return
    const action = keys[event.key]
    if (!action || event.metaKey || event.ctrlKey || event.altKey) return
    event.preventDefault()
    action()
  }

  // A first press sorts ascending, as Lumovi's lists do; a status the other way, worst first.
  const sortBy = (column: number) =>
    setSort((was) =>
      was?.column === column
        ? { column, down: !was.down }
        : { column, down: columns[column]?.kind === 'status' },
    )
  const sortable = [
    ...(nameSorts ? [NAME] : []),
    ...columns.flatMap((column, c) => (column.sorts ? [c] : [])),
  ]
  const nameOf = (column: number): ReactNode =>
    column === NAME ? 'Name' : <TheirText text={columns[column]?.name} inline />
  // How many show, each group's own `shows` at most, of how many there are.
  const showing = groups.reduce((sum, group, g) => sum + Math.min(limitOf(g), group.rows.length), 0)
  const count =
    total === 0
      ? undefined
      : showing < total
        ? `${counted(showing)} of ${counted(total)}`
        : counted(total)

  const heading = (
    <h3 className="flex items-center px-4 pt-3.5 pb-1.5 text-[13px] font-semibold text-ink-1 phone:px-0 phone:pt-0 phone:pb-2.5">
      <TheirText text={title} />
      {count && (
        <small className="ml-auto text-xs font-normal text-ink-3 tabular-nums">{count}</small>
      )}
      {/* Where a thumb is: after the count, at the edge. */}
      {phone && sortable.length > 0 && total > 0 && (
        <button
          type="button"
          aria-label={`Sort ${named}`}
          onClick={() => setSorting(true)}
          className="-my-3 -mr-3 grid size-11 place-items-center text-ink-2"
        >
          <ArrowUpDown className="size-4" />
        </button>
      )}
    </h3>
  )
  // A cut read: what's listed is from the first `at` Lumovi read, said in Lumovi's words above
  // the rows (never as a failure: what was read is there).
  const ceiling = cut && (
    <p className="mx-4 mb-2 text-xs leading-[18px] text-ink-2 phone:mx-0">
      {cut.of === undefined
        ? `These are from the first ${counted(cut.at)} Lumovi read. There are more.`
        : `These are from the first ${counted(cut.at)} of ${counted(cut.of)} Lumovi read.`}
    </p>
  )
  const more = !grouped && limitOf(0) < total && (
    <ShowAll count={total} onShow={() => showWhole(0)} />
  )

  if (total === 0 || state) {
    return (
      // (Bare in a card too while it reads, or has nothing: the card says the title, once.)
      <section aria-label={bare ? undefined : named} className={cn(!phone && !bare && CARD)}>
        {!bare && heading}
        {ceiling}
        <Nothing state={state ?? { is: 'empty' }} of={title} onRetry={() => onRetry?.({})} />
      </section>
    )
  }

  if (phone) {
    const cards: ReactNode[] = []
    let list: ReactNode[] = []
    const flush = (key: string) => {
      if (list.length)
        cards.push(
          <ul key={key} className="overflow-hidden rounded-xl border border-line">
            {list}
          </ul>,
        )
      list = []
    }
    lines.forEach((line, index) => {
      if (line.is === 'more') {
        flush(`before:${line.key}`)
        cards.push(
          <ShowAll key={line.key} count={line.count} onShow={() => showWhole(line.group)} />,
        )
        return
      }
      if (line.is === 'group') {
        flush(`before:${line.key}`)
        cards.push(
          <GroupHeading
            key={line.key}
            name={line.name}
            count={line.count}
            className="mt-3.5 mb-1.5 first:mt-0"
          />,
        )
        return
      }
      list.push(
        <Card
          key={line.key}
          id={`${id}-${index}`}
          line={line}
          columns={columns}
          beside={beside}
          first={list.length === 0}
          onOpen={() => open(line)}
          onTwist={() => twist(line.key, !line.open)}
          index={index}
        />,
      )
    })
    flush('last')
    return (
      // (Bare, it's a part of the card it's in, which is the region and says its name.)
      <section aria-label={bare ? undefined : named} className="min-w-0">
        {!bare && heading}
        {ceiling}
        {cards}
        {more}
        {sorting && (
          <Sheet title="Sort by" onClose={() => setSorting(false)}>
            <ul role="listbox" aria-label="Sort by" className="px-2 pb-3">
              {sortable.map((c) => (
                <li key={c} role="option" aria-selected={sort?.column === c}>
                  <button
                    type="button"
                    onClick={() => {
                      sortBy(c)
                      setSorting(false)
                    }}
                    className={cn(
                      'flex h-11 w-full items-center gap-2 rounded-lg px-3 text-left text-sm',
                      sort?.column === c ? 'font-medium text-ink-1' : 'text-ink-2',
                    )}
                  >
                    {nameOf(c)}
                    {sort?.column === c &&
                      (sort.down ? (
                        <ArrowDown className="size-4" />
                      ) : (
                        <ArrowUp className="size-4" />
                      ))}
                  </button>
                </li>
              ))}
            </ul>
          </Sheet>
        )}
      </section>
    )
  }

  const shown = windowed
    ? virtualizer.getVirtualItems().map((item) => ({ index: item.index, top: item.start }))
    : lines.map((_, index) => ({ index, top: 0 }))
  return (
    <section aria-label={bare ? undefined : `${named} table`} className={cn(!bare && CARD)}>
      {!bare && heading}
      {ceiling}
      <div className="flex flex-col px-2 pb-3">
        <div
          ref={scroll}
          // A table whose rows nest is a tree of rows: each says how deep it is, at any depth.
          role={nests ? 'treegrid' : 'grid'}
          tabIndex={0}
          aria-label={named}
          aria-rowcount={rowCount + 1}
          aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            if (active < 0 && event.target === event.currentTarget) setActive(stop(0, 1))
          }}
          className={cn('group/table outline-none', windowed && 'max-h-[32rem] overflow-y-auto')}
        >
          <div
            role="row"
            // (Read first by a screen reader; reached by Tab after the rows, as in Lumovi's lists.)
            className={cn(
              'grid h-7 items-center gap-4 px-2',
              !headings && 'sr-only',
              // Its headings stay as a long table scrolls under them.
              headings && windowed && 'sticky top-0 z-10 bg-surface-2',
            )}
            style={{ gridTemplateColumns: template }}
          >
            <span
              role="columnheader"
              aria-sort={
                sort?.column === NAME ? (sort.down ? 'descending' : 'ascending') : undefined
              }
              className="flex min-w-0"
            >
              {nameSorts && headings ? (
                <button
                  type="button"
                  onClick={() => sortBy(NAME)}
                  className={cn(
                    HEADING,
                    'flex min-w-0 items-center gap-1 hover:text-ink-1',
                    sort?.column === NAME && 'text-ink-1',
                  )}
                >
                  Name
                  {sort?.column === NAME &&
                    (sort.down ? (
                      <ArrowDown className="size-3 shrink-0" />
                    ) : (
                      <ArrowUp className="size-3 shrink-0" />
                    ))}
                </button>
              ) : (
                <span className={HEADING}>Name</span>
              )}
            </span>
            {columns.map((column, c) => {
              const sorted = sort?.column === c
              const right = column.kind === 'number' || column.kind === 'age'
              return (
                <span
                  key={c}
                  role="columnheader"
                  aria-sort={sorted ? (sort.down ? 'descending' : 'ascending') : undefined}
                  className={cn('flex min-w-0', right && 'justify-end')}
                >
                  {column.sorts && headings ? (
                    <button
                      type="button"
                      onClick={() => sortBy(c)}
                      className={cn(
                        HEADING,
                        'flex min-w-0 items-center gap-1 hover:text-ink-1',
                        sorted && 'text-ink-1',
                      )}
                    >
                      <span className="truncate">
                        <TheirText text={column.name} inline />
                      </span>
                      {sorted &&
                        (sort.down ? (
                          <ArrowDown className="size-3 shrink-0" />
                        ) : (
                          <ArrowUp className="size-3 shrink-0" />
                        ))}
                    </button>
                  ) : (
                    <span className={cn(HEADING, 'truncate')}>
                      <TheirText text={column.name} inline />
                    </span>
                  )}
                </span>
              )
            })}
          </div>
          <div
            role="rowgroup"
            className="relative"
            style={windowed ? { height: virtualizer.getTotalSize() } : undefined}
          >
            {shown.map(({ index, top }) => {
              const line = lines[index]!
              const place = windowed
                ? ({ position: 'absolute', top, left: 0, right: 0 } as const)
                : undefined
              if (line.is === 'group') {
                return (
                  <GroupHeading
                    key={line.key}
                    name={line.name}
                    count={line.count}
                    className="h-7 px-2 pt-2.5"
                    style={place}
                  />
                )
              }
              if (line.is === 'more') {
                return (
                  <div key={line.key} style={place} className="flex h-8 items-center">
                    <ShowAll count={line.count} onShow={() => showWhole(line.group)} />
                  </div>
                )
              }
              const { row } = line
              const from = row.rest?.from
              const called = spelled(row.lead.name.their)
              return (
                <div
                  key={line.key}
                  id={`${id}-${index}`}
                  role="row"
                  aria-rowindex={rowNumbers[index]! + 1}
                  aria-level={nests ? line.depth + 1 : undefined}
                  // (Active, not picked: nothing here picks rows.)
                  data-active={active === index}
                  aria-expanded={line.holds ? line.open : undefined}
                  onClick={() => {
                    setActive(index)
                    open(line)
                  }}
                  style={{
                    gridTemplateColumns: template,
                    // (A note may be one line; in a windowed table every row keeps the height it was placed by.)
                    minHeight: height(line) - GAP - (row.note?.their && !windowed ? NOTE_LINE : 0),
                    marginBottom: GAP,
                    ...place,
                  }}
                  className={cn(
                    'grid items-center gap-x-4 rounded-lg px-2 py-2',
                    row.note?.their && 'content-start items-start gap-y-0.5',
                    row.opens && 'cursor-default hover:bg-surface-3/60',
                    // The ring of the keyboard, when the table has the focus.
                    active === index &&
                      'group-focus-visible/table:ring-2 group-focus-visible/table:ring-accent',
                  )}
                >
                  <span
                    role="gridcell"
                    style={{ paddingLeft: Math.min(line.depth, DEEPEST) * INDENT }}
                    className="relative flex min-w-0 items-center gap-2.5"
                  >
                    <Deeper depth={line.depth} deepest={DEEPEST} step={INDENT} />
                    {line.holds && (
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={line.open ? `Close ${called}` : `Open ${called}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          twist(line.key, !line.open)
                        }}
                        className="-ml-0.5 grid size-4 shrink-0 place-items-center text-ink-3"
                      >
                        {line.open ? (
                          <ChevronDown className="size-3.5" />
                        ) : (
                          <ChevronRight className="size-3.5" />
                        )}
                      </button>
                    )}
                    <Lead
                      lead={row.lead}
                      top={Boolean(row.note?.their)}
                      quiet={Boolean(row.again)}
                    />
                  </span>
                  {row.again ? (
                    <span
                      role="gridcell"
                      style={{ gridColumn: '2 / -1' }}
                      className="flex min-w-0 items-center gap-1.5 text-xs text-ink-3"
                    >
                      <Again again={row.again} onGo={() => goFirst(row.again!.first)} />
                    </span>
                  ) : (
                    columns.map((column, c) =>
                      from !== undefined && c >= from ? (
                        c === from && (
                          <span
                            key={c}
                            role="gridcell"
                            style={{ gridColumn: `${c + 2} / -1` }}
                            className="min-w-0 truncate text-right text-xs text-ink-3"
                          >
                            <Rest rest={row.rest} />
                          </span>
                        )
                      ) : (
                        <span key={c} role="gridcell" className="min-w-0">
                          <Cell column={column} cell={cellAt(row, c)} />
                        </span>
                      ),
                    )
                  )}
                  {row.note?.their && (
                    <span className="col-span-full -mt-0.5 ml-[18px] line-clamp-2 text-xs leading-[19px] text-ink-2">
                      <TheirText text={row.note} inline />
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
        {more}
      </div>
    </section>
  )
}

/**
 * How deep a row is, where it's set in no further than the deepest it can be (a graph's table):
 * its level, quiet, in the last step of its indent. Nothing for a row less deep.
 */
function Deeper({ depth, deepest, step }: { depth: number; deepest: number; step: number }) {
  if (depth <= deepest) return null
  // (In the indent, where it takes no room: its cell or card is the box it's placed in.)
  return (
    <span
      title={`Level ${depth + 1}`}
      style={{ left: (deepest - 1) * step, width: step }}
      className="absolute inset-y-0 flex items-center justify-end pr-1.5 text-[11px] text-ink-3 tabular-nums"
    >
      {depth + 1}
    </span>
  )
}

/** A group's heading, with its count: the table's own, and not a stop. */
/** Under a group, or a table, showing fewer rows than it has: "Show all N", in place. */
function ShowAll({ count, onShow }: { count: number; onShow: () => void }) {
  return (
    <button
      type="button"
      onClick={onShow}
      className="mt-1.5 self-start rounded-md px-2 py-1 text-xs font-medium text-accent-strong hover:bg-surface-3 phone:mt-1 phone:flex phone:h-11 phone:items-center phone:px-0 phone:text-[13px]"
    >
      Show all {count}
    </button>
  )
}

function GroupHeading({
  name,
  count,
  className,
  style,
}: {
  name?: Their
  count: number
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <h4 style={style} className={cn(HEADING, 'flex items-baseline gap-2', className)}>
      <TheirText text={name} inline />
      <small className="text-[11px] font-normal tracking-normal normal-case tabular-nums">
        {count}
      </small>
    </h4>
  )
}

/** A text's words: the plugin's drawn in pieces, Lumovi's own as they are. */
function Words({ text }: { text: Their | string }) {
  return typeof text === 'string' ? text : <TheirText text={text} inline />
}

/**
 * A status as the app's pill draws one (`StatusPill`), but its word the plugin's: drawn in
 * pieces, and spelled in its tooltip.
 */
export function Pill({
  level,
  word,
  className,
}: {
  level: Health
  word?: Their
  className?: string
}) {
  const style = HEALTH_STYLE[level]
  const Icon = style.icon
  return (
    <span
      data-health={level}
      className={cn(
        'inline-flex h-[22px] max-w-full items-center gap-1 rounded-full pr-2 pl-1.5 text-xs font-medium',
        style.soft,
        style.text,
        className,
      )}
    >
      <Icon
        className={cn('size-3.5 shrink-0', level === 'progressing' && 'animate-turn')}
        strokeWidth={2.25}
      />
      <span className="truncate" title={word ? tooltip(word.their) : undefined}>
        <TheirText text={word} inline />
      </span>
    </span>
  )
}

/** A meter's fill and its track, a light step of the same hue: as the app's own meters. */
const METER = {
  normal: { fill: 'bg-series-1', track: 'bg-series-1/20' },
  warn: { fill: 'bg-warn', track: 'bg-warn/20' },
  critical: { fill: 'bg-critical', track: 'bg-critical/20' },
} as const

/** A cell, drawn Lumovi's way for its kind. */
function Cell({ column, cell }: { column: TableColumn; cell: TableCell }) {
  switch (cell.kind) {
    case 'none':
      // (Where its column's values stand: right for a number or an age.)
      return (
        <span
          className={cn(
            'block text-ink-3',
            (column.kind === 'number' || column.kind === 'age') && 'text-right',
          )}
        >
          —
        </span>
      )
    case 'status':
      return <Pill level={cell.level} word={cell.word} />
    case 'meter': {
      const { used, of } = cell
      const ratio = of && used !== undefined ? Math.max(0, Math.min(1, used / of)) : undefined
      const level = meterLevel(cell)
      const tone = level === 'critical' ? 'critical' : level === 'warning' ? 'warn' : 'normal'
      // (Read out, its marks spelled.)
      const named = `${spelled(cell.label.their)}: ${spelled(cell.text.their)}`
      return (
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex justify-between gap-2 text-[11px] leading-[14px] text-ink-3">
            {/* (Its label stays whole, as a word would, and its words give way.) */}
            <span className="max-w-full shrink-0 truncate">
              <TheirText text={cell.label} inline />
            </span>
            <span className="truncate text-ink-2 tabular-nums">
              <TheirText text={cell.text} inline />
            </span>
          </span>
          {ratio === undefined ? (
            <span className="h-1.5 rounded-full border border-dashed border-line-strong" />
          ) : (
            <span
              role="meter"
              aria-label={named}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(ratio * 100)}
              className={cn('h-1.5 overflow-hidden rounded-full', METER[tone].track)}
            >
              <span
                className={cn('block h-full rounded-full', METER[tone].fill)}
                style={{ width: `${ratio * 100}%` }}
              />
            </span>
          )}
        </span>
      )
    }
    case 'number':
    case 'age':
      return (
        <span
          className={cn(
            'block truncate text-right tabular-nums',
            column.kind === 'age' ? 'text-xs text-ink-3' : 'text-ink-2',
          )}
          title={cell.kind === 'age' && cell.time ? tooltip(cell.time) : undefined}
        >
          <Words text={words(cell)} />
        </span>
      )
    case 'text':
      return (
        <span className="block truncate text-ink-2">
          <TheirText text={cell.text} inline />
        </span>
      )
  }
}

/** A row as a card: its lead, then its other columns as labelled facts. */
function Card({
  id,
  line,
  columns,
  beside,
  first,
  onOpen,
  onTwist,
  index,
}: {
  /** As a desk's row has it: where "Listed again" finds the card it goes to. */
  id: string
  line: Extract<Line, { is: 'row' }>
  columns: TableColumn[]
  beside: boolean
  first: boolean
  onOpen: () => void
  onTwist: () => void
  index: number
}) {
  const { row } = line
  if (row.again) {
    // A row listed again is one line, 44 px, and pressed goes where it's first.
    return (
      <li
        id={id}
        data-row={index}
        className={cn('relative flex', !first && 'border-t border-line', 'bg-surface-2/60')}
        style={{ paddingLeft: Math.min(line.depth, PHONE_DEEPEST) * PHONE_INDENT }}
      >
        <Deeper depth={line.depth} deepest={PHONE_DEEPEST} step={PHONE_INDENT} />
        <button
          type="button"
          onClick={onOpen}
          className="flex h-11 min-w-0 flex-1 items-center gap-2 px-3.5 text-left text-xs text-ink-2 active:bg-surface-3"
        >
          <Again again={row.again} onGo={onOpen} name={row.lead?.name} />
        </button>
      </li>
    )
  }
  const from = row.rest?.from
  const called = spelled(row.lead.name.their)
  const facts = columns.flatMap((column, c) =>
    // (A card says what there is: a cell with nothing in it is no fact. Side by side it keeps
    // its place, with a dash, so every card's facts stand under the same names.)
    (from !== undefined && c >= from) || (!beside && cellAt(row, c).kind === 'none')
      ? []
      : [
          {
            c,
            name: column.name,
            said: words(cellAt(row, c)),
            // (A meter at its warning or critical line says so, as a status does.)
            level: meterLevel(cellAt(row, c)),
          },
        ],
  )
  const body = (
    <>
      <span className="flex items-center gap-2.5">
        <Lead lead={row.lead} />
      </span>
      {row.note?.their && (
        <span className="mt-1.5 ml-[18px] line-clamp-3 text-xs leading-[18px] text-ink-2">
          <TheirText text={row.note} inline />
        </span>
      )}
      <dl
        className={cn(
          'mt-2 ml-[18px] grid gap-3 text-xs leading-4',
          beside ? 'grid-cols-3' : 'grid-cols-1',
        )}
      >
        {facts.map((fact) => (
          <div key={fact.c} className="min-w-0">
            <dt className="text-ink-3">
              <TheirText text={fact.name} inline />
            </dt>
            <dd
              data-level={fact.level}
              className={cn(
                'mt-0.5 [overflow-wrap:anywhere] tabular-nums',
                fact.level ? HEALTH_STYLE[fact.level].text : 'text-ink-1',
              )}
            >
              {fact.level && <LevelIcon level={fact.level} />}
              <Words text={fact.said} />
            </dd>
          </div>
        ))}
        {/* (The rest of the row: across the facts' columns, as it takes the row's on a desk.) */}
        {from !== undefined && (
          <div className="col-span-full min-w-0">
            <dd className="text-ink-3">
              <Rest rest={row.rest} />
            </dd>
          </div>
        )}
      </dl>
    </>
  )
  return (
    <li
      id={id}
      data-row={index}
      className={cn(
        'relative flex items-start',
        !first && 'border-t border-line',
        line.depth > 0 && 'bg-surface-2/60',
      )}
      style={{ paddingLeft: Math.min(line.depth, PHONE_DEEPEST) * PHONE_INDENT }}
    >
      <Deeper depth={line.depth} deepest={PHONE_DEEPEST} step={PHONE_INDENT} />
      {row.opens ? (
        // A row that opens is the whole card.
        <button
          type="button"
          onClick={onOpen}
          className="block min-w-0 flex-1 px-3.5 py-2.5 text-left active:bg-surface-3"
        >
          {body}
        </button>
      ) : (
        <div className="min-w-0 flex-1 px-3.5 py-2.5">{body}</div>
      )}
      {line.holds && (
        <button
          type="button"
          aria-expanded={line.open}
          aria-label={line.open ? `Close ${called}` : `Open ${called}`}
          onClick={onTwist}
          className="grid size-11 shrink-0 place-items-center text-ink-3"
        >
          {line.open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
      )}
    </li>
  )
}

/**
 * Where a row listed again is first: "Listed again: first under cart", the row it's first inside
 * a link to it. (A row of the table's own, listed again, is first at the top: "Listed again".)
 */
function Again({
  again,
  onGo,
  name,
}: {
  again: NonNullable<DrawnRow['again']>
  onGo: () => void
  /** Its own name, on a phone, where the line says whose it is. */
  name?: Their
}) {
  const go = (event: React.MouseEvent) => {
    event.stopPropagation()
    onGo()
  }
  return (
    <>
      <CornerDownLeft className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">
        {name && (
          <>
            <TheirText text={name} inline />,{' '}
          </>
        )}
        {name ? 'listed again' : 'Listed again'}
        {again.under?.their ? (
          <>
            : first under{' '}
            {name ? (
              // (On a phone the whole row is what's pressed.)
              <b className="font-medium text-accent-strong">
                <TheirText text={again.under} inline />
              </b>
            ) : (
              <button
                type="button"
                tabIndex={-1}
                onClick={go}
                className="font-medium text-accent-strong hover:underline"
              >
                <TheirText text={again.under} inline />
              </button>
            )}
          </>
        ) : null}
      </span>
    </>
  )
}

/**
 * Nothing to list: busy, failed, empty or quiet, in the words it was given. Empty and given no
 * words, it says there's none of what the table is `of`.
 */
export function Nothing({
  state,
  of,
  onRetry,
}: {
  /** A table's own (the plugin's texts handed over), or a frame's own as it's written. */
  state: TableState | WrittenTableState
  of?: Their
  onRetry: () => void
}) {
  if (state.is === 'busy') {
    return (
      <div
        role="status"
        aria-label="Loading"
        className="flex flex-col gap-3.5 px-4 pt-3 pb-5 phone:px-0"
      >
        {['w-3/5', 'w-2/5', 'w-1/2'].map((width) => (
          <span
            key={width}
            className={cn('h-2.5 animate-pulse rounded-full bg-surface-3', width)}
          />
        ))}
      </div>
    )
  }
  if (state.is === 'quiet') {
    return (
      <div className="flex min-h-[132px] flex-col items-center justify-center gap-2 p-4 text-center text-xs text-ink-3">
        {state.good && <CircleCheck className="size-5 text-good-text" aria-hidden />}
        <span>
          <TheirText text={state.line} inline />
        </span>
      </div>
    )
  }
  const Icon = state.is === 'failed' ? TriangleAlert : Search
  return (
    <div
      role={state.is === 'failed' ? 'alert' : undefined}
      className="flex min-h-[132px] flex-col items-center justify-center gap-1 p-4 text-center text-ink-3"
    >
      <span className="mb-1.5 grid size-9 place-items-center rounded-[10px] bg-surface-3 text-ink-2">
        <Icon className="size-4" aria-hidden />
      </span>
      <b className="text-[13px] font-medium text-ink-1">
        {state.is === 'empty' && !state.title ? (
          <>
            No{' '}
            <TheirText
              // (Lowercased as a word in a sentence: its letters, never its marks.)
              pieces={drawn(of).map((piece) =>
                typeof piece === 'string' ? piece.toLowerCase() : piece,
              )}
              inline
            />
          </>
        ) : (
          <TheirText text={state.title} inline />
        )}
      </b>
      {state.is === 'failed' ? (
        <span className="max-w-[300px] text-xs leading-[18px] break-words">
          <TheirText text={state.said} inline />
        </span>
      ) : (
        said(state.line) && (
          <span className="max-w-[300px] text-xs leading-[18px]">
            <TheirText text={state.line} inline />
          </span>
        )
      )}
      {state.is === 'failed' && (
        <Button className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

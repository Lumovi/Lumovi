/**
 * The kit's Table: what a plugin lists things with, drawn by Lumovi from a description
 * (`@shared/kit/table`). A plugin names its columns and gives its rows; everything a person
 * sees of them is decided here: the widths, from one scale; the order, when a column sorts; how
 * a long name is cut; how an age, a status and a meter look; and what a phone makes of it.
 *
 * It has the keys of Lumovi's own lists wherever both have the thing: one stop for all its
 * rows, with an active row that the arrows (and j, k, Home, End, Page Up and Page Down) move;
 * Enter opens; the headings that sort are stops after the rows. Right opens a row that holds
 * rows and left closes it. It's never paged, and nothing in it is picked.
 */
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Search,
  TriangleAlert,
} from 'lucide-react'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type { Health } from '@shared/health'
import type {
  ObjectRef,
  Table as TableSaid,
  TableCell,
  TableColumn,
  TableCarries,
  TableRow,
} from '@shared/kit/table'
import { Button } from '@renderer/components/Button'
import { MiddleTruncate } from '@renderer/components/MiddleTruncate'
import { Sheet } from '@renderer/components/Sheet'
import { StatusDot, StatusPill } from '@renderer/components/Status'
import { cn } from '@renderer/lib/cn'
import { age } from '@renderer/lib/format'
import { useLayout } from '@renderer/lib/layout'

/** A row of one line, one with a line under its name, and each line of a note. */
const ROW = 36
const ROW_WITH_LINE = 52
const ROW_WITH_METER = 40
const NOTE_LINE = 19
/** Between rows. */
const GAP = 2
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

/** What a cell says in words: what a phone shows of it, what it sorts by as text, how wide it is. */
function words(cell: TableCell): string {
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
 * What a cell sorts by: a number where it has one. Nothing (`undefined`) is last whichever way
 * the rest is sorted.
 */
function rank(cell: TableCell): number | string | undefined {
  switch (cell.kind) {
    case 'none':
      return undefined
    case 'number':
      return cell.value
    // How long ago, or how soon: what's said, so the youngest and the soonest come first.
    case 'age':
      return Number.isNaN(Date.parse(cell.time))
        ? undefined
        : Math.abs(Date.now() - Date.parse(cell.time))
    case 'status':
      // (How bad it is: sorted descending first, so the worst is on top.)
      return SEVERITY.indexOf(cell.level)
    case 'meter':
      return cell.of ? cell.used / cell.of : undefined
    case 'text':
      return cell.text.toLowerCase()
  }
}

/** A row with fewer cells than columns has nothing in the rest. */
const NONE: TableCell = { kind: 'none' }

/** What's been measured, the newest few thousand: a table's texts change for as long as Lumovi runs. */
const measured = new Map<string, number>()
const MEASURED_AT_MOST = 4000

/**
 * How wide each of these is as the table sets it (`className`: its size, its figures), the widest
 * of them: laid out once, unseen, and not drawn on a canvas, which knows nothing of tabular
 * figures. Figures in a tabular face are all one width, so a text is measured by its shape and
 * thousands of ages are a handful of shapes. (`fonts`: what was measured before the page's own
 * fonts were in isn't kept.)
 */
function widest(texts: string[], className: string, fonts: number): number {
  const shapes = [...new Set(texts.map((text) => text.replace(/\d/g, '0')))]
  const unknown = shapes.filter((shape) => !measured.has(`${fonts}|${className}|${shape}`))
  if (unknown.length) {
    const box = document.createElement('div')
    box.className = 'pointer-events-none invisible absolute top-0 left-0 whitespace-nowrap'
    const spans = unknown.map((shape) => {
      const span = document.createElement('span')
      span.className = cn('block w-max', className)
      span.textContent = shape
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
  | { is: 'group'; key: string; name: string; count: number }
  | { is: 'row'; key: string; row: TableRow; inside: boolean; holds: boolean; open: boolean }

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
  // (A meter is its words over its bar: a row of one line with one is a little taller.)
  const meter = line.row.cells.some((cell) => cell.kind === 'meter')
  const base = line.row.lead.under ? ROW_WITH_LINE : meter ? ROW_WITH_METER : ROW
  return (line.row.note ? base + 2 * NOTE_LINE + 2 : base) + GAP
}

export function Table({
  table,
  go,
  onOpen,
  onRetry,
}: {
  table: TableSaid
  /** Opens the object a row names: Lumovi's own to do, never the plugin's. */
  go?: (object: ObjectRef) => void
  /** A row that opens something was pressed, for whoever described the table. */
  onOpen?: (carries: TableCarries['open']) => void
  /** "Try again" was pressed. */
  onRetry?: (carries: TableCarries['retry']) => void
}) {
  const id = useId()
  const phone = useLayout() === 'phone'
  const scroll = useRef<HTMLDivElement>(null)
  const [sort, setSort] = useState<Sort>()
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const [all, setAll] = useState(false)
  // The active row, by its key: it stays on its row as rows sort, open, or are told anew.
  const [activeKey, setActiveKey] = useState<string>()
  const [sorting, setSorting] = useState(false)
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

  const { columns } = table
  // Rows that follow each other with the same group stand under one heading.
  const groups = useMemo(() => {
    const out: { name: string; rows: TableRow[] }[] = []
    for (const row of table.rows) {
      const name = row.group ?? ''
      const last = out.at(-1)
      if (last && last.name === name) last.rows.push(row)
      else out.push({ name, rows: [row] })
    }
    return out
  }, [table.rows])
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0)
  const limit = all || table.shows === undefined ? Infinity : table.shows

  // Sorted, then cut to what shows first: the same rows on every draw, whatever is scrolled.
  const lines = useMemo(() => {
    const ordered = (rows: TableRow[]) => {
      if (!sort) return rows
      const by = (row: TableRow) =>
        sort.column === NAME ? row.lead.name.toLowerCase() : rank(row.cells[sort.column] ?? NONE)
      return [...rows].sort((a, b) => {
        const [x, y] = [by(a), by(b)]
        if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1
        const order = x < y ? -1 : x > y ? 1 : 0
        return sort.down ? -order : order
      })
    }
    const out: Line[] = []
    let left = limit
    for (const [g, group] of groups.entries()) {
      if (left <= 0) break
      const rows = ordered(group.rows).slice(0, left)
      left -= rows.length
      if (group.name)
        out.push({
          is: 'group',
          key: `group:${g}`,
          name: group.name,
          count: group.rows.length,
        })
      for (const row of rows) {
        const holds = Boolean(row.rows?.length)
        const open = holds && opened.has(row.key)
        out.push({ is: 'row', key: `row:${row.key}`, row, inside: false, holds, open })
        if (open) {
          for (const inner of row.rows!) {
            out.push({
              is: 'row',
              key: `in:${JSON.stringify([row.key, inner.key])}`,
              row: inner,
              inside: true,
              holds: false,
              open: false,
            })
          }
        }
      }
    }
    return out
  }, [groups, sort, opened, limit])

  // A column that's as wide as its text is as wide as its widest value: of all the rows it was
  // given, not of the ones drawn, so nothing shifts as a long table scrolls.
  const template = useMemo(() => {
    const everyRow = groups.flatMap((group) =>
      group.rows.flatMap((row) => [row, ...(row.rows ?? [])]),
    )
    return [
      'minmax(0,1.4fr)',
      ...columns.map((column, c) => {
        if (column.kind === 'status') return STATUS_WIDTH
        if (column.width !== 'text') return WIDTHS[column.width ?? 'normal']
        const width = Math.max(
          // (Its heading counts where headings show.)
          table.headings ? widest([column.name], HEADING, fonts) : 0,
          widest(
            everyRow.map((row) => words(row.cells[c] ?? NONE)),
            SET[column.kind],
            fonts,
          ),
        )
        return `${width}px`
      }),
    ].join(' ')
  }, [columns, groups, table.headings, fonts])

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
    const third = (screen - 32 - 28 - 18 - 24) / 3
    const everyRow = groups.flatMap((group) =>
      group.rows.flatMap((row) => [row, ...(row.rows ?? [])]),
    )
    return columns.every(
      (column, c) =>
        widest([column.name, ...everyRow.map((row) => words(row.cells[c] ?? NONE))], FACT, fonts) <=
        third,
    )
  }, [phone, screen, groups, columns, fonts])

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
  const open = (line: Extract<Line, { is: 'row' }>) => {
    if (!line.row.opens) return
    go?.(line.row.opens)
    onOpen?.({ row: line.row.key })
  }
  const twist = (key: string, to: boolean) =>
    setOpened((was) => {
      const next = new Set(was)
      if (to) next.add(key)
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
    ArrowRight: () => rowAt(active)?.holds && twist(rowAt(active)!.row.key, true),
    ArrowLeft: () => rowAt(active)?.holds && twist(rowAt(active)!.row.key, false),
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
    ...(table.nameSorts ? [NAME] : []),
    ...columns.flatMap((column, c) => (column.sorts ? [c] : [])),
  ]
  const nameOf = (column: number) => (column === NAME ? 'Name' : columns[column]!.name)
  const count =
    total === 0 ? undefined : limit < total ? `${limit} of ${total}` : total.toLocaleString('en-US')

  const heading = (
    <h3 className="flex items-center px-4 pt-3.5 pb-1.5 text-[13px] font-semibold text-ink-1 phone:px-0 phone:pt-0 phone:pb-2.5">
      {table.title}
      {count && (
        <small className="ml-auto text-xs font-normal text-ink-3 tabular-nums">{count}</small>
      )}
      {/* Where a thumb is: after the count, at the edge. */}
      {phone && sortable.length > 0 && total > 0 && (
        <button
          type="button"
          aria-label={`Sort ${table.title}`}
          onClick={() => setSorting(true)}
          className="-my-3 -mr-3 grid size-11 place-items-center text-ink-2"
        >
          <ArrowUpDown className="size-4" />
        </button>
      )}
    </h3>
  )
  const more = limit < total && (
    <button
      type="button"
      onClick={() => setAll(true)}
      className="mt-1.5 self-start rounded-md px-2 py-1 text-xs font-medium text-accent-strong hover:bg-surface-3 phone:mt-1 phone:flex phone:h-11 phone:items-center phone:px-0 phone:text-[13px]"
    >
      Show all {total}
    </button>
  )

  if (total === 0 || table.state) {
    return (
      <section aria-label={table.title} className={cn(!phone && CARD)}>
        {heading}
        <Nothing
          state={table.state ?? { is: 'empty', title: `No ${table.title.toLowerCase()}` }}
          onRetry={() => onRetry?.({})}
        />
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
          line={line}
          columns={columns}
          beside={beside}
          first={list.length === 0}
          onOpen={() => open(line)}
          onTwist={() => twist(line.row.key, !line.open)}
          index={index}
        />,
      )
    })
    flush('last')
    return (
      <section aria-label={table.title} className="min-w-0">
        {heading}
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
    <section aria-label={`${table.title} table`} className={CARD}>
      {heading}
      <div className="flex flex-col px-2 pb-3">
        <div
          ref={scroll}
          role="grid"
          tabIndex={0}
          aria-label={table.title}
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
              !table.headings && 'sr-only',
              // Its headings stay as a long table scrolls under them.
              table.headings && windowed && 'sticky top-0 z-10 bg-surface-2',
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
              {table.nameSorts && table.headings ? (
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
                  {column.sorts && table.headings ? (
                    <button
                      type="button"
                      onClick={() => sortBy(c)}
                      className={cn(
                        HEADING,
                        'flex min-w-0 items-center gap-1 hover:text-ink-1',
                        sorted && 'text-ink-1',
                      )}
                    >
                      <span className="truncate">{column.name}</span>
                      {sorted &&
                        (sort.down ? (
                          <ArrowDown className="size-3 shrink-0" />
                        ) : (
                          <ArrowUp className="size-3 shrink-0" />
                        ))}
                    </button>
                  ) : (
                    <span className={cn(HEADING, 'truncate')}>{column.name}</span>
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
              const { row } = line
              const rest = row.rest
              return (
                <div
                  key={line.key}
                  id={`${id}-${index}`}
                  role="row"
                  aria-rowindex={rowNumbers[index]! + 1}
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
                    minHeight: height(line) - GAP - (row.note && !windowed ? NOTE_LINE : 0),
                    marginBottom: GAP,
                    ...place,
                  }}
                  className={cn(
                    'grid items-center gap-x-4 rounded-lg px-2 py-2',
                    row.note && 'content-start items-start gap-y-0.5',
                    row.opens && 'cursor-default hover:bg-surface-3/60',
                    // The ring of the keyboard, when the table has the focus.
                    active === index &&
                      'group-focus-visible/table:ring-2 group-focus-visible/table:ring-accent',
                  )}
                >
                  <span
                    role="gridcell"
                    className={cn('flex min-w-0 items-center gap-2.5', line.inside && 'pl-[26px]')}
                  >
                    {line.holds && (
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={line.open ? `Close ${row.lead.name}` : `Open ${row.lead.name}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          twist(line.row.key, !line.open)
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
                    <Lead row={row} />
                  </span>
                  {columns.map((column, c) =>
                    rest && c >= rest.from ? (
                      c === rest.from && (
                        <span
                          key={c}
                          role="gridcell"
                          style={{ gridColumn: `${c + 2} / -1` }}
                          className="min-w-0 truncate text-right text-xs text-ink-3"
                        >
                          {rest.text}
                        </span>
                      )
                    ) : (
                      <span key={c} role="gridcell" className="min-w-0">
                        <Cell column={column} cell={row.cells[c] ?? NONE} />
                      </span>
                    ),
                  )}
                  {row.note && (
                    <span className="col-span-full -mt-0.5 ml-[18px] line-clamp-2 text-xs leading-[19px] text-ink-2">
                      {row.note}
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

const CARD = 'overflow-hidden rounded-xl border border-line bg-surface-2 shadow-panel'
const HEADING = 'text-[11px] font-medium tracking-wider whitespace-nowrap text-ink-3 uppercase'

/** A group's heading, with its count: the table's own, and not a stop. */
function GroupHeading({
  name,
  count,
  className,
  style,
}: {
  name: string
  count: number
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <h4 style={style} className={cn(HEADING, 'flex items-baseline gap-2', className)}>
      {name}
      <small className="text-[11px] font-normal tracking-normal normal-case tabular-nums">
        {count}
      </small>
    </h4>
  )
}

/** What a row is called: a dot in a level (or none, and the name keeps its place), a name, a quiet word, a line under. */
function Lead({ row }: { row: TableRow }) {
  const { level, name, beside, under } = row.lead
  return (
    <span className={cn('flex min-w-0 flex-1 items-center gap-2.5', row.note && 'items-start')}>
      {level ? (
        <StatusDot health={level} className={cn(row.note && 'mt-1.5')} />
      ) : (
        <span className="w-2 shrink-0" />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          {/* A name is never cut at its end: it loses its middle and keeps its last characters. */}
          <MiddleTruncate text={name} className="font-medium text-ink-1" />
          {/* The word beside it gives way first, to 40% of the lead at most. */}
          {beside && (
            <span
              // (A short word stays whole; a long one keeps its first few characters.)
              style={{ minWidth: `${Math.min(beside.length, 5)}ch` }}
              className="max-w-[40%] shrink-[99] truncate text-xs text-ink-3"
            >
              {beside}
            </span>
          )}
        </span>
        {under && <span className="block truncate text-xs leading-4 text-ink-3">{under}</span>}
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
      return <StatusPill status={{ health: cell.level, label: cell.word }} />
    case 'meter': {
      const ratio = cell.of ? Math.max(0, Math.min(1, cell.used / cell.of)) : undefined
      const tone =
        ratio === undefined
          ? 'normal'
          : ratio >= 0.9
            ? 'critical'
            : ratio >= 0.75
              ? 'warn'
              : 'normal'
      return (
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex justify-between gap-2 text-[11px] leading-[14px] text-ink-3">
            {cell.label}
            <span className="truncate text-ink-2 tabular-nums">{cell.text}</span>
          </span>
          {ratio === undefined ? (
            <span className="h-1.5 rounded-full border border-dashed border-line-strong" />
          ) : (
            <span
              role="meter"
              aria-label={`${cell.label}: ${cell.text}`}
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
          title={cell.kind === 'age' ? cell.time : undefined}
        >
          {words(cell)}
        </span>
      )
    case 'text':
      return <span className="block truncate text-ink-2">{cell.text}</span>
  }
}

/** A row as a card: its lead, then its other columns as labelled facts. */
function Card({
  line,
  columns,
  beside,
  first,
  onOpen,
  onTwist,
  index,
}: {
  line: Extract<Line, { is: 'row' }>
  columns: TableColumn[]
  beside: boolean
  first: boolean
  onOpen: () => void
  onTwist: () => void
  index: number
}) {
  const { row } = line
  const facts = columns.flatMap((column, c) =>
    // (A card says what there is: a cell with nothing in it is no fact. Side by side it keeps
    // its place, with a dash, so every card's facts stand under the same names.)
    (row.rest && c >= row.rest.from) || (!beside && (row.cells[c] ?? NONE).kind === 'none')
      ? []
      : [{ name: column.name, said: words(row.cells[c] ?? NONE) }],
  )
  const body = (
    <>
      <span className="flex items-center gap-2.5">
        <Lead row={{ ...row, note: undefined }} />
      </span>
      {row.note && (
        <span className="mt-1.5 ml-[18px] line-clamp-3 text-xs leading-[18px] text-ink-2">
          {row.note}
        </span>
      )}
      <dl
        className={cn(
          'mt-2 ml-[18px] grid gap-3 text-xs leading-4',
          beside ? 'grid-cols-3' : 'grid-cols-1',
        )}
      >
        {facts.map((fact) => (
          <div key={fact.name} className="min-w-0">
            <dt className="text-ink-3">{fact.name}</dt>
            <dd className="mt-0.5 [overflow-wrap:anywhere] text-ink-1 tabular-nums">{fact.said}</dd>
          </div>
        ))}
        {row.rest && (
          <div className="min-w-0">
            <dd className="text-ink-3">{row.rest.text}</dd>
          </div>
        )}
      </dl>
    </>
  )
  return (
    <li
      data-row={index}
      className={cn(
        'flex items-start',
        !first && 'border-t border-line',
        line.inside && 'bg-surface-2/60 pl-6',
      )}
    >
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
          aria-label={line.open ? `Close ${row.lead.name}` : `Open ${row.lead.name}`}
          onClick={onTwist}
          className="grid size-11 shrink-0 place-items-center text-ink-3"
        >
          {line.open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
      )}
    </li>
  )
}

/** Nothing to list: busy, failed, empty or quiet, in the words it was given. */
function Nothing({
  state,
  onRetry,
}: {
  state: NonNullable<TableSaid['state']>
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
        {state.line}
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
      <b className="text-[13px] font-medium text-ink-1">{state.title}</b>
      {'said' in state ? (
        <span className="max-w-[300px] text-xs leading-[18px] break-words">{state.said}</span>
      ) : (
        state.line && <span className="max-w-[300px] text-xs leading-[18px]">{state.line}</span>
      )}
      {state.is === 'failed' && (
        <Button className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

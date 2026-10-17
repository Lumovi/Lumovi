/**
 * A list's columns as the person chooses them: which show, in what order, how wide, and a column
 * from a label or an annotation; and the list copied or saved as CSV. One menu for every list, as
 * every list is ResourceTable: a square button at the end of its toolbar (on a phone, beside the
 * filter), and the header's own menu. Kept per kind (or page) and per cluster.
 */
import { Check, Columns3, Download, GripVertical, Plus, X } from 'lucide-react'
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import type { KubeObject } from '@shared/api'
import { inPieces, shortInPieces } from '@shared/kit/characters'
import { Button } from '@renderer/components/Button'
import { ALT_KEY, Kbd } from '@renderer/components/Kbd'
import { Picker } from '@renderer/components/Picker'
import { barButton } from '@renderer/components/Sheet'
import { Tooltip } from '@renderer/components/Tooltip'
import { cn } from '@renderer/lib/cn'
import { csvName, toTabs } from '@renderer/lib/csv'
import { saveCsv } from '@renderer/lib/save-csv'
import { useLayout } from '@renderer/lib/layout'
import { MiddleCut } from '@renderer/kit/MiddleCut'
import { Pieces, TheirText } from '@renderer/plugins/TheirText'
import { useCluster } from '@renderer/state/cluster'
import { usePrefs } from '@renderer/state/prefs'
import { toast } from '@renderer/state/toasts'
import {
  ADDED_WIDTH,
  addedId,
  addedValue,
  ALWAYS_SHOWN,
  columnRows,
  moved,
  shownColumns,
  sized,
  toggled,
  withAdded,
  withoutAdded,
  type AddedColumn,
  type ColumnChoices,
  type ColumnRow,
} from './column-choices'
import { TheirCell, type CellContext, type Column } from './columns'
import { csvTable, shownTable } from './export'
import { squareButton } from './ListToolbar'

/** What a list's table is told of the person's choices, and does with their hands on its header. */
export interface TableLayout {
  /** Whether anything is chosen: the columns then give way in the person's order, last first. */
  chosen: boolean
  hide: (id: string) => void
  openMenu: () => void
  /** Sizes a column; no width gives it its own back. */
  size: (id: string, width: number | undefined) => void
  /** Which shown columns the list's width doesn't hold. */
  unfit: (ids: string[]) => void
}

export interface ListColumns {
  /** The columns the list shows, as chosen. */
  columns: Column[]
  layout: TableLayout
  /**
   * The toolbar's button, and the menu it opens; `rows` are what the filters and the namespace
   * pick let through, in the list's order: what a CSV holds.
   */
  button: (rows: readonly KubeObject[]) => ReactNode
  /** Copies objects' rows as the list shows them. */
  copy: (objects: readonly KubeObject[]) => void
}

/** A label Lumovi leaves off a listed object already; never offered, should one come. */
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration'
/** How many keys a group of suggestions offers. */
const SUGGESTED = 8

const none = <span className="truncate text-ink-3">—</span>

/** As much of a value as its tooltip shows: an annotation can be a page long. */
const TIP_MOST = 280
const TIP_LINES = 6

/** A value in a tooltip, in pieces: its start, on a few lines, and an ellipsis where it goes on. */
function tipOf(value: string) {
  const all = Array.from(value)
  const pieces = shortInPieces(all.slice(0, TIP_MOST).join(''), TIP_MOST, TIP_LINES)
  return all.length > TIP_MOST ? [...pieces, '…'] : pieces
}

/**
 * A label's or an annotation's column: its value in mono, cut at its end, the dash without. Its
 * key and its values are the cluster's, so they're drawn in pieces, tooltips too.
 */
function addedColumn(added: AddedColumn, header: string): Column {
  const value = (object: KubeObject) => addedValue(object, added)
  return {
    id: addedId(added),
    header,
    headerTheirs: true,
    headerTip: (
      <>
        {added.from === 'label' ? 'Label' : 'Annotation'} <TheirText text={added.key} inline />
      </>
    ),
    headerCut: header === added.key && header.includes('/') ? 'middle' : undefined,
    width: `${ADDED_WIDTH}px`,
    cell: (object) => {
      const shown = value(object)
      return shown === undefined ? (
        none
      ) : (
        <Tooltip content={<TheirText pieces={tipOf(shown)} lines />}>
          <span className="flex min-w-0">
            <TheirCell text={shown} className="font-mono text-xs text-ink-2" />
          </span>
        </Tooltip>
      )
    },
    fact: (object) => {
      const shown = value(object)
      return shown === undefined ? undefined : (
        <span className="font-mono">
          <TheirText text={shown} inline />
        </span>
      )
    },
    text: (object) => value(object) ?? '—',
    csv: { header: added.key, value },
    sort: (object) => value(object) ?? '',
  }
}

/**
 * A list's columns as chosen, its Columns button, and what copies and saves it. `count` says how
 * many of the list's objects there are ("41 pods", "1 pod"); `title` is its own plural, as its
 * page is titled ("Pods").
 */
export function useListColumns({
  list,
  columns,
  listed,
  ctx,
  title,
  count,
  namespaced,
  labelled = true,
}: {
  /** Which list: a kind, or a page's own ("workloads"). */
  list: string
  columns: Column[]
  /** Every object the list holds now: the keys offered are theirs. */
  listed: readonly KubeObject[]
  ctx: CellContext
  title: string
  count: (n: number) => string
  /** Whether its objects are in namespaces: a file's name has the one picked. */
  namespaced: boolean
  /** Whether its objects carry labels and annotations to make columns of (a Helm release doesn't). */
  labelled?: boolean
}): ListColumns {
  const { context, namespace } = useCluster()
  const key = `${context}/${list}`
  const choices = usePrefs((prefs) => prefs.columns[key])
  const setColumns = usePrefs((prefs) => prefs.setColumns)
  const choose = (next: ColumnChoices | undefined) => setColumns(key, next)
  const [open, setOpen] = useState(false)
  const [unfit, setUnfit] = useState<string[]>([])
  const all = columnRows(columns, choices, addedColumn)
  const shown = shownColumns(all, choices)
  // (A list keeps one column at least: one without names, an event's, could lose them all.)
  const hide = (id: string) => {
    if (shown.length > 1 || !shown.some((column) => column.id === id)) choose(toggled(choices, id))
  }

  const copy = (objects: readonly KubeObject[]) => {
    const { header, rows: lines } = shownTable(shown, objects, ctx)
    void navigator.clipboard.writeText(toTabs(header, lines)).then(() =>
      toast({
        tone: 'success',
        title: `Copied ${objects.length} ${objects.length === 1 ? 'row' : 'rows'}`,
      }),
    )
  }

  const download = async (rows: readonly KubeObject[]) => {
    const { header, rows: lines } = csvTable(shown, rows, ctx)
    const plural = count(2).replace(/^\S+ /, '')
    const where = namespaced && namespace ? namespace : context
    await saveCsv(csvName(plural, where, new Date()), header, lines)
  }

  return {
    columns: shown,
    layout: {
      chosen: choices !== undefined,
      hide,
      openMenu: () => setOpen(true),
      size: (id, width) => choose(sized(choices, id, width)),
      unfit: (ids) => setUnfit((was) => (was.join('\n') === ids.join('\n') ? was : ids)),
    },
    copy,
    button: (rows) => (
      <ColumnsButton
        open={open}
        onOpenChange={setOpen}
        rows={all}
        choices={choices}
        onChoose={choose}
        onToggle={hide}
        unfit={unfit}
        listed={listed}
        title={title}
        count={count}
        labelled={labelled}
        onDownload={() => void download(rows)}
      />
    ),
  }
}

function ColumnsButton({
  open,
  onOpenChange,
  rows,
  choices,
  onChoose,
  onToggle,
  unfit,
  listed,
  title,
  count,
  labelled,
  onDownload,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: ColumnRow[]
  choices: ColumnChoices | undefined
  onChoose: (choices: ColumnChoices | undefined) => void
  /** Shows a column, or hides it (not the last one shown). */
  onToggle: (id: string) => void
  unfit: string[]
  listed: readonly KubeObject[]
  title: string
  count: (n: number) => string
  labelled: boolean
  onDownload: () => void
}) {
  const phone = useLayout() === 'phone'
  const first = useRef<HTMLButtonElement>(null)
  // (Nothing is sized on a phone, so nothing there doesn't fit.)
  const left = phone
    ? []
    : unfit.filter((id) => rows.some((row) => row.shown && row.column.id === id))
  const reset = (
    <Tooltip content={`Show Lumovi’s columns for ${title} in this cluster again`}>
      <button
        type="button"
        disabled={choices === undefined}
        onClick={() => onChoose(undefined)}
        className={
          phone
            ? 'h-11 px-3 text-[15px] font-semibold text-accent disabled:opacity-45'
            : 'ml-auto grid h-7 place-items-center rounded-md px-2 text-[13px] font-medium text-ink-2 hover:bg-surface-3 hover:text-ink-1 disabled:opacity-45 disabled:hover:bg-transparent'
        }
      >
        Reset
      </button>
    </Tooltip>
  )
  return (
    <Picker
      open={open}
      onOpenChange={onOpenChange}
      title="Columns"
      align="end"
      className="w-[360px] p-0"
      tooltip={
        left.length > 0
          ? `Columns: ${left.length} ${left.length === 1 ? 'doesn’t' : 'don’t'} fit at this width`
          : 'Columns'
      }
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        first.current?.focus()
      }}
      sheetHeader={
        <div className="flex h-11 shrink-0 items-center gap-1 px-1">
          <button
            type="button"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
            className={barButton}
          >
            <X />
          </button>
          {/* (The sheet's title, for a screen reader, is the picker's own: this is its look.) */}
          <span
            aria-hidden
            className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink-1"
          >
            Columns
          </span>
          {reset}
        </div>
      }
      trigger={
        <button
          type="button"
          aria-label="Columns"
          className={
            phone
              ? squareButton
              : 'relative grid size-8 shrink-0 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink-1 data-[state=open]:bg-surface-3 data-[state=open]:text-ink-1 touch:size-11 [&_svg]:size-4'
          }
        >
          <Columns3 />
          {left.length > 0 && (
            <span
              aria-hidden
              className="absolute -top-1 -right-1.5 h-4 min-w-4 rounded-full bg-surface-3 px-1 text-center text-[10.5px] leading-4 font-semibold text-ink-1 tabular-nums shadow-[0_0_0_2px_var(--surface)]"
            >
              {left.length}
            </span>
          )}
        </button>
      }
    >
      {!phone && (
        <div className="flex h-10 items-center border-b border-line pr-2 pl-3 text-[13px] font-semibold text-ink-1">
          Columns
          {reset}
        </div>
      )}
      <ColumnList
        rows={rows}
        unfit={left}
        first={first}
        onToggle={onToggle}
        onMove={(id, to) => onChoose(moved(choices, rows, id, to))}
        onRemove={(id) => onChoose(withoutAdded(choices, id))}
      />
      {labelled && (
        <AddKey
          listed={listed}
          added={rows.flatMap((row) => (row.added ? [row.added] : []))}
          count={count}
          onAdd={(added) => onChoose(withAdded(choices, added))}
        />
      )}
      {phone ? (
        <div className="flex border-t border-line px-4 pt-2 pb-4">
          <Button onClick={onDownload} className="h-11 flex-1 text-[15px]">
            <Download className="!size-4" />
            Download CSV
          </Button>
        </div>
      ) : (
        // (The keys on one line, Download CSV on its own under them at the right: it fits at any
        // width, in any words.)
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line py-2 pr-2 pl-3 text-[11.5px] whitespace-nowrap text-ink-3">
          <span className="flex items-center gap-1">
            <Kbd>Space</Kbd>show or hide
          </span>
          <span className="flex items-center gap-1">
            <Kbd>{ALT_KEY}↑</Kbd>
            <Kbd>{ALT_KEY}↓</Kbd>move
          </span>
          <span aria-hidden className="h-0 basis-full" />
          <Button onClick={onDownload} className="ml-auto h-7 px-2.5 text-[12.5px]">
            <Download className="!size-3.5" />
            Download CSV
          </Button>
        </div>
      )}
    </Picker>
  )
}

/**
 * The columns in the list's order, a box to show or hide each and a handle to move it (the whole
 * row, where there's a pointer; the handle, under a finger): the name first, always shown, and
 * nothing above it.
 */
function ColumnList({
  rows,
  unfit,
  first,
  onToggle,
  onMove,
  onRemove,
}: {
  rows: ColumnRow[]
  unfit: string[]
  first: RefObject<HTMLButtonElement | null>
  onToggle: (id: string) => void
  /** To a place among the rows, the moved one taken out. */
  onMove: (id: string, to: number) => void
  onRemove: (id: string) => void
}) {
  const phone = useLayout() === 'phone'
  const boxes = useRef(new Map<string, HTMLButtonElement>())
  const items = useRef<HTMLUListElement>(null)
  const [current, setCurrent] = useState<string>()
  const [drag, setDrag] = useState<{ id: string; to: number }>()
  const pressed = useRef<{ id: string; y: number; pointer: number } | undefined>(undefined)
  // A row let go of after a drag isn't also clicked.
  const dragged = useRef(false)
  const floor = rows[0]?.column.id === ALWAYS_SHOWN ? 1 : 0
  const ids = rows.map((row) => row.column.id)
  // A row moved is drawn again in its new place, which takes its focus: it's given back then.
  const refocus = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    if (refocus.current === undefined) return
    boxes.current.get(refocus.current)?.focus()
    refocus.current = undefined
  })
  const focus = (id: string | undefined) => {
    if (id === undefined) return
    setCurrent(id)
    refocus.current = id
    boxes.current.get(id)?.focus()
  }

  const keys = (event: KeyboardEvent, row: ColumnRow, index: number) => {
    const id = row.column.id
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step !== 0) {
      event.preventDefault()
      if (event.altKey) {
        if (index >= floor && index + step >= floor) {
          onMove(id, index + step)
          focus(id)
        }
      } else focus(ids[Math.max(0, Math.min(ids.length - 1, index + step))])
    } else if ((event.key === 'Backspace' || event.key === 'Delete') && row.added) {
      event.preventDefault()
      onRemove(id)
      focus(ids[index + 1] ?? ids[index - 1])
    }
  }

  /** Where a row dragged to `y` lands: its place among the others. */
  const landing = (id: string, y: number) => {
    const others = [
      ...(items.current?.querySelectorAll<HTMLElement>('[data-column]') ?? []),
    ].filter((each) => each.dataset.column !== id)
    const above = others.filter((each) => {
      const box = each.getBoundingClientRect()
      return box.top + box.height / 2 < y
    }).length
    return Math.max(floor, above)
  }
  const down = (event: PointerEvent, row: ColumnRow, fromHandle: boolean) => {
    if (event.button !== 0 || row.column.id === ALWAYS_SHOWN || (phone && !fromHandle)) return
    pressed.current = { id: row.column.id, y: event.clientY, pointer: event.pointerId }
  }
  const move = (event: PointerEvent) => {
    const press = pressed.current
    if (!press || press.pointer !== event.pointerId) return
    if (!drag && Math.abs(event.clientY - press.y) < 4) return
    if (!drag) items.current?.setPointerCapture(event.pointerId)
    setDrag({ id: press.id, to: landing(press.id, event.clientY) })
  }
  const up = () => {
    if (drag) {
      onMove(drag.id, drag.to)
      dragged.current = true
      requestAnimationFrame(() => (dragged.current = false))
    }
    pressed.current = undefined
    setDrag(undefined)
  }

  let place = 0
  const line = <li aria-hidden className="mx-2 -my-px h-0.5 rounded-full bg-accent" />
  return (
    <ul
      ref={items}
      aria-label="Columns"
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      className={cn('max-h-[50vh] overflow-y-auto p-1', phone && 'max-h-none px-2')}
    >
      {rows.map((row, index) => {
        const id = row.column.id
        const named = id === ALWAYS_SHOWN
        const lifted = drag?.id === id
        const before = drag && !lifted && place++ === drag.to ? line : null
        // (An added key is cut in its middle, as its heading is: its end tells keys apart.)
        const label = row.added ? (
          <MiddleCut text={{ their: row.added.key }} className="min-w-0" />
        ) : row.column.headerTheirs ? (
          <TheirText text={row.column.header} inline />
        ) : (
          row.column.header
        )
        return [
          before,
          <li
            key={id}
            data-column={id}
            onPointerDown={(event) => down(event, row, false)}
            className={cn(
              'flex min-w-0 items-center gap-2 rounded-md pr-1.5 pl-0.5',
              phone ? 'h-11 text-[15px]' : 'h-8 text-[13px]',
              lifted && 'bg-surface shadow-pop outline outline-line-strong',
              !named && !phone && 'cursor-grab',
            )}
          >
            <span
              aria-hidden
              onPointerDown={(event) => {
                event.stopPropagation()
                down(event, row, true)
              }}
              className={cn(
                'grid shrink-0 place-items-center text-ink-3',
                phone ? 'size-11 touch-none' : 'w-5',
                named && 'invisible',
              )}
            >
              <GripVertical className="size-3.5" />
            </span>
            <button
              ref={(box) => {
                if (box) boxes.current.set(id, box)
                else boxes.current.delete(id)
                if (index === 0) first.current = box
              }}
              type="button"
              role="checkbox"
              aria-checked={row.shown}
              aria-disabled={named || undefined}
              tabIndex={(current ?? ids[0]) === id ? 0 : -1}
              onFocus={() => setCurrent(id)}
              onKeyDown={(event) => keys(event, row, index)}
              onClick={() => {
                if (!named && !dragged.current) onToggle(id)
              }}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md px-1 text-left outline-none focus-visible:bg-surface-3',
                phone && 'gap-3',
              )}
            >
              <span
                className={cn(
                  'grid shrink-0 place-items-center',
                  // (A finger's target is 44 px; the box in it is the same 16.)
                  phone && '-ml-1 size-11',
                )}
              >
                <span
                  className={cn(
                    'grid size-4 place-items-center rounded border',
                    row.shown
                      ? 'border-accent bg-accent text-on-accent'
                      : 'border-line-strong bg-surface',
                    named && 'opacity-45',
                  )}
                >
                  {row.shown && <Check className="size-3" strokeWidth={3} />}
                </span>
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1',
                  row.added ? 'flex font-mono text-xs' : 'truncate',
                  !row.shown && 'text-ink-3',
                )}
              >
                {label}
              </span>
              {row.shown && unfit.includes(id) && (
                <span className="shrink-0 text-[11.5px] text-ink-3">doesn’t fit</span>
              )}
              {row.added && (
                <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[11px] leading-[18px] text-ink-2">
                  {row.added.from}
                </span>
              )}
            </button>
            {row.added && (
              <Tooltip content="Remove this column">
                <button
                  type="button"
                  aria-label="Remove this column"
                  tabIndex={-1}
                  onClick={() => onRemove(id)}
                  className={cn(
                    'grid shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink-1',
                    phone ? 'size-11' : 'size-6',
                  )}
                >
                  <X className="size-3.5" />
                </button>
              </Tooltip>
            )}
          </li>,
        ]
      })}
      {drag && place === drag.to && line}
    </ul>
  )
}

/** What the listed objects carry, by key: how many of them have each label and annotation. */
function keysOf(listed: readonly KubeObject[]) {
  const labels = new Map<string, number>()
  const annotations = new Map<string, number>()
  for (const object of listed) {
    for (const key of Object.keys(object.metadata.labels ?? {})) {
      labels.set(key, (labels.get(key) ?? 0) + 1)
    }
    for (const key of Object.keys(object.metadata.annotations ?? {})) {
      if (key !== LAST_APPLIED) annotations.set(key, (annotations.get(key) ?? 0) + 1)
    }
  }
  return { label: labels, annotation: annotations }
}

/** An offer of the add field: a key the objects have, or one none has yet. */
interface Offer extends AddedColumn {
  /** How many of them have it; none, for a key typed that none has. */
  on?: number
}

/**
 * The menu's last row: a key typed, and the keys the listed objects have that it matches, labels
 * then annotations, the most common first; one none has can still be added, either way. Enter
 * adds the one under the keyboard, and the field stays for another.
 */
function AddKey({
  listed,
  added,
  count,
  onAdd,
}: {
  listed: readonly KubeObject[]
  added: AddedColumn[]
  count: (n: number) => string
  onAdd: (added: AddedColumn) => void
}) {
  const phone = useLayout() === 'phone'
  const id = useId()
  const [typed, setTyped] = useState('')
  const [active, setActive] = useState(0)
  const keys = useMemo(() => keysOf(listed), [listed])
  const sought = typed.trim()
  const matches = (from: AddedColumn['from']): Offer[] =>
    [...keys[from]]
      .filter(
        ([key]) =>
          key.toLowerCase().includes(sought.toLowerCase()) &&
          !added.some((each) => each.from === from && each.key === key),
      )
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .slice(0, SUGGESTED)
      .map(([key, on]) => ({ from, key, on }))
  const groups = sought
    ? ([
        ['Labels', matches('label')],
        ['Annotations', matches('annotation')],
      ] as const)
    : []
  const found = groups.flatMap(([, offers]) => offers)
  // A key has no spaces: one typed with them isn't offered.
  const unknown = sought !== '' && found.length === 0 && !/\s/.test(sought)
  const offers: Offer[] = unknown
    ? [
        { from: 'label', key: sought },
        { from: 'annotation', key: sought },
      ]
    : found
  const at = Math.min(active, offers.length - 1)
  const add = (offer: Offer) => {
    onAdd({ from: offer.from, key: offer.key })
    setTyped('')
    setActive(0)
  }
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (offers.length === 0) return
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((at + step + offers.length) % offers.length)
    } else if (event.key === 'Enter' && offers[at]) {
      event.preventDefault()
      add(offers[at])
    }
  }
  const optionId = (index: number) => `${id}-${index}`
  const option = (offer: Offer, index: number, words: ReactNode) => (
    <li
      key={`${offer.from}:${offer.key}`}
      id={optionId(index)}
      role="option"
      aria-selected={index === at}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => add(offer)}
      onPointerMove={() => setActive(index)}
      className={cn(
        'flex min-w-0 cursor-default items-center gap-2 rounded-md px-2',
        phone ? 'h-11 text-[15px]' : 'h-8 text-[13px]',
        index === at && 'bg-surface-3',
      )}
    >
      {words}
    </li>
  )
  /** A key the objects have, in pieces, what was typed of it bold: one text, its parts in it. */
  const marked = (key: string) => {
    const from = key.toLowerCase().indexOf(sought.toLowerCase())
    const part = (text: string) => <Pieces pieces={inPieces(text)} oneLine />
    return (
      <bdi dir="auto" className="text-left">
        {part(key.slice(0, from))}
        <b className="font-semibold text-ink-1">{part(key.slice(from, from + sought.length))}</b>
        {part(key.slice(from + sought.length))}
      </bdi>
    )
  }
  const n = listed.length
  const things = count(n).replace(/^\S+ /, '')
  let index = 0
  return (
    <div className="border-t border-line">
      <label
        className={cn(
          'm-1 flex items-center gap-2 rounded-lg border border-line px-2.5 text-ink-3 focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft',
          phone ? 'mx-4 my-2 h-11' : 'h-9',
        )}
      >
        <Plus className="size-3.5 shrink-0" />
        <input
          role="combobox"
          aria-label="Label or annotation key for a new column"
          aria-expanded={offers.length > 0}
          aria-controls={`${id}-offers`}
          aria-activedescendant={offers.length > 0 ? optionId(at) : undefined}
          aria-autocomplete="list"
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value)
            setActive(0)
          }}
          onKeyDown={keyDown}
          placeholder="Label or annotation key"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className={cn(
            'min-w-0 flex-1 bg-transparent text-ink-1 outline-none placeholder:text-ink-3',
            phone ? 'text-[15px]' : 'text-[13px]',
            sought && 'font-mono text-xs',
          )}
        />
      </label>
      {offers.length > 0 && (
        <ul id={`${id}-offers`} role="listbox" aria-label="Keys" className="px-1 pb-1">
          {unknown
            ? offers.map((offer, i) =>
                option(
                  offer,
                  i,
                  <span className="min-w-0 flex-1 truncate">
                    Add {offer.from} “<TheirText text={offer.key} inline />”
                  </span>,
                ),
              )
            : groups.map(
                ([name, group]) =>
                  group.length > 0 && (
                    <li key={name} role="presentation">
                      <ul role="group" aria-label={name}>
                        <li
                          role="presentation"
                          className="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wider text-ink-3 uppercase"
                        >
                          {name}
                        </li>
                        {group.map((offer) =>
                          option(
                            offer,
                            index++,
                            <>
                              <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2">
                                {marked(offer.key)}
                              </span>
                              <small className="shrink-0 text-[11.5px] text-ink-3 tabular-nums">
                                on {offer.on} of {n}
                              </small>
                            </>,
                          ),
                        )}
                      </ul>
                    </li>
                  ),
              )}
        </ul>
      )}
      {unknown && (
        <p className="px-3 pt-1 pb-2 text-xs text-ink-3">
          {n === 0
            ? `No ${things} are listed here yet, so the column will be empty until some are.`
            : n === 1
              ? `The one ${things} listed doesn’t have it yet.`
              : `None of the ${count(n)} has it yet.`}
        </p>
      )}
    </div>
  )
}

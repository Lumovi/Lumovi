import { ArrowDown, ArrowUp, ArrowUpDown, Check, Gauge, Tag } from 'lucide-react'
import { Button } from '@renderer/components/Button'
import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react'
import { Picker } from '@renderer/components/Picker'
import { SearchInput } from '@renderer/components/SearchInput'
import { Sheet } from '@renderer/components/Sheet'
import { HEALTH_STYLE } from '@renderer/components/Status'
import { Tooltip } from '@renderer/components/Tooltip'
import { cn } from '@renderer/lib/cn'
import { useLayout } from '@renderer/lib/layout'
import { HEALTH_RANK, type Health } from '@renderer/lib/health'
import type { Column } from './columns'

const HEALTH_ORDER = (Object.keys(HEALTH_RANK) as Health[]).sort(
  (a, b) => HEALTH_RANK[a] - HEALTH_RANK[b],
)

/** A filter chip per health level a list has, most urgent first, with how many are at it. */
export function HealthChips({
  counts,
  active,
  onToggle,
  name,
}: {
  counts: Map<Health, number>
  active: Health[]
  onToggle: (health: Health) => void
  /** What the level is called in this list ("Running", "Deployed"…). */
  name: (health: Health) => string
}) {
  return HEALTH_ORDER.filter((h) => counts.has(h)).map((health) => {
    const on = active.includes(health)
    return (
      <button
        key={health}
        type="button"
        aria-pressed={on}
        onClick={() => onToggle(health)}
        className={cn(
          'flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs whitespace-nowrap transition-colors touch:finger',
          on
            ? 'border-transparent bg-ink-1 text-surface'
            : 'border-line text-ink-2 hover:border-line-strong hover:text-ink-1',
        )}
      >
        <span aria-hidden className={cn('size-1.5 rounded-full', HEALTH_STYLE[health].dot)} />
        {name(health)}
        <span className="font-semibold tabular-nums">{counts.get(health)}</span>
      </button>
    )
  })
}

/** What a page asks of its list's label selector: to be typed in, wherever it is. */
export interface LabelSelectorHandle {
  focus: () => void
}

const selectorField =
  'min-w-0 flex-1 bg-transparent font-mono text-xs text-ink-1 outline-none placeholder:font-sans placeholder:text-[13px] placeholder:text-ink-3'

/**
 * A server-side label selector, applied with Enter. Where the bar has no room for the field
 * (`compact`), it's a button that opens the same field under it.
 */
export function LabelSelector({
  value,
  onApply,
  compact = false,
  ref,
}: {
  value: string
  onApply: (labels: string) => void
  compact?: boolean
  ref?: Ref<LabelSelectorHandle>
}) {
  const [draft, setDraft] = useState(value)
  const [open, setOpen] = useState(false)
  const phone = useLayout() === 'phone'
  const field = useRef<HTMLInputElement>(null)
  const frame = useRef<HTMLLabelElement>(null)
  const [roomy, setRoomy] = useState(true)
  useLayoutEffect(() => {
    if (!frame.current) return
    // The example goes when the field is too short to show it whole.
    const observer = new ResizeObserver(() => setRoomy(frame.current!.offsetWidth >= 220))
    observer.observe(frame.current)
    return () => observer.disconnect()
  }, [compact])
  useImperativeHandle(ref, () => ({
    focus: () => {
      if (!compact) return field.current?.focus()
      setDraft(value)
      setOpen(true)
    },
  }))
  if (!compact) {
    return (
      <label
        ref={frame}
        className={cn(
          'flex h-8 min-w-40 shrink basis-60 items-center gap-2 rounded-lg border bg-surface px-2.5 text-ink-3 transition-colors no-drag focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft touch:h-11',
          value ? 'border-accent/60' : 'border-line',
        )}
      >
        <Tag className="size-3.5 shrink-0" />
        <input
          ref={field}
          aria-label="Label selector"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onApply(draft.trim())
          }}
          onBlur={() => setDraft(value)}
          placeholder={roomy ? 'Label selector, e.g. app=web' : 'Label selector'}
          spellCheck={false}
          className={selectorField}
        />
      </label>
    )
  }
  // What's applied can't be read off a button, so its name and tooltip say it.
  const name = value ? `Label selector: ${value}` : 'Label selector'
  return (
    <Picker
      open={open}
      onOpenChange={(next) => {
        // Opened afresh each time: what was typed and not applied is gone, as on leaving the field.
        setDraft(value)
        setOpen(next)
      }}
      title="Label selector"
      tooltip={name}
      className="w-72 p-2"
      collisionPadding={8}
      // The field is typed in at once, over what's applied.
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        field.current?.select()
      }}
      trigger={
        <button
          type="button"
          aria-label={name}
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-lg border bg-surface transition-colors no-drag hover:text-ink-1 focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent-soft focus-visible:outline-none data-[state=open]:border-accent data-[state=open]:ring-3 data-[state=open]:ring-accent-soft touch:size-11 touch:[&_svg]:size-4',
            value ? 'border-accent/60 text-accent-strong' : 'border-line text-ink-3',
          )}
        >
          <Tag className="size-3.5" />
        </button>
      }
    >
      <div className="phone:px-4 phone:pb-4">
        <input
          ref={field}
          aria-label="Label selector"
          autoFocus={phone}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter applies it (nothing typed clears it); Tab leaves it as it was.
            if (event.key === 'Enter') onApply(draft.trim())
            else if (event.key === 'Tab' && !phone) setDraft(value)
            else return
            event.preventDefault()
            setOpen(false)
          }}
          placeholder="app=web"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          enterKeyHint="done"
          className="h-8 w-full rounded-lg border border-line bg-surface px-2.5 font-mono text-xs text-ink-1 outline-none placeholder:text-ink-3 focus:border-accent focus:ring-3 focus:ring-accent-soft phone:h-11 phone:px-3"
        />
        {phone ? (
          <>
            <p className="pt-3 text-xs leading-relaxed text-ink-3">
              Only what carries these labels is listed, as kubectl’s -l does:{' '}
              <span className="font-mono">app=web,tier!=cache</span>.
            </p>
            <div className="flex items-center justify-between pt-3">
              <Button
                variant="ghost"
                className="-ml-4 h-11 px-4"
                disabled={!value}
                onClick={() => {
                  onApply('')
                  setOpen(false)
                }}
              >
                Clear
              </Button>
              <Button
                variant="primary"
                className="h-11 min-w-[120px] px-4"
                onClick={() => {
                  onApply(draft.trim())
                  setOpen(false)
                }}
              >
                Apply
              </Button>
            </div>
          </>
        ) : (
          <p className="px-0.5 pt-2 text-xs text-ink-3">Enter applies it.</p>
        )}
      </div>
    </Picker>
  )
}

/** Under these widths of bar (inside its padding) it gives way: see `ListBar`. */
const BAR = { narrow: 480, compact: 720 }
const GAP = 8
/** The least the label selector's field, its button and the filter take. */
const LEAST = { selector: 160, button: 32, filter: 128 }

/**
 * The bar over a list: how many there are, a chip per health level, then to the right what the
 * page adds (`before`, which never gives way), a note, the label selector and the filter. Its
 * fields keep to one row. As it narrows they give way first, from 240 px each;
 * under 480 px (720 where there are chips) the label selector is a button; and the chips, which
 * never shrink, take a row of their own under the first whenever it can't hold them beside
 * everything else at its least, and wrap there.
 *
 * (That is measured: wrapping alone would send the fields under the chips, not the chips under
 * the fields.)
 */
export function ListBar({
  count,
  chips,
  before,
  note,
  labels,
  onLabels,
  labelsRef,
  filter,
  noun,
  onFilter,
  onArrowDown,
}: {
  count: string
  /** The health chips, when the list has any. */
  chips?: ReactNode
  before?: ReactNode
  /** Said in full while there's room; then an icon with it as its tooltip. */
  note?: string
  /** The label selector applied, for lists that take one. */
  labels?: string
  onLabels?: (labels: string) => void
  labelsRef?: Ref<LabelSelectorHandle>
  filter: string
  /** What the filter filters: "Filter pods". */
  noun: string
  onFilter: (q: string) => void
  onArrowDown: () => void
}) {
  const bar = useRef<HTMLDivElement>(null)
  const counted = useRef<HTMLSpanElement>(null)
  const chipRow = useRef<HTMLDivElement>(null)
  const extras = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState(Infinity)
  const [stacked, setStacked] = useState(false)
  const compact = onLabels !== undefined && width < (chips ? BAR.compact : BAR.narrow)

  useLayoutEffect(() => {
    const measure = () => {
      const style = getComputedStyle(bar.current!)
      setWidth(
        bar.current!.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(bar.current!)
    return () => observer.disconnect()
  }, [])
  // Whether the first row holds the chips whole, beside everything else at its least.
  useLayoutEffect(() => {
    if (!chipRow.current) return setStacked(false)
    const each = [...chipRow.current.children].map((chip) => (chip as HTMLElement).offsetWidth)
    const parts = [
      counted.current!.offsetWidth + 4,
      each.reduce((sum, w) => sum + w, 0) + GAP * Math.max(0, each.length - 1),
      ...(extras.current ? [extras.current.offsetWidth] : []),
      ...(onLabels ? [compact ? LEAST.button : LEAST.selector] : []),
      LEAST.filter,
    ]
    const least = parts.reduce((sum, w) => sum + w, 0) + GAP * (parts.length - 1)
    setStacked(least > width)
  }, [width, compact, chips, count, before, note, onLabels])

  const chipped = chips ? (
    <div ref={chipRow} className={cn('flex gap-2', stacked ? 'flex-wrap' : 'shrink-0')}>
      {chips}
    </div>
  ) : null
  return (
    <div
      ref={bar}
      role="group"
      aria-label="Filters"
      className="flex shrink-0 flex-col gap-2 border-b border-line px-5 py-3 touch:gap-4"
    >
      <div className="flex items-center gap-2">
        <span
          ref={counted}
          className="mr-1 shrink-0 text-[13px] whitespace-nowrap text-ink-2 tabular-nums"
        >
          {count}
        </span>
        {!stacked && chipped}
        <div className="flex-1" />
        {(before || note) && (
          <span ref={extras} className="flex shrink-0 items-center gap-2">
            {before}
            {note &&
              (width < BAR.compact ? (
                <Tooltip content={note}>
                  <span
                    role="img"
                    aria-label={note}
                    tabIndex={0}
                    className="grid size-8 place-items-center rounded-lg text-ink-3 outline-none focus-visible:ring-3 focus-visible:ring-accent-soft"
                  >
                    <Gauge className="size-3.5" />
                  </span>
                </Tooltip>
              ) : (
                <span className="flex items-center gap-1.5 text-xs whitespace-nowrap text-ink-3">
                  <Gauge className="size-3.5" /> {note}
                </span>
              ))}
          </span>
        )}
        {onLabels && (
          <LabelSelector
            ref={labelsRef}
            value={labels ?? ''}
            onApply={onLabels}
            compact={compact}
          />
        )}
        <SearchInput
          value={filter}
          onChange={onFilter}
          onArrowDown={onArrowDown}
          placeholder={width < BAR.narrow ? 'Filter' : `Filter ${noun}`}
          hint={width >= BAR.narrow}
          className="min-w-32 shrink basis-60"
        />
      </div>
      {stacked && chipped}
    </div>
  )
}

/** A square button beside a phone's filter field: 44 px each way. */
const squareButton =
  'grid size-11 shrink-0 place-items-center rounded-lg border border-line-strong bg-surface-2 text-ink-2 shadow-xs outline-offset-[-2px] [&_svg]:size-4'

/**
 * What a phone's list is sorted by: a button beside the filter field, and a sheet of the
 * columns it can be sorted by. The one it's sorted by says which way; choosing it again turns
 * it around.
 */
export function SortButton({
  columns,
  sort,
  onSort,
}: {
  columns: Column[]
  sort: { id: string; desc: boolean }
  onSort: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const sortable = columns.filter((column) => column.sort)
  if (sortable.length === 0) return null
  const current = sortable.find((column) => column.id === sort.id)
  return (
    <>
      <button
        type="button"
        aria-label={current ? `Sort: by ${current.header.toLowerCase()}` : 'Sort'}
        onClick={() => setOpen(true)}
        className={squareButton}
      >
        <ArrowUpDown />
      </button>
      {open && (
        <Sheet title="Sort by" onClose={() => setOpen(false)}>
          <ul role="listbox" aria-label="Sort by" className="px-2 pb-3">
            {sortable.map((column) => {
              const chosen = column.id === sort.id
              const Direction = sort.desc ? ArrowDown : ArrowUp
              return (
                <li key={column.id} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={chosen}
                    onClick={() => {
                      onSort(column.id)
                      // Chosen again, it turns around, and stays to be seen; another closes it.
                      if (!chosen) setOpen(false)
                    }}
                    className="flex h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-ink-1 outline-offset-[-2px] active:bg-surface-3"
                  >
                    <span className="flex-1">{column.header}</span>
                    {chosen && (
                      <>
                        <span className="flex items-center gap-1 text-xs text-ink-3">
                          <Direction className="size-3.5" />
                          {sortWords(column, sort.desc)}
                        </span>
                        <Check className="size-4 text-accent" />
                      </>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </Sheet>
      )}
    </>
  )
}

/** Which way a column is sorted, in its own words: a status's worst first, a name's A to Z. */
function sortWords(column: Column, desc: boolean): string {
  if (column.id === 'status') return desc ? 'Best first' : 'Worst first'
  if (column.id === 'name') return desc ? 'Z to A' : 'A to Z'
  if (column.id === 'age' || column.id === 'lastSeen') return desc ? 'Oldest first' : 'Newest first'
  return desc ? 'Most first' : 'Least first'
}

/** Counts items by a key of theirs (a health level, a namespace…). */
export function countBy<T, K>(items: T[], key: (item: T) => K): Map<K, number> {
  const counts = new Map<K, number>()
  for (const item of items) {
    const k = key(item)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return counts
}

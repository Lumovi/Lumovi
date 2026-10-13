/**
 * A list that one thing is always picked from: a Table's lead with a status at its right, in a
 * card that says what's listed and how many. The keys move an active row and Enter or Space
 * picks it (picking is this list's whole act); past twelve rows it scrolls, with a filter above.
 * On a phone it's the page: full width, nothing picked, and a tap opens what it lists.
 */
import { SearchX } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Health } from '@shared/health'
import { spelled } from '@shared/kit/characters'
import { PICKS_BEFORE_FILTER, type Pick, type PickList as PickListSaid } from '@shared/kit/page'
import { SearchInput } from '@renderer/components/SearchInput'
import { EmptyState } from '@renderer/components/States'
import { cn } from '@renderer/lib/cn'
import { useLayout } from '@renderer/lib/layout'
import { TheirText } from '@renderer/plugins/TheirText'
import { CARD, Lead } from './Lead'
import { keyOf, Nothing, Pill } from './Table'

/** How bad a level is, worst first: how the rows stand unless they're to stand as given. */
const WORST_FIRST: Health[] = ['critical', 'warning', 'progressing', 'neutral', 'healthy']
/** A row, and the gap under it. */
const ROW = 52
const GAP = 2

/** The rows as they stand: the worst first (and otherwise as given), unless said. */
export function standing(list: PickListSaid): Pick[] {
  const given = list.rows
  if (list.asGiven) return given
  const rank = (row: Pick) => {
    const at = row.status?.level ? WORST_FIRST.indexOf(row.status.level) : -1
    return at < 0 ? WORST_FIRST.length : at
  }
  return given
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    .map(({ row }) => row)
}

export function PickList({
  list,
  picked,
  onPick,
}: {
  list: PickListSaid
  /** The picked row's key; none on a phone, where the list is the page. */
  picked?: string
  onPick: (key: string) => void
}) {
  const id = useId()
  const phone = useLayout() === 'phone'
  const scroll = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState('')
  const [activeKey, setActiveKey] = useState<string>()
  const rows = useMemo(() => standing(list), [list])
  const needle = filter.trim().toLowerCase()
  const shown = useMemo(
    () =>
      needle
        ? rows.filter((row) =>
            [row.lead?.name, row.lead?.beside, row.lead?.under]
              .map((text) => text?.their ?? '')
              .join(' ')
              .toLowerCase()
              .includes(needle),
          )
        : rows,
    [rows, needle],
  )
  const filtered = rows.length > PICKS_BEFORE_FILTER
  // The plugin's title, as a screen reader and a field's placeholder say it: spelled.
  const named = spelled(list.title.their)
  const noun = named.toLowerCase()

  // The picked row is kept in view, as rows come and go around it.
  useEffect(() => {
    if (picked === undefined) return
    scroll.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [picked, shown])

  const find = (
    <SearchInput
      value={filter}
      onChange={setFilter}
      onArrowDown={() => scroll.current?.focus()}
      placeholder={`Filter ${noun}`}
      hint={false}
      className={cn('mx-4 mb-2', phone && 'mx-0 mb-0 h-11')}
    />
  )
  const nothing =
    rows.length === 0 || list.state ? (
      <Nothing
        state={list.state ?? { is: 'empty', title: `No ${noun}` }}
        onRetry={() => undefined}
      />
    ) : shown.length === 0 ? (
      <EmptyState icon={SearchX} title="Nothing matches">
        No {noun} match “{filter.trim()}”.
      </EmptyState>
    ) : undefined

  if (phone) {
    return (
      <section aria-label={named} className="min-w-0">
        {/* How many, in a line of its own: the top bar has the page's name. */}
        <p className="pb-2.5 text-[13px] text-ink-2 tabular-nums">
          {rows.length.toLocaleString('en-US')} {noun}
        </p>
        {filtered && <div className="pb-2.5">{find}</div>}
        {nothing ?? (
          <ul className="-mx-4 border-t border-line">
            {shown.map((row) => (
              <li key={keyOf(row)} className="border-b border-line">
                <button
                  type="button"
                  onClick={() => onPick(keyOf(row))}
                  className="flex h-[60px] w-full items-center gap-3 px-4 text-left active:bg-surface-3"
                >
                  <Lead lead={row.lead} />
                  {row.status?.level && (
                    <Pill level={row.status.level} word={row.status.word} className="shrink-0" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  }

  const active = shown.findIndex((row) => keyOf(row) === (activeKey ?? picked))
  const move = (to: number) => {
    const next = shown[Math.max(0, Math.min(shown.length - 1, to))]
    if (!next) return
    setActiveKey(keyOf(next))
    // (By its place: a key is the plugin's text, and may be nothing an id can be.)
    document.getElementById(`${id}-${shown.indexOf(next)}`)?.scrollIntoView({ block: 'nearest' })
  }
  const keys: Record<string, () => void> = {
    ArrowDown: () => move(active + 1),
    ArrowUp: () => move(active - 1),
    Home: () => move(0),
    End: () => move(shown.length - 1),
    Enter: () => shown[active] && onPick(keyOf(shown[active])),
    ' ': () => shown[active] && onPick(keyOf(shown[active])),
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const action = keys[event.key]
    if (!action || event.metaKey || event.ctrlKey || event.altKey) return
    event.preventDefault()
    action()
  }
  return (
    <section aria-label={`${named} list`} className={CARD}>
      <h3 className="flex items-center px-4 pt-3.5 pb-2 text-[13px] font-semibold text-ink-1">
        <TheirText text={list.title} />
        {rows.length > 0 && (
          <small className="ml-auto text-xs font-normal text-ink-3 tabular-nums">
            {rows.length.toLocaleString('en-US')}
          </small>
        )}
      </h3>
      {filtered && find}
      {nothing ?? (
        <div
          ref={scroll}
          role="listbox"
          tabIndex={0}
          aria-label={named}
          aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
          onKeyDown={onKeyDown}
          style={{ maxHeight: PICKS_BEFORE_FILTER * (ROW + GAP) }}
          className="group/picks overflow-y-auto px-2 pb-2 outline-none"
        >
          {shown.map((row, index) => (
            <div
              key={keyOf(row)}
              id={`${id}-${index}`}
              role="option"
              aria-selected={keyOf(row) === picked}
              onClick={() => {
                setActiveKey(keyOf(row))
                onPick(keyOf(row))
              }}
              style={{ height: ROW, marginBottom: GAP }}
              className={cn(
                'flex cursor-default items-center gap-3 rounded-lg border border-transparent px-2 hover:bg-surface-3/60',
                // Picked: the selection's wash, and never the blue alone (the header names it).
                'aria-selected:border-accent/30 aria-selected:bg-accent-soft',
                index === active &&
                  'group-focus-visible/picks:ring-2 group-focus-visible/picks:ring-accent',
              )}
            >
              <Lead lead={row.lead} />
              {/* The status is never cut: the name gives way. */}
              {row.status?.level && (
                <Pill level={row.status.level} word={row.status.word} className="shrink-0" />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

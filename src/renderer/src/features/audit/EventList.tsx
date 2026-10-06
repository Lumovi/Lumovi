/**
 * The audit log's events, the newest first, a day at a time: however many
 * there are (it draws only those in view, and asks for older ones as it's
 * scrolled), with those recorded since the page opened coming in on top.
 */
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowUp } from 'lucide-react'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { AuditEvent } from '@shared/audit'
import { cn } from '@renderer/lib/cn'
import { ACTIONS, clock, dayOf, initials, OUTCOME_STYLES } from './audit-model'

type Row = { kind: 'day'; label: string } | { kind: 'event'; event: AuditEvent }

const DAY_HEIGHT = 34
const EVENT_HEIGHT = 58

export interface EventListHandle {
  focus(): void
}

export const EventList = forwardRef<
  EventListHandle,
  {
    events: AuditEvent[]
    fresh: Set<string>
    selected?: string
    onSelect: (event: AuditEvent | undefined) => void
    more: boolean
    loadingMore: boolean
    loadMore: () => void
  }
>(function EventList({ events, fresh, selected, onSelect, more, loadingMore, loadMore }, ref) {
  const scroller = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => {
    const now = new Date()
    const made: Row[] = []
    let day = ''
    for (const event of events) {
      const label = dayOf(event.time, now)
      if (label !== day) made.push({ kind: 'day', label })
      day = label
      made.push({ kind: 'event', event })
    }
    return made
  }, [events])
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (rows[i]!.kind === 'day' ? DAY_HEIGHT : EVENT_HEIGHT),
    overscan: 12,
  })
  useImperativeHandle(ref, () => ({ focus: () => scroller.current?.focus() }))

  // Older ones once the end is near.
  const items = virtualizer.getVirtualItems()
  const lastShown = items.at(-1)?.index ?? 0
  useEffect(() => {
    if (more && !loadingMore && lastShown >= rows.length - 30) loadMore()
  }, [lastShown, rows.length, more, loadingMore, loadMore])

  // New ones that came in above, while the list was scrolled down: said, until it's back on top.
  const [seenFresh, setSeenFresh] = useState(fresh.size)
  const [scrolled, setScrolled] = useState(false)
  if (!scrolled && seenFresh !== fresh.size) setSeenFresh(fresh.size)
  const unseen = fresh.size - seenFresh

  const ordered = rows.flatMap((row) => (row.kind === 'event' ? [row.event] : []))
  const move = (step: number) => {
    const at = ordered.findIndex((event) => event.id === selected)
    // (It's shown with at least one.)
    const next = ordered[Math.min(Math.max(at + step, 0), ordered.length - 1)]!
    onSelect(next)
    virtualizer.scrollToIndex(
      rows.findIndex((row) => row.kind === 'event' && row.event.id === next.id),
      { align: 'auto' },
    )
  }

  return (
    <div className="relative min-h-0 flex-1">
      {unseen > 0 && (
        <button
          type="button"
          onClick={() => {
            scroller.current!.scrollTo({ top: 0 })
            setSeenFresh(fresh.size)
          }}
          className="absolute top-3 left-1/2 z-10 inline-flex -translate-x-1/2 animate-pop-in items-center gap-1.5 rounded-full bg-ink-1 px-3 py-1 text-xs font-medium text-surface shadow-pop"
        >
          <ArrowUp className="size-3.5" />
          {unseen} new {unseen === 1 ? 'event' : 'events'}
        </button>
      )}
      <div
        ref={scroller}
        role="listbox"
        aria-label="Events"
        tabIndex={0}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 40)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            move(e.key === 'ArrowDown' ? 1 : -1)
          } else if (e.key === 'Escape' && selected) {
            e.stopPropagation()
            onSelect(undefined)
          }
        }}
        className="h-full overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:ring-inset"
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = rows[item.index]!
            return (
              <div
                key={item.key}
                data-index={item.index}
                className="absolute inset-x-0"
                style={{ top: item.start, height: item.size }}
              >
                {row.kind === 'day' ? (
                  <div
                    role="presentation"
                    className="flex h-full items-end border-b border-line bg-app px-4 pb-1.5 text-2xs font-semibold tracking-wide text-ink-3 uppercase"
                  >
                    {row.label}
                  </div>
                ) : (
                  <EventRow
                    event={row.event}
                    fresh={fresh.has(row.event.id)}
                    selected={row.event.id === selected}
                    onSelect={() => onSelect(row.event)}
                  />
                )}
              </div>
            )
          })}
        </div>
        {loadingMore && (
          <p role="status" className="py-3 text-center text-xs text-ink-3">
            Looking further back…
          </p>
        )}
      </div>
    </div>
  )
})

function EventRow({
  event,
  fresh,
  selected,
  onSelect,
}: {
  event: AuditEvent
  fresh: boolean
  selected: boolean
  onSelect: () => void
}) {
  const action = ACTIONS[event.action]
  const outcome = OUTCOME_STYLES[event.outcome]
  const { actor, target } = event
  const where = [event.cluster, target?.namespace].filter(Boolean).join(' / ')
  const name = actor.via === 'server' ? 'Lumovi' : actor.user
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={`${clock(event.time)}: ${event.summary}${event.outcome === 'success' ? '' : `, ${outcome.label.toLowerCase()}`}`}
      onClick={onSelect}
      className={cn(
        'relative flex h-full cursor-default items-center gap-3 border-b border-line px-4 transition-colors',
        selected ? 'bg-accent-soft/60' : 'bg-surface hover:bg-surface-2',
      )}
    >
      {selected && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
      <span className="w-[80px] shrink-0 font-mono text-2xs whitespace-nowrap text-ink-3 tabular-nums">
        {clock(event.time)}
      </span>
      <span
        className={cn(
          'relative grid size-7 shrink-0 place-items-center rounded-lg border border-line bg-surface-2',
          outcome.className,
        )}
      >
        <action.icon className="size-3.5" />
        {fresh && (
          <span
            aria-label="New"
            className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-accent ring-2 ring-surface"
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-ink-1">{event.summary}</span>
          {event.outcome !== 'success' && (
            <span
              className={cn(
                'shrink-0 rounded-md px-1.5 py-px text-2xs font-semibold',
                outcome.badge,
              )}
            >
              {outcome.label}
            </span>
          )}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
          <span
            aria-hidden
            className="grid size-4 shrink-0 place-items-center rounded-full bg-surface-3 text-[8px] font-semibold text-ink-2"
          >
            {initials(name)}
          </span>
          <span className="truncate text-ink-2">{name}</span>
          {actor.via === 'assistant' && (
            <span className="shrink-0 rounded-md border border-line px-1 text-2xs text-ink-2">
              {actor.assistant}
            </span>
          )}
          {where && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate font-mono text-2xs">{where}</span>
            </>
          )}
        </span>
      </span>
    </div>
  )
}

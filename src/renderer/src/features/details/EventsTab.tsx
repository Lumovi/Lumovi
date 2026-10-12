import { useVirtualizer } from '@tanstack/react-virtual'
import { Activity, Info, SearchX, TriangleAlert } from 'lucide-react'
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react'
import type { KubeObject } from '@shared/api'
import { SearchInput } from '@renderer/components/SearchInput'
import { EmptyState, ErrorState, Loading } from '@renderer/components/States'
import { useList } from '@renderer/hooks/queries'
import type { KubeApiError } from '@renderer/lib/api'
import { age, formatDateTime } from '@renderer/lib/format'
import { useLayout } from '@renderer/lib/layout'
import { lastSeen } from '../resources/columns'

/** Past this many events, only the ones in view are drawn. */
const IN_VIEW_FROM = 200
/** About how tall an event is before it's measured, and the gap under it. */
const ABOUT = 72
const GAP = 4

/** Events about one object, newest first — the same lookup `kubectl describe` does. */
export function EventsTab({
  object,
  refused,
}: {
  object: KubeObject
  /** In place of the usual error where the events may not be read: said by whoever shows them. */
  refused?: ReactNode
}) {
  const events = useList('Event', {
    namespace: object.metadata.namespace ?? null,
    fieldSelector: `involvedObject.kind=${object.kind},involvedObject.name=${object.metadata.name}`,
  })

  if (events.isPending) return <Loading label="Loading events…" />
  if (events.data === undefined) {
    const { code } = events.error as KubeApiError
    if (refused && (code === 'forbidden' || code === 'not-allowed')) return refused
    return <ErrorState error={events.error as KubeApiError} onRetry={() => void events.refetch()} />
  }
  if (events.data.length === 0) {
    return (
      <EmptyState icon={Activity} title="No recent events">
        Kubernetes keeps events for about an hour by default.
      </EmptyState>
    )
  }

  return <Events events={events.data} />
}

/** What a filter is matched against: an event's reason, its message and what reported it. */
const said = (event: KubeObject) =>
  `${event.reason as string} ${event.message as string} ${
    (event.source as { component?: string } | undefined)?.component ?? ''
  }`.toLowerCase()

/**
 * The events, newest first. Thousands of them are as quick as ten: past a couple of hundred,
 * only the ones in view are drawn, and since the page's own find then reaches only those, a
 * filter above them finds one among them all.
 */
function Events({ events }: { events: KubeObject[] }) {
  const [filter, setFilter] = useState('')
  const sorted = useMemo(
    () => [...events].sort((a, b) => Date.parse(lastSeen(b)) - Date.parse(lastSeen(a))),
    [events],
  )
  const needle = filter.trim().toLowerCase()
  const shown = useMemo(
    () => (needle ? sorted.filter((event) => said(event).includes(needle)) : sorted),
    [sorted, needle],
  )
  // Once the filter is there it stays for this visit to the tab: events come and age out while
  // a person watches, and a field that came and went as their count crossed the line would move
  // the list under the pointer, and could go with text in it.
  const [filtering, setFiltering] = useState(false)
  if (!filtering && sorted.length > IN_VIEW_FROM) setFiltering(true)
  if (!filtering && sorted.length <= IN_VIEW_FROM) return <EventList events={sorted} />
  return (
    <div>
      {/* (Shown in a card of its own, the field stays above the events as they scroll in it.) */}
      <div className="flex items-center gap-3 px-(--events-field-inset,1.25rem) pt-(--events-gap,1rem) [.events-in-a-card_&]:sticky [.events-in-a-card_&]:top-0 [.events-in-a-card_&]:z-10 [.events-in-a-card_&]:bg-(--events-ground) [.events-in-a-card_&]:pb-2">
        <SearchInput
          value={filter}
          onChange={setFilter}
          // (The events aren't something the keys move through: down from the field goes nowhere.)
          onArrowDown={() => undefined}
          placeholder="Filter events"
          hint={false}
          className="min-w-0 flex-1"
        />
        {needle && (
          <span className="shrink-0 text-xs text-ink-3 tabular-nums">
            {shown.length.toLocaleString('en-US')} of {sorted.length.toLocaleString('en-US')}
          </span>
        )}
      </div>
      {shown.length === 0 ? (
        <EmptyState icon={SearchX} title="Nothing matches">
          No events match “{filter.trim()}”.
        </EmptyState>
      ) : shown.length > IN_VIEW_FROM ? (
        <EventsInView events={shown} />
      ) : (
        <EventList events={shown} />
      )}
    </div>
  )
}

/** Every event drawn: what a list of a couple of hundred or fewer is. */
function EventList({ events }: { events: KubeObject[] }) {
  return (
    <ol
      aria-label="Events"
      // (Where it's shown may set how far in it stands: a card's rows start at its own edge.)
      className="relative mx-(--events-inset,1.25rem) space-y-1 py-(--events-gap,1rem)"
    >
      {events.map((event) => (
        <EventRow key={event.metadata.name} event={event} />
      ))}
    </ol>
  )
}

/**
 * A long list of events, drawn as far as it's in view. It scrolls with whatever it's in (the
 * tab, or the page on a phone), and each event is measured as it's drawn: a message is as long
 * as it is.
 */
function EventsInView({ events }: { events: KubeObject[] }) {
  const list = useRef<HTMLOListElement>(null)
  // What scrolls it, and how far down that the list starts. Found again when the layout changes
  // (on a phone it's the detail's page that scrolls), and the start measured again as the
  // scroller resizes or scrolls: what's above the list in it may grow while the tab is open.
  const layout = useLayout()
  const [within, setWithin] = useState<{ scroller: HTMLElement; from: number }>()
  useLayoutEffect(() => {
    const element = list.current!
    let scroller = element.parentElement
    while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement
    }
    const found = scroller ?? document.documentElement
    const measure = () => {
      const from =
        element.getBoundingClientRect().top - found.getBoundingClientRect().top + found.scrollTop
      setWithin((was) =>
        was && was.scroller === found && Math.abs(was.from - from) < 1
          ? was
          : { scroller: found, from },
      )
    }
    measure()
    const resized = new ResizeObserver(measure)
    resized.observe(found)
    found.addEventListener('scroll', measure, { passive: true })
    return () => {
      resized.disconnect()
      found.removeEventListener('scroll', measure)
    }
  }, [layout])
  // The React Compiler is not used, so the virtualizer's unmemoizable API is fine here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => within?.scroller ?? null,
    estimateSize: () => ABOUT,
    getItemKey: (index) => events[index]!.metadata.name,
    scrollMargin: within?.from ?? 0,
    gap: GAP,
    overscan: 8,
  })
  return (
    <ol
      ref={list}
      aria-label="Events"
      className="relative mx-(--events-inset,1.25rem) my-(--events-gap,1rem)"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((item) => (
        <EventRow
          key={item.key}
          event={events[item.index]!}
          measure={virtualizer.measureElement}
          index={item.index}
          of={events.length}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
          }}
        />
      ))}
    </ol>
  )
}

function EventRow({
  event,
  measure,
  index,
  of,
  style,
}: {
  event: KubeObject
  /** Where only some are drawn: how it's measured, where it is among them all, and placed. */
  measure?: Ref<HTMLLIElement>
  index?: number
  of?: number
  style?: CSSProperties
}) {
  const warning = event.type === 'Warning'
  const Icon = warning ? TriangleAlert : Info
  return (
    <li
      ref={measure}
      data-index={index}
      aria-posinset={index === undefined ? undefined : index + 1}
      aria-setsize={of}
      style={style}
      className="flex gap-3 rounded-xl px-3 py-2.5 hover:bg-surface-2"
    >
      <Icon
        className={
          warning ? 'mt-0.5 size-4 shrink-0 text-warn' : 'mt-0.5 size-4 shrink-0 text-ink-3'
        }
      />
      <div className="min-w-0 flex-1">
        {/* A long reason is cut short (it's all on hover): when it was keeps its place. */}
        <div className="flex min-w-0 items-baseline gap-2">
          <span
            className="min-w-0 truncate font-semibold text-ink-1"
            title={event.reason as string}
          >
            {event.reason as string}
          </span>
          {(event.count as number) > 1 && (
            <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-2xs font-medium text-ink-2 tabular-nums">
              ×{event.count as number}
            </span>
          )}
          <span className="flex-1" />
          <time
            className="shrink-0 text-xs text-ink-3"
            dateTime={lastSeen(event)}
            title={formatDateTime(lastSeen(event))}
          >
            {age(lastSeen(event))} ago
          </time>
        </div>
        <p className="mt-0.5 text-[13px] leading-relaxed wrap-anywhere text-ink-2 selectable">
          {event.message as string}
        </p>
        <p className="mt-0.5 text-xs wrap-anywhere text-ink-3">
          {(event.source as { component?: string } | undefined)?.component}
        </p>
      </div>
    </li>
  )
}

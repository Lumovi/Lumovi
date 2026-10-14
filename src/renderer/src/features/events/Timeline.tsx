/**
 * Events on a time axis: a row an involved object (or, on an object's tab, a reason), each event a
 * mark at its time, a repeated one a bar from its first time to its last. The axis, the ranges,
 * the zoom and the tooltip are the metrics charts' own. It reads nothing: it draws the events it's
 * given, filtered as the page that shows it filters them.
 */
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChartNoAxesGantt, List, TriangleAlert, X } from 'lucide-react'
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import type { KubeObject } from '@shared/api'
import { formatMoment, formatTick, timeTicks } from '@renderer/components/charts/scale'
import { kindIcon } from '@renderer/components/KindIcon'
import { MiddleTruncate } from '@renderer/components/MiddleTruncate'
import { cn } from '@renderer/lib/cn'
import { age } from '@renderer/lib/format'
import {
  marksOf,
  rowsOf,
  stepsOf,
  TIMELINE_RANGES,
  windowOf,
  zoomInto,
  type Happened,
  type Mark,
  type TimelineRow,
  type TimelineSelection,
} from './timeline-rows'

/** Room after "now", so a count by the last mark is never cut off. */
const AFTER = 48
/** Tick labels this close to "now" give way to it. */
const NOW_ROOM = 44
/** The narrowest track the timeline is drawn on: under it, there's only the list. */
export const LEAST_TRACK = 320
/** Rows are drawn as far as they're in view past this many. */
const IN_VIEW_FROM = 60
/** Rows' heights: roomy, and closer where there are many. */
const ROW = 40
const ROW_CLOSE = 34
const CLOSE_FROM = 20
/** A bar's height, and the narrowest that holds its count inside it. */
const BAR = 14
/** A bar's height where a row stacks three. */
const BAR_THIN = 10
/** A names column this narrow shows each kind as its icon alone. */
const NARROW_NAMES = 150
const COUNT_INSIDE = 44

/** The names' column: wider on a wide page, narrow on an object's tab. */
export function namesWidth(width: number, on: 'page' | 'tab'): number {
  if (on === 'tab') return 150
  return width >= 1280 ? 340 : width >= 1000 ? 220 : 150
}

/** Whether a width holds a timeline: its names, and a track of at least LEAST_TRACK after them. */
export const holdsTimeline = (width: number, on: 'page' | 'tab', inset: number) =>
  width - 2 * inset - namesWidth(width, on) - AFTER >= LEAST_TRACK

/** The narrowest page a timeline is drawn on, with its names as narrow as they go. */
export const leastForTimeline = (inset: number) =>
  2 * inset + namesWidth(0, 'page') + AFTER + LEAST_TRACK

/** A time to the second, with its day where the window spans days. */
const moment = (time: number, span: number) =>
  new Date(time).toLocaleString(undefined, {
    ...(span > 86_400_000 ? { weekday: 'short', day: 'numeric', month: 'short' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

/** What a row is called: a kind and name, or a reason. */
const rowWords = (row: TimelineRow) => (row.kind ? `${row.kind} ${row.name}` : row.name)

/** A mark's name, as a screen reader hears it. */
function markWords(one: Happened, row: TimelineRow, now: number) {
  const ago = age(new Date(one.last).toISOString(), now)
  const on = row.kind ? ` on ${rowWords(row)}` : ''
  return one.count > 1
    ? `${one.reason}${on}, ${one.count} times, last ${ago} ago`
    : `${one.reason}${on}, ${ago} ago`
}

export function Timeline({
  events,
  by,
  now,
  showNamespace,
  filtered,
  selection,
  onSelection,
  onOpenEvent,
  onOpenObject,
  inset,
}: {
  events: readonly KubeObject[]
  /** A row an object (the Events page), or a reason (an object's tab). */
  by: 'object' | 'reason'
  /** When the events were read: ages and "now" are as of then. */
  now: number
  /** Whether rows say their namespace: where all namespaces are shown. */
  showNamespace: boolean
  /** Whether a filter hides some: nothing shown then is "no match", not "nothing happened". */
  filtered: boolean
  selection: TimelineSelection
  onSelection: (selection: TimelineSelection) => void
  onOpenEvent: (event: KubeObject) => void
  onOpenObject?: (row: TimelineRow) => void
  /** The room each side of the timeline, in pixels. */
  inset: number
}) {
  const rows = rowsOf(events, by)
  const { start, end } = windowOf(selection, rows, now)
  const toNow = !('from' in selection)
  const shownRows = rows.filter((row) => stepsOf(row, start, end).length > 0)

  // The track's width: the timeline's own, less its names and the room after "now".
  const [box, width] = useWidth<HTMLDivElement>()
  const names = namesWidth(width, by === 'reason' ? 'tab' : 'page')
  const narrowNames = names <= NARROW_NAMES
  const plot = Math.max(1, width - 2 * inset - names - AFTER)
  const x = (time: number) => ((time - start) / (end - start)) * plot
  const timeAt = (px: number) => start + (Math.max(0, Math.min(plot, px)) / plot) * (end - start)
  const { ticks, step } = timeTicks(start, end, Math.max(2, Math.floor(plot / 90)))

  // The mark the pointer or the keys are on: its row, and which of the row's events; and, where
  // the pointer is on a mark of several, all it holds (its card lists them).
  const [active, setActive] = useState<{
    row: number
    step: number
    by: 'keys' | 'pointer'
    ones?: Happened[]
  }>()
  const activeRow = active ? shownRows[active.row] : undefined
  const activeSteps = activeRow ? stepsOf(activeRow, start, end) : []
  const activeOne = active ? activeSteps[active.step] : undefined
  const tooltipId = useId()
  const gridId = useId()

  const height = shownRows.length > CLOSE_FROM ? ROW_CLOSE : ROW
  const scroller = useRef<HTMLDivElement>(null)
  // The React Compiler is not used, so the virtualizer's unmemoizable API is fine here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: shownRows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => height,
    getItemKey: (index) => shownRows[index]!.key,
    overscan: 10,
  })
  const inView = shownRows.length > IN_VIEW_FROM

  // Dragging across the track zooms into what was dragged across.
  const [drag, setDrag] = useState<{ from: number; to: number }>()
  const trackLeft = (element: HTMLElement) => element.getBoundingClientRect().left + inset + names
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' || event.button !== 0) return
    const px = event.clientX - trackLeft(event.currentTarget)
    if (px < 0 || px > plot) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({ from: px, to: px })
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag) setDrag({ ...drag, to: event.clientX - trackLeft(event.currentTarget) })
  }
  const onPointerUp = () => {
    if (!drag) return
    setDrag(undefined)
    const [a, b] = [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)]
    // A click, or a sliver, isn't a zoom.
    if (b - a >= 8) onSelection(zoomInto(selection, timeAt(a), timeAt(b)))
  }

  /** Puts the keys on a row's event nearest a time (or its first), and that row in view. */
  const keysTo = (row: number, time?: number) => {
    const steps = stepsOf(shownRows[row]!, start, end)
    const nearest =
      time === undefined
        ? 0
        : steps.reduce(
            (best, one, i) =>
              Math.abs(one.first - time) < Math.abs(steps[best]!.first - time) ? i : best,
            0,
          )
    setActive({ row, step: nearest, by: 'keys' })
    if (inView) virtualizer.scrollToIndex(row)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // (Keys on a row's name are the name's: Enter opens the object.)
    if (event.target !== event.currentTarget || shownRows.length === 0) return
    const at = active ?? { row: 0, step: 0 }
    const steps = stepsOf(shownRows[at.row]!, start, end)
    const time = steps[at.step]?.first
    const moves: Record<string, () => void> = {
      ArrowDown: () => keysTo(Math.min(shownRows.length - 1, at.row + (active ? 1 : 0)), time),
      ArrowUp: () => keysTo(Math.max(0, at.row - (active ? 1 : 0)), time),
      ArrowRight: () =>
        setActive({
          ...at,
          step: Math.min(steps.length - 1, at.step + (active ? 1 : 0)),
          by: 'keys',
        }),
      ArrowLeft: () => setActive({ ...at, step: Math.max(0, at.step - 1), by: 'keys' }),
      Home: () => setActive({ ...at, step: 0, by: 'keys' }),
      End: () => setActive({ ...at, step: steps.length - 1, by: 'keys' }),
      Enter: () => activeOne && onOpenEvent(activeOne.event),
      Escape: () => setActive(undefined),
    }
    const move = moves[event.key]
    if (!move || (event.key === 'Escape' && !active)) return
    event.preventDefault()
    move()
  }

  const nothing = shownRows.length === 0
  const zoomed = 'from' in selection
  // (A filter that leaves nothing at all is "no match"; zoomed into a stretch without any, that
  // stretch; else the range's time.)
  const emptyWords =
    filtered && events.length === 0
      ? 'No events match.'
      : zoomed
        ? 'No events in this stretch.'
        : 'No events in this time.'

  const drawRow = (row: TimelineRow, index: number, style?: React.CSSProperties) => {
    const lit = active?.row === index
    const Icon = row.kind ? kindIcon(row.kind) : undefined
    return (
      <div
        key={row.key}
        role="row"
        aria-rowindex={index + 2}
        data-index={index}
        style={{ height, ...style }}
        className={cn('flex items-center border-b border-line', lit && 'bg-surface-2')}
      >
        <div
          role="rowheader"
          className="flex h-full min-w-0 shrink-0 items-center gap-2 pr-3"
          style={{ width: names, marginLeft: inset }}
        >
          {Icon && (
            <Icon aria-hidden className="size-4 shrink-0 text-ink-3">
              {narrowNames && row.kind && <title>{row.kind}</title>}
            </Icon>
          )}
          {/* (A kind keeps all of itself, up to under half the column: HorizontalPodAutoscaler's
              is cut there. The name takes the rest, cut in its middle. Where the column is at its
              narrowest, the kind is its icon: its word is for a screen reader alone.) */}
          {row.kind && (
            <span
              className={
                narrowNames ? 'sr-only' : 'max-w-[45%] shrink-0 truncate text-xs text-ink-3'
              }
              title={row.kind}
            >
              {row.kind}
            </span>
          )}
          {onOpenObject && row.kind ? (
            <button
              type="button"
              // (One stop for the grid: from it, Tab comes to the name of the row the keys are on.)
              tabIndex={lit || (!active && index === 0) ? 0 : -1}
              onClick={() => onOpenObject(row)}
              className="min-w-0 shrink overflow-hidden rounded text-left text-[13px] font-medium text-accent-strong hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              <MiddleTruncate text={row.name} className="block" />
            </button>
          ) : (
            <span className="min-w-0 text-[13px] font-medium text-ink-1">
              <MiddleTruncate text={row.name} className="block" />
            </span>
          )}
          {showNamespace && row.namespace && (
            <span className="shrink-0 text-xs text-ink-3">{row.namespace}</span>
          )}
        </div>
        <div role="gridcell" className="relative h-full shrink-0" style={{ width: plot + AFTER }}>
          {marksOf(row.events, start, end, plot).map((mark) => (
            <MarkShape
              key={markKey(mark)}
              mark={mark}
              row={row}
              rowIndex={index}
              x={x}
              plot={plot}
              now={now}
              activeOne={lit ? activeOne : undefined}
              keys={active?.by === 'keys'}
              onPoint={(one, ones) =>
                setActive({
                  row: index,
                  step: stepsOf(row, start, end).indexOf(one),
                  by: 'pointer',
                  ones,
                })
              }
              onLeave={() => setActive((was) => (was?.by === 'pointer' ? undefined : was))}
              onOpen={onOpenEvent}
              onZoom={(from, to) => onSelection(zoomInto(selection, from, to))}
              gridId={gridId}
            />
          ))}
        </div>
      </div>
    )
  }

  const activeX = activeOne ? x(activeOne.count > 1 ? activeOne.first : activeOne.last) : undefined
  const flip = activeX !== undefined && activeX > plot * 0.62

  return (
    <div ref={box} className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 py-3"
        style={{ paddingInline: inset }}
      >
        <TimelineRanges selection={selection} onChange={onSelection} />
        <span className="flex-1" />
        <Legend />
      </div>
      {nothing ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center">
          <p className="text-[13px] text-ink-2">{emptyWords}</p>
          {zoomed && (
            <button
              type="button"
              onClick={() => onSelection({ range: selection.back })}
              className="text-xs font-medium text-accent-strong hover:underline"
            >
              Reset zoom
            </button>
          )}
        </div>
      ) : (
        <div
          ref={scroller}
          id={gridId}
          role="grid"
          tabIndex={0}
          aria-label={`Events on a timeline${zoomed ? ', zoomed in' : ''}. Arrow keys move between rows and events; Enter opens one; drag across the times to zoom.`}
          aria-rowcount={shownRows.length + 1}
          aria-describedby={activeOne ? tooltipId : undefined}
          onKeyDown={onKeyDown}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setActive(undefined)
          }}
          className="relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
        >
          {/* The axis, above the rows as they scroll. */}
          <div
            role="row"
            aria-rowindex={1}
            className="sticky top-0 z-10 flex h-8 items-end border-b border-line-strong bg-surface"
          >
            <div
              role="columnheader"
              className="shrink-0 pb-1.5 text-2xs font-semibold tracking-wide text-ink-3 uppercase"
              style={{ width: names, marginLeft: inset }}
            >
              {by === 'reason' ? 'Reason' : 'Object'}
            </div>
            <div
              role="columnheader"
              className="relative h-full shrink-0"
              style={{ width: plot + AFTER }}
            >
              <span className="sr-only">When</span>
              {ticks
                .filter((tick) => !toNow || x(end) - x(tick) >= NOW_ROOM)
                .map((tick) => (
                  <span
                    key={tick}
                    aria-hidden
                    className="absolute bottom-1.5 -translate-x-1/2 text-[11px] text-ink-3 tabular-nums"
                    style={{ left: x(tick) }}
                  >
                    {formatTick(tick, step)}
                  </span>
                ))}
              {toNow && (
                <span
                  aria-hidden
                  className="absolute bottom-1.5 -translate-x-1/2 text-[11px] font-medium text-ink-2"
                  style={{ left: x(end) }}
                >
                  now
                </span>
              )}
            </div>
          </div>
          <div
            className={cn('relative', drag ? 'cursor-col-resize' : 'cursor-crosshair')}
            style={inView ? { height: virtualizer.getTotalSize() } : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => setDrag(undefined)}
          >
            {/* The grid's hairlines, "now", and the time the pointer or the keys are on. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0"
              style={{ left: inset + names, width: plot + AFTER }}
            >
              {ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute inset-y-0 w-px bg-line"
                  style={{ left: x(tick) }}
                />
              ))}
              {toNow && (
                <span
                  className="absolute inset-y-0 border-l border-dashed border-ink-3"
                  style={{ left: x(end) }}
                />
              )}
              {activeX !== undefined && (
                <span className="absolute inset-y-0 w-px bg-ink-2" style={{ left: activeX }} />
              )}
              {drag && Math.abs(drag.to - drag.from) > 2 && (
                <span
                  className="absolute inset-y-0 border-x border-accent/40 bg-accent-soft"
                  style={{
                    left: Math.max(0, Math.min(drag.from, drag.to)),
                    width: Math.min(plot, Math.abs(drag.to - drag.from)),
                  }}
                />
              )}
            </div>
            {inView
              ? virtualizer.getVirtualItems().map((item) =>
                  drawRow(shownRows[item.index]!, item.index, {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${item.start}px)`,
                  }),
                )
              : shownRows.map((row, index) => drawRow(row, index))}
          </div>
          {activeOne && activeRow && activeX !== undefined && (
            <Card
              id={tooltipId}
              one={activeOne}
              ones={active?.ones}
              row={activeRow}
              span={end - start}
              style={{
                top:
                  32 +
                  (inView
                    ? (virtualizer.getVirtualItems().find((item) => item.index === active!.row)
                        ?.start ?? 0)
                    : active!.row * height) +
                  height,
                ...(flip
                  ? { right: width - (inset + names + activeX) + 12 }
                  : { left: inset + names + activeX + 12 }),
              }}
            />
          )}
        </div>
      )}
      <p
        role="note"
        className="shrink-0 border-t border-line py-2 text-xs text-ink-3"
        style={{ paddingInline: inset }}
      >
        Kubernetes keeps events for about an hour, unless its API server is set otherwise: older
        ones are gone, here as in kubectl.
      </p>
    </div>
  )
}

const markKey = (mark: Mark) =>
  mark.is === 'together' || mark.is === 'pile'
    ? `${mark.is}/${mark.ones.map((one) => one.event.metadata.name).join('+')}`
    : `${mark.is}/${mark.one.event.metadata.name}`

/** A mark: a hollow circle for a Normal event, a triangle for a Warning, a bar for a repeated one. */
function MarkShape({
  mark,
  row,
  rowIndex,
  x,
  plot,
  now,
  activeOne,
  keys,
  onPoint,
  onLeave,
  onOpen,
  onZoom,
  gridId,
}: {
  mark: Mark
  row: TimelineRow
  rowIndex: number
  x: (time: number) => number
  plot: number
  now: number
  activeOne?: Happened
  /** Whether the keys put it there: the ring is the keyboard's, where the pointer is a hairline. */
  keys: boolean
  onPoint: (one: Happened, ones?: Happened[]) => void
  onLeave: () => void
  onOpen: (event: KubeObject) => void
  onZoom: (from: number, to: number) => void
  gridId: string
}) {
  // (A press on a mark is the mark's: it doesn't start a zoom across the track.)
  const own = (event: PointerEvent) => event.stopPropagation()
  if (mark.is === 'together') {
    const first = mark.ones[0]!.first
    const last = Math.max(...mark.ones.map((one) => one.last))
    const lit = keys && mark.ones.includes(activeOne!)
    const warning = mark.ones.some((one) => one.warning)
    return (
      <button
        type="button"
        tabIndex={-1}
        aria-label={`${mark.ones.length} events close together: ${mark.ones.map((one) => markWords(one, row, now)).join('; ')}`}
        aria-controls={gridId}
        data-row={rowIndex}
        onPointerDown={own}
        onPointerEnter={() => onPoint(mark.ones[0]!, mark.ones)}
        onPointerLeave={onLeave}
        // Zooming into them parts them.
        onClick={() => {
          const room = Math.max(last - first, 30_000) * 2
          onZoom(first - room, last + room)
        }}
        className={cn(
          'absolute top-1/2 grid h-[18px] min-w-[18px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border bg-surface px-1 text-2xs font-semibold tabular-nums',
          warning ? 'text-warn-strong border-warn' : 'border-ink-3 text-ink-2',
          lit && 'ring-2 ring-accent',
        )}
        style={{ left: x(mark.at) }}
      >
        {mark.ones.length}
      </button>
    )
  }
  if (mark.is === 'pile') {
    return (
      <Pile
        mark={mark}
        row={row}
        rowIndex={rowIndex}
        x={x}
        plot={plot}
        now={now}
        lit={keys && mark.ones.includes(activeOne!)}
        onPoint={onPoint}
        onLeave={onLeave}
        onZoom={onZoom}
        gridId={gridId}
      />
    )
  }
  const one = mark.one
  const lit = keys && activeOne === one
  const words = markWords(one, row, now)
  if (mark.is === 'bar') {
    const from = Math.max(0, x(mark.from))
    const to = Math.min(plot, x(mark.to))
    const inside = to - from >= COUNT_INSIDE
    // (Lanes about the row's middle, a pixel or two apart; three are thinner, to fit a row.)
    const thick = mark.lanes > 2 ? BAR_THIN : BAR
    const lane = (mark.lane - (mark.lanes - 1) / 2) * (thick + 2)
    return (
      <button
        type="button"
        tabIndex={-1}
        aria-label={words}
        data-row={rowIndex}
        data-lane={mark.lanes > 1 ? mark.lane : undefined}
        onPointerDown={own}
        onPointerEnter={() => onPoint(one)}
        onPointerLeave={onLeave}
        onClick={() => onOpen(one.event)}
        className={cn(
          'absolute top-1/2 -translate-y-1/2 rounded-full border',
          one.warning ? 'bg-warn-soft border-warn/45' : 'border-line-strong bg-surface-3',
          lit && 'ring-2 ring-accent',
        )}
        style={{ left: from, width: Math.max(1, to - from), height: thick, marginTop: lane }}
      >
        <span className="absolute top-1/2 left-0 -translate-x-1/2 -translate-y-1/2">
          <Glyph warning={one.warning} />
        </span>
        <span
          className={cn(
            'absolute top-1/2 -translate-y-1/2 text-2xs font-semibold whitespace-nowrap tabular-nums',
            one.warning ? 'text-warn-strong' : 'text-ink-2',
          )}
          style={inside ? { left: 10 } : { left: to - from + 6 }}
        >
          ×{one.count}
        </span>
      </button>
    )
  }
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={words}
      data-row={rowIndex}
      onPointerDown={own}
      onPointerEnter={() => onPoint(one)}
      onPointerLeave={onLeave}
      onClick={() => onOpen(one.event)}
      className={cn(
        'absolute top-1/2 grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full',
        lit && 'ring-2 ring-accent',
      )}
      style={{ left: x(mark.at) }}
    >
      <Glyph warning={one.warning} />
      {one.count > 1 && (
        <span
          className={cn(
            'absolute top-1/2 left-full ml-1 -translate-y-1/2 text-2xs font-semibold whitespace-nowrap tabular-nums',
            one.warning ? 'text-warn-strong' : 'text-ink-2',
          )}
        >
          ×{one.count}
        </span>
      )}
    </button>
  )
}

/**
 * Bars past a row's three lanes that overlap each other: one pile over their joined span, with how
 * many by its start, in the warning's look where it holds one, so a Warning in it never looks
 * quiet. Pointed at, its card lists them; the keys step through them one by one, each heard as
 * itself; pressed, it zooms in, as close marks do.
 */
function Pile({
  mark,
  row,
  rowIndex,
  x,
  plot,
  now,
  lit,
  onPoint,
  onLeave,
  onZoom,
  gridId,
}: {
  mark: Extract<Mark, { is: 'pile' }>
  row: TimelineRow
  rowIndex: number
  x: (time: number) => number
  plot: number
  now: number
  lit: boolean
  onPoint: (one: Happened, ones?: Happened[]) => void
  onLeave: () => void
  onZoom: (from: number, to: number) => void
  gridId: string
}) {
  const from = Math.max(0, x(mark.from))
  const to = Math.min(plot, x(mark.to))
  const inside = to - from >= COUNT_INSIDE
  const thick = mark.lanes > 2 ? BAR_THIN : BAR
  const lane = (mark.lane - (mark.lanes - 1) / 2) * (thick + 2)
  const warning = mark.ones.some((one) => one.warning)
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`${mark.ones.length} events that repeated over the same stretch: ${mark.ones.map((one) => markWords(one, row, now)).join('; ')}`}
      aria-controls={gridId}
      data-row={rowIndex}
      data-lane={mark.lane}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerEnter={() => onPoint(mark.ones[0]!, mark.ones)}
      onPointerLeave={onLeave}
      onClick={() => {
        const room = Math.max(mark.to - mark.from, 30_000) * 2
        onZoom(mark.from - room, mark.to + room)
      }}
      className={cn(
        'absolute top-1/2 -translate-y-1/2 rounded-full border-[1.5px] bg-surface',
        warning ? 'border-warn' : 'border-ink-3',
        lit && 'ring-2 ring-accent',
      )}
      style={{ left: from, width: Math.max(1, to - from), height: thick, marginTop: lane }}
    >
      {warning && (
        <span className="absolute top-1/2 left-0 -translate-x-1/2 -translate-y-1/2">
          <Glyph warning />
        </span>
      )}
      <span
        className={cn(
          'absolute top-1/2 -translate-y-1/2 text-2xs font-semibold whitespace-nowrap tabular-nums',
          warning ? 'text-warn-strong' : 'text-ink-2',
        )}
        style={inside ? { left: 10 } : { left: to - from + 6 }}
      >
        +{mark.ones.length}
      </span>
    </button>
  )
}

/** A Normal event's hollow circle, as an icon beside its word: the mark's own shape. */
const Hollow = ({ className }: { className?: string }) => (
  <span aria-hidden className={cn('grid shrink-0 place-items-center', className)}>
    <span className="block size-3 rounded-full border-[1.5px] border-current" />
  </span>
)

/** A Warning's filled triangle, or a Normal event's hollow circle. */
function Glyph({ warning }: { warning: boolean }) {
  return warning ? (
    <svg aria-hidden viewBox="0 0 10 10" className="size-2.5 fill-warn">
      <path d="M5 0.6 9.6 9.2H0.4Z" />
    </svg>
  ) : (
    <span
      aria-hidden
      className="block size-2.5 rounded-full border-[1.5px] border-ink-3 bg-surface"
    />
  )
}

/**
 * What a mark is, beside it: the charts' tooltip, with the event's reason, message and times; or,
 * where the pointer is on a mark of several, a line for each it holds.
 */
function Card({
  id,
  one,
  ones,
  row,
  span,
  style,
}: {
  id: string
  one: Happened
  ones?: Happened[]
  row: TimelineRow
  span: number
  style: React.CSSProperties
}) {
  if (ones && ones.length > 1) {
    return (
      <div
        id={id}
        role="tooltip"
        className="pointer-events-none absolute z-20 w-96 max-w-[calc(100%-2rem)] rounded-lg border border-line-strong bg-surface-2 px-3 py-2 shadow-pop"
        style={style}
      >
        <ul className="flex flex-col gap-1">
          {ones.map((each) => {
            const Icon = each.warning ? TriangleAlert : Hollow
            return (
              <li
                key={each.event.metadata.uid ?? each.event.metadata.name}
                className="flex items-center gap-2 text-xs"
              >
                <span className="min-w-0 truncate font-semibold text-ink-1">{each.reason}</span>
                <span
                  className={cn(
                    'flex shrink-0 items-center gap-1 font-medium',
                    each.warning ? 'text-warn-strong' : 'text-ink-3',
                  )}
                >
                  <Icon aria-hidden className="size-3.5" />
                  {each.warning ? 'Warning' : 'Normal'}
                </span>
                <span className="flex-1" />
                {each.count > 1 && (
                  <span className="shrink-0 font-semibold text-ink-1 tabular-nums">
                    ×{each.count}
                  </span>
                )}
                <span className="shrink-0 text-ink-3 tabular-nums">
                  {each.count > 1
                    ? `${moment(each.first, span)}–${moment(each.last, span)}`
                    : moment(each.last, span)}
                </span>
              </li>
            )
          })}
        </ul>
        {row.kind && (
          <p className="mt-1.5 border-t border-line pt-1.5 text-xs text-ink-3">{rowWords(row)}</p>
        )}
      </div>
    )
  }
  const Icon = one.warning ? TriangleAlert : Hollow
  return (
    <div
      id={id}
      role="tooltip"
      className="pointer-events-none absolute z-20 w-80 max-w-[calc(100%-2rem)] rounded-lg border border-line-strong bg-surface-2 px-3 py-2 shadow-pop"
      style={style}
    >
      <p className="flex items-center gap-2 text-[13px]">
        <span className="min-w-0 truncate font-semibold text-ink-1">{one.reason}</span>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 text-xs font-medium',
            one.warning ? 'text-warn-strong' : 'text-ink-3',
          )}
        >
          <Icon aria-hidden className="size-3.5" />
          {one.warning ? 'Warning' : 'Normal'}
        </span>
        <span className="flex-1" />
        {one.count > 1 && (
          <span className="shrink-0 text-xs font-semibold text-ink-1 tabular-nums">
            ×{one.count}
          </span>
        )}
      </p>
      <p className="mt-1 text-xs leading-relaxed wrap-anywhere text-ink-2">
        {(one.event.message as string | undefined) ?? ''}
      </p>
      <p className="mt-1.5 border-t border-line pt-1.5 text-xs text-ink-3 tabular-nums">
        {row.kind ? `${rowWords(row)} · ` : ''}
        {one.count > 1 ? (
          <>
            <Field name="First">{moment(one.first, span)}</Field>,{' '}
            <Field name="Last">{moment(one.last, span)}</Field>
          </>
        ) : (
          <Field name="At">{moment(one.last, span)}</Field>
        )}
      </p>
    </div>
  )
}

const Field = ({ name, children }: { name: string; children: ReactNode }) => (
  <>
    <span className="font-medium text-ink-2">{name}</span> {children}
  </>
)

/** 15m, 1h and All, as on the metrics charts, and the window zoomed into, if any. */
function TimelineRanges({
  selection,
  onChange,
}: {
  selection: TimelineSelection
  onChange: (selection: TimelineSelection) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <div
        role="group"
        aria-label="Time range"
        className="flex rounded-lg border border-line bg-surface-2 p-0.5"
      >
        {TIMELINE_RANGES.map((range) => (
          <button
            key={range.id}
            type="button"
            title={range.label}
            aria-pressed={'range' in selection && selection.range === range.id}
            onClick={() => onChange({ range: range.id })}
            className="h-6 rounded-md px-2 text-xs font-medium text-ink-2 tabular-nums transition-colors hover:text-ink-1 aria-pressed:bg-surface aria-pressed:text-ink-1 aria-pressed:shadow-[0_0_0_1px_var(--line-strong)]"
          >
            {range.id === 'all' ? 'All' : range.id}
          </button>
        ))}
      </div>
      {'from' in selection && (
        <span className="flex h-7 items-center gap-1 rounded-full bg-accent-soft pr-1 pl-2.5 text-xs font-medium text-accent-strong tabular-nums">
          {formatMoment(selection.from, selection.to - selection.from)} –{' '}
          {formatMoment(selection.to, selection.to - selection.from)}
          <button
            type="button"
            aria-label="Reset zoom"
            title="Reset zoom"
            onClick={() => onChange({ range: selection.back })}
            className="grid size-5 place-items-center rounded-full hover:bg-accent/15"
          >
            <X className="size-3.5" />
          </button>
        </span>
      )}
    </div>
  )
}

/**
 * List | Timeline: the charts' segmented control, at the end of the toolbar. Where the toolbar is
 * short of room (a page beside an open panel), its icons alone, their words in their names.
 */
export function ShownAs({
  as,
  onAs,
  compact = false,
}: {
  as: 'list' | 'timeline'
  onAs: (as: 'list' | 'timeline') => void
  compact?: boolean
}) {
  const choices = [
    { id: 'list', label: 'List', Icon: List },
    { id: 'timeline', label: 'Timeline', Icon: ChartNoAxesGantt },
  ] as const
  return (
    <div
      role="group"
      aria-label="Show events as"
      className="flex shrink-0 rounded-lg border border-line bg-surface-2 p-0.5"
    >
      {choices.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          aria-pressed={as === id}
          title={compact ? label : undefined}
          onClick={() => onAs(id)}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-md text-[13px] font-medium text-ink-2 transition-colors hover:text-ink-1 aria-pressed:bg-surface aria-pressed:text-ink-1 aria-pressed:shadow-[0_0_0_1px_var(--line-strong)]',
            compact ? 'px-1.5' : 'px-2.5',
          )}
        >
          <Icon aria-hidden className="size-4" />
          <span className={compact ? 'sr-only' : undefined}>{label}</span>
        </button>
      ))}
    </div>
  )
}

/** An element's width, as it's laid out, measured again as it changes. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const element = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const measured = element.current
    if (!measured) return
    const measure = () => setWidth(measured.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(measured)
    return () => observer.disconnect()
  }, [])
  return [element, width]
}

/** What the shapes mean. */
function Legend() {
  return (
    <ul
      aria-label="What the marks mean"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2"
    >
      <li className="flex items-center gap-1.5">
        <Glyph warning /> Warning
      </li>
      <li className="flex items-center gap-1.5">
        <Glyph warning={false} /> Normal
      </li>
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="bg-warn-soft block h-2.5 w-5 rounded-full border border-warn/45"
        />
        Repeated, with how often
      </li>
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="grid h-4 min-w-4 place-items-center rounded-full border border-ink-3 px-1 text-2xs font-semibold"
        >
          3
        </span>
        Close together: zoom to part them
      </li>
    </ul>
  )
}

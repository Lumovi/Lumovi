/**
 * The Events timeline's sums, apart from how it's drawn: when each event happened, the rows it
 * makes (an object each on the Events page, a reason each on an object's tab), the window a range
 * or a zoom shows, and where each mark falls in it.
 */
import type { KubeObject } from '@shared/api'
import { eventCount, lastSeen } from '@shared/events'

/** What's drawn: a range back from now, or everything there is. */
export type TimelineRange = '15m' | '1h' | 'all'

export const TIMELINE_RANGES: { id: TimelineRange; label: string; ms?: number }[] = [
  { id: '15m', label: 'Last 15 minutes', ms: 15 * 60_000 },
  { id: '1h', label: 'Last hour', ms: 60 * 60_000 },
  // ("All" is all the events there are: Kubernetes keeps them for about an hour by default.)
  { id: 'all', label: 'All the events there are' },
]

/** A range that follows the clock, or a window zoomed into from one. */
export type TimelineSelection =
  { range: TimelineRange } | { from: number; to: number; back: TimelineRange }

/** One event, as the timeline draws it. */
export interface Happened {
  event: KubeObject
  /** When it first and last happened, in milliseconds; the same for an event that happened once. */
  first: number
  last: number
  count: number
  warning: boolean
  reason: string
}

/** When an event first happened: its first time, else when it was made, else its last. */
function firstSeen(event: KubeObject): string {
  return (event.firstTimestamp ??
    event.eventTime ??
    event.metadata.creationTimestamp ??
    lastSeen(event)) as string
}

export function happened(event: KubeObject): Happened {
  const last = Date.parse(lastSeen(event))
  const first = Date.parse(firstSeen(event))
  return {
    event,
    // (A first after the last, or one that doesn't read as a time, is the last: once, then.)
    first: Number.isFinite(first) && first <= last ? first : last,
    last,
    count: eventCount(event),
    warning: event.type === 'Warning',
    reason: (event.reason as string | undefined) ?? '',
  }
}

/** What a row is: an object the events are about, or (on an object's tab) a reason. */
export interface TimelineRow {
  key: string
  /** The object's kind, name and namespace; or, by reason, the reason alone as its name. */
  kind?: string
  name: string
  namespace?: string
  events: Happened[]
  /** When its first event happened: rows come in that order, so an incident reads top down. */
  first: number
}

interface Involved {
  kind?: string
  name?: string
  namespace?: string
}

/** The events in rows: one an involved object, or one a reason, each in the order it began. */
export function rowsOf(events: readonly KubeObject[], by: 'object' | 'reason'): TimelineRow[] {
  const rows = new Map<string, TimelineRow>()
  for (const event of events) {
    const one = happened(event)
    if (!Number.isFinite(one.last)) continue
    const involved = (event.involvedObject ?? {}) as Involved
    const key =
      by === 'reason'
        ? one.reason
        : `${involved.kind ?? ''}/${involved.namespace ?? ''}/${involved.name ?? ''}`
    let row = rows.get(key)
    if (!row) {
      row =
        by === 'reason'
          ? { key, name: one.reason, events: [], first: one.first }
          : {
              key,
              kind: involved.kind,
              name: involved.name ?? '',
              namespace: involved.namespace,
              events: [],
              first: one.first,
            }
      rows.set(key, row)
    }
    row.events.push(one)
    row.first = Math.min(row.first, one.first)
  }
  const ordered = [...rows.values()]
  // (Ties by name, so the same events always come in the same order.)
  const byName = (a: Happened, b: Happened) =>
    a.event.metadata.name.localeCompare(b.event.metadata.name)
  for (const row of ordered) {
    row.events.sort((a, b) => a.first - b.first || a.last - b.last || byName(a, b))
  }
  return ordered.sort((a, b) => a.first - b.first || a.key.localeCompare(b.key))
}

/** The times a selection shows, in milliseconds: back from now, or from the first event. */
export function windowOf(
  selection: TimelineSelection,
  rows: readonly TimelineRow[],
  now: number,
): { start: number; end: number } {
  if ('from' in selection) return { start: selection.from, end: selection.to }
  const range = TIMELINE_RANGES.find((r) => r.id === selection.range)!
  if (range.ms) return { start: now - range.ms, end: now }
  const first = Math.min(...rows.map((row) => row.first))
  // (Nothing there, or nothing before now: the last hour, so the axis still reads.)
  const start = Number.isFinite(first) && first < now ? first : now - 60 * 60_000
  // A little room before the first event, so its mark isn't on the edge.
  return { start: start - (now - start) * 0.02, end: now }
}

/** Zooms into a window; resetting goes back to the range it started from. */
export function zoomInto(
  selection: TimelineSelection,
  from: number,
  to: number,
): TimelineSelection {
  return { from, to, back: 'range' in selection ? selection.range : selection.back }
}

/** Whether an event happened at all in a window. */
export const within = (one: Happened, start: number, end: number) =>
  one.last >= start && one.first <= end

/**
 * What a row draws: a bar for a repeated event, a mark for one, and marks close together as one.
 * Bars that overlap in time go one above the other (`lane`, of the row's `lanes`); past three,
 * those that overlap in the last lane are one pile over their joined span, with how many.
 */
export type Mark =
  | {
      is: 'bar'
      from: number
      to: number
      one: Happened
      lane: number
      lanes: number
      count: CountAt
    }
  | { is: 'point'; at: number; one: Happened }
  | { is: 'together'; at: number; ones: Happened[] }
  | {
      is: 'pile'
      from: number
      to: number
      ones: Happened[]
      lane: number
      lanes: number
      count: CountAt
    }

/**
 * Where a bar's count (or a pile's how many) is drawn: inside it by its start, just after it,
 * before its first mark, or, where none of those has room, not at all: its card and its name
 * still say it.
 */
export type CountAt = 'inside' | 'after' | 'before' | 'none'

/** Marks closer than this, in pixels, are drawn as one, with how many. */
export const TOGETHER = 8
/** How many bars a row stacks: past that, the last lane's that overlap are one pile. */
const LANES = 3
/** The room after a bar its count takes, before the next bar in its lane may start. */
const COUNT_ROOM = 44
/** A count inside its bar is this far from its start; after it, this far from its end. */
export const COUNT_INSIDE = 10
export const COUNT_GAP = 6
/** A count before its bar ends this far before its first mark. */
export const COUNT_BEFORE = 4
/** A count's box: its width, a character at a time (the small figures), and 4 px more. */
const COUNT_CHAR = 7
const COUNT_CLEAR = 4
/** A mark's half width, and close marks' pill's. */
export const HALF_MARK = 5
const HALF_TOGETHER = 9

/**
 * A row's marks in a window of `width` pixels: a repeated event (more than once, over a while) a
 * bar from its first time to its last; one that happened once, a mark at its time; and marks
 * fewer than TOGETHER pixels apart, one mark with how many it holds. Bars that overlap (a pod's
 * BackOff while its image is pulled, made and started again and again) take a lane each, so none
 * hides another's count: in one order for every row, Warnings first, then the most repeated, then
 * the earliest, each in the top-most of three lanes free across its span. Where one finds none,
 * the first two lanes keep theirs and the rest share the third, where those that overlap (or
 * overlap through each other) are one pile: so a Warning is always on top, and a Normal event
 * never keeps a lane while a Warning is in a pile.
 */
export function marksOf(
  events: readonly Happened[],
  start: number,
  end: number,
  width: number,
): Mark[] {
  const x = (time: number) => ((time - start) / (end - start)) * width
  const shown = events.filter((one) => within(one, start, end))
  const repeated = shown
    .filter((one) => one.count > 1 && x(one.last) - x(one.first) >= TOGETHER)
    .sort(
      (a, b) =>
        Number(b.warning) - Number(a.warning) ||
        b.count - a.count ||
        a.first - b.first ||
        a.event.metadata.name.localeCompare(b.event.metadata.name),
    )
  // (What a bar takes in its lane: its span, and its count's room after it.)
  const from = (one: Happened) => x(one.first)
  const to = (one: Happened) => x(one.last) + COUNT_ROOM
  const apart = (a: Happened, b: Happened) => to(a) <= from(b) || to(b) <= from(a)
  const lanes: Happened[][] = Array.from({ length: LANES }, () => [])
  const left: Happened[] = []
  for (const one of repeated) {
    const lane = lanes.find((bars) => bars.every((bar) => apart(bar, one)))
    if (lane) lane.push(one)
    else left.push(one)
  }
  const used = lanes.filter((bars) => bars.length > 0).length
  type Stacked = Extract<Mark, { is: 'bar' | 'pile' }>
  const bar = (one: Happened, lane: number, of: number): Stacked => ({
    is: 'bar',
    from: one.first,
    to: one.last,
    one,
    lane,
    lanes: of,
    count: 'inside',
  })
  const bars: Stacked[] = []
  if (left.length === 0) {
    lanes.forEach((ones, lane) => bars.push(...ones.map((one) => bar(one, lane, used))))
  } else {
    lanes
      .slice(0, LANES - 1)
      .forEach((ones, lane) => bars.push(...ones.map((one) => bar(one, lane, LANES))))
    // The rest share the last lane: in the order they begin, each joining the pile before it
    // while it overlaps it; a pile of one is a bar.
    const last = [...lanes[LANES - 1]!, ...left].sort((a, b) => from(a) - from(b))
    let pile: Happened[] = []
    let reach = -Infinity
    const closePile = () => {
      if (pile.length === 1) bars.push(bar(pile[0]!, LANES - 1, LANES))
      if (pile.length > 1) {
        bars.push({
          is: 'pile',
          from: Math.min(...pile.map((one) => one.first)),
          to: Math.max(...pile.map((one) => one.last)),
          ones: pile,
          lane: LANES - 1,
          lanes: LANES,
          count: 'inside',
        })
      }
      pile = []
    }
    for (const one of last) {
      if (pile.length > 0 && from(one) >= reach) closePile()
      pile.push(one)
      reach = pile.length === 1 ? to(one) : Math.max(reach, to(one))
    }
    closePile()
  }
  const points = shown
    .filter((one) => !(one.count > 1 && x(one.last) - x(one.first) >= TOGETHER))
    .map((one) => ({ one, at: one.count > 1 ? one.first : one.last }))
    .sort((a, b) => a.at - b.at)
  const marks: Mark[] = []
  let group: { one: Happened; at: number }[] = []
  const close = () => {
    if (group.length === 1) marks.push({ is: 'point', at: group[0]!.at, one: group[0]!.one })
    if (group.length > 1) {
      marks.push({ is: 'together', at: group[0]!.at, ones: group.map(({ one }) => one) })
    }
    group = []
  }
  for (const point of points) {
    if (group.length > 0 && x(point.at) - x(group[0]!.at) >= TOGETHER) close()
    group.push(point)
  }
  close()
  placeCounts(bars, marks, x, width)
  return [...bars, ...marks]
}

/**
 * Where each bar's count goes, the first of these with room: inside it by its start, just after
 * it, before its first mark, or nowhere. A place has room where the count's box is inside the plot
 * (never over the names, never past now) and over no mark or bar but its own: marks are in the
 * row's middle, so they're kept clear in every lane; bars and counts, in their own.
 */
function placeCounts(
  bars: Extract<Mark, { is: 'bar' | 'pile' }>[],
  marks: readonly Mark[],
  x: (time: number) => number,
  width: number,
): void {
  type Box = { from: number; to: number; lane?: number; of?: Mark }
  const taken: Box[] = marks.map((mark) => {
    const at = x((mark as { at: number }).at)
    const half = mark.is === 'together' ? HALF_TOGETHER : HALF_MARK
    // (A repeated event too close to be a bar has its count after its mark.)
    const after =
      mark.is === 'point' && mark.one.count > 1
        ? 4 + `×${mark.one.count}`.length * COUNT_CHAR + COUNT_CLEAR
        : 0
    return { from: at - half, to: at + half + after }
  })
  const span = (mark: Mark & { from: number; to: number }) => ({
    from: Math.max(0, x(mark.from)),
    to: Math.min(width, x(mark.to)),
  })
  for (const mark of bars) {
    const { from, to } = span(mark)
    taken.push({ from: from - HALF_MARK, to, lane: mark.lane, of: mark })
  }
  for (const mark of [...bars].sort((a, b) => a.from - b.from)) {
    const { from, to } = span(mark)
    const text = mark.is === 'bar' ? `×${mark.one.count}` : `+${mark.ones.length}`
    const room = text.length * COUNT_CHAR + COUNT_CLEAR
    const before = from - HALF_MARK - COUNT_BEFORE
    const places: [CountAt, Box][] = [
      ['inside', { from: from + COUNT_INSIDE, to: from + COUNT_INSIDE + room }],
      ['after', { from: to + COUNT_GAP, to: to + COUNT_GAP + room }],
      ['before', { from: before - room, to: before }],
    ]
    const fits = ([at, box]: [CountAt, Box]) =>
      box.from >= 0 &&
      box.to <= (at === 'inside' ? to : width) &&
      taken.every(
        (t) =>
          t.of === mark ||
          (t.lane !== undefined && t.lane !== mark.lane) ||
          t.to <= box.from ||
          box.to <= t.from,
      )
    const place = places.find(fits)
    mark.count = place?.[0] ?? 'none'
    if (place) taken.push({ ...place[1], lane: mark.lane, of: mark })
  }
}

/** A row's events in the order the arrow keys step through them: by when each began. */
export const stepsOf = (row: TimelineRow, start: number, end: number) =>
  row.events.filter((one) => within(one, start, end))

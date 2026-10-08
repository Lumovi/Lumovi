/**
 * Where a chart's reference lines (requests, limits, allocatable) say what they are: at either
 * end of their line, above or below it (or a little further off), wherever the label is clear of
 * what's plotted, the other lines and the other labels. Where nothing is, it's where it's least in
 * the way, and TimeChart gives it a background.
 */

/** A rectangle, in the chart's pixels. */
export interface Box {
  x0: number
  x1: number
  y0: number
  y1: number
}

/** A label's text position: its baseline, and which end of the text `x` is. */
export interface Placement {
  x: number
  y: number
  anchor: 'start' | 'end'
  box: Box
}

/** A plotted line, in pixels: null where there's no sample. */
export type Polyline = ({ x: number; y: number } | null)[]

/** How far a label sits off its line, above (to its baseline) or below; and further off, in steps. */
const ABOVE = 5
const BELOW = 12
const STEP = 6
const STEPS = 3
/** The text's reach from its baseline, at 10.5 px: up to the caps, down to the descenders. */
const ASCENT = 8
const DESCENT = 3
/** Room kept around a label, and half a plotted line's stroke. */
const PAD = 2
const STROKE = 1

/** The box a label of `width` takes, with its baseline at `y`. */
export function textBox(x: number, y: number, width: number, anchor: 'start' | 'end'): Box {
  const x0 = anchor === 'start' ? x : x - width
  return { x0, x1: x0 + width, y0: y - ASCENT, y1: y + DESCENT }
}

/** The highest and lowest a line goes between x0 and x1, or nothing where it isn't there. */
export function spanOf(line: Polyline, x0: number, x1: number): [number, number] | undefined {
  let low = Infinity
  let high = -Infinity
  const take = (y: number) => {
    low = Math.min(low, y)
    high = Math.max(high, y)
  }
  line.forEach((p, i) => {
    if (!p) return
    if (p.x >= x0 && p.x <= x1) take(p.y)
    // Where the segment to the next point crosses the span's edges.
    const q = line[i + 1]
    if (!q) return
    for (const edge of [x0, x1]) {
      if ((p.x - edge) * (q.x - edge) < 0) take(p.y + ((edge - p.x) / (q.x - p.x)) * (q.y - p.y))
    }
  })
  return low <= high ? [low, high] : undefined
}

const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))

const intersects = (a: Box, b: Box) =>
  overlap(a.x0, a.x1, b.x0, b.x1) > 0 && overlap(a.y0, a.y1, b.y0, b.y1) > 0

/**
 * Places each line's label, top line first: at its right end, then its left, above the line,
 * then below, then a step further off each time; the first spot that's clear, or, if none is,
 * the one beside the line that's least in the way.
 */
export function placeLabels({
  lines,
  plot,
  fixed,
  obstacles,
}: {
  /** Each reference line's height, and its label's width, top down. */
  lines: { y: number; width: number }[]
  /** The plot, and how high a label may go above it. */
  plot: { left: number; right: number; ceiling: number; bottom: number }
  /** Labels already there (notes above the chart). */
  fixed: Box[]
  /** The vertical spans of what's plotted between two x positions. */
  obstacles: (x0: number, x1: number) => [number, number][]
}): (Placement & { clear: boolean })[] {
  const taken = [...fixed]
  return lines.map((line, index) => {
    const others = lines.filter((_, i) => i !== index).map((l) => l.y)
    const spots = Array.from({ length: STEPS + 1 }, (_, step) => step).flatMap((step) =>
      (['end', 'start'] as const).flatMap((anchor) =>
        [line.y - ABOVE - step * STEP, line.y + BELOW + step * STEP].map((y) => {
          const x = anchor === 'end' ? plot.right : plot.left + 6
          return { x, y, anchor, box: textBox(x, y, line.width, anchor) }
        }),
      ),
    )
    const cost = ({ box }: Placement) => {
      const padded = { x0: box.x0 - PAD, x1: box.x1 + PAD, y0: box.y0 - PAD, y1: box.y1 + PAD }
      let sum = 0
      if (box.y0 < plot.ceiling || box.y1 > plot.bottom) sum += 10_000
      for (const other of taken) if (intersects(padded, other)) sum += 1_000
      // Not on another line, nor past one: it would read as that line's.
      const far = box.y1 < line.y ? box.y0 : box.y1
      for (const y of others) {
        if ((y > padded.y0 && y < padded.y1) || (y - line.y) * (y - far) < 0) sum += 100
      }
      for (const [low, high] of obstacles(padded.x0, padded.x1)) {
        sum += overlap(low - STROKE, high + STROKE, padded.y0, padded.y1)
      }
      return sum
    }
    const costs = spots.map(cost)
    // How far a spot keeps from the nearest other line: halfway between two, it reads as either's.
    const room = ({ box }: Placement) =>
      Math.min(Infinity, ...others.map((y) => Math.max(box.y0 - y, y - box.y1)))
    // The first that's clear (or, if the other side of the line there is clear too, the one further
    // from another line); or, on a background, the least in the way of those beside the line (one
    // further off would only look like another's).
    let clearOne = costs.indexOf(0)
    // Spots come in pairs, above then below, at the same end and step.
    const pair = clearOne ^ 1
    if (clearOne >= 0 && costs[pair] === 0 && room(spots[pair]!) > room(spots[clearOne]!)) {
      clearOne = pair
    }
    const near = costs.slice(0, 4)
    const best = clearOne >= 0 ? clearOne : near.indexOf(Math.min(...near))
    taken.push(spots[best]!.box)
    return { ...spots[best]!, clear: clearOne >= 0 }
  })
}

let context: CanvasRenderingContext2D | null | undefined

/** How wide a label is, in the chart's type (10.5 px, medium). */
export function labelWidth(text: string): number {
  context ??= document.createElement('canvas').getContext('2d')
  if (!context) return text.length * 6
  context.font = `500 10.5px ${getComputedStyle(document.body).fontFamily}`
  return Math.ceil(context.measureText(text).width)
}

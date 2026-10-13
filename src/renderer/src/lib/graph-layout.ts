/**
 * Where a graph's cards go: the kit's Graph, laid out as Lumovi lays out its own map of a
 * workload (`map-layout.ts`, whose rows, order and lanes these are), but of cards a plugin
 * describes, so nothing here knows a kind. In rows, top to bottom in the direction of the lines;
 * each row ordered to keep lines from crossing, and as wide as there's room for. Rows that don't
 * fit end in a "+N more" card until they're opened.
 *
 * A loop is broken where it turns back: that one line runs up the cards' right side and ends in an
 * arrowhead, the only one drawn, since there the rows can't say the direction.
 */
import { HEALTH_RANK, type Health } from '@shared/health'

export const CARD_HEIGHT = 56
const GAP_X = 12
/** Between rows, where the lines run. */
const GAP_Y = 44
/** Between the lines of a row that's opened. */
const LINE_GAP = 12
const MIN_WIDTH = 210
const MAX_WIDTH = 252
/** Room at the right for lines that turn back, where there are any. */
export const BACK_ROOM = 40

/** A card, as its layout needs it: its key, and how well what it stands for is. */
export interface LaidNode {
  key: string
  level?: Health
}

/** A line, as its layout needs it. */
export interface LaidEdge {
  from: string
  to: string
  label?: string
}

export interface PlacedCard<N extends LaidNode> {
  /** A card, or a row's "+N more". */
  node?: N
  more?: { row: number; count: number }
  key: string
  x: number
  y: number
  width: number
}

export interface PlacedEdge<E extends LaidEdge> {
  key: string
  /** The cards it's drawn between (a row's "+N more" for a card not shown). */
  from: string
  to: string
  edge: E
  /** An SVG path from the bottom of one card to the top of the other. */
  path: string
  /** A line that turns back: drawn up the cards' right side, ending in an arrowhead at `to`. */
  back?: boolean
  /** Where its label sits, on the line where it's halfway; none where another said it already. */
  label?: { x: number; y: number }
}

export interface GraphLayout<N extends LaidNode, E extends LaidEdge> {
  cards: PlacedCard<N>[]
  edges: PlacedEdge<E>[]
  height: number
}

const levelRank = (node: LaidNode) => HEALTH_RANK[node.level ?? 'neutral']

/** Lines by the card they leave, each in the description's order: pushed to, never copied. */
function outOf<E extends LaidEdge>(edges: readonly E[]): Map<string, E[]> {
  const out = new Map<string, E[]>()
  for (const e of edges) {
    const list = out.get(e.from)
    if (list) list.push(e)
    else out.set(e.from, [e])
  }
  return out
}

/**
 * The lines that turn back: those that would lead round in a circle. One walk, depth first and
 * without recursion, from each card in the description's order along its lines in theirs: a line
 * to a card still on the walk's path closes a circle, and is the one left out (a failed test
 * sending a workflow back to its build). What's left leads round in none.
 */
function turning<E extends LaidEdge>(keys: readonly string[], edges: readonly E[]): Set<E> {
  const out = outOf(edges)
  const back = new Set<E>()
  /** 1: on the path being walked; 2: done. */
  const state = new Map<string, 1 | 2>()
  for (const start of keys) {
    if (state.has(start)) continue
    const path: { key: string; next: number }[] = [{ key: start, next: 0 }]
    state.set(start, 1)
    while (path.length > 0) {
      const at = path.at(-1)!
      const line = out.get(at.key)?.[at.next++]
      if (!line) {
        state.set(at.key, 2)
        path.pop()
      } else if (line.from === line.to) {
        // (A line to itself says nothing of rows.)
      } else if (state.get(line.to) === 1) {
        back.add(line)
      } else if (!state.has(line.to)) {
        state.set(line.to, 1)
        path.push({ key: line.to, next: 0 })
      }
    }
  }
  return back
}

/**
 * Each card's row, by the lines that lead down: one below everything that leads to it, by the
 * longest way down, taken in order (each card once all that leads to it is placed); sources just
 * above what they lead to. No row is empty, and no two cards with a line between them share one.
 */
function rowsBy(keys: readonly string[], down: readonly LaidEdge[]): Map<string, number> {
  const rank = new Map(keys.map((key) => [key, 0]))
  const into = new Map(keys.map((key) => [key, 0]))
  for (const { to } of down) into.set(to, into.get(to)! + 1)
  const out = outOf(down)
  const sources = keys.filter((key) => into.get(key) === 0)
  const ready = [...sources]
  const waiting = new Map(into)
  while (ready.length > 0) {
    const key = ready.pop()!
    for (const { to } of out.get(key) ?? []) {
      if (rank.get(to)! < rank.get(key)! + 1) rank.set(to, rank.get(key)! + 1)
      const left = waiting.get(to)! - 1
      waiting.set(to, left)
      if (left === 0) ready.push(to)
    }
  }
  // Sources sit just above what they lead to (one that leads nowhere stays where it is).
  for (const key of sources) {
    const lines = out.get(key)
    if (!lines?.length) continue
    let nearest = Infinity
    for (const { to } of lines) nearest = Math.min(nearest, rank.get(to)!)
    rank.set(key, nearest - 1)
  }
  // Rows are counted from the top, with none left out.
  const rows = [...new Set(rank.values())].sort((a, b) => a - b)
  const index = new Map(rows.map((r, i) => [r, i]))
  return new Map([...rank].map(([key, r]) => [key, index.get(r)!]))
}

/** Each card's row, and which lines turn back. */
export function ranks<E extends LaidEdge>(
  nodes: readonly LaidNode[],
  edges: readonly E[],
): { rank: Map<string, number>; back: Set<E> } {
  const keys = nodes.map((n) => n.key)
  const back = turning(keys, edges)
  const rank = rowsBy(
    keys,
    edges.filter((e) => e.from !== e.to && !back.has(e)),
  )
  return { rank, back }
}

/** Down, across and down again, with rounded corners. */
function squared(x1: number, y1: number, x2: number, y2: number, lane: number): string {
  if (Math.abs(x2 - x1) < 1) return `M ${x1} ${y1} V ${y2}`
  const dir = x2 > x1 ? 1 : -1
  const r = Math.min(8, Math.abs(x2 - x1) / 2, lane - y1, y2 - lane)
  return [
    `M ${x1} ${y1}`,
    `V ${lane - r}`,
    `Q ${x1} ${lane} ${x1 + dir * r} ${lane}`,
    `H ${x2 - dir * r}`,
    `Q ${x2} ${lane} ${x2} ${lane + r}`,
    `V ${y2}`,
  ].join(' ')
}

/** Out of a card's right side, up beside the cards, and back into the other's right side. */
function turnedBack(from: PlacedCard<LaidNode>, to: PlacedCard<LaidNode>, out: number): string {
  const y1 = from.y + CARD_HEIGHT / 2
  const y2 = to.y + CARD_HEIGHT / 2
  const x1 = from.x + from.width
  const x2 = to.x + to.width
  const r = Math.min(8, Math.abs(y1 - y2) / 2)
  return [
    `M ${x1} ${y1}`,
    `H ${out - r}`,
    `Q ${out} ${y1} ${out} ${y1 - r}`,
    `V ${y2 + r}`,
    `Q ${out} ${y2} ${out - r} ${y2}`,
    `H ${x2}`,
  ].join(' ')
}

/** A graph's cards in their rows, the lines between cards there are, and those that turn back. */
export interface Shape<N extends LaidNode, E extends LaidEdge> {
  rows: N[][]
  lines: E[]
  back: Set<E>
}

/**
 * A graph's cards in their rows, each row in the picture's order, left to right: what a layout
 * places, whatever its width, and the order its table lists them in. Unless `placed` is false
 * (a graph past the ceiling, which is only listed), each row is ordered to keep lines from
 * crossing, by where what leads to its cards is, and then the rows above by where theirs lead;
 * otherwise, and among equals, as given.
 */
export function orderRows<N extends LaidNode, E extends LaidEdge>(
  nodes: readonly N[],
  edges: readonly E[],
  { placed = true }: { placed?: boolean } = {},
): Shape<N, E> {
  const known = new Set(nodes.map((n) => n.key))
  const lines = edges.filter((e) => known.has(e.from) && known.has(e.to))
  const { rank, back } = ranks(nodes, lines)
  const rows: N[][] = []
  // (In the description's order: so each row starts as given.)
  for (const node of nodes) (rows[rank.get(node.key)!] ??= []).push(node)
  if (!placed) return { rows, lines, back }

  const given = new Map(nodes.map((n, i) => [n.key, i]))
  const position = new Map<string, number>()
  const asGiven = (a: N, b: N) => given.get(a.key)! - given.get(b.key)!
  const placeRow = (row: N[]) => row.forEach((n, i) => position.set(n.key, (i + 0.5) / row.length))
  // What leads to each card, and what it leads to, down the lines: looked up, never searched for.
  const parents = new Map<string, string[]>()
  const children = new Map<string, string[]>()
  for (const e of lines) {
    if (back.has(e) || e.from === e.to) continue
    const up = parents.get(e.to)
    if (up) up.push(e.from)
    else parents.set(e.to, [e.from])
    const down = children.get(e.from)
    if (down) down.push(e.to)
    else children.set(e.from, [e.to])
  }
  const mean = (keys: string[] | undefined) => {
    let sum = 0
    let count = 0
    for (const key of keys ?? []) {
      const at = position.get(key)
      if (at === undefined) continue
      sum += at
      count++
    }
    return count > 0 ? sum / count : undefined
  }
  for (const row of rows) {
    const keys = new Map(
      row.map((n, i) => [n.key, mean(parents.get(n.key)) ?? (i + 0.5) / row.length]),
    )
    row.sort((a, b) => keys.get(a.key)! - keys.get(b.key)! || asGiven(a, b))
    placeRow(row)
  }
  // And the rows above by what they lead to, now that those have places (ties keep theirs).
  for (let r = rows.length - 2; r >= 0; r--) {
    const row = rows[r]!
    const keys = new Map(row.map((n) => [n.key, mean(children.get(n.key)) ?? position.get(n.key)!]))
    row.sort(
      (a, b) => keys.get(a.key)! - keys.get(b.key)! || position.get(a.key)! - position.get(b.key)!,
    )
    placeRow(row)
  }
  return { rows, lines, back }
}

/**
 * The part of a graph's shape a filter keeps: its rows as they were (empty ones gone), its lines
 * between cards kept. Nothing is ordered again: what's kept stays where it was in the order.
 */
export function keptOf<N extends LaidNode, E extends LaidEdge>(
  shape: Shape<N, E>,
  kept: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): Shape<N, E> {
  const rows = shape.rows
    .map((row) => row.filter((card) => kept.has(card.key)))
    .filter((row) => row.length > 0)
  const lines = shape.lines.filter((e) => kept.has(e.from) && kept.has(e.to))
  return { rows, lines, back: new Set(lines.filter((e) => shape.back.has(e))) }
}

/**
 * Places a graph's shape (`orderRows`, or what a filter kept of it) `width` wide, with the rows in
 * `open` shown in full: nothing is ordered here, so a width or a filter never orders it again.
 * What shows of a row that doesn't fit is what's worst, then what comes first.
 */
export function layoutGraph<N extends LaidNode, E extends LaidEdge>(
  shape: Shape<N, E>,
  width: number,
  open: ReadonlySet<number>,
): GraphLayout<N, E> {
  const { rows, lines, back } = shape
  const given = new Map(rows.flat().map((n, i) => [n.key, i]))
  const room = back.size > 0 ? width - BACK_ROOM : width
  const perLine = Math.max(1, Math.floor((room + GAP_X) / (MIN_WIDTH + GAP_X)))
  const cardWidth = Math.min(MAX_WIDTH, (room - (perLine - 1) * GAP_X) / perLine)

  const priority = (n: N) => levelRank(n) * 100_000 + given.get(n.key)!
  const cards: PlacedCard<N>[] = []
  const at = new Map<string, PlacedCard<N>>()
  let y = 0
  rows.forEach((row, r) => {
    let shown: (N | 'more')[] = row
    if (row.length > perLine && !open.has(r)) {
      const visible = new Set(
        [...row].sort((a, b) => priority(a) - priority(b)).slice(0, perLine - 1),
      )
      shown = [...row.filter((n) => visible.has(n)), 'more']
    }
    for (let start = 0; start < shown.length; start += perLine) {
      const line = shown.slice(start, start + perLine)
      const lineWidth = line.length * cardWidth + (line.length - 1) * GAP_X
      line.forEach((item, i) => {
        const x = (room - lineWidth) / 2 + i * (cardWidth + GAP_X)
        const card: PlacedCard<N> =
          item === 'more'
            ? {
                key: `more:${r}`,
                more: { row: r, count: row.length - perLine + 1 },
                x,
                y,
                width: cardWidth,
              }
            : { key: item.key, node: item, x, y, width: cardWidth }
        cards.push(card)
        if (item !== 'more') at.set(item.key, card)
      })
      y += CARD_HEIGHT + (start + perLine < shown.length ? LINE_GAP : GAP_Y)
    }
    // Lines to hidden cards go to the row's "+N more".
    const more = cards.find((c) => c.more?.row === r)
    if (more) for (const n of row) if (!at.has(n.key)) at.set(n.key, more)
  })

  // Lines leave the middle of a card's bottom and arrive at the middle of another's top; one
  // that turns back leaves and arrives at their right sides.
  const pairs = new Map<string, { from: PlacedCard<N>; to: PlacedCard<N>; edge: E }>()
  const turned = new Map<string, { from: PlacedCard<N>; to: PlacedCard<N>; edge: E }>()
  for (const edge of lines) {
    if (edge.from === edge.to) continue
    if (back.has(edge)) {
      const from = at.get(edge.from)!
      const to = at.get(edge.to)!
      const key = `${from.key}<${to.key}`
      if (from !== to) turned.set(key, turned.get(key) ?? { from, to, edge })
      continue
    }
    // (One of two shown in a row's opened lines may lead to one beside it: drawn from the one above.)
    const [from, to] = [at.get(edge.from)!, at.get(edge.to)!].sort((a, b) => a.y - b.y) as [
      PlacedCard<N>,
      PlacedCard<N>,
    ]
    if (from === to) continue
    pairs.set(`${from.key}>${to.key}`, pairs.get(`${from.key}>${to.key}`) ?? { from, to, edge })
  }
  const center = (card: PlacedCard<N>) => card.x + card.width / 2

  // In the gap above a row, the lines of one card fanning out, or of many going into one,
  // share a lane, like an organisation chart's; lanes only multiply where lines would overlap.
  const outs = new Map<string, number>()
  for (const { from } of pairs.values()) outs.set(from.key, (outs.get(from.key) ?? 0) + 1)
  type Bus = { gap: number; keys: string[]; start: number; end: number }
  const buses = new Map<string, Bus>()
  for (const [key, { from, to }] of pairs) {
    const id = outs.get(from.key)! > 1 ? `from:${from.key}@${to.y}` : `to:${to.key}`
    const [a, b] = [center(from), center(to)].sort((m, n) => m - n)
    const bus = buses.get(id) ?? { gap: to.y, keys: [], start: a!, end: b! }
    bus.keys.push(key)
    bus.start = Math.min(bus.start, a!)
    bus.end = Math.max(bus.end, b!)
    buses.set(id, bus)
  }
  const laneOf = new Map<string, { index: number; of: number }>()
  const byGap = new Map<number, Bus[]>()
  for (const bus of buses.values()) byGap.set(bus.gap, [...(byGap.get(bus.gap) ?? []), bus])
  for (const group of byGap.values()) {
    const ends: number[] = []
    const lane = new Map<Bus, number>()
    for (const bus of group.sort((a, b) => a.start - b.start)) {
      let i = ends.findIndex((end) => end < bus.start - 8)
      if (i === -1) i = ends.push(0) - 1
      ends[i] = bus.end
      lane.set(bus, i)
    }
    for (const [bus, index] of lane) {
      for (const key of bus.keys) laneOf.set(key, { index, of: ends.length })
    }
  }

  // A label is said once among the lines into one card: on the first of those that carry it.
  const said = new Set<string>()
  const labelled = (edge: E, to: string) => {
    if (!edge.label) return false
    const once = `${to}\u0000${edge.label}`
    if (said.has(once)) return false
    said.add(once)
    return true
  }

  const placed: PlacedEdge<E>[] = [...pairs].map(([key, { from, to, edge }]) => {
    const y1 = from.y + CARD_HEIGHT
    const y2 = to.y
    const gap = Math.min(GAP_Y, y2 - y1)
    const { index, of } = laneOf.get(key)!
    const step = Math.min(8, (gap - 16) / Math.max(1, of - 1))
    const lane = y2 - gap / 2 + (index - (of - 1) / 2) * step
    const straight = Math.abs(center(to) - center(from)) < 1
    return {
      key,
      from: from.key,
      to: to.key,
      edge,
      path: squared(center(from), y1, center(to), y2, lane),
      ...(labelled(edge, to.key) && {
        // Halfway: on its lane between the two, or halfway down a straight one.
        label: straight
          ? { x: center(to), y: (y1 + y2) / 2 }
          : { x: (center(from) + center(to)) / 2, y: lane },
      }),
    }
  })
  const out = room + BACK_ROOM / 2
  for (const [key, { from, to, edge }] of turned) {
    placed.push({
      key,
      from: from.key,
      to: to.key,
      edge,
      back: true,
      path: turnedBack(from, to, out),
      ...(labelled(edge, to.key) && {
        label: { x: out, y: (from.y + to.y + CARD_HEIGHT) / 2 },
      }),
    })
  }
  return { cards, edges: placed, height: Math.max(0, y - GAP_Y) }
}

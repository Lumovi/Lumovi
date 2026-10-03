/**
 * Where a map's nodes go: in rows, top to bottom in the direction of their
 * relations (traffic to services to workloads to pods to nodes), each row
 * ordered to keep lines from crossing, and as wide as there's room for.
 * Rows that don't fit end in a "+N more" card until they're opened.
 */
import { HEALTH_RANK } from './health'
import { nodeStatus, type MapEdge, type MapGraph, type MapNode } from './map'

export const CARD_HEIGHT = 56
const GAP_X = 12
/** Between rows, where the lines run. */
const GAP_Y = 44
/** Between the lines of a row that's opened. */
const LINE_GAP = 12
const MIN_WIDTH = 210
const MAX_WIDTH = 252

export interface PlacedCard {
  /** A node, or a row's "+N more". */
  node?: MapNode
  more?: { row: number; count: number }
  key: string
  x: number
  y: number
  width: number
}

export interface PlacedEdge {
  key: string
  from: string
  to: string
  edge: MapEdge
  /** An SVG path from the bottom of one card to the top of the other. */
  path: string
}

export interface MapLayout {
  cards: PlacedCard[]
  edges: PlacedEdge[]
  height: number
}

/** Kinds in the order they read best in a row, left to right. */
const KIND_ORDER = [
  'Gateway',
  'HTTPRoute',
  'Ingress',
  'Service',
  'NetworkPolicy',
  'PodDisruptionBudget',
  'HorizontalPodAutoscaler',
  'CronJob',
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'Job',
  'ReplicaSet',
  'Pod',
  'ConfigMap',
  'Secret',
  'ServiceAccount',
  'PersistentVolumeClaim',
  'Node',
  'PersistentVolume',
  'StorageClass',
]
const kindRank = (node: MapNode) => {
  const i = KIND_ORDER.indexOf(node.kind.split('.')[0]!)
  return i === -1 ? KIND_ORDER.length : i
}

/** Each node's row: one below everything that leads to it; sources just above what they lead to. */
export function ranks(graph: MapGraph): Map<string, number> {
  const rank = new Map([...graph.nodes.keys()].map((id) => [id, 0]))
  // Longest paths, as long as there are no cycles (owner references can't make one; a bad
  // selector could): at most as many rounds as there are nodes.
  for (let round = 0; round < graph.nodes.size; round++) {
    let changed = false
    for (const { from, to } of graph.edges) {
      if (rank.get(to)! < rank.get(from)! + 1) {
        rank.set(to, rank.get(from)! + 1)
        changed = true
      }
    }
    if (!changed) break
  }
  // Sources (all lead somewhere: the map has no loose ends) sit just above what they lead to.
  const sources = [...graph.nodes.keys()].filter((id) => !graph.edges.some((e) => e.to === id))
  for (const id of sources) {
    rank.set(
      id,
      Math.min(...graph.edges.filter((e) => e.from === id).map((e) => rank.get(e.to)!)) - 1,
    )
  }
  const top = Math.min(...rank.values())
  return new Map([...rank].map(([id, r]) => [id, r - top]))
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

/** Lays `graph` out `width` wide, with the rows in `open` shown in full. */
export function layoutMap(graph: MapGraph, width: number, open: ReadonlySet<number>): MapLayout {
  const rank = ranks(graph)
  const rows: MapNode[][] = []
  for (const node of graph.nodes.values()) (rows[rank.get(node.id)!] ??= []).push(node)
  const perLine = Math.max(1, Math.floor((width + GAP_X) / (MIN_WIDTH + GAP_X)))
  const cardWidth = Math.min(MAX_WIDTH, (width - (perLine - 1) * GAP_X) / perLine)

  // Order each row by where what leads to it is, then by kind and name.
  const position = new Map<string, number>()
  const byKind = (a: MapNode, b: MapNode) =>
    kindRank(a) - kindRank(b) || a.name.localeCompare(b.name)
  const placeRow = (row: MapNode[]) =>
    row.forEach((n, i) => position.set(n.id, (i + 0.5) / row.length))
  const around = (id: string, side: 'from' | 'to') => {
    const other = side === 'from' ? 'to' : 'from'
    const xs = graph.edges
      .filter((e) => e[other] === id && position.has(e[side]))
      .map((e) => position.get(e[side])!)
    return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined
  }
  for (const row of rows) row.sort(byKind)
  for (const row of rows) {
    const keys = new Map(row.map((n, i) => [n.id, around(n.id, 'from') ?? (i + 0.5) / row.length]))
    row.sort((a, b) => keys.get(a.id)! - keys.get(b.id)! || byKind(a, b))
    placeRow(row)
  }
  // And the rows above by what they lead to, now that those have places (ties keep theirs).
  for (let r = rows.length - 2; r >= 0; r--) {
    const row = rows[r]!
    const keys = new Map(row.map((n) => [n.id, around(n.id, 'to') ?? position.get(n.id)!]))
    row.sort(
      (a, b) => keys.get(a.id)! - keys.get(b.id)! || position.get(a.id)! - position.get(b.id)!,
    )
    placeRow(row)
  }

  // What shows of a row that doesn't fit: the map's own node, what's unwell, what goes by its
  // name (its Service, its autoscaler), then kinds in their order.
  const focusName = graph.nodes.get(graph.focus)!.name
  const priority = (n: MapNode) =>
    (n.id === graph.focus ? 0 : 10_000) +
    HEALTH_RANK[nodeStatus(n)?.health ?? 'neutral'] * 1_000 +
    (n.name === focusName ? 0 : 100) +
    kindRank(n)

  const cards: PlacedCard[] = []
  const at = new Map<string, PlacedCard>()
  let y = 0
  rows.forEach((row, r) => {
    let shown: (MapNode | 'more')[] = row
    if (row.length > perLine && !open.has(r) && !row.some((n) => n.unfolded)) {
      const visible = new Set(
        [...row].sort((a, b) => priority(a) - priority(b)).slice(0, perLine - 1),
      )
      shown = [...row.filter((n) => visible.has(n)), 'more']
    }
    for (let start = 0; start < shown.length; start += perLine) {
      const line = shown.slice(start, start + perLine)
      const lineWidth = line.length * cardWidth + (line.length - 1) * GAP_X
      line.forEach((item, i) => {
        const x = (width - lineWidth) / 2 + i * (cardWidth + GAP_X)
        const card: PlacedCard =
          item === 'more'
            ? {
                key: `more:${r}`,
                more: { row: r, count: row.length - perLine + 1 },
                x,
                y,
                width: cardWidth,
              }
            : { key: item.id, node: item, x, y, width: cardWidth }
        cards.push(card)
        if (item !== 'more') at.set(item.id, card)
      })
      y += CARD_HEIGHT + (start + perLine < shown.length ? LINE_GAP : GAP_Y)
    }
    // Lines to hidden nodes go to the row's "+N more".
    const more = cards.find((c) => c.more?.row === r)
    if (more) for (const n of row) if (!at.has(n.id)) at.set(n.id, more)
  })

  // Lines leave the middle of a card's bottom and arrive at the middle of another's top.
  const pairs = new Map<string, { from: PlacedCard; to: PlacedCard; edge: MapEdge }>()
  for (const edge of graph.edges) {
    const from = at.get(edge.from)!
    const to = at.get(edge.to)!
    pairs.set(`${from.key}>${to.key}`, pairs.get(`${from.key}>${to.key}`) ?? { from, to, edge })
  }
  const center = (card: PlacedCard) => card.x + card.width / 2

  // In the gap above a row, the lines of one card fanning out, or of many going into one,
  // share a lane, like an organisation chart's; lanes only multiply where lines would overlap.
  const outs = new Map<string, number>()
  for (const { from } of pairs.values()) outs.set(from.key, (outs.get(from.key) ?? 0) + 1)
  const buses = new Map<string, { gap: number; keys: string[]; start: number; end: number }>()
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
  type Bus = { gap: number; keys: string[]; start: number; end: number }
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

  const edges: PlacedEdge[] = [...pairs].map(([key, { from, to, edge }]) => {
    const y1 = from.y + CARD_HEIGHT
    const y2 = to.y
    const gap = Math.min(GAP_Y, y2 - y1)
    const { index, of } = laneOf.get(key)!
    const step = Math.min(8, (gap - 16) / Math.max(1, of - 1))
    const lane = y2 - gap / 2 + (index - (of - 1) / 2) * step
    return {
      key,
      from: from.key,
      to: to.key,
      edge,
      path: squared(center(from), y1, center(to), y2, lane),
    }
  })
  return { cards, edges, height: Math.max(0, y - GAP_Y) }
}

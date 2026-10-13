/**
 * A graph's table, and its filter: the same cards the picture draws, listed as the kit's Table
 * lists rows, nesting as deep as the lines go. The plugin never describes it; it's made here,
 * once for each graph, from the graph's shape (`orderRows`) and in its order, so a phone, the
 * keys and a screen reader have one order with the picture. The filter works on these rows.
 *
 * The cards nothing leads to come first; under each card, the cards its lines lead to. A card
 * with two parents is listed whole under the first, and under the others as a row that says where
 * it's first; so is a card a line turns back to. A line's label joins its row's line under
 * ("ConfigMap · mounts").
 *
 * Nothing here calls itself: a plugin's graph may be as deep as it has cards, and no depth it
 * gives can run Lumovi out of stack.
 */
import { HEALTH_RANK } from '@shared/health'
import type { Their } from '@shared/kit/declare'
import type { GraphEdge, GraphNode } from '@shared/kit/graph'
import type { DrawnRow } from '@shared/kit/table'
import type { LaidEdge, LaidNode, Shape } from './graph-layout'

/** A card as the layout and the table take it: its key, its level, and the card itself. */
export interface Card extends LaidNode {
  node: GraphNode
}

/** A line as the layout and the table take it. */
export interface Line extends LaidEdge {
  edge: GraphEdge
}

/** A graph's cards and lines, by their keys as written. */
export function cardsOf(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): { cards: Card[]; lines: Line[] } {
  return {
    cards: nodes.map((node) => ({
      key: node.key.their,
      level: node.status?.level,
      node,
    })),
    lines: edges.map((edge) => ({
      from: edge.from.their,
      to: edge.to.their,
      label: edge.label?.their || undefined,
      edge,
    })),
  }
}

/** A text of the plugin's, written by joining two: "ConfigMap · mounts". */
const joined = (...texts: (Their | undefined)[]): Their | undefined => {
  const words = texts.map((text) => text?.their ?? '').filter(Boolean)
  return words.length ? { their: words.join(' · ') } : undefined
}

/** A row the table is built from: its row, and the rows it holds, filled in as they're made. */
interface Building {
  row: DrawnRow
  rows: Building[]
}

/** Rows built from the bottom up, with no call for each level: each one's rows set before it. */
function finished(tops: readonly Building[]): DrawnRow[] {
  // In order, each before what's inside it; then backwards, so what's inside is done first.
  const all: Building[] = []
  const todo = [...tops].reverse()
  while (todo.length > 0) {
    const next = todo.pop()!
    all.push(next)
    for (let i = next.rows.length - 1; i >= 0; i--) todo.push(next.rows[i]!)
  }
  const done = new Map<Building, DrawnRow>()
  for (let i = all.length - 1; i >= 0; i--) {
    const each = all[i]!
    done.set(
      each,
      each.rows.length
        ? { ...each.row, rows: each.rows.map((inside) => done.get(inside)!) }
        : each.row,
    )
  }
  return tops.map((top) => done.get(top)!)
}

/** The graph's table: its rows, in its shape's order, nesting as deep as the lines go. */
export function tableOf<C extends Card, L extends Line>(shape: Shape<C, L>): DrawnRow[] {
  const { rows, lines, back } = shape
  // Where each card is in the picture: by its row, then left to right; the worst first among equals.
  const place = new Map<string, number>()
  const byKey = new Map<string, C>()
  rows.forEach((row, r) =>
    row.forEach((card, i) => {
      place.set(card.key, r * 1_000_000 + i)
      byKey.set(card.key, card)
    }),
  )
  const order = (a: C, b: C) =>
    place.get(a.key)! - place.get(b.key)! ||
    HEALTH_RANK[a.level ?? 'neutral'] - HEALTH_RANK[b.level ?? 'neutral']
  const under = new Map<string, L[]>()
  const led = new Set<string>()
  for (const line of lines) {
    if (line.from === line.to) continue
    const list = under.get(line.from)
    if (list) list.push(line)
    else under.set(line.from, [line])
    if (!back.has(line)) led.add(line.to)
  }
  for (const list of under.values()) list.sort((a, b) => order(byKey.get(a.to)!, byKey.get(b.to)!))

  /** Where each card was listed first: under whom (none, at the top). */
  const first = new Map<string, C | undefined>()
  const tops: Building[] = []
  // Depth first, as a table is read, with a stack of what's still to list (the next on top).
  const todo: { card: C; parent?: C; line?: L; into: Building[] }[] = []
  const roots = rows
    .flat()
    .filter((card) => !led.has(card.key))
    .sort(order)
  for (let i = roots.length - 1; i >= 0; i--) todo.push({ card: roots[i]!, into: tops })
  while (todo.length > 0) {
    const { card, parent, line, into } = todo.pop()!
    const label = line?.edge.label
    if (first.has(card.key)) {
      into.push({
        row: {
          key: card.node.key,
          lead: { name: card.node.name, under: joined(card.node.kind, label) },
          // (Its lead only: in place of its cells, where it's first.)
          cells: [],
          again: {
            first: card.key,
            under: first.get(card.key)?.node.name,
            ...(line && back.has(line) && { back: true }),
          },
        },
        rows: [],
      })
      continue
    }
    first.set(card.key, parent)
    const { node } = card
    const building: Building = {
      row: {
        key: node.key,
        lead: { level: node.status?.level, name: node.name, under: joined(node.kind, label) },
        cells: node.cells,
        opens: node.opens,
      },
      rows: [],
    }
    into.push(building)
    const inside = under.get(card.key) ?? []
    for (let i = inside.length - 1; i >= 0; i--) {
      const next = inside[i]!
      todo.push({ card: byKey.get(next.to)!, parent: card, line: next, into: building.rows })
    }
  }
  return finished(tops)
}

/**
 * A card a filter keeps: one that matches, or one above a match, kept for where the match is
 * ("shown for context").
 */
export type Kept = 'match' | 'context'

/**
 * What a filter keeps of a graph's table: each row whose card matches by its name or its kind
 * word (in the table, by its cells too), as written and whatever the case, and every row above
 * one. A row listed again for a line that turns back keeps nothing above it, so a loop can't
 * make every card context. Nothing typed keeps everything as it is.
 */
export function filterRows(
  rows: readonly DrawnRow[],
  sought: string,
  { cells = false }: { cells?: boolean } = {},
): { rows: readonly DrawnRow[]; kept: Map<string, Kept>; matches: number } {
  const want = sought.trim().toLowerCase()
  const kept = new Map<string, Kept>()
  const keyOf = (row: DrawnRow) => row.key.their
  if (!want) {
    // (Every card, by walking the rows once: what the picture shows of them.)
    const todo = [...rows]
    while (todo.length > 0) {
      const row = todo.pop()!
      if (!row.again) kept.set(keyOf(row), 'match')
      if (row.rows) todo.push(...row.rows)
    }
    return { rows, kept, matches: kept.size }
  }
  const has = (text: Their | undefined) => (text?.their ?? '').toLowerCase().includes(want)
  const matching = (row: DrawnRow) =>
    has(row.lead.name) ||
    has(row.lead.under) ||
    (cells &&
      row.cells.some(
        (cell) =>
          ('text' in cell && has(cell.text)) ||
          ('word' in cell && has(cell.word)) ||
          ('label' in cell && has(cell.label)),
      ))
  // Every row, each before what's inside it, with its parent's place; then backwards, inside first.
  const all: { row: DrawnRow; parent: number }[] = []
  const todo = [...rows].reverse().map((row) => ({ row, parent: -1 }))
  while (todo.length > 0) {
    const next = todo.pop()!
    const at = all.push(next) - 1
    const inside = next.row.rows ?? []
    for (let i = inside.length - 1; i >= 0; i--) todo.push({ row: inside[i]!, parent: at })
  }
  const keep = new Array<DrawnRow | undefined>(all.length)
  const insideOf = new Map<number, DrawnRow[]>()
  const matched = new Set<string>()
  for (let i = all.length - 1; i >= 0; i--) {
    const { row, parent } = all[i]!
    // (Gathered backwards: turned round, they're in order.)
    const inside = (insideOf.get(i) ?? []).reverse()
    const own = matching(row) && !row.again?.back
    if (own && !row.again) matched.add(keyOf(row))
    if (!own && inside.length === 0) continue
    keep[i] = inside.length ? { ...row, rows: inside } : { ...row, rows: undefined }
    if (!row.again && !kept.has(keyOf(row))) kept.set(keyOf(row), 'context')
    if (parent >= 0) {
      const list = insideOf.get(parent)
      if (list) list.push(keep[i]!)
      else insideOf.set(parent, [keep[i]!])
    }
  }
  // A card that matches is a match, wherever else it's kept for context.
  for (const key of matched) kept.set(key, 'match')
  return {
    rows: all.flatMap((each, i) => (each.parent === -1 && keep[i] ? [keep[i]!] : [])),
    kept,
    matches: matched.size,
  }
}

/**
 * The kit's Graph, declared: what a plugin may say to have Lumovi draw things that lead to other
 * things (an application's resources, a workflow's steps, who talks to whom). Cards, and the lines
 * between them, and nothing of where they go: Lumovi lays them out in rows by the lines'
 * direction, as it lays out its own map of a workload, and lists the same cards as a table whose
 * rows nest. That table is what a phone shows, what's shown past the ceiling, and what a person
 * may switch to; the plugin never describes it.
 *
 * One declaration (`graph`), in the Table's way, and its types worked out from it. A card's row in
 * the table is a Table row: the same columns and cells, so a graph's table is the kit's own Table.
 * What the kinds can't say (a key used twice, a line to a card that isn't there, a card with an
 * object and an icon both) is the door's to refuse, by `graphProblem`.
 */
import { VIEW_ICON_NAMES } from '../plugins'
import {
  destination,
  handler,
  list,
  object,
  oneOf,
  record,
  text,
  yesOrNo,
  type Part,
  type PropsOf,
} from './declare'
import { cell, cellsProblem, column, HEALTHS, state, TABLE_LIMITS } from './table'

/** How much may be said, and how much is drawn. */
export const GRAPH_LIMITS = {
  /**
   * Past either, the part is its table, and says why: a picture of more can't be read. Not a
   * refusal: the graph is taken, and listed.
   */
  drawn: { cards: 300, lines: 600 },
  /** Cards at all: as many as a table's rows. */
  cards: TABLE_LIMITS.rows,
  /** Lines at all. */
  lines: 2 * TABLE_LIMITS.rows,
  /** Characters of a name, a word, or a line's label. */
  text: TABLE_LIMITS.text,
  /** Of a line's label, what's drawn on its line; the rest is cut at its end, and said whole. */
  label: 16,
} as const

const name = text(GRAPH_LIMITS.text)

/** What a card is: a row of the table too, and what lines name. */
const node = record(
  {
    /** Its own among the graph's cards, and the same from one description to the next. */
    key: name,
    name,
    /** A quiet word on its first line, before its Status: what it is ("Deployment", "Step"). */
    kind: name,
    /** A word after it, quieter still ("4f1c9aa", "1 of 4"): cut first where there's no room. */
    beside: name,
    /**
     * Its icon, from the set a view picks from. A card that opens an object Lumovi gave the plugin
     * has that object's own kind's icon, from what Lumovi holds, and never one a plugin names.
     */
    icon: oneOf(VIEW_ICON_NAMES),
    /** A level and its word, at the card's right; in the table, its row's dot. */
    status: record({ level: oneOf(HEALTHS), word: name }, ['level', 'word']),
    /** One for each column, in the columns' order: what its row says in the table. */
    cells: list(cell, TABLE_LIMITS.columns),
    /** The object it opens. A card with one is pressed whole, in the picture and in the table. */
    opens: object,
    /**
     * Or where it goes, as a Table's row does: a list of Lumovi's own at one object of a kind its
     * plugin's file says its pages open, where the plugin read no object to open (what a tool's
     * status names, say), or one of Lumovi's own places for an object it was handed. Pressed
     * whole, as one that opens; and it has that kind's own icon, never one a plugin names.
     */
    goes: destination,
    /**
     * It stands out from the rest, with an edge in the warning colour: what that means is the
     * legend's `marked`, in the plugin's words ("Out of sync"), said beside it in the table and
     * to a screen reader.
     */
    marked: yesOrNo,
    /**
     * Shown for context only (what's somewhere Lumovi doesn't read, say): drawn dashed and quiet,
     * as a filter draws what it keeps above a match, and it opens nothing.
     */
    context: yesOrNo,
  },
  ['key', 'name', 'cells'],
)

/** A line from one card to another: what leads to what. */
const edge = record(
  {
    from: name,
    to: name,
    /** Solid unless said; the legend says what each means. */
    style: oneOf(['solid', 'dashed'] as const),
    /** Set on the line where it's halfway, cut at its end past `GRAPH_LIMITS.label`. */
    label: name,
  },
  ['from', 'to'],
)

/** The Graph, as a plugin says it. */
export const graph = {
  name: 'Graph',
  holds: 'nothing',
  props: {
    /** What the graph is of: said above it, and what a screen reader calls it. */
    title: name,
    /**
     * What a solid line means, and a dashed one: two words under the title; and what a marked
     * card is, beside an edge of its colour.
     */
    legend: record({ solid: name, dashed: name, marked: name }),
    /** The table's columns, as a Table's are: what each card's cells are under. */
    columns: list(column, TABLE_LIMITS.columns),
    nodes: list(node, GRAPH_LIMITS.cards),
    edges: list(edge, GRAPH_LIMITS.lines),
    /** In place of cards, when there are none to show: as a Table's. */
    state,
    /** Pressed a card that opens something (Lumovi opens the object itself). */
    onOpen: handler('open'),
    /** Pressed "Try again" of a graph that failed. */
    onRetry: handler('retry'),
  },
  required: ['title', 'columns', 'nodes', 'edges'],
  events: { open: { node: name }, retry: {} },
  also: (props) => graphProblem(props),
} as const satisfies Part

/** A graph as a plugin wrote it, as far as `graphProblem` reads it (its kinds already passed). */
interface Written {
  columns: { kind: string }[]
  nodes: {
    key: string
    cells: { kind: string }[]
    icon?: string
    opens?: string
    goes?: unknown
    marked?: boolean
    context?: boolean
  }[]
  edges: { from: string; to: string }[]
  legend?: { marked?: string }
}

/**
 * What's wrong with a graph that its kinds can't say, for whoever wrote it, in the Table's way:
 * where (a card or a line, counted from 1 as they wrote it; both places, where two clash), then
 * what. One line of Lumovi's own words that quotes nothing the graph holds: a card is named by
 * where it is, never by its key. Nothing, when the graph can be drawn as it's described.
 */
export function graphProblem(written: Readonly<Record<string, unknown>>): string | undefined {
  const { columns, nodes, edges, legend } = written as unknown as Written
  const keys = new Map<string, number>()
  for (const [n, node] of nodes.entries()) {
    const here = `Card ${n + 1}`
    const first = keys.get(node.key)
    if (first !== undefined) return `Cards ${first} and ${n + 1} have the same key.`
    keys.set(node.key, n + 1)
    // (A card that opens an object has that object's own icon, from what Lumovi holds: never one
    // a plugin names beside it, which could make it look like another kind's.)
    if (node.opens !== undefined && node.icon !== undefined) {
      return `${here} opens an object and names an icon: one that opens an object has its object’s own.`
    }
    if (node.opens !== undefined && node.goes !== undefined) {
      return `${here} opens an object and goes to a list: a card does one or the other.`
    }
    if (node.goes !== undefined && node.icon !== undefined) {
      return `${here} goes somewhere and names an icon: one that goes has its kind’s own.`
    }
    const wrong = cellsProblem(node, columns, here)
    if (wrong) return wrong
    if (node.context && (node.opens !== undefined || node.goes !== undefined)) {
      return `${here} is shown for context and opens something: one shown for context opens nothing.`
    }
    if (node.marked && !legend?.marked) {
      return `${here} is marked, and the legend doesn’t say what a mark is: give it legend.marked.`
    }
  }
  for (const [l, edge] of edges.entries()) {
    const here = `Line ${l + 1}`
    if (!keys.has(edge.from)) return `${here} starts at a card that isn’t there.`
    if (!keys.has(edge.to)) return `${here} ends at a card that isn’t there.`
    if (edge.from === edge.to) return `${here} starts and ends at the same card.`
  }
  return undefined
}

/** The Graph's properties, as its component takes them: worked out from `graph`. */
export type GraphProps = PropsOf<typeof graph>
export type GraphNode = NonNullable<GraphProps['nodes']>[number]
export type GraphEdge = NonNullable<GraphProps['edges']>[number]

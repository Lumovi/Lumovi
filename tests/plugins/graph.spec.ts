/**
 * The kit's Graph: its declaration is one the door takes, and a graph a plugin writes is checked
 * by it; where its cards go (rows by the lines' direction, a loop turned back, a label once,
 * "+N more"); the table made from it, nesting as deep as the lines go, a card listed again saying
 * where it's first; and its filter, keeping the cards above a match. And a plugin's own Table
 * still nests one level. Plain functions, so nothing is built or launched.
 */
import { expect, test } from '@playwright/test'
import {
  handedFields,
  wrongWithFields,
  wrongWithPart,
  type Swap,
  type WrittenProps,
} from '../../src/shared/kit/declare.ts'
import { graph, graphProblem, type GraphProps } from '../../src/shared/kit/graph.ts'
import { DoorPage } from '../../src/shared/plugin-door.ts'
import { table } from '../../src/shared/kit/table.ts'
import type { DrawnRow } from '../../src/shared/kit/table.ts'
import { layoutGraph, orderRows, ranks } from '../../src/renderer/src/lib/graph-layout.ts'
import { cardsOf, filterRows, tableOf } from '../../src/renderer/src/lib/graph-table.ts'

type Written = WrittenProps<typeof graph>

/** What the door says of a graph a plugin wrote, by its kinds. */
const said = (written: unknown) => wrongWithFields(written, graph.props, graph.required, 'Graph')

const SWAP: Swap = {
  object: (token) => (token === 'object-1' ? { kind: 'Deployment', name: 'cart' } : undefined),
  secret: () => undefined,
  cut: () => undefined,
  handler: () => undefined,
}

/** A graph as the door hands it to the part. */
const handed = (written: Written) => handedFields(written, graph.props, SWAP) as GraphProps

/** A card, with nothing to say in its one cell (the Health column's) unless said. */
const card = (key: string, extra: object = {}) => ({
  key,
  name: key,
  kind: 'Thing',
  cells: [{ kind: 'none' as const }],
  ...extra,
})

/** An application: two workloads under it, their pods, and a ConfigMap both use. */
const APP = {
  title: 'Resources',
  legend: { solid: 'Owns', dashed: 'Uses' },
  columns: [{ name: 'Health', kind: 'status' }],
  nodes: [
    card('app', { kind: 'Application', icon: 'git-branch' }),
    card('cart', {
      kind: 'Deployment',
      opens: 'object-1',
      status: { level: 'critical', word: 'Degraded' },
      // (Its Health cell: what a filter of the table finds, and the picture's doesn't.)
      cells: [{ kind: 'status', level: 'critical', word: 'Degraded' }],
    }),
    card('storefront', { kind: 'Deployment' }),
    card('cart-pod', { kind: 'Pod' }),
    card('storefront-pod', { kind: 'Pod' }),
    card('config', { kind: 'ConfigMap' }),
  ],
  edges: [
    { from: 'app', to: 'cart' },
    { from: 'app', to: 'storefront' },
    { from: 'cart', to: 'cart-pod' },
    { from: 'storefront', to: 'storefront-pod' },
    { from: 'cart', to: 'config', style: 'dashed', label: 'mounts' },
    { from: 'storefront', to: 'config', style: 'dashed', label: 'mounts' },
  ],
} as const satisfies Written

test('the Graph’s declaration is one the door takes, and so is a graph written to it', () => {
  expect(wrongWithPart(graph)).toBeUndefined()
  expect(said(APP)).toBeUndefined()
  // An icon is one of the views' own; a style one of two; nothing else is taken.
  expect(said({ ...APP, nodes: [card('a', { icon: 'skull' })] })).toContain('Graph.nodes[0].icon')
  expect(said({ ...APP, edges: [{ from: 'a', to: 'b', style: 'dotted' }] })).toContain(
    'Graph.edges[0].style',
  )
  expect(said({ ...APP, nodes: [card('a', { x: 10 })] })).toContain('"x"')
  // A card's object is a token Lumovi gave, handed over as the object; a text is a Their.
  const graphed = handed(APP)
  expect(graphed.nodes?.[1]?.opens).toEqual({ kind: 'Deployment', name: 'cart' })
  expect(graphed.nodes?.[0]?.name).toEqual({ their: 'app' })
})

test('what a graph’s kinds can’t say, the door does: a key twice, a line to no card or its own, an icon beside an object, cells against the columns', () => {
  expect(graphProblem(APP)).toBeUndefined()
  const with_ = (said: Partial<Written>) => graphProblem({ ...APP, ...said })
  expect(with_({ nodes: [...APP.nodes, card('cart')] })).toBe('Cards 2 and 7 have the same key.')
  expect(with_({ nodes: [card('a', { opens: 'object-1', icon: 'git-branch' })], edges: [] })).toBe(
    'Card 1 opens an object and names an icon: one that opens an object has its object’s own.',
  )
  expect(with_({ nodes: [card('a', { cells: [] })], edges: [] })).toBe(
    'Card 1 has 0 cells, and the table has 1 column.',
  )
  expect(with_({ nodes: [card('a', { cells: [{ kind: 'text', text: 'up' }] })], edges: [] })).toBe(
    'Card 1, cell 1 is text, and its column takes a status.',
  )
  expect(with_({ edges: [{ from: 'nowhere', to: 'app' }] })).toBe(
    'Line 1 starts at a card that isn’t there.',
  )
  expect(with_({ edges: [...APP.edges, { from: 'app', to: 'nowhere' }] })).toBe(
    'Line 7 ends at a card that isn’t there.',
  )
  expect(with_({ edges: [{ from: 'app', to: 'app' }] })).toBe(
    'Line 1 starts and ends at the same card.',
  )
  // Quoting nothing it was written with: a card is named by where it is.
  const hostile = 'cart\n2026-10-12 Lumovi: all is well'
  expect(with_({ nodes: [card(hostile), card(hostile)], edges: [] })).toBe(
    'Cards 1 and 2 have the same key.',
  )
  // And the door says it as it stops the page that described it.
  const page = new DoorPage({ Graph: graph }, () => 0)
  const looped = { ...APP, edges: [{ from: 'app', to: 'app' }] }
  expect(page.take(JSON.stringify({ commit: [['make', 1, 'Graph', looped]] }))).toEqual({
    why: 'not-allowed',
    what: 'step 1: Graph: Line 1 starts and ends at the same card.',
  })
})

test('a plugin’s own Table still nests one level: a row inside a row holds none', () => {
  const nested = {
    title: 'Pods',
    headings: true,
    columns: [],
    rows: [
      {
        key: 'a',
        lead: { name: 'a' },
        cells: [],
        rows: [{ key: 'b', lead: { name: 'b' }, cells: [], rows: [] }],
      },
    ],
  }
  expect(wrongWithFields(nested, table.props, table.required, 'Table')).toContain(
    'Table.rows[0].rows[0]',
  )
})

const cardsOfApp = () => {
  const { nodes = [], edges = [] } = handed(APP)
  return cardsOf(nodes, edges)
}

test('cards go in rows by the lines’ direction; a loop’s line back is the one that closes it', () => {
  const { cards, lines } = cardsOfApp()
  const { rank, back } = ranks(cards, lines)
  expect(['app', 'cart', 'cart-pod'].map((key) => rank.get(key))).toEqual([0, 1, 2])
  // (The ConfigMap is below both workloads that use it.)
  expect(rank.get('config')).toBe(2)
  expect(back.size).toBe(0)
  const steps = ['checkout', 'build', 'test', 'deploy'].map((key) => ({ key }))
  const loop = [
    { from: 'checkout', to: 'build' },
    { from: 'build', to: 'test' },
    { from: 'test', to: 'deploy' },
    { from: 'test', to: 'build' },
  ]
  const looped = ranks(steps, loop)
  expect(steps.map((step) => looped.rank.get(step.key))).toEqual([0, 1, 2, 3])
  expect([...looped.back]).toEqual([loop[3]])
})

test('a laid-out graph: a line back runs up the side, a label is said once, a full row ends in “+N more”', () => {
  const steps = ['checkout', 'build', 'test'].map((key) => ({ key }))
  const laid = layoutGraph(
    orderRows(steps, [
      { from: 'checkout', to: 'build' },
      { from: 'build', to: 'test' },
      { from: 'test', to: 'build', label: 'retried' },
    ]),
    800,
    new Set(),
  )
  const back = laid.edges.filter((edge) => edge.back)
  expect(back).toHaveLength(1)
  expect(back[0]!.label).toBeDefined()
  expect(laid.edges.filter((edge) => !edge.back).every((edge) => !edge.label)).toBe(true)

  const { cards, lines } = cardsOfApp()
  const app = layoutGraph(orderRows(cards, lines), 900, new Set())
  // Two lines into the ConfigMap, both "mounts": said once.
  expect(app.edges.filter((edge) => edge.to === 'config' && edge.label)).toHaveLength(1)

  // Twenty pods under one database, at 500 px: one row's worth, and "+N more" for the rest.
  const many = [{ key: 'db' }, ...Array.from({ length: 20 }, (_, i) => ({ key: `pod-${i}` }))]
  const fan = many.slice(1).map((pod) => ({ from: 'db', to: pod.key }))
  const narrow = layoutGraph(orderRows(many, fan), 500, new Set())
  const more = narrow.cards.find((placed) => placed.more)
  expect(more?.more?.count).toBe(20 - (narrow.cards.length - 2))
  // Opened, the row is whole, over as many lines as it takes.
  const opened = layoutGraph(orderRows(many, fan), 500, new Set([1]))
  expect(opened.cards.filter((placed) => placed.node)).toHaveLength(21)
  expect(opened.height).toBeGreaterThan(narrow.height)
})

/** A table's rows as names, set in by how deep they are, and a row listed again as "↵ name < first". */
const outline = (rows: readonly DrawnRow[], depth = 0): string[] =>
  rows.flatMap((row) => [
    `${'  '.repeat(depth)}${row.again ? `↵ ${row.lead?.name?.their} < ${row.again.under?.their ?? ''}` : row.lead?.name?.their}${row.lead?.under?.their ? ` (${row.lead.under.their})` : ''}`,
    ...outline(row.rows ?? [], depth + 1),
  ])

test('the table is made from the graph: nested as deep as the lines go, a second parent’s listing pointing to the first', () => {
  const { cards, lines } = cardsOfApp()
  // (In the picture's order: the ConfigMap sits between the two workloads that use it.)
  expect(outline(tableOf(orderRows(cards, lines)))).toEqual([
    'app (Application)',
    '  cart (Deployment)',
    '    cart-pod (Pod)',
    '    config (ConfigMap · mounts)',
    '  storefront (Deployment)',
    '    ↵ config < cart (ConfigMap · mounts)',
    '    storefront-pod (Pod)',
  ])
  // A loop's line back is said under the card it leaves, as a listing of the card it goes to.
  const steps = ['checkout', 'build', 'test'].map((key) => ({
    key,
    node: { key: { their: key }, name: { their: key }, cells: [] },
  }))
  const looped = tableOf(
    orderRows(steps, [
      lineOf('checkout', 'build'),
      lineOf('build', 'test'),
      lineOf('test', 'build'),
    ]),
  )
  expect(outline(looped)).toEqual(['checkout', '  build', '    test', '      ↵ build < checkout'])
})

test('a filter keeps what matches by name or kind, and the cards above it as context', () => {
  const { cards, lines } = cardsOfApp()
  const rows = tableOf(orderRows(cards, lines))
  const kept = (sought: string, cells = false) =>
    [...filterRows(rows, sought, { cells }).kept].map(([key, is]) => `${key}:${is}`).sort()
  expect(kept('POD')).toEqual([
    'app:context',
    'cart-pod:match',
    'cart:context',
    'storefront-pod:match',
    'storefront:context',
  ])
  expect(kept('config')).toEqual([
    'app:context',
    'cart:context',
    'config:match',
    'storefront:context',
  ])
  // Cells count only in the table.
  expect(kept('degraded')).toEqual([])
  expect(kept('degraded', true)).toEqual(['app:context', 'cart:match'])
  expect(kept('nothing like it')).toEqual([])
  // Nothing typed keeps everything, as it is.
  expect(filterRows(rows, '  ').kept.size).toBe(cards.length)
  expect(filterRows(rows, '  ').rows).toBe(rows)
  // The rows kept: a match's, and those above it, nested as they were.
  expect(outline(filterRows(rows, 'cart-pod').rows)).toEqual([
    'app (Application)',
    '  cart (Deployment)',
    '    cart-pod (Pod)',
  ])
})

/** A line from one card to another, as the part takes it. */
const lineOf = (from: string, to: string) => ({
  from,
  to,
  edge: { from: { their: from }, to: { their: to } },
})

/** `count` cards, as the part takes them. */
const many = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    key: `k${i}`,
    node: { key: { their: `k${i}` }, name: { their: `card ${i}` }, cells: [] },
  }))

/** How long `work` takes, in milliseconds: the best of three, said in the test's output. */
function timed<T>(what: string, work: () => T): T {
  let best = Infinity
  let made: T
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    made = work()
    best = Math.min(best, performance.now() - start)
  }
  console.log(`${what}: ${best.toFixed(1)} ms`)
  return made!
}

test('a chain of 5,000 cards, as many as a graph may have, is listed and filtered without running out of stack', () => {
  const cards = many(5_000)
  const lines = cards.slice(1).map((card, i) => lineOf(`k${i}`, card.key))
  const rows = timed('chain: rows and table', () =>
    tableOf(orderRows(cards, lines, { placed: false })),
  )
  // One row at the top, and each the next one's only row, all the way down.
  let depth = 0
  for (let row = rows[0]; row?.rows; row = row.rows[0]) depth++
  expect(depth).toBe(4_999)
  const found = timed('chain: one letter typed', () => filterRows(rows, 'card 4999'))
  expect(found.matches).toBe(1)
  expect(found.kept.get('k0')).toBe('context')
})

test('5,000 cards and 10,000 lines, loops among them, are listed and filtered in time', () => {
  const cards = many(5_000)
  // Each card leads to the next two; every tenth, to the next and back to one nine above:
  // circles everywhere.
  const lines = cards.flatMap((_, i) =>
    (i % 10 === 9 ? [i + 1, i - 9] : [i + 1, i + 2])
      .filter((to) => to < 5_000)
      .map((to) => lineOf(`k${i}`, `k${to}`)),
  )
  expect(lines.length).toBeGreaterThan(9_900)
  const shape = timed('dense: rows', () => orderRows(cards, lines, { placed: false }))
  expect(shape.back.size).toBeGreaterThan(0)
  const rows = timed('dense: table', () => tableOf(shape))
  const found = timed('dense: one letter typed', () => filterRows(rows, 'card 42'))
  // ("card 42", "card 420" to "card 429", and "card 4200" to "card 4299".)
  expect(found.matches).toBe(111)
  // Under the ceiling, ordering for the picture is in time too.
  const fewer = many(300)
  const fewerLines = lines.filter((line) => +line.from.slice(1) < 300 && +line.to.slice(1) < 300)
  timed('300 cards: ordered for the picture', () => orderRows(fewer, fewerLines))
})

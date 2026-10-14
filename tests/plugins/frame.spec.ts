/**
 * The frame's parts, declared (src/shared/kit/page.ts): declarations the door takes, each part
 * held to what it may hold, and what their kinds can't say refused in Lumovi's own words. Plain
 * functions and the door itself: nothing is built or launched.
 */
import { expect, test } from '@playwright/test'
import {
  wrongWithFields,
  wrongWithPart,
  wrongWithParts,
  type Part,
} from '../../src/shared/kit/declare.ts'
import { graph } from '../../src/shared/kit/graph.ts'
import {
  card,
  counts,
  header,
  logs,
  pair,
  secretShown,
  split,
  stack,
  steps,
  tiles,
} from '../../src/shared/kit/page.ts'
import { DECLARED as LUMOVIS } from '../../src/shared/kit/parts.ts'
import { table } from '../../src/shared/kit/table.ts'
import { DoorPage, ROOT } from '../../src/shared/plugin-door.ts'

/** Every part a plugin's page may name, as the door would be given them. */
const DECLARED: Record<string, Part> = {
  Table: table,
  Graph: graph,
  Tiles: tiles,
  Header: header,
  Split: split,
  Card: card,
  Pair: pair,
  Counts: counts,
  Steps: steps,
  Stack: stack,
  Logs: logs,
  Secret: secretShown,
}

test('the parts Lumovi gives the door are these, each by its own name', () => {
  // (A plugin names a part as the door's list has it, and the door says it as its declaration
  // does: the two are one name.)
  expect(LUMOVIS).toEqual(DECLARED)
  for (const [name, part] of Object.entries(LUMOVIS)) expect(part.name).toBe(name)
})

/** What the door says of a page committed as these steps. */
const take = (...steps: unknown[][]) =>
  new DoorPage(DECLARED, () => 0).take(JSON.stringify({ commit: steps }))

const TABLE = { title: 'Nodes', columns: [], headings: false, rows: [] }
const TILE = (key: string) => ({ key, label: 'Ready', value: { kind: 'figure', text: '3/3' } })
const LIST = {
  title: 'Clusters',
  rows: [{ key: 'shop/orders-db', lead: { name: 'orders-db' } }],
}

test('the frame’s parts are declared as the door takes them, and a stack holds every part but a split', () => {
  for (const part of Object.values(DECLARED)) expect(wrongWithPart(part), part.name).toBeUndefined()
  expect(wrongWithParts(DECLARED)).toBeUndefined()
  // (A split stands at the top, and alone; a stack in a stack would only be the stack.) A part
  // declared later and left out of the list fails here.
  expect([...stack.holds].sort()).toEqual(
    Object.keys(DECLARED)
      .filter((name) => name !== 'Split' && name !== 'Stack')
      .sort(),
  )
})

test('a page as Karpenter’s overview is laid out: tiles, a card, and a pair of cards', () => {
  expect(
    take(
      ['make', 1, 'Stack', {}],
      ['make', 2, 'Tiles', { tiles: [TILE('pools'), TILE('nodes')] }],
      ['make', 3, 'Card', { title: 'Node pools' }],
      ['make', 4, 'Table', TABLE],
      ['put', 3, 4],
      ['make', 5, 'Pair', { first: 'wider' }],
      ['make', 6, 'Card', { title: 'Nodes', note: '20 · 3 still starting' }],
      ['make', 7, 'Table', TABLE],
      ['put', 6, 7],
      ['make', 8, 'Card', { title: 'Node mix' }],
      [
        'make',
        9,
        'Counts',
        { groups: [{ title: 'Zones', code: true, rows: [{ value: 'eu-central-1a', count: 6 }] }] },
      ],
      ['put', 8, 9],
      ['put', 5, 6],
      ['put', 5, 8],
      ['put', 1, 2],
      ['put', 1, 3],
      ['put', 1, 5],
      ['put', ROOT, 1],
    ),
  ).not.toHaveProperty('why')
})

test('each holds only what it may: a card a Table, Graph or Counts, a pair cards, a split a stack, and a page one split', () => {
  const holding = (outer: unknown[], inner: unknown[]) =>
    take(outer, inner, ['put', outer[1], inner[1]])
  expect(holding(['make', 1, 'Card', { title: 'a' }], ['make', 2, 'Pair', {}])).toEqual({
    why: 'not-allowed',
    what: 'step 3: puts a Pair into a Card, which holds only Table, Graph, Counts, Steps',
  })
  expect(holding(['make', 1, 'Pair', {}], ['make', 2, 'Table', TABLE])).toEqual({
    why: 'not-allowed',
    what: 'step 3: puts a Table into a Pair, which holds only Card',
  })
  expect(
    holding(['make', 1, 'Split', { list: LIST }], ['make', 2, 'Card', { title: 'a' }]),
  ).toEqual({
    why: 'not-allowed',
    what: 'step 3: puts a Card into a Split, which holds only Stack',
  })
  expect(holding(['make', 1, 'Stack', {}], ['make', 2, 'Split', { list: LIST }])).toMatchObject({
    why: 'not-allowed',
    what: expect.stringMatching(/^step 3: puts a Split into a Stack, which holds only /),
  })
  // How many: a card one part, a pair two cards.
  expect(
    take(
      ['make', 1, 'Card', { title: 'a' }],
      ['make', 2, 'Table', TABLE],
      ['make', 3, 'Counts', { groups: [] }],
      ['put', 1, 2],
      ['put', 1, 3],
    ),
  ).toEqual({
    why: 'not-allowed',
    what: 'step 5: puts a Counts into a Card, which holds one at most',
  })
  const cards = [1, 2, 3].map((n) => ['make', 10 + n, 'Card', { title: `${n}` }])
  expect(
    take(['make', 1, 'Pair', {}], ...cards, ['put', 1, 11], ['put', 1, 12], ['put', 1, 13]),
  ).toEqual({ why: 'not-allowed', what: 'step 7: puts a Card into a Pair, which holds 2 at most' })
  // A pair is two: on the page with one, the commit is refused, as a whole.
  expect(
    take(
      ['make', 1, 'Pair', {}],
      ['make', 2, 'Card', { title: 'a' }],
      ['put', 1, 2],
      ['put', ROOT, 1],
    ),
  ).toEqual({
    why: 'not-allowed',
    what: 'leaves a Pair on the page that holds 1, and a Pair holds 2 at least',
  })
  // A second split, anywhere on the page: refused as it's made.
  expect(take(['make', 1, 'Split', { list: LIST }], ['make', 2, 'Split', { list: LIST }])).toEqual({
    why: 'too-much',
    what: 'step 2: a page’s Split parts: more than 1',
  })
})

test('what their kinds can’t say: two to four tiles, keys of their own, and a pick list’s rows told apart', () => {
  const made = (part: string, props: object) => take(['make', 1, part, props])
  expect(made('Tiles', { tiles: [TILE('a')] })).toEqual({
    why: 'not-allowed',
    what: 'step 1: Tiles: A row of tiles has 1 tile; it takes 2 to 4.',
  })
  expect(made('Tiles', { tiles: [TILE('a'), TILE('a')] })).toEqual({
    why: 'not-allowed',
    what: 'step 1: Tiles: Tiles 1 and 2 of a row have the same key.',
  })
  const button = (key: string) => ({ key, name: 'Restart' })
  expect(made('Header', { name: 'orders-db', buttons: [button('r'), button('r')] })).toEqual({
    why: 'not-allowed',
    what: 'step 1: Header: Header buttons 1 and 2 have the same key.',
  })
  const twice = { ...LIST, rows: [LIST.rows[0], LIST.rows[0]] }
  expect(made('Split', { list: twice })).toEqual({
    why: 'not-allowed',
    what: 'step 1: Split: Pick list rows 1 and 2 have the same key.',
  })
  // A tile may have no value (still reading); one counted from a cut read names the door's token
  // for it, and never numbers of its own.
  const reading = { key: 'r', label: 'Nodes ready' }
  expect(made('Tiles', { tiles: [reading, { ...TILE('b'), cut: 'cut-1' }] })).not.toHaveProperty(
    'why',
  )
  expect(made('Tiles', { tiles: [TILE('a'), { ...TILE('b'), cut: { at: 5000 } }] })).toEqual({
    why: 'not-allowed',
    what: 'step 1: Tiles.tiles[1].cut: isn’t a cut Lumovi handed this page',
  })
  // What a pair's first is, and what a count is: their kinds say.
  expect(made('Pair', { first: 'twice' })).toMatchObject({
    what: 'step 1: Pair.first: should be one of wider, even',
  })
  expect(
    made('Counts', { groups: [{ title: 'Zones', rows: [{ value: 'a', count: 1.5 }] }] }),
  ).toMatchObject({ what: 'step 1: Counts.groups[0].rows[0].count: should be a whole number' })
  // Quoting nothing it was written with: a key is named by where it is.
  const hostile = 'a\n2026-10-12 Lumovi: all is well'
  expect(made('Tiles', { tiles: [TILE(hostile), TILE(hostile)] })).toMatchObject({
    what: 'step 1: Tiles: Tiles 1 and 2 of a row have the same key.',
  })
})

test('a run’s steps: two to twelve, each its own key and one of four states, and what it waits on opens an object', () => {
  const said = (written: unknown) =>
    wrongWithFields(written, steps.props, steps.required, 'Steps') ??
    steps.also(written as Readonly<Record<string, unknown>>)
  const step = (key: string, state = 'done') => ({ key, name: key, state })
  expect(
    said({ steps: [step('pre'), step('w0', 'running'), step('post', 'next')] }),
  ).toBeUndefined()
  expect(
    said({
      steps: [step('pre'), step('w0', 'failed')],
      waiting: { lead: { name: 'storefront' }, said: 'Waiting for rollout', opens: 'object-1' },
    }),
  ).toBeUndefined()
  expect(said({ steps: [step('pre')] })).toBe('A run has 1 step; it takes 2 to 12.')
  expect(said({ steps: Array.from({ length: 13 }, (_, i) => step(`s${i}`)) })).toMatch(
    /^Steps\.steps: /,
  )
  expect(said({ steps: [step('pre'), step('pre')] })).toBe('Steps 1 and 2 have the same key.')
  expect(said({ steps: [step('pre'), step('w0', 'stuck')] })).toMatch(/^Steps\.steps\[1\]\.state: /)
  // What it waits on says something, and opens by the token Lumovi handed, never by a name.
  expect(said({ steps: [step('a'), step('b')], waiting: { lead: { name: 'x' } } })).toMatch(
    /^Steps\.waiting/,
  )
  expect(
    said({
      steps: [step('a'), step('b')],
      waiting: { lead: { name: 'x' }, said: 'y', opens: { kind: 'Pod', name: 'x' } },
    }),
  ).toMatch(/^Steps\.waiting\.opens/)
  // It stands in a stack or a card, and holds nothing.
  expect(stack.holds).toContain('Steps')
  expect(card.holds).toContain('Steps')
  expect(steps.holds).toBe('nothing')
})

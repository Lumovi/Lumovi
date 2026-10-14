/**
 * The door's checks, tried in Lumovi's own built page: door.spec's cases, with its values and
 * its words, each check made by the page's own door (the tests' stage lends it), so what's
 * measured of the door is what ran in a page. door.spec tries the same as plain functions (and
 * times two of them, which a page built to be measured can't). And a refusal through a real box,
 * as a plugin meets it.
 */
import { readFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import type { JSHandle, Page } from '@playwright/test'
import {
  choice,
  cut,
  destination,
  handler,
  list,
  number,
  object,
  oneOf,
  record,
  secret,
  shared,
  text,
  time,
  yesOrNo,
  type handed,
  type handedFields,
  type Kind,
  type Part,
  type wrongWith,
  type wrongWithFields,
  type wrongWithPart,
  type wrongWithParts,
} from '../../src/shared/kit/declare.ts'
import {
  DOOR_LIMITS,
  ROOT,
  type DoorPage,
  type PageNode,
  type Stopped,
} from '../../src/shared/plugin-door.ts'
import type { inPieces, shortInPieces, spelled } from '../../src/shared/kit/characters.ts'
import type { tableProblem } from '../../src/shared/kit/table.ts'
import type { placed } from '../../src/shared/plugin-box.ts'
import type { notHandedLine } from '../../src/shared/plugin-hand-over.ts'
import { DECLARED } from '../../src/shared/kit/parts.ts'
import { PLUGIN_SINCE } from '../../src/shared/plugin-since.ts'
import { DEMO_TOKEN, expect, signIn, test, type ServeOptions, type Served } from './fixtures.ts'

/** What the stage lends the tests of the door. */
interface DoorChecks {
  DoorPage: typeof DoorPage
  wrongWith: typeof wrongWith
  wrongWithFields: typeof wrongWithFields
  wrongWithPart: typeof wrongWithPart
  wrongWithParts: typeof wrongWithParts
  handedFields: typeof handedFields
  handed: typeof handed
  number: typeof number
  record: typeof record
  choice: typeof choice
  tableProblem: typeof tableProblem
  inPieces: typeof inPieces
  shortInPieces: typeof shortInPieces
  spelled: typeof spelled
  placed: typeof placed
  notHandedLine: typeof notHandedLine
  PLUGIN_SINCE: typeof PLUGIN_SINCE
}
/** The page's window, as the stage lends it. */
type Lent = { __lumoviDoor: { doorChecks: DoorChecks; show(shown: object): void } }

const CARDS = shared('Card and Tag parts', 20)

const PARTS: Record<string, Part> = {
  Stack: { name: 'Stack', holds: 'parts', props: { gap: number(0, 8, true) } },
  Label: { name: 'Label', holds: 'text', props: { tone: oneOf(['plain', 'quiet']) } },
  Row: { name: 'Row', holds: ['Label'], props: {} },
  Button: {
    name: 'Button',
    holds: 'nothing',
    props: { label: text(80), onPress: handler('press'), of: object },
    required: ['label'],
    events: { press: {} },
  },
  /** One a page may have only two of. */
  Badge: { name: 'Badge', holds: 'nothing', props: {}, most: 2 },
  /** One that holds one thing at most; one that holds two texts, and on the page no fewer. */
  Frame: { name: 'Frame', holds: ['Label', 'Row'], holdsMost: 1, props: {} },
  Pair: { name: 'Pair', holds: 'text', holdsMost: 2, holdsLeast: 2, props: {} },
  /** Two a page may have twenty of between them (each naming the ceiling for itself). */
  Card: { name: 'Card', holds: 'nothing', props: {}, counts: CARDS },
  Tag: { name: 'Tag', holds: 'nothing', props: {}, counts: shared('Card and Tag parts', 20) },
}

/** Lumovi's page, built for the tests, with its door's checks there. */
async function opened(page: Page, serve: (options?: ServeOptions) => Promise<Served>) {
  const { url } = await serve()
  await page.goto(url)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  return page
}

/** A page the door holds, in Lumovi's page: its clock, and `send` for a commit's steps. */
async function doorPage(page: Page, parts: Record<string, Part> = PARTS) {
  const held: JSHandle<{ door: DoorPage; clock: { now: number } }> = await page.evaluateHandle(
    (parts) => {
      const { DoorPage } = (window as unknown as Lent).__lumoviDoor.doorChecks
      const clock = { now: 0 }
      return { door: new DoorPage(parts, () => clock.now), clock }
    },
    parts,
  )
  const take = (message: unknown) =>
    held.evaluate(({ door }, message) => door.take(message as string), message)
  return {
    take,
    send: (...steps: unknown[]) =>
      held.evaluate(({ door }, steps) => door.take(JSON.stringify({ commit: steps })), steps),
    /** The same commit, `times` over: what each was answered. */
    sendTimes: (times: number, ...steps: unknown[]) =>
      held.evaluate(
        ({ door }, [times, steps]) =>
          Array.from({ length: times }, () => door.take(JSON.stringify({ commit: steps }))),
        [times, steps] as const,
      ),
    at: (now: number) => held.evaluate(({ clock }, now) => void (clock.now = now), now),
    later: (ms: number) => held.evaluate(({ clock }, ms) => void (clock.now += ms), ms),
    node: (id: unknown) =>
      held.evaluate(({ door }, id) => door.node(id as number), id) as Promise<PageNode | undefined>,
    frozen: (id: number, ...path: string[]) =>
      held.evaluate(
        ({ door }, [id, path]) => {
          let value: unknown = door.node(id)
          const all = [value]
          for (const key of path) all.push((value = (value as Record<string, unknown>)[key]))
          return all.every((each) => Object.isFrozen(each))
        },
        [id, path] as const,
      ),
    /** Each message taken by the page in turn: what each was answered. */
    takeAll: (messages: string[]) =>
      held.evaluate(
        ({ door }, messages) => messages.map((message) => door.take(message)),
        messages,
      ),
    /** Whether a part's children can be added to, as read of the page. */
    pushThrows: (id: number) =>
      held.evaluate(({ door }, id) => {
        try {
          ;(door.node(id)!.children as number[]).push(5)
          return false
        } catch {
          return true
        }
      }, id),
    /** The same commit, by the page, until it's stopped or `rounds` are done: the round, or 0. */
    exactRounds: (text: string, rounds: number, from: number, every: number) =>
      held.evaluate(
        ({ door, clock }, [text, rounds, from, every]) => {
          for (let round = 1; round <= rounds; round++) {
            clock.now = from + round * every
            if ('why' in door.take(text)) return round
          }
          return 0
        },
        [text, rounds, from, every] as const,
      ),
    holds: () => held.evaluate(({ door }) => door.holds),
    stopped: () => held.evaluate(({ door }) => door.stopped),
    changedAt: (ids: number[]) =>
      held.evaluate(({ door }, ids) => ids.map((id) => door.changedAt(id)), ids),
  }
}

const stopped = (result: unknown): Stopped => {
  expect(result).toHaveProperty('why')
  return result as Stopped
}

test('a value against its kind', async ({ page, serve }) => {
  await opened(page, serve)
  const cases: [string, Kind, unknown[], unknown[]][] = [
    ['text', text(5), ['', 'hello'], ['hello!', 5, null, ['a'], {}]],
    ['number', number(0, 10), [0, 2.5, 10], [-1, 11, '3', Number.NaN, null]],
    ['whole number', number(0, 10, true), [3], [2.5]],
    ['yes or no', yesOrNo, [true, false], [0, 'true', null]],
    ['one of', oneOf(['a', 'b']), ['a'], ['c', 'toString', 1, null]],
    ['time', time, ['2026-10-12T08:30:00Z'], ['yesterday', '2026-13-40T99:00:00Z', 5]],
    ['object', object, ['o_1-A'], ['', 'a b', '../x', 'x'.repeat(65), { kind: 'Pod' }]],
    ['secret', secret, ['s_1-A'], ['', 'a/b', 'a b', 5, { name: 'db' }]],
    ['how a read was cut', cut, ['c_1-A'], ['', 'a b', 5000, { at: 5000 }]],
    ['handler', handler('press'), ['h7'], ['() => 1', 7, null]],
    [
      'list to open',
      destination,
      [
        { list: 'karpenter.sh/NodePool' },
        { list: '/Node', labels: ['karpenter.sh/nodepool'] },
        { list: '/Pod', health: ['critical', 'warning'], labels: ['app=web', 'tier='] },
        { list: 'apps/Deployment', name: 'storefront', namespace: 'shop' },
        { list: '/Node', name: 'ip-10-0-1-5.ec2.internal' },
        { list: 'rbac.authorization.k8s.io/ClusterRole', name: 'system:controller:job-controller' },
      ],
      [
        'karpenter.sh/NodePool',
        {},
        { list: 'NodePool' },
        { list: '/Node', path: '/api/v1/nodes' },
        { list: '/Node', namespace: 'kube-system' },
        { list: '/Node', health: [] },
        { list: '/Node', health: ['bad'] },
        { list: '/Node', health: ['critical', 'critical'] },
        { list: '/Node', labels: ['a b'] },
        { list: '/Node', labels: ['a', 'b', 'c', 'd', 'e'] },
        { list: '/Node', labels: 'app=web' },
        { list: 'apps/Deployment', name: '' },
        { list: 'apps/Deployment', name: '..' },
        { list: 'apps/Deployment', name: 'shop/storefront' },
        { list: 'apps/Deployment', name: 'store front' },
        { list: 'apps/Deployment', name: 'a'.repeat(254) },
        { list: 'apps/Deployment', name: 7 },
        { list: 'apps/Deployment', name: 'storefront', namespace: 'Shop' },
        { list: 'apps/Deployment', name: 'storefront', namespace: '' },
        { list: 'apps/Deployment', name: 'storefront', health: ['critical'] },
        { list: 'apps/Deployment', name: 'storefront', labels: ['app=web'] },
      ],
    ],
    ['list', list(text(3), 2), [[], ['a', 'b']], [['a', 'b', 'c'], ['long'], 'ab', { 0: 'a' }]],
    [
      'record',
      record({ name: text(10), size: number(0, 5) }, ['name']),
      [{ name: 'a' }, { name: 'a', size: 1 }],
      [{}, { size: 1 }, { name: 'a', other: 1 }, [], null, 'a'],
    ],
    // (A record declared as data, with nothing said of what's required: none is.)
    [
      'record, nothing required',
      { kind: 'record', fields: { name: text(10) } },
      [{}, { name: 'a' }],
      [{ name: 5 }, 'a'],
    ],
    [
      'choice',
      choice('kind', { none: {}, text: { value: text(5) } }),
      [{ kind: 'none' }, { kind: 'text', value: 'a' }],
      [
        {},
        { kind: 'other' },
        { kind: 'text' },
        { kind: 'none', value: 'a' },
        { kind: 'constructor' },
        'text',
        null,
        [{ kind: 'none' }],
      ],
    ],
  ]
  for (const [name, kind, right, wrong] of cases) {
    await test.step(name, async () => {
      const said = await page.evaluate(
        ([kind, right, wrong]) => {
          const { wrongWith } = (window as unknown as Lent).__lumoviDoor.doorChecks
          return {
            right: right.map((value) => wrongWith(value, kind, 'it')),
            wrong: wrong.map((value) => wrongWith(value, kind, 'it')),
          }
        },
        [kind, right, wrong] as const,
      )
      for (const [i, value] of right.entries())
        expect(said.right[i], JSON.stringify(value)).toBeUndefined()
      for (const [i, value] of wrong.entries())
        expect(said.wrong[i], JSON.stringify(value)).toMatch(/^it/)
    })
  }

  await test.step('a name every object has is never a property', async () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      // (Read in the page, as the door reads what it's sent: a name every object has, kept as one.)
      const said = await page.evaluate(
        ([key, kind]) =>
          (window as unknown as Lent).__lumoviDoor.doorChecks.wrongWithFields(
            JSON.parse(`{"${key}": "a"}`),
            { [key]: kind },
            [],
            'Part',
          ),
        [key, text(5)] as const,
      )
      expect(said).toBe(`Part: takes nothing named "${key}"`)
    }
    // A description itself, where nothing names it: said of "it".
    expect(
      await page.evaluate(
        (kind) =>
          (window as unknown as Lent).__lumoviDoor.doorChecks.wrongWithFields(
            { other: 'a' },
            { label: kind },
            [],
            '',
          ),
        text(5),
      ),
    ).toBe('it: takes nothing named "other"')
  })

  await test.step('handed over with no swap, what a plugin named is as it named it', async () => {
    // (What the kit page's own describers are handed: no door, nothing put in anything's place.)
    const kinds = { of: object, shows: secret, cut, opens: destination, onPress: handler('press') }
    const written = {
      of: 'o_1',
      shows: 's_1',
      cut: 'c_1',
      opens: { list: '/Node' },
      onPress: 'h1',
    }
    const said = await page.evaluate(
      ([written, kinds]) =>
        (window as unknown as Lent).__lumoviDoor.doorChecks.handedFields(written, kinds),
      [written, kinds] as const,
    )
    expect(said).toEqual(written)
  })

  await test.step('a value nested deeper than anything a part takes is refused, not followed', async () => {
    let kind: Kind = text(5)
    let value: unknown = 'a'
    for (let i = 0; i < 40; i++) {
      kind = list(kind, 1)
      value = [value]
    }
    const said = await page.evaluate(
      ([value, kind]) =>
        (window as unknown as Lent).__lumoviDoor.doorChecks.wrongWith(value, kind, 'it'),
      [value, kind] as const,
    )
    expect(said).toContain('nested deeper')
  })

  await test.step('said from the top, a value’s fields are named by themselves', async () => {
    const said = await page.evaluate((kind) => {
      const { wrongWithFields } = (window as unknown as Lent).__lumoviDoor.doorChecks
      return [
        wrongWithFields({ name: 5 }, { name: kind }, [], ''),
        wrongWithFields({ other: 1 }, {}, [], ''),
      ]
    }, text(3))
    expect(said).toEqual(['name: should be text', 'it: takes nothing named "other"'])
  })

  await test.step('handed over with nothing to swap them for, a token and a handle stay as written', async () => {
    const said = await page.evaluate(
      (kinds) => {
        const { handed } = (window as unknown as Lent).__lumoviDoor.doorChecks
        return kinds.map(([value, kind]) => handed(value, kind))
      },
      [
        ['o1', object],
        ['s1', secret],
        ['h1', handler('press')],
      ] as [string, Kind][],
    )
    expect(said).toEqual(['o1', 's1', 'h1'])
  })
})

test('a text that isn’t Lumovi’s, in pieces', async ({ page, serve }) => {
  await opened(page, serve)
  const said = await page.evaluate(() => {
    const { inPieces, shortInPieces, spelled } = (window as unknown as Lent).__lumoviDoor.doorChecks
    return {
      // A flag made with tags, whole and closed, is text.
      flag: inPieces('\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}'),
      // Marks one at a time, apart: twenty drawn, and the rest said once, at the end.
      apart: inPieces(`${'a\u0001'.repeat(25)}a`),
      // A line's end past the lines it may have is a space.
      lines: shortInPieces('a\nb\nc', 100, 2),
      // Spelled, a run past three says how many more.
      run: spelled('\u0001'.repeat(5)),
    }
  })
  expect(said.flag).toEqual(['\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}'])
  expect(said.apart.filter((piece) => typeof piece === 'object' && 'unseen' in piece)).toHaveLength(
    20,
  )
  expect(said.apart.at(-1)).toEqual({ more: 5 })
  expect(said.lines).toEqual(['a\nb c'])
  expect(said.run).toBe(' U+0001  U+0001  U+0001  and 2 more ')
})

test('where boxes are, and why a plugin’s pages don’t run', async ({ page, serve }) => {
  await opened(page, serve)
  const said = await page.evaluate(() => {
    const { placed, notHandedLine } = (window as unknown as Lent).__lumoviDoor.doorChecks
    // One plugin in the page's own process; two sharing one; one alone in its own.
    const boxes = [
      { plugin: 'a', pid: 1, window: 1 },
      { plugin: 'b', pid: 2, window: 1 },
      { plugin: 'c', pid: 2, window: 1 },
      { plugin: 'd', pid: 3, window: 1 },
    ]
    const { endProcesses, takeOff, pluginOf } = placed(boxes, [1])
    return {
      ends: [...endProcesses],
      takeOff: [...takeOff],
      own: [...pluginOf],
      lines: [notHandedLine('check-unfinished'), notHandedLine('no-code')],
    }
  })
  expect(said.ends).toEqual([[2, ['b', 'c']]])
  expect(said.takeOff).toEqual([[1, ['a']]])
  expect(said.own).toEqual([[3, 'd']])
  expect(said.lines).toEqual([
    'Its pages don’t run here yet: Lumovi’s check of this browser didn’t finish in time.',
    'Its pages don’t run here: its code isn’t part of this Lumovi.',
  ])
})

test('a part’s declaration', async ({ page, serve }) => {
  await opened(page, serve)

  await test.step('declared in the page, a kind says what it was given and nothing it wasn’t', async () => {
    const said = await page.evaluate(() => {
      const { number, record, choice } = (window as unknown as Lent).__lumoviDoor.doorChecks
      return [number(0, 1), number(0, 1, true), record({}), choice('kind', { none: {} })]
    })
    expect(said).toEqual([
      { kind: 'number', min: 0, max: 1 },
      { kind: 'number', min: 0, max: 1, whole: true },
      { kind: 'record', fields: {}, required: [] },
      { kind: 'choice', by: 'kind', of: { none: {} }, optional: {} },
    ])
  })

  await test.step('the Table’s own check: a row’s rest starts at one of its columns', async () => {
    const said = await page.evaluate(() => {
      const { tableProblem } = (window as unknown as Lent).__lumoviDoor.doorChecks
      return tableProblem({
        title: 'Pods',
        columns: [{ name: 'Node', kind: 'text' }],
        headings: true,
        rows: [
          {
            key: 'a',
            lead: { name: 'a' },
            cells: [{ kind: 'text', text: 'node-1' }],
            rest: { from: 1, text: 'All' },
          },
        ],
      })
    })
    expect(said).toBe('Row 1’s rest starts at column 2, and the table has 1 column.')
  })

  await test.step('the Table’s own check: a row is pressed for one thing, an object or a list', async () => {
    const said = await page.evaluate(() => {
      const { tableProblem } = (window as unknown as Lent).__lumoviDoor.doorChecks
      return tableProblem({
        title: 'Resources',
        columns: [{ name: 'Sync', kind: 'text' }],
        headings: true,
        rows: [
          {
            key: 'a',
            lead: { name: 'storefront' },
            cells: [{ kind: 'text', text: 'Synced' }],
            opens: 'object-1',
            goes: { list: 'apps/Deployment', name: 'storefront', namespace: 'shop' },
          },
        ],
      })
    })
    expect(said).toBe('Row 1 opens an object and goes to a list: a row is pressed for one of them.')
  })

  await test.step('the parts here are declared rightly', async () => {
    expect(
      await page.evaluate(
        ([parts]) => (window as unknown as Lent).__lumoviDoor.doorChecks.wrongWithParts(parts),
        [PARTS] as const,
      ),
    ).toBeUndefined()
    // One careless part among them is said, as it would be alone.
    expect(
      await page.evaluate(
        ([parts]) => (window as unknown as Lent).__lumoviDoor.doorChecks.wrongWithParts(parts),
        [{ ...PARTS, Bad: { name: 'two words', holds: 'parts', props: {} } }] as const,
      ),
    ).toBe('two words: isn’t a part’s name')
  })

  await test.step('a careless one is named', async () => {
    const wrong: Part[] = [
      { name: 'two words', holds: 'parts', props: {} },
      { name: 'A', holds: 'nothing', props: { label: text(0) } },
      { name: 'A', holds: 'nothing', props: { size: number(5, 1) } },
      { name: 'A', holds: 'nothing', props: { tone: oneOf([]) } },
      { name: 'A', holds: 'nothing', props: { onPress: handler('press') } },
      { name: 'A', holds: 'nothing', props: {}, required: ['label'] },
      { name: 'A', holds: 'nothing', props: {}, most: 0 },
      { name: 'A', holds: 'nothing', props: {}, most: 1.5 },
      { name: 'A', holds: 'nothing', props: {}, counts: shared('A parts', 0) },
      { name: 'A', holds: 'parts', props: {}, holdsMost: 0 },
      { name: 'A', holds: 'text', props: {}, holdsMost: 1.5 },
      { name: 'A', holds: 'parts', props: {}, holdsLeast: 0 },
      { name: 'A', holds: 'nothing', props: {}, holdsLeast: 1 },
    ]
    const said = await page.evaluate(
      ([wrong]) =>
        wrong.map((part) =>
          (window as unknown as Lent).__lumoviDoor.doorChecks.wrongWithPart(part),
        ),
      [wrong] as const,
    )
    for (const [i, part] of wrong.entries()) expect(said[i], JSON.stringify(part)).toBeTruthy()
    // Said with where it is: a list, a choice, a property's name, an event, and what it carries.
    const named: [Part, string][] = [
      [
        { name: 'A', holds: 'nothing', props: { rows: list(text(3), 0) } },
        'A.rows: a list needs a greatest length',
      ],
      [
        { name: 'A', holds: 'nothing', props: {}, holdsMost: 1 },
        'A: holds nothing, so it can’t say how many it holds',
      ],
      [
        { name: 'A', holds: ['Label'], props: {}, holdsMost: 0 },
        'A: how many it holds should be a whole number, 1 or more',
      ],
      [
        { name: 'A', holds: 'parts', props: {}, holdsLeast: 3, holdsMost: 2 },
        'A: holds 3 at least and 2 at most',
      ],
      [
        { name: 'A', holds: 'nothing', props: { cell: choice('two words', { a: {} }) } },
        'A.cell: two words isn’t a property’s name',
      ],
      [
        { name: 'A', holds: 'nothing', props: { cell: choice('kind', {}) } },
        'A.cell: chooses between nothing',
      ],
      [
        { name: 'A', holds: 'nothing', props: { cell: choice('kind', { a: { kind: text(3) } }) } },
        'A.cell.a: declares kind itself',
      ],
      [
        { name: 'A', holds: 'nothing', props: { cell: choice('kind', { a: { value: text(0) } }) } },
        'A.cell.a.value: a text needs a greatest length',
      ],
      [
        { name: 'A', holds: 'nothing', props: { 'two words': text(3) } },
        'A.two words: isn’t a property’s name',
      ],
      [
        { name: 'A', holds: 'nothing', props: {}, events: { 'two words': {} } },
        'A: two words isn’t an event’s name',
      ],
      [
        { name: 'A', holds: 'nothing', props: {}, events: { press: { row: text(0) } } },
        'A.press.row: a text needs a greatest length',
      ],
      [
        { name: 'A', holds: 'nothing', props: {}, events: { press: { then: handler('press') } } },
        'A.press: a call can’t carry a handler',
      ],
    ]
    // And one declared deeper than anything is checked; and a choice declared rightly.
    let deep: Kind = text(5)
    for (let i = 0; i < 40; i++) deep = list(deep, 1)
    const more = await page.evaluate(
      ([named, deep, right]) => {
        const { wrongWithPart } = (window as unknown as Lent).__lumoviDoor.doorChecks
        return {
          named: named.map(([part]) => wrongWithPart(part)),
          deep: wrongWithPart(deep),
          right: wrongWithPart(right),
        }
      },
      [
        named,
        { name: 'A', holds: 'nothing', props: { deep } },
        {
          name: 'A',
          holds: 'nothing',
          props: { cell: choice('kind', { none: {}, text: { value: text(5) } }) },
        },
      ] as [[Part, string][], Part, Part],
    )
    for (const [i, [, said]] of named.entries()) expect(more.named[i]).toBe(said)
    expect(more.deep).toContain('declared deeper')
    expect(more.right).toBeUndefined()
    // Together: a shared ceiling that says two things.
    const chip = {
      name: 'Chip',
      holds: 'nothing',
      props: {},
      counts: shared('Card and Tag parts', 21),
    }
    const parts = { ...PARTS, Chip: chip } as Record<string, Part>
    const [together, thrown] = await page.evaluate(
      ([parts]) => {
        const { wrongWithParts, DoorPage } = (window as unknown as Lent).__lumoviDoor.doorChecks
        let thrown: string | undefined
        try {
          new DoorPage(parts)
        } catch (error) {
          thrown = (error as Error).message
        }
        return [wrongWithParts(parts), thrown] as const
      },
      [parts] as const,
    )
    const said_ =
      'Chip: Card and Tag parts is 21 here and 20 where Card names it, and a shared ceiling has one number'
    expect(together).toBe(said_)
    // And the door starts no page with them.
    expect(thrown).toBe(`Lumovi’s own parts are declared wrongly: ${said_}`)
    // Nor with one among them declared wrongly by itself.
    const careless = { ...PARTS, Two: { name: 'two words', holds: 'parts', props: {} } }
    expect(
      await page.evaluate(
        (parts) => (window as unknown as Lent).__lumoviDoor.doorChecks.wrongWithParts(parts),
        careless as Record<string, Part>,
      ),
    ).toBe('two words: isn’t a part’s name')
  })
})

test('a plugin’s page: what it is, and how it changes', async ({ page, serve }) => {
  await opened(page, serve)

  await test.step('is what its plugin described: parts, their properties, texts, in order', async () => {
    const door = await doorPage(page)
    expect(
      await door.send(
        ['make', 1, 'Stack', { gap: 2 }],
        ['make', 2, 'Label', { tone: 'quiet' }],
        ['text', 3, 'Nodes'],
        ['put', 2, 3],
        ['make', 4, 'Button', { label: 'Refresh', onPress: 'h1' }],
        ['put', 1, 4],
        ['put', 1, 2, 4],
        ['put', ROOT, 1],
      ),
    ).toEqual({ changed: [2, 1, ROOT] })
    expect((await door.node(ROOT))?.children).toEqual([1])
    expect(await door.node(1)).toMatchObject({
      part: 'Stack',
      props: { gap: 2 },
      children: [2, 4],
    })
    expect((await door.node(3))?.text).toBe('Nodes')
    expect((await door.holds()).nodes).toBe(4)
  })

  await test.step('changes: a text, a part’s properties, the order, and what’s taken away is gone whole', async () => {
    const door = await doorPage(page)
    await door.send(
      ['make', 1, 'Stack', {}],
      ['put', ROOT, 1],
      ['make', 2, 'Label', {}],
      ['text', 3, 'a'],
      ['put', 2, 3],
      ['put', 1, 2],
      ['make', 4, 'Button', { label: 'b' }],
      ['put', 1, 4],
    )
    const before = (await door.holds()).characters
    expect(await door.send(['text', 3, 'abc'], ['change', 4, { label: 'bcd' }])).toEqual({
      changed: [3, 4],
    })
    expect((await door.holds()).characters).toBe(before + 4)
    expect((await door.node(4))?.props).toEqual({ label: 'bcd' })
    // Moved: to the end, and back before the other.
    await door.send(['put', 1, 2])
    expect((await door.node(1))?.children).toEqual([4, 2])
    await door.send(['put', 1, 2, 4])
    expect((await door.node(1))?.children).toEqual([2, 4])
    // Taken away, with the text under it; what was changed and then taken isn't to be drawn.
    expect(await door.send(['text', 3, 'x'], ['take', 1, 2])).toEqual({ changed: [1] })
    expect(await door.node(2)).toBeUndefined()
    expect(await door.node(3)).toBeUndefined()
    expect((await door.holds()).nodes).toBe(2)
    expect(await door.stopped()).toBeUndefined()
  })

  await test.step('says which commit last changed what’s drawn of each part and text, and only ever later', async () => {
    const door = await doorPage(page)
    await door.send(
      ['make', 1, 'Stack', {}],
      ['make', 2, 'Label', {}],
      ['text', 3, 'a'],
      ['put', 2, 3],
      ['put', 1, 2],
      ['make', 4, 'Button', { label: 'b' }],
      ['put', 1, 4],
      ['put', ROOT, 1],
    )
    expect(await door.changedAt([ROOT, 1, 2, 3, 4])).toEqual([1, 1, 1, 0, 0])
    await door.send(['text', 3, 'abc'])
    await door.send(['change', 4, { label: 'bcd' }])
    expect(await door.changedAt([ROOT, 1, 2, 3, 4])).toEqual([1, 1, 1, 2, 3])
    await door.send(['put', 1, 2])
    expect(await door.changedAt([1])).toEqual([4])
    await door.send(['take', 1, 2])
    expect(await door.changedAt([1, 2, 3])).toEqual([5, 0, 0])
    stopped(await door.send(['change', 4, { label: 7 }]))
    expect(await door.changedAt([4])).toEqual([3])
  })

  await test.step('what was made and never put anywhere can be let go of', async () => {
    const door = await doorPage(page)
    await door.send(
      ['make', 1, 'Stack', {}],
      ['make', 2, 'Stack', {}],
      ['put', 1, 2],
      ['text', 3, 'abc'],
    )
    expect(await door.holds()).toEqual({ nodes: 3, characters: 7 })
    expect(await door.send(['take', null, 1], ['take', null, 3])).toEqual({ changed: [] })
    expect(await door.holds()).toEqual({ nodes: 0, characters: 0 })
    // Not what's under something, not the page itself, not what's gone.
    for (const id of [2, ROOT, 9, '1']) {
      const other = await doorPage(page)
      await other.send(['make', 1, 'Stack', {}], ['make', 2, 'Stack', {}], ['put', 1, 2])
      expect(stopped(await other.send(['take', null, id])).what, String(id)).toBe(
        'step 1: takes away what isn’t there',
      )
    }
  })

  await test.step('what’s read of the page, and what was checked, is a copy nobody can change', async () => {
    const door = await doorPage(page)
    await door.send(
      ['make', 1, 'Stack', {}],
      ['make', 2, 'Stack', {}],
      ['put', 1, 2],
      ['put', ROOT, 1],
    )
    expect((await door.frozen(1)) && (await door.frozen(1, 'children'))).toBe(true)
    expect(await door.pushThrows(1)).toBe(true)
    expect(await door.node(1)).toEqual({ part: 'Stack', props: {}, children: [2] })
    await door.send(['text', 3, 'a'])
    expect((await door.frozen(3, 'props')) && (await door.frozen(ROOT, 'props'))).toBe(true)
    const rows = await doorPage(page, {
      ...PARTS,
      Rows: {
        name: 'Rows',
        holds: 'nothing',
        props: { rows: list(record({ name: text(10) }), 5) },
      },
    })
    await rows.take(JSON.stringify({ commit: [['make', 1, 'Rows', { rows: [{ name: 'a' }] }]] }))
    expect(await rows.frozen(1, 'props', 'rows', '0')).toBe(true)
    await rows.take(JSON.stringify({ commit: [['change', 1, { rows: [] }]] }))
    expect(await rows.frozen(1, 'props', 'rows')).toBe(true)
  })

  await test.step('a part is handed every text as one that isn’t Lumovi’s, wherever it is in its properties', async () => {
    const fields = {
      label: text(10),
      size: number(0, 9),
      rows: list(
        record({ name: text(10), cell: choice('kind', { none: {}, text: { text: text(10) } }) }),
        5,
      ),
    }
    const props = {
      label: 'a',
      size: 2,
      rows: [{ name: 'b', cell: { kind: 'text', text: 'c' } }, { cell: { kind: 'none' } }],
    }
    const [wrong, given, frozen] = await page.evaluate(
      ([props, fields]) => {
        const { wrongWithFields, handedFields } = (window as unknown as Lent).__lumoviDoor
          .doorChecks
        const given = handedFields(props, fields)
        return [
          wrongWithFields(props, fields, [], 'Part'),
          given,
          Object.isFrozen(given) && Object.isFrozen((given.rows as unknown[])[0]),
        ] as const
      },
      [props, fields] as const,
    )
    expect(wrong).toBeUndefined()
    expect(given).toEqual({
      label: { their: 'a' },
      size: 2,
      rows: [
        { name: { their: 'b' }, cell: { kind: 'text', text: { their: 'c' } } },
        { cell: { kind: 'none' } },
      ],
    })
    expect(frozen).toBe(true)
  })

  await test.step('a text is taken whatever its characters: what’s in a cluster isn’t the plugin’s to answer for', async () => {
    const texts = ['👨‍👩‍👧', 'می‌خواهم', 'un­seen', 'safe‮gnp.exe', 'a\u0000b', 'a\uD83Db']
    const door = await doorPage(page)
    for (const [i, text] of texts.entries()) {
      expect(
        await door.send(['text', 2 * i + 1, text], ['make', 2 * i + 2, 'Button', { label: text }]),
      ).toEqual({ changed: [] })
      expect((await door.node(2 * i + 1))?.text).toBe(text)
      expect((await door.node(2 * i + 2))?.props.label).toBe(text)
    }
    expect(await door.stopped()).toBeUndefined()
  })
})

test('what a plugin can use of the door: the release that first carried each, as the page holds it', async ({
  page,
  serve,
}) => {
  await opened(page, serve)
  // plugin-since.spec's first case, of what the built page holds: every part a page may name has
  // a release, and each is the one being made or three numbers no newer than this one.
  const since = await page.evaluate(
    () => (window as unknown as Lent).__lumoviDoor.doorChecks.PLUGIN_SINCE,
  )
  expect(since).toEqual(PLUGIN_SINCE)
  expect(Object.keys(since.parts).sort()).toEqual(Object.keys(DECLARED).sort())
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
  const numbers = (release: string) => release.split('.').map(Number)
  for (const [what, each] of Object.entries(since)) {
    for (const [name, release] of Object.entries(each) as [string, string][]) {
      if (release === 'next') continue
      expect(release, `${what}.${name}`).toMatch(/^\d+\.\d+\.\d+$/)
      const [a, b] = [numbers(release), numbers(version)]
      const newer = a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!
      expect(newer, `${what}.${name}`).toBeLessThanOrEqual(0)
    }
  }
})

test('a plugin’s page: what stops it', async ({ page, serve }) => {
  await opened(page, serve)

  await test.step('has no more of a part than its declaration lets a page have: made and not taken away', async () => {
    const door = await doorPage(page)
    await door.send(
      ['make', 1, 'Stack', {}],
      ['put', ROOT, 1],
      ['make', 2, 'Badge', {}],
      ['put', 1, 2],
    )
    await door.send(['make', 3, 'Badge', {}])
    await door.send(['take', 1, 2], ['make', 4, 'Badge', {}], ['put', 1, 4])
    await door.send(['take', null, 3], ['make', 5, 'Badge', {}])
    await door.send(['take', ROOT, 1], ['make', 6, 'Badge', {}])
    expect(await door.stopped()).toBeUndefined()
    expect(stopped(await door.send(['make', 7, 'Badge', {}]))).toEqual({
      why: 'too-much',
      what: 'step 1: a page’s Badge parts: more than 2',
    })
  })

  await test.step('has no more between them of parts that share a ceiling than it lets a page have', async () => {
    const cards = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ['make', from + i, i % 2 ? 'Tag' : 'Card', {}])
    for (const last of ['Card', 'Tag']) {
      const door = await doorPage(page)
      await door.send(...cards(1, 20))
      expect(await door.stopped()).toBeUndefined()
      expect(stopped(await door.send(['make', 21, last, {}]))).toEqual({
        why: 'too-much',
        what: 'step 1: a page’s Card and Tag parts: more than 20',
      })
    }
    const door = await doorPage(page)
    await door.send(...cards(1, 20))
    await door.send(['take', null, 2], ['make', 21, 'Card', {}])
    expect(await door.stopped()).toBeUndefined()
    await door.send(['make', 22, 'Badge', {}])
    expect(await door.stopped()).toBeUndefined()
  })

  await test.step('a message that isn’t a commit stops it', async () => {
    const messages: unknown[] = [
      '',
      '{',
      'null',
      '[]',
      '"commit"',
      '{}',
      '{"commit": {}}',
      '{"commit": [], "more": 1}',
      '{"commit": [], "__proto__": {}}',
      '{"__proto__": {"commit": []}}',
      '{"commit": [5]}',
      '{"commit": [[]]}',
      '{"commit": [[1, 2]]}',
      '{"commit": [["eval", "1"]]}',
      '{"commit": [["make", 1, "Stack"]]}',
      '{"commit": [["make", 1, "Stack", {}, 1]]}',
      '{"commit": [["put", 0]]}',
      '{"commit": [["text", 1]]}',
      '{"commit": [["change", 1]]}',
      '{"commit": [["put", 0, 1, 2, 3]]}',
      '{"commit": [["take", 1]]}',
      5,
      { commit: [] },
    ]
    for (const message of messages) {
      const door = await doorPage(page)
      const result = stopped(await door.take(message))
      expect(result.why, String(message)).toBe('not-allowed')
      expect(await door.stopped()).toEqual(result)
    }
  })

  await test.step('once stopped it takes nothing more, and says the same', async () => {
    const door = await doorPage(page)
    const first = stopped(await door.send(['make', 1, 'Nothing', {}]))
    expect(first).toEqual({
      why: 'not-allowed',
      what: 'step 1: names a part Lumovi doesn’t have: "Nothing"',
    })
    expect(await door.send(['make', 1, 'Stack', {}])).toEqual(first)
    expect(await door.node(1)).toBeUndefined()
  })

  await test.step('a part gets only what’s declared for it', async () => {
    const wrong: unknown[][] = [
      ['make', 1, 'Stack', { gap: 9 }],
      ['make', 1, 'Stack', { style: 'color: red' }],
      ['make', 1, 'Stack', { dangerouslySetInnerHTML: { __html: '<img>' } }],
      ['make', 1, 'Stack', null],
      ['make', 1, 'Stack', []],
      ['make', 1, 'Button', {}],
      ['make', 1, 'Button', { label: 'a', onPress: 'javascript:alert(1)' }],
      ['make', 1, 'Button', { label: 'a', of: { kind: 'Secret', name: 'a' } }],
      ['make', 1, 'toString', {}],
      ['make', 1, 'constructor', {}],
      ['make', 1, 5, {}],
    ]
    for (const step of wrong) {
      expect(stopped(await (await doorPage(page)).send(step)).why, JSON.stringify(step)).toBe(
        'not-allowed',
      )
    }
    const door = await doorPage(page)
    await door.send(['make', 1, 'Stack', {}])
    expect(stopped(await door.send(['change', 1, { gap: 2, onPress: 'h1' }])).what).toBe(
      'step 1: Stack: takes nothing named "onPress"',
    )
  })

  await test.step('what a part’s kinds can’t say, the part says: one property agreeing with another', async () => {
    // (Its check is a function, so the part is declared in the page, as door.spec declares it.)
    const said = await page.evaluate(
      ([names, values]) => {
        const { DoorPage } = (window as unknown as Lent).__lumoviDoor.doorChecks
        const parts: Record<string, Part> = {
          Pair: {
            name: 'Pair',
            holds: 'nothing',
            props: { names, values },
            also: (props) =>
              (props.names as string[] | undefined)?.length ===
              (props.values as number[] | undefined)?.length
                ? undefined
                : 'a value for every name',
          },
        }
        const made = (props: unknown) =>
          new DoorPage(parts, () => 0).take(
            JSON.stringify({ commit: [['make', 1, 'Pair', props]] }),
          )
        const agreeing = made({ names: ['a'], values: [1] })
        const disagreeing = made({ names: ['a'], values: [] })
        parts.Pair = { ...parts.Pair!, also: () => (undefined as unknown as { a: string }).a }
        const throwing = made({ names: [], values: [] })
        delete parts.Pair.also
        const notAList = made({ names: 'a', values: [] })
        return { agreeing, disagreeing, throwing, notAList }
      },
      [list(text(10), 5), list(number(0, 9), 5)] as const,
    )
    expect(said.agreeing).toEqual({ changed: [] })
    expect(said.disagreeing).toEqual({
      why: 'not-allowed',
      what: 'step 1: Pair: a value for every name',
    })
    // A check that throws refuses; the door doesn't throw.
    expect(said.throwing).toEqual({
      why: 'not-allowed',
      what: 'step 1: Pair: has properties it can’t check',
    })
    // (Only what passed its kinds is asked about.)
    expect(stopped(said.notAList).what).toBe('step 1: Pair.names: should be a list')
  })

  await test.step('what a plugin wrote is never said back as it wrote it: short, one line, nothing unseen', async () => {
    const long = `style\n2026-10-12 Lumovi: all is well‮${'x'.repeat(10_000)}`
    const said = async (...steps: unknown[]) =>
      stopped(await (await doorPage(page)).send(...steps)).what
    const lines = [
      await said(['make', 1, 'Stack', { [long]: 1 }]),
      await said(['make', 1, long, {}]),
      await said(['make', long, 'Stack', {}]),
      await said(['make', 1, 'Stack', { gap: { [long]: long } }]),
      await said(['make', 1, 'Button', { label: long }]),
      await said(['make', 1, 'Button', { label: 'a', onPress: long }]),
      await said([long, 1]),
    ]
    for (const line of lines) {
      expect(line.length, line).toBeLessThan(120)
      expect(line, line).not.toMatch(/[\n‮]/)
      expect(line, line).not.toContain('xxxx')
    }
    expect(lines[0]).toBe(
      'step 1: Stack: takes nothing named "style 2026-10-12 Lumovi: all is well U+202E xxx…"',
    )
  })

  await test.step('a number is new once, and only a whole one above nothing', async () => {
    for (const id of [0, -1, 1.5, '1', null, 2 ** 53, [1]]) {
      expect(
        stopped(await (await doorPage(page)).send(['make', id, 'Stack', {}])).why,
        String(id),
      ).toBe('not-allowed')
    }
    const door = await doorPage(page)
    await door.send(['make', 5, 'Stack', {}])
    expect(stopped(await door.send(['make', 5, 'Stack', {}])).what).toContain('isn’t new')
    expect(
      stopped(await (await doorPage(page)).send(['make', 5, 'Stack', {}], ['make', 4, 'Stack', {}]))
        .why,
    ).toBe('not-allowed')
    expect(
      stopped(
        await (
          await doorPage(page)
        ).send(
          ['make', 1, 'Stack', {}],
          ['put', ROOT, 1],
          ['take', ROOT, 1],
          ['make', 1, 'Stack', {}],
        ),
      ).why,
    ).toBe('not-allowed')
  })

  await test.step('one parent, no loop, and only what a part holds', async () => {
    const base: unknown[][] = [
      ['make', 1, 'Stack', {}],
      ['make', 2, 'Stack', {}],
      ['make', 3, 'Label', {}],
      ['text', 4, 'a'],
      ['make', 5, 'Row', {}],
      ['make', 6, 'Button', { label: 'a' }],
      ['put', 1, 2],
    ]
    const wrong: [unknown[], string][] = [
      [['put', 1, 1], 'under itself'],
      [['put', 2, 1], 'under itself'],
      [['put', ROOT, 2], 'under another'],
      [['put', 1, 4], 'which holds'],
      [['put', ROOT, 4], 'which holds'],
      [['put', 3, 6], 'which holds'],
      [['put', 5, 6], 'which holds'],
      [['put', 6, 3], 'which holds'],
      [['put', 4, 3], 'which holds'],
      [['put', 1, 9], 'isn’t there'],
      [['put', 9, 1], 'isn’t there'],
      [['put', '0', 1], 'isn’t there'],
      [['put', 1, 'x'], 'isn’t there'],
      [['put', 1, 3, 6], 'isn’t beside it'],
      [['put', 1, 3, 3], 'isn’t beside it'],
      [['put', 1, 3, 'x'], 'isn’t beside it'],
      [['take', 1, 3], 'isn’t there'],
      [['take', 2, 2], 'isn’t there'],
      [['take', 9, 2], 'isn’t there'],
      [['take', 'x', 3], 'isn’t there'],
      [['text', 1, 'a'], 'isn’t a text'],
      [['text', 'x', 'a'], 'isn’t a text'],
      [['text', 4, 5], 'isn’t text'],
      [['change', 4, {}], 'isn’t a part'],
      [['change', ROOT, {}], 'isn’t a part'],
      [['change', 9, {}], 'isn’t a part'],
    ]
    for (const [step, what] of wrong) {
      const result = stopped(await (await doorPage(page)).send(...base, step))
      expect(result.why, JSON.stringify(step)).toBe('not-allowed')
      expect(result.what, JSON.stringify(step)).toContain(what)
    }
    const said = async (step: unknown[]) =>
      stopped(await (await doorPage(page)).send(...base, step)).what
    expect(await said(['put', 5, 6])).toBe(
      'step 8: puts a Button into a Row, which holds only Label',
    )
    expect(await said(['put', ROOT, 4])).toBe(
      'step 8: puts a text into the page itself, which holds only parts',
    )
    expect(await said(['put', 6, 3])).toBe(
      'step 8: puts a Label into a Button, which holds nothing',
    )
    expect(await said(['make', 3, 'Stack', {}])).toBe(
      'step 8: makes something under a number that isn’t new: 3',
    )
    expect(await (await doorPage(page)).send(...base, ['put', 5, 3])).toEqual({ changed: [1, 5] })
  })

  await test.step('a part that holds so many holds no more: one more is refused, not left undrawn', async () => {
    const base: unknown[][] = [
      ['make', 1, 'Frame', {}],
      ['make', 2, 'Label', {}],
      ['make', 3, 'Row', {}],
      ['make', 4, 'Pair', {}],
      ['text', 5, 'a'],
      ['text', 6, 'b'],
      ['text', 7, 'c'],
      ['put', 1, 2],
      ['put', 4, 5],
      ['put', 4, 6],
    ]
    expect(await (await doorPage(page)).send(...base)).toEqual({ changed: [1, 4] })
    expect(stopped(await (await doorPage(page)).send(...base, ['put', 1, 3]))).toEqual({
      why: 'not-allowed',
      what: 'step 11: puts a Row into a Frame, which holds one at most',
    })
    expect(stopped(await (await doorPage(page)).send(...base, ['put', 4, 7])).what).toBe(
      'step 11: puts a text into a Pair, which holds 2 at most',
    )
    // What it holds already moves within it; and with one taken away, another goes in.
    expect(await (await doorPage(page)).send(...base, ['put', 4, 6, 5])).toEqual({
      changed: [1, 4],
    })
    expect(await (await doorPage(page)).send(...base, ['take', 1, 2], ['put', 1, 3])).toEqual({
      changed: [1, 4],
    })
  })

  await test.step('a part that holds so many at least holds them on the page once a commit is whole', async () => {
    const short = (holds: number) =>
      `leaves a Pair on the page that holds ${holds}, and a Pair holds 2 at least`
    const pair: unknown[][] = [
      ['make', 1, 'Pair', {}],
      ['text', 2, 'a'],
      ['text', 3, 'b'],
    ]
    // Put together in one commit, one text at a time: whole, it holds two.
    const { send } = await doorPage(page)
    expect(await send(...pair, ['put', ROOT, 1], ['put', 1, 2], ['put', 1, 3])).toEqual({
      changed: [ROOT, 1],
    })
    // On the page with one, it's refused, and said as the commit's (no one step is wrong).
    expect(
      stopped(await (await doorPage(page)).send(...pair, ['put', 1, 2], ['put', ROOT, 1])),
    ).toEqual({ why: 'not-allowed', what: short(1) })
    // One taken away from it on the page, and none put back: refused. One put back: taken.
    expect(stopped(await send(['take', 1, 2])).what).toBe(short(1))
    const again = await doorPage(page)
    await again.send(...pair, ['put', 1, 2], ['put', 1, 3], ['put', ROOT, 1])
    expect(await again.send(['take', 1, 2], ['text', 4, 'c'], ['put', 1, 4])).toEqual({
      changed: [1],
    })
    // Off the page it's still being put together, over as many commits as it takes, however
    // deep: under a Stack that isn't on the page either. Put on whole, it's taken.
    const inStack: unknown[][] = [
      ['make', 1, 'Stack', {}],
      ['make', 2, 'Pair', {}],
      ['put', 1, 2],
    ]
    const off = await doorPage(page)
    expect(await off.send(...inStack)).toEqual({ changed: [1] })
    expect(await off.send(['text', 3, 'a'], ['put', 2, 3])).toEqual({ changed: [2] })
    expect(stopped(await (await doorPage(page)).send(...inStack, ['put', ROOT, 1])).what).toBe(
      short(0),
    )
    expect(await off.send(['text', 4, 'b'], ['put', 2, 4], ['put', ROOT, 1])).toEqual({
      changed: [2, ROOT],
    })
    // And taken away whole, with what's short in it, nothing short is left on the page.
    expect(
      await off.send(['take', 2, 4], ['take', ROOT, 1], ['make', 5, 'Label', {}], ['put', ROOT, 5]),
    ).toEqual({ changed: [ROOT] })
  })
})

test('a plugin’s page: its ceilings', async ({ page, serve }) => {
  test.slow()
  await opened(page, serve)

  await test.step('over a ceiling it’s stopped: a message, a commit’s steps, a text', async () => {
    const door = await doorPage(page)
    expect(stopped(await door.take(' '.repeat(DOOR_LIMITS.message + 1)))).toEqual({
      why: 'too-much',
      what: 'a message: more than 1,048,576',
    })
    const steps = Array.from({ length: DOOR_LIMITS.stepsACommit + 1 }, (_, i) => [
      'text',
      i + 1,
      '',
    ])
    expect(stopped(await (await doorPage(page)).send(...steps)).what).toBe(
      'the steps of a commit: more than 2,000',
    )
    expect(await (await doorPage(page)).send(...steps.slice(1))).toEqual({ changed: [] })
    expect(await (await doorPage(page)).send(['text', 1, 'a'.repeat(DOOR_LIMITS.text)])).toEqual({
      changed: [],
    })
    expect(
      stopped(await (await doorPage(page)).send(['text', 1, 'a'.repeat(DOOR_LIMITS.text + 1)]))
        .what,
    ).toBe('step 1: a text: more than 4,000')
  })

  await test.step('over a ceiling it’s stopped: commits and steps in a second, by Lumovi’s clock', async () => {
    const most = DOOR_LIMITS.secondsAtOnce
    const nothing = (times: number) => Array.from({ length: times }, () => ({ changed: [] }))
    const door = await doorPage(page)
    expect(await door.sendTimes(DOOR_LIMITS.commitsASecond * most)).toEqual(
      nothing(DOOR_LIMITS.commitsASecond * most),
    )
    await door.at(500)
    expect(await door.sendTimes(DOOR_LIMITS.commitsASecond / 2)).toEqual(
      nothing(DOOR_LIMITS.commitsASecond / 2),
    )
    expect(stopped(await door.send()).what).toBe('commits in a second: more than 60')
    const quiet = await doorPage(page)
    await quiet.send()
    await quiet.at(3_600_000)
    expect(await quiet.sendTimes(DOOR_LIMITS.commitsASecond * most)).toEqual(
      nothing(DOOR_LIMITS.commitsASecond * most),
    )
    expect(stopped(await quiet.send()).why).toBe('too-much')

    const other = await doorPage(page)
    const full = Array.from({ length: DOOR_LIMITS.stepsACommit }, () => ['text', 1, ''])
    expect(await other.send(['text', 1, ''])).toEqual({ changed: [] })
    await other.at(5000)
    const rounds = (DOOR_LIMITS.stepsASecond * most) / DOOR_LIMITS.stepsACommit
    expect(await other.sendTimes(rounds, ...full)).toEqual(
      Array.from({ length: rounds }, () => ({ changed: [1] })),
    )
    expect(stopped(await other.send(['text', 1, ''])).what).toBe(
      'steps in a second: more than 20,000',
    )
    // A plugin that takes exactly what's filled, with nothing in hand, by a clock that isn't
    // whole numbers (as a real one isn't): never stopped for the hair that arithmetic leaves
    // under a whole step. (Counted strictly, this stops at its eleventh round.)
    const exact = await doorPage(page)
    await exact.at(0.1)
    await exact.sendTimes(rounds, ...full)
    const EXACT = JSON.stringify({
      commit: Array.from({ length: DOOR_LIMITS.stepsASecond / 10 }, () => ['text', 1, '']),
    })
    expect(await exact.exactRounds(EXACT, 2000, 0.1, 100), 'the round it was stopped at').toBe(0)
    // And one step more than what's filled is still one too many.
    expect(stopped(await exact.send(['text', 1, ''])).what).toBe(
      'steps in a second: more than 20,000',
    )
    // A plugin that keeps to its second, whose messages come late and together: never stopped.
    const late = await doorPage(page)
    await late.send(['text', 1, ''])
    for (let second = 1; second <= 30; second++) {
      // (Nothing for 1.9 s, then what it sent in that time, at once.)
      await late.later(1900)
      expect(await late.sendTimes(19, ...full.slice(0, 1000))).toEqual(
        Array.from({ length: 19 }, () => ({ changed: [1] })),
      )
    }
  })

  await test.step('a clock set back doesn’t stop an honest page, nor give it more', async () => {
    const door = await doorPage(page)
    const nothing = Array.from({ length: DOOR_LIMITS.commitsASecond }, () => ({ changed: [] }))
    await door.at(50_000)
    await door.sendTimes(DOOR_LIMITS.commitsASecond)
    await door.at(10_000)
    expect(await door.sendTimes(DOOR_LIMITS.commitsASecond)).toEqual(nothing)
    await door.at(11_000)
    expect(await door.sendTimes(DOOR_LIMITS.commitsASecond)).toEqual(nothing)
    expect(stopped(await door.send()).why).toBe('too-much')
    // And with no clock given it has one of its own.
    expect(
      await page.evaluate((parts) => {
        const { DoorPage } = (window as unknown as Lent).__lumoviDoor.doorChecks
        return new DoorPage(parts).take('{"commit":[]}')
      }, PARTS),
    ).toEqual({ changed: [] })
  })

  await test.step('over a ceiling it’s stopped: how many parts, and they’re counted off the page too', async () => {
    // A text past it, and a part: each is refused.
    for (const past of [
      (id: number) => ['text', id, ''],
      (id: number) => ['make', id, 'Label', {}],
    ]) {
      const door = await doorPage(page)
      let id = 0
      while (id < DOOR_LIMITS.nodes) {
        await door.later(1000)
        const some = Array.from({ length: 1000 }, () => ['make', ++id, 'Stack', {}])
        expect(await door.send(...some)).toEqual({ changed: [] })
      }
      expect((await door.holds()).nodes).toBe(DOOR_LIMITS.nodes)
      expect(stopped(await door.send(past(++id))).what).toBe(
        'step 1: a page’s parts: more than 5,000',
      )
    }
  })

  await test.step('over a ceiling it’s stopped: all a page holds, a changed text and property counted', async () => {
    const door = await doorPage(page)
    const full = 'a'.repeat(DOOR_LIMITS.text)
    const texts = Math.floor(DOOR_LIMITS.held / DOOR_LIMITS.text)
    let id = 0
    while (id < texts) {
      await door.later(1000)
      expect(await door.send(...Array.from({ length: 131 }, () => ['text', ++id, full]))).toEqual({
        changed: [],
      })
    }
    expect(DOOR_LIMITS.held - (await door.holds()).characters).toBe(1152)
    await door.later(1000)
    expect(
      await door.send(
        ['text', ++id, 'a'.repeat(1152)],
        ['text', id, ''],
        ['make', ++id, 'Stack', {}],
      ),
    ).toEqual({ changed: [id - 1] })
    expect(stopped(await door.send(['text', id - 1, 'a'.repeat(1151)])).what).toBe(
      'step 1: what a page holds: more than 2,097,152',
    )
    // A new text past it too, as well as a text that grows.
    const fresh = await doorPage(page)
    let written = 0
    while (written < texts) {
      await fresh.later(1000)
      await fresh.send(...Array.from({ length: 131 }, () => ['text', ++written, full]))
    }
    expect(stopped(await fresh.send(['text', ++written, 'a'.repeat(1153)])).what).toBe(
      'step 1: what a page holds: more than 2,097,152',
    )
    const other = await doorPage(page)
    let made = 0
    while (made < texts) {
      await other.later(1000)
      await other.send(...Array.from({ length: 131 }, () => ['text', ++made, full]))
    }
    await other.later(1000)
    expect(
      await other.send(['make', 1000, 'Button', { label: '' }], ['text', 1001, 'a'.repeat(1000)]),
    ).toEqual({ changed: [] })
    expect(
      await other.send(['change', 1000, { label: 'a'.repeat(80), of: 'o'.repeat(52) }]),
    ).toEqual({ changed: [1000] })
    expect(DOOR_LIMITS.held - (await other.holds()).characters).toBe(0)
    const result = await other.send(['change', 1000, { label: 'a'.repeat(80), of: 'o'.repeat(53) }])
    expect(stopped(result).why).toBe('too-much')
  })

  await test.step('over a ceiling it’s stopped: what one part holds, and a move isn’t one more', async () => {
    const door = await doorPage(page)
    let id = 1
    await door.send(['make', 1, 'Stack', {}], ['put', ROOT, 1])
    while (id <= DOOR_LIMITS.inOnePart) {
      await door.later(1000)
      const steps: unknown[][] = []
      for (let i = 0; i < 500; i++) steps.push(['make', ++id, 'Stack', {}], ['put', 1, id])
      expect(await door.send(...steps)).toEqual({ changed: [1] })
    }
    expect(await door.send(['put', 1, 2], ['put', 1, 3, 2])).toEqual({ changed: [1] })
    expect(stopped(await door.send(['make', ++id, 'Stack', {}], ['put', 1, id])).what).toBe(
      'step 2: what one part holds: more than 1,000',
    )
  })

  // (door.spec times these two as well; a page built to be measured is slower, so here they're
  // tried for what they leave the page, not for how long they take.)
  await test.step('the worst second the ceilings allow is taken whole', async () => {
    const door = await doorPage(page)
    let id = 1
    await door.send(['make', 1, 'Stack', {}], ['put', ROOT, 1])
    for (let n = 0; n < 2; n++) {
      await door.later(1000)
      const steps: unknown[][] = []
      for (let i = 0; i < 500; i++) steps.push(['make', ++id, 'Stack', {}], ['put', 1, id])
      await door.send(...steps)
    }
    const commits = Array.from(
      { length: DOOR_LIMITS.stepsASecond / DOOR_LIMITS.stepsACommit },
      (_, c) =>
        JSON.stringify({
          commit: Array.from({ length: DOOR_LIMITS.stepsACommit }, (_, i) =>
            (i + c) % 2
              ? ['put', 1, 2 + (i % 1000)]
              : ['put', 1, 1001 - (i % 1000), 2 + ((i + 500) % 1000)],
          ),
        }),
    )
    await door.later(1000)
    expect(await door.takeAll(commits)).toEqual(commits.map(() => ({ changed: [1] })))
    expect(await door.stopped()).toBeUndefined()
  })

  await test.step('the other worst second: a leaf put and taken at the bottom of wide parts', async () => {
    const door = await doorPage(page)
    let id = 0
    const chain: number[] = []
    for (let level = 0; level < 31; level++) {
      await door.later(1000)
      const steps: unknown[][] = [
        ['make', ++id, 'Stack', {}],
        ['put', chain.at(-1) ?? ROOT, id],
      ]
      chain.push(id)
      if (level % 8 === 3) {
        for (let i = 0; i < 990; i++)
          steps.push(['make', ++id, 'Stack', {}], ['put', chain.at(-1)!, id])
      }
      expect(await door.send(...steps)).toHaveProperty('changed')
    }
    expect((await door.holds()).nodes).toBe(31 + 4 * 990)
    const bottom = chain.at(-1)!
    const commits = Array.from(
      { length: DOOR_LIMITS.stepsASecond / DOOR_LIMITS.stepsACommit },
      () => {
        const steps: unknown[][] = []
        while (steps.length + 3 <= DOOR_LIMITS.stepsACommit)
          steps.push(['make', ++id, 'Stack', {}], ['put', bottom, id], ['take', bottom, id])
        return JSON.stringify({ commit: steps })
      },
    )
    await door.later(1000)
    expect(await door.takeAll(commits)).toEqual(commits.map(() => ({ changed: [bottom] })))
    // And the heights it keeps are still right: one more level fits, and no more.
    expect(await door.send(['make', ++id, 'Stack', {}], ['put', bottom, id])).toEqual({
      changed: [bottom],
    })
    expect(stopped(await door.send(['make', ++id, 'Stack', {}], ['put', id - 1, id])).why).toBe(
      'too-much',
    )
  })

  await test.step('over a ceiling it’s stopped: how deep, however the page is put together', async () => {
    const makes = Array.from({ length: DOOR_LIMITS.depth + 1 }, (_, i) => [
      'make',
      i + 1,
      'Stack',
      {},
    ])
    const down = await doorPage(page)
    expect(await down.send(...makes, ['put', ROOT, 1])).toEqual({ changed: [ROOT] })
    for (let i = 1; i < DOOR_LIMITS.depth; i++)
      expect(await down.send(['put', i, i + 1])).toEqual({ changed: [i] })
    expect(stopped(await down.send(['put', DOOR_LIMITS.depth, DOOR_LIMITS.depth + 1])).what).toBe(
      'step 1: how deep a page goes: more than 32',
    )
    const up = await doorPage(page)
    await up.send(...makes)
    for (let i = DOOR_LIMITS.depth; i > 1; i--)
      expect(await up.send(['put', i, i + 1])).toEqual({ changed: [i] })
    expect(stopped(await up.send(['put', 1, 2])).what).toBe(
      'step 1: how deep a page goes: more than 32',
    )
    const halves = await doorPage(page)
    await halves.send(...makes, ['make', 40, 'Stack', {}], ['put', ROOT, 1])
    for (let i = 1; i < 20; i++) await halves.send(['put', i, i + 1])
    for (let i = 21; i < DOOR_LIMITS.depth + 1; i++) await halves.send(['put', i, i + 1])
    expect(await halves.stopped()).toBeUndefined()
    expect(stopped(await halves.send(['put', 20, 21])).why).toBe('too-much')
    const room = await doorPage(page)
    await room.send(...makes, ['make', 40, 'Stack', {}], ['put', ROOT, 1])
    for (let i = 1; i < DOOR_LIMITS.depth; i++) await room.send(['put', i, i + 1])
    expect(await room.send(['take', 20, 21], ['put', 20, 40])).toEqual({ changed: [20] })
  })
})

/** A port nothing listens on (for now): a server is told its own address before it starts. */
const freePort = () =>
  new Promise<number>((found) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => found(port))
    })
  })

test('through a real box: what isn’t text stops the page, as the box tells Lumovi', async ({
  page,
  serve,
}) => {
  // (A server with plugins knows its own address: the box is served at it.)
  const port = await freePort()
  const { url } = await serve({ port, env: { LUMOVI_URL: `http://127.0.0.1:${port}` } })
  await signIn(page, `${url}cluster/demo/pods`, DEMO_TOKEN)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  await page.evaluate(() =>
    (window as unknown as Lent).__lumoviDoor.show({
      plugin: 'toys',
      name: 'Toys',
      version: '1.0.0',
      code: 'box.then(({ post }) => post(5))',
    }),
  )
  const ended = page.getByTestId('plugin-ended')
  await expect(ended).toHaveAttribute('data-why', 'not-allowed')
  await expect(ended).toContainText('It sent something a plugin can’t.')
})

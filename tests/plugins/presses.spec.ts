/**
 * The door, for what a person presses on a plugin's page: tokens and what they stand for, what
 * a part is handed in their place, the one message a press sends a plugin, and the rule that a
 * press is what it does and not what a button said. Plain functions: nothing is built or launched.
 */
import { expect, test } from '@playwright/test'
import {
  handedFields,
  handler,
  list,
  object,
  record,
  choice,
  secret,
  text,
  wrongWithFields,
  wrongWithPart,
  type Part,
} from '../../src/shared/kit/declare.ts'
import { DoorPage } from '../../src/shared/plugin-door.ts'
import {
  callOf,
  HANDED_LIMITS,
  mayStart,
  ON_A_LARGER_SCREEN,
  swapFor,
  Tokens,
} from '../../src/shared/plugin-presses.ts'

const POD = { kind: '/Pod', namespace: 'shop', name: 'cart-1' }
const pods = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => ({ ...POD, name: `pod-${from + i}` }))
const SECRET = { namespace: 'shop', name: 'shop-tls', keys: ['tls.crt'] }

test('a token is random, good on the page it was handed to and on no other, and of one sort', () => {
  const plugin = { objects: 0 }
  const page = new Tokens(plugin)
  const other = new Tokens(plugin)
  const pod = (page.hand(1, [POD]) as string[])[0]!
  const tls = page.secret(1, SECRET)
  // At least 128 random bits, as text the door's grammar takes for a token.
  expect(pod).toMatch(/^[A-Za-z0-9_-]{24}$/)
  const many = page.hand(2, pods(2000)) as string[]
  expect(new Set(many).size).toBe(2000)
  expect(page.objectOf(pod)).toEqual(POD)
  expect(page.secretOf(tls)).toEqual(SECRET)
  // The two sorts never stand in for each other.
  expect(page.secretOf(pod)).toBeUndefined()
  expect(page.objectOf(tls)).toBeUndefined()
  // Another page of the same plugin: nothing.
  expect(other.objectOf(pod)).toBeUndefined()
  expect(other.secretOf(tls)).toBeUndefined()
  // Nothing but the token itself, whole: not its start, not the names every object answers to.
  for (const token of [
    pod.slice(0, -1),
    `${pod}x`,
    pod.toLowerCase(),
    '',
    '__proto__',
    'constructor',
    'toString',
  ]) {
    expect(page.objectOf(token), token).toBeUndefined()
  }
  // What it stands for can't be changed by whoever is handed it.
  expect(() => ((page.objectOf(pod) as { name: string }).name = 'other')).toThrow()
  expect(() => (page.secretOf(tls)!.keys as string[]).push('tls.key')).toThrow()
  expect(page.secretOf(tls)!.keys).toEqual(['tls.crt'])
})

test('a token goes with the read that brought it, and with the page', () => {
  const plugin = { objects: 0 }
  const page = new Tokens(plugin)
  const first = (page.hand(1, [POD]) as string[])[0]!
  const tls = page.secret(1, SECRET)
  const second = (page.hand(2, [{ ...POD, name: 'cart-2' }]) as string[])[0]!
  expect(plugin.objects).toBe(2)
  page.ended(1)
  expect(page.objectOf(first)).toBeUndefined()
  expect(page.secretOf(tls)).toBeUndefined()
  expect(page.objectOf(second)).toBeTruthy()
  expect(plugin.objects).toBe(1)
  // Ended twice, or a read that brought nothing: nothing to do.
  page.ended(1)
  page.ended(9)
  page.close()
  page.close()
  expect(page.objectOf(second)).toBeUndefined()
  expect(plugin.objects).toBe(0)
})

test('how much is handed over is bounded by refusing a read, never by stopping a plugin', () => {
  const plugin = { objects: 0 }
  const page = new Tokens(plugin, counting())
  // One over a page's share: none is handed and nothing is counted.
  expect(page.hand(1, pods(HANDED_LIMITS.objectsAPage + 1))).toBe('too-many')
  expect(plugin.objects).toBe(0)
  expect(page.hand(1, pods(HANDED_LIMITS.objectsAPage))).toHaveLength(HANDED_LIMITS.objectsAPage)
  expect(page.hand(2, pods(1, 900_000))).toBe('too-many')
  // A plugin's pages share its bound; a read that ends gives its objects back.
  const second = new Tokens(plugin, counting('b'))
  expect(second.hand(1, pods(HANDED_LIMITS.objectsAPage))).toHaveLength(HANDED_LIMITS.objectsAPage)
  const third = new Tokens(plugin, counting('c'))
  expect(third.hand(1, pods(1))).toBe('too-many')
  page.ended(1)
  expect(third.hand(1, pods(1))).toHaveLength(1)
  // A Secret's token isn't an object handed over: it counts nothing.
  const before = plugin.objects
  third.secret(1, SECRET)
  expect(plugin.objects).toBe(before)
})

test('within a read an object has one token, however often it’s handed over: counted once', () => {
  const plugin = { objects: 0 }
  const page = new Tokens(plugin)
  const [first] = page.hand(1, [POD]) as string[]
  // A list kept up to date hands a pod over every time it changes.
  for (let i = 0; i < 1000; i++) expect(page.hand(1, [{ ...POD }])).toEqual([first])
  expect(plugin.objects).toBe(1)
  // Twice in one handing over: one token, one counted.
  const [a, other, again] = page.hand(1, [POD, { ...POD, name: 'cart-2' }, POD]) as string[]
  expect([a, again]).toEqual([first, first])
  expect(other).not.toBe(first)
  expect(plugin.objects).toBe(2)
  expect(page.hand(1, pods(HANDED_LIMITS.objectsAPage - 2))).not.toBe('too-many')
  // Another read of the same object is another token: each read's go with it.
  const [elsewhere] = new Tokens({ objects: 0 }).hand(1, [POD]) as string[]
  expect(elsewhere).not.toBe(first)
})

test('an object that leaves a read gives its place back, and its token is no more', () => {
  const plugin = { objects: 0 }
  const page = new Tokens(plugin)
  const [token] = page.hand(1, [POD]) as string[]
  const given = page.objectOf(token!)
  page.gone(1, { ...POD })
  expect(plugin.objects).toBe(0)
  expect(page.objectOf(token!)).toBeUndefined()
  expect(page.destinationOf(given)).toBeUndefined()
  // Gone twice, or never there: nothing to do. Back again: a new token.
  page.gone(1, POD)
  page.gone(7, POD)
  const [again] = page.hand(1, [POD]) as string[]
  expect(again).not.toBe(token)
  expect(plugin.objects).toBe(1)
})

/** Tokens that are quick to make, for counting many. */
function counting(prefix = 'a') {
  let n = 0
  return () => `${prefix}${++n}`
}

const ROWS: Part = {
  name: 'Rows',
  holds: 'nothing',
  props: {
    title: text(80),
    rows: list(record({ key: text(64), opens: object, shows: secret }, ['key']), 100),
    onOpen: handler('open'),
    onRetry: handler('retry'),
  },
  events: { open: { row: text(64) }, retry: {} },
}

test('a part is handed the object where a plugin named a token, and nothing where the page holds none', () => {
  const page = new Tokens({ objects: 0 })
  const other = new Tokens({ objects: 0 })
  const pod = (page.hand(1, [POD]) as string[])[0]!
  const tls = page.secret(1, SECRET)
  const elsewhere = (other.hand(1, [{ ...POD, name: 'not-this-page' }]) as string[])[0]!
  const calls: unknown[][] = []
  let stale = 0
  const swap = swapFor(
    page,
    (...call) => calls.push(call),
    () => stale++,
  )
  const props = {
    title: 'Pods',
    rows: [
      { key: 'a', opens: pod, shows: tls },
      // Made up, another page's, gone stale, and each sort in the other's place.
      { key: 'b', opens: 'made-up-token' },
      { key: 'c', opens: elsewhere },
      { key: 'd', opens: tls, shows: pod },
    ],
    onOpen: 'h1',
  }
  expect(wrongWithFields(props, ROWS.props, [], 'Rows')).toBeUndefined()
  const given = handedFields(props, ROWS.props, swap) as {
    rows: { key: unknown; opens?: unknown; shows?: unknown }[]
    onOpen: (carries: unknown) => void
    onRetry?: unknown
  }
  expect(given.rows).toEqual([
    { key: { their: 'a' }, opens: POD, shows: SECRET },
    { key: { their: 'b' } },
    { key: { their: 'c' } },
    { key: { their: 'd' } },
  ])
  // A row that gets no reference has no `opens` at all: nothing the plugin wrote stands in.
  expect(Object.hasOwn(given.rows[1]!, 'opens')).toBe(false)
  expect(stale).toBe(4)
  // A handler the plugin named is a function; one it didn't name isn't there.
  given.onOpen({ row: 'a' })
  expect(calls).toEqual([['h1', 'open', { row: 'a' }]])
  expect(given.onRetry).toBeUndefined()
  // When the read ends, the same description gives no reference any more.
  page.ended(1)
  expect((handedFields(props, ROWS.props, swap) as typeof given).rows[0]).toEqual({
    key: { their: 'a' },
  })
})

test('nothing the door swaps can be required: a part is always written to draw without it', () => {
  // (A token can be made up, or gone with its read while a commit was on its way: the property
  // is then absent, and a part that required it would fail as it drew, by a plugin's choice.)
  const part = (props: Part['props'], required?: string[]): Part => ({
    name: 'A',
    holds: 'nothing',
    props,
    required,
  })
  expect(wrongWithPart(ROWS)).toBeUndefined()
  expect(wrongWithPart(part({ opens: object }, ['opens']))).toBe(
    'A.opens: an object or a Secret can’t be required',
  )
  expect(wrongWithPart(part({ shows: secret }, ['shows']))).toBe(
    'A.shows: an object or a Secret can’t be required',
  )
  expect(
    wrongWithPart(part({ row: record({ key: text(8), opens: object }, ['key', 'opens']) })),
  ).toContain('can’t be required')
  expect(wrongWithPart(part({ rows: list(record({ opens: object }, ['opens']), 5) }))).toContain(
    'can’t be required',
  )
  // In a choice, what isn't optional is required.
  expect(wrongWithPart(part({ cell: choice('kind', { link: { opens: object } }) }))).toContain(
    'can’t be required',
  )
  expect(
    wrongWithPart(
      part({
        cell: choice('kind', { link: { opens: object, label: text(8) } }, { link: ['opens'] }),
      }),
    ),
  ).toBeUndefined()
  // Optional, it's fine anywhere; and a handler may be required (it's always a function).
  expect(
    wrongWithPart(part({ opens: object, shows: secret, row: record({ opens: object }) })),
  ).toBeUndefined()
  expect(
    wrongWithPart({ ...part({ onOpen: handler('open') }, ['onOpen']), events: { open: {} } }),
  ).toBeUndefined()
})

test('only a reference the door put in a component’s hands opens anything', () => {
  const page = new Tokens({ objects: 0 })
  const other = new Tokens({ objects: 0 })
  const token = (page.hand(1, [POD]) as string[])[0]!
  const given = page.objectOf(token)!
  expect(page.destinationOf(given)).toEqual({ to: 'object', object: POD })
  // Something that only looks like it; another page's; a path, an address, a token, nothing.
  for (const made of [
    { ...POD },
    other.objectOf((other.hand(1, [POD]) as string[])[0]!),
    '/cluster/demo/secrets/shop/admin',
    'https://example.com',
    token,
    null,
    undefined,
  ]) {
    expect(page.destinationOf(made), JSON.stringify(made)).toBeUndefined()
  }
  // A token never minted for this page isn't a destination just because it was looked up.
  expect(page.objectOf('made-up')).toBeUndefined()
})

test('what a component was handed opens nothing once its read has ended, or its page has gone', () => {
  const page = new Tokens({ objects: 0 })
  const [one, two] = page.hand(1, [POD, { ...POD, name: 'cart-2' }]) as string[]
  const [kept] = page.hand(2, [POD]) as string[]
  const given = [page.objectOf(one!), page.objectOf(two!), page.objectOf(kept!)]
  for (const ref of given) expect(page.destinationOf(ref)).toBeTruthy()
  // A component not yet drawn again still holds the old reference: it opens nothing.
  page.ended(1)
  expect(page.destinationOf(given[0])).toBeUndefined()
  expect(page.destinationOf(given[1])).toBeUndefined()
  expect(page.destinationOf(given[2])).toBeTruthy()
  page.close()
  expect(page.destinationOf(given[2])).toBeUndefined()
})

test('nothing a plugin’s code can send opens anything, or is a press', () => {
  const door = new DoorPage({ Rows: ROWS }, () => 0)
  for (const message of [
    { open: 'token' },
    { go: { to: 'object', object: POD } },
    { navigate: '/cluster/demo/secrets' },
    { press: 1 },
    { call: 'h1', carries: {} },
    { commit: [], open: 'token' },
    { commit: [['open', 1]] },
    { commit: [['press', 1, 'open']] },
  ]) {
    const fresh = new DoorPage({ Rows: ROWS }, () => 0)
    expect(fresh.take(JSON.stringify(message)), JSON.stringify(message)).toMatchObject({
      why: 'not-allowed',
    })
  }
  expect(door.stopped).toBeUndefined()
})

test('a press sends a plugin its handle and what the part’s declaration says it carries, and nothing else', () => {
  expect(callOf(ROWS, 'open', 'h1', { row: 'a' })).toBe('{"call":"h1","carries":{"row":"a"}}')
  expect(callOf(ROWS, 'retry', 'h2', {})).toBe('{"call":"h2","carries":{}}')
  // An event the part doesn't declare; what it doesn't declare, Lumovi's own reference above
  // all; too little; the wrong kind; the names every object answers to.
  const wrong: [string, unknown][] = [
    ['close', {}],
    ['open', { row: 'a', object: POD }],
    ['open', { row: 'a', name: 'cart-1' }],
    ['open', {}],
    ['open', { row: 5 }],
    ['open', { row: 'x'.repeat(65) }],
    ['open', null],
    ['open', ['a']],
    ['retry', { row: 'a' }],
    ['toString', {}],
    ['__proto__', {}],
    ['constructor', {}],
  ]
  for (const [event, carries] of wrong) {
    expect(
      callOf(ROWS, event, 'h1', carries),
      `${event} ${JSON.stringify(carries)}`,
    ).toBeUndefined()
  }
  expect(callOf({ ...ROWS, events: undefined }, 'open', 'h1', { row: 'a' })).toBeUndefined()
})

test('a press is what it does, not what its button said: on a phone nothing a plugin’s page starts is a change', () => {
  const button = (changes: boolean) => ({ key: 'sync', name: 'Sync', changes })
  // A button that says it changes nothing, whose press would change: refused on a phone.
  expect(button(false).changes).toBe(false)
  expect(mayStart('changes', 'phone')).toEqual({ refused: ON_A_LARGER_SCREEN })
  expect(ON_A_LARGER_SCREEN).toBe('Open Lumovi on a larger screen to do this.')
  // A button that says it changes, whose press only tells the plugin or opens something: fine.
  expect(button(true).changes).toBe(true)
  expect(mayStart('tells', 'phone')).toBe(true)
  expect(mayStart('opens', 'phone')).toBe(true)
  // On a larger screen a change may start (and is then Lumovi's own confirmation's to carry).
  for (const layout of ['wide', 'tablet']) expect(mayStart('changes', layout)).toBe(true)
  // Anything that isn't known to be a larger screen is not one: a new layout, a wrong word,
  // nothing at all. There only telling and opening may start.
  for (const layout of [
    'phone',
    'Phone',
    'PHONE',
    'narrow',
    'desktop',
    'watch',
    '',
    ' wide',
    null,
    undefined,
    5,
    {},
  ]) {
    expect(mayStart('changes', layout), String(layout)).toEqual({ refused: ON_A_LARGER_SCREEN })
    expect(mayStart('tells', layout)).toBe(true)
    expect(mayStart('opens', layout)).toBe(true)
  }
  // A sort of press nobody has decided about starts nowhere, on any screen.
  for (const does of ['destroys', 'Changes', '', 'toString', '__proto__', null, undefined]) {
    for (const layout of ['wide', 'tablet', 'phone']) {
      expect(mayStart(does as never, layout), `${String(does)} ${layout}`).toHaveProperty('refused')
    }
  }
  // The rule takes no word of a plugin's at all: there's nowhere to hand it one.
  expect(mayStart.length).toBe(2)
})

/**
 * The door, for what a person presses on a plugin's page: tokens and what they stand for, what
 * a part is handed in their place, the one message a press sends a plugin, and the rule that a
 * press is what it does and not what a button said. Plain functions: nothing is built or launched.
 */
import { expect, test } from '@playwright/test'
import {
  cut,
  destination,
  handed,
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
  type ListDestination,
  type Part,
} from '../../src/shared/kit/declare.ts'
import {
  filledLast,
  header,
  headerProblem,
  pressable,
  pressChanges,
} from '../../src/shared/kit/page.ts'
import { rowButton, table } from '../../src/shared/kit/table.ts'
import { DoorPage } from '../../src/shared/plugin-door.ts'
import {
  callOf,
  HANDED_LIMITS,
  mayStart,
  ON_A_LARGER_SCREEN,
  swapFor,
  Tokens,
  unnamedLine,
} from '../../src/shared/plugin-presses.ts'

const POD = { kind: '/Pod', namespace: 'shop', name: 'cart-1' }
const pods = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => ({ ...POD, name: `pod-${from + i}` }))
const SECRET = { namespace: 'shop', name: 'shop-tls', keys: ['tls.crt'] }
/** The token for the one Secret `POD`, handed by `read`, names. */
const secretOf = (page: Tokens, read = 1) => (page.secrets(read, POD, [SECRET]) as string[])[0]!

test('a token is random, good on the page it was handed to and on no other, and of one sort', () => {
  const plugin = { objects: 0 }
  const page = new Tokens(plugin)
  const other = new Tokens(plugin)
  const pod = (page.hand(1, [POD]) as string[])[0]!
  const tls = secretOf(page)
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
  const tls = secretOf(page)
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
  // A Secret's token isn't an object handed over: it isn't counted among them.
  const before = plugin.objects
  third.secrets(1, { ...POD, name: 'pod-0' }, [SECRET])
  expect(plugin.objects).toBe(before)
})

test('no token is made for a name or a namespace no object could have', () => {
  const plugin = { objects: 0 }
  const page = new Tokens(plugin, counting())
  // Names as kinds have them: a cluster's own, a role's with colons, one without a namespace.
  for (const ref of [
    POD,
    { kind: 'rbac.authorization.k8s.io/ClusterRole', name: 'system:controller:job-controller' },
    { kind: '/Node', name: 'ip-10-0-1-17.eu-west-1.compute.internal' },
  ]) {
    expect(page.hand(1, [ref])).toHaveLength(1)
  }
  const handed = plugin.objects
  // What a path would take for another (or for nothing), what can't be seen, what's too long.
  for (const name of [
    '',
    '.',
    '..',
    'a/b',
    'a%2Fb',
    'cart 1',
    'cart​1',
    'cart\n1',
    'a'.repeat(254),
  ]) {
    expect(page.hand(2, [POD, { ...POD, name }]), JSON.stringify(name)).toBe('not-a-name')
  }
  for (const namespace of ['', 'Shop', 'shop.prod', '-shop', 'a'.repeat(64)]) {
    expect(page.hand(2, [{ ...POD, namespace }]), JSON.stringify(namespace)).toBe('not-a-name')
    expect(page.secrets(1, POD, [{ ...SECRET, namespace }]), JSON.stringify(namespace)).toEqual([
      undefined,
    ])
  }
  expect(page.secrets(1, POD, [{ ...SECRET, name: '../shop-tls' }])).toEqual([undefined])
  // Nor for what isn't text, nor a Secret outside a namespace.
  const unread = { ...SECRET, namespace: undefined } as unknown as typeof SECRET
  expect(page.secrets(1, POD, [unread])).toEqual([undefined])
  // Nor for keys that aren't Secrets' keys: a part draws each where a person reads it.
  for (const key of ['tls/crt', '', 'a\u202Eb', 'k'.repeat(254), 'tls crt', '.', '..', '..data']) {
    expect(
      page.secrets(1, POD, [{ ...SECRET, keys: ['tls.crt', key] }]),
      JSON.stringify(key),
    ).toEqual([undefined])
  }
  expect(page.hand(2, [{ ...POD, name: undefined } as unknown as typeof POD])).toBe('not-a-name')
  expect(page.hand(2, [{ ...POD, namespace: 7 } as unknown as typeof POD])).toBe('not-a-name')
  // None handed, nothing counted: the read is refused whole.
  expect(plugin.objects).toBe(handed)
  expect(page.hand(2, [POD])).toHaveLength(1)
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

test('a Secret an object names keeps its token while the object names it, and goes with the object', () => {
  const page = new Tokens({ objects: 0 })
  page.hand(1, [POD, { ...POD, name: 'cart-2' }])
  const db = { ...SECRET, name: 'shop-db', keys: ['password'] }
  const [tls, first] = page.secrets(1, POD, [SECRET, db]) as string[]
  // Read again: the same tokens, however often.
  for (let i = 0; i < 100; i++)
    expect(page.secrets(1, { ...POD }, [SECRET, db])).toEqual([tls, first])
  // The same Secret named by another object is that object's token, not this one's.
  const [theirs] = page.secrets(1, { ...POD, name: 'cart-2' }, [SECRET]) as string[]
  expect(theirs).not.toBe(tls)
  // Named no more: its token is no more. Named again: a new one.
  expect(page.secrets(1, POD, [SECRET])).toEqual([tls])
  expect(page.secretOf(first!)).toBeUndefined()
  expect(page.secrets(1, POD, [SECRET, db])[1]).not.toBe(first)
  // The same Secret with other keys is another reference: what it may show is part of what it is.
  expect(page.secrets(1, POD, [{ ...SECRET, keys: ['ca.crt'] }])[0]).not.toBe(tls)
  expect(page.secretOf(tls!)).toBeUndefined()
  // An object that leaves the read takes its Secrets' tokens with it.
  const [now] = page.secrets(1, POD, [SECRET]) as string[]
  page.gone(1, POD)
  expect(page.secretOf(now!)).toBeUndefined()
  expect(page.secretOf(theirs!)).toEqual(SECRET)
  // Nothing for an object the read didn't hand (any more), or another read's.
  expect(page.secrets(1, POD, [SECRET])).toEqual([undefined])
  expect(page.secrets(2, { ...POD, name: 'cart-2' }, [SECRET])).toEqual([undefined])
  // And the read's end takes every one.
  page.ended(1)
  expect(page.secretOf(theirs!)).toBeUndefined()
})

test('how many Secrets a page is handed is bounded by refusing, never by taking any back', () => {
  const page = new Tokens({ objects: 0 })
  const owners = pods(HANDED_LIMITS.secretsAPage / 20 + 1)
  page.hand(1, owners)
  const twenty = (n: number) =>
    Array.from({ length: 20 }, (_, i) => ({ ...SECRET, name: `s-${n}-${i}` }))
  for (let n = 0; n < owners.length - 1; n++) {
    expect(page.secrets(1, owners[n]!, twenty(n))).not.toBe('too-many')
  }
  const last = owners.at(-1)!
  expect(page.secrets(1, last, twenty(99_999))).toBe('too-many')
  // Nothing was made, and what was had stands.
  const [kept] = page.secrets(1, owners[0]!, twenty(0)) as string[]
  expect(page.secretOf(kept!)).toBeTruthy()
  // Room again once one names fewer.
  page.secrets(1, owners[0]!, [])
  expect(page.secrets(1, last, twenty(99_999))).not.toBe('too-many')
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
  const tls = secretOf(page)
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
    'A.opens: an object, a Secret or a list to open can’t be required',
  )
  expect(wrongWithPart(part({ shows: secret }, ['shows']))).toBe(
    'A.shows: an object, a Secret or a list to open can’t be required',
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

test('a list to open is one the door made: of a kind its file names, the same each time, opened only so', () => {
  const page = new Tokens({ objects: 0 })
  const kinds = new Set(['NodePool.karpenter.sh', 'Node'])
  const swap = swapFor(page, () => undefined, undefined, kinds)
  const pools = swap.destination({
    list: 'karpenter.sh/NodePool',
    health: ['critical'],
  }) as ListDestination
  expect(pools).toEqual({ to: 'list', kind: 'NodePool.karpenter.sh', health: ['critical'] })
  expect(Object.isFrozen(pools) && Object.isFrozen(pools.health)).toBe(true)
  // Said the same way, the same one: a page drawn again hands its part what it had.
  expect(swap.destination({ list: 'karpenter.sh/NodePool', health: ['critical'] })).toBe(pools)
  expect(swap.destination({ list: '/Node', labels: ['karpenter.sh/nodepool'] })).toEqual({
    to: 'list',
    kind: 'Node',
    labels: ['karpenter.sh/nodepool'],
  })
  // Its levels said in another order: the same one.
  const both = swap.destination({ list: '/Node', health: ['warning', 'critical'] })
  expect(swap.destination({ list: '/Node', health: ['critical', 'warning'] })).toBe(both)
  // A kind its file doesn't name opens nothing, and its author is told which, once a page; nor
  // does a list another page's door made open anything, or one that only looks like it.
  const unnamed: string[] = []
  const telling = swapFor(
    page,
    () => undefined,
    undefined,
    kinds,
    (kind) => unnamed.push(kind),
  )
  expect(telling.destination({ list: '/Secret' })).toBeUndefined()
  expect(unnamed).toEqual(['/Secret'])
  expect([page.unnamedToSay(), page.unnamedToSay()]).toEqual([true, false])
  expect(unnamedLine('karpenter.sh/NodeClass', 'argo-workflows’')).toBe(
    'Lumovi opens no list of karpenter.sh/NodeClass for argo-workflows’ page: its file doesn’t name that kind.',
  )
  expect(swap.destination({ list: '/Secret' })).toBeUndefined()
  expect(swapFor(page, () => undefined).destination({ list: '/Node' })).toBeUndefined()
  expect(page.destinationOf(pools)).toBe(pools)
  expect(page.destinationOf({ ...pools })).toBeUndefined()
  expect(new Tokens({ objects: 0 }).destinationOf(pools)).toBeUndefined()
  // A part's property, as the door hands it: the list it made.
  expect(handed({ list: 'karpenter.sh/NodePool', health: ['critical'] }, destination, swap)).toBe(
    pools,
  )
  // Past a page's share of them, one more opens nothing (and those made still do).
  for (let i = 0; i < HANDED_LIMITS.destinationsAPage; i++) {
    swap.destination({ list: '/Node', labels: [`l${i}`] })
  }
  expect(swap.destination({ list: '/Node', labels: ['one-more'] })).toBeUndefined()
  expect(page.destinationOf(pools)).toBe(pools)
})

test('a link to one of its own pages is one the door made: a page its file names, its filters kept in pairs, the same each time', () => {
  const page = new Tokens({ objects: 0 })
  const unknown: string[] = []
  const swap = swapFor(
    page,
    () => undefined,
    undefined,
    new Set(),
    undefined,
    new Set(),
    new Set(),
    undefined,
    new Set(['overview', 'applications']),
    (named) => unknown.push(named),
  )
  const apps = swap.destination({
    page: 'applications',
    filters: { sync: ['Out of sync', 'Unknown'], health: ['critical'] },
    search: 'shop',
  })
  expect(apps).toEqual({
    to: 'page',
    page: 'applications',
    filters: [
      ['health', ['critical']],
      ['sync', ['Out of sync', 'Unknown']],
    ],
    search: 'shop',
  })
  expect(Object.isFrozen(apps) && Object.isFrozen((apps as { filters: unknown }).filters)).toBe(
    true,
  )
  // Said the same way, in another order: the same one; and only one this door made opens.
  expect(
    swap.destination({
      page: 'applications',
      filters: { health: ['critical'], sync: ['Unknown', 'Out of sync'] },
      search: 'shop',
    }),
  ).toBe(apps)
  expect(page.destinationOf(apps)).toBe(apps)
  expect(page.destinationOf({ ...(apps as object) })).toBeUndefined()
  // A page its file doesn't name: nothing, and its author is told which.
  expect(swap.destination({ page: 'settings' })).toBeUndefined()
  expect(unknown).toEqual(['settings'])
})

test('a list at one object is opened only of a kind its file says its pages open, and only as the door made it', () => {
  const page = new Tokens({ objects: 0 })
  const kinds = new Set(['Deployment', 'Node', 'Application.argoproj.io'])
  const opens = new Set(['Deployment', 'Node'])
  const unnamed: [string, string | undefined][] = []
  const swap = swapFor(
    page,
    () => undefined,
    undefined,
    kinds,
    (kind, by) => unnamed.push([kind, by]),
    opens,
  )
  const one = swap.destination({ list: 'apps/Deployment', name: 'storefront', namespace: 'shop' })!
  expect(one).toEqual({ to: 'list', kind: 'Deployment', name: 'storefront', namespace: 'shop' })
  expect(Object.isFrozen(one)).toBe(true)
  expect(page.destinationOf(one)).toBe(one)
  // Said the same way, the same one; in another namespace, another.
  expect(swap.destination({ list: 'apps/Deployment', name: 'storefront', namespace: 'shop' })).toBe(
    one,
  )
  expect(
    swap.destination({ list: 'apps/Deployment', name: 'storefront', namespace: 'web' }),
  ).not.toBe(one)
  // A kind without namespaces is named without one.
  expect(swap.destination({ list: '/Node', name: 'ip-10-0-1-5' })).toEqual({
    to: 'list',
    kind: 'Node',
    name: 'ip-10-0-1-5',
  })
  // The whole list of a kind it opens, as of any kind its file names.
  expect(swap.destination({ list: 'apps/Deployment' })).toEqual({ to: 'list', kind: 'Deployment' })
  // Its own kind at one name isn't among those it opens: nothing, and its author is told why.
  expect(
    swap.destination({ list: 'argoproj.io/Application', name: 'storefront', namespace: 'argocd' }),
  ).toBeUndefined()
  // One of a kind with namespaces without its own, or one without with one: nothing, and why.
  expect(swap.destination({ list: 'apps/Deployment', name: 'storefront' })).toBeUndefined()
  expect(
    swap.destination({ list: '/Node', name: 'ip-10-0-1-5', namespace: 'shop' }),
  ).toBeUndefined()
  expect(unnamed).toEqual([
    ['argoproj.io/Application', 'opens'],
    ['apps/Deployment', 'namespace'],
    ['/Node', 'namespace'],
  ])
  expect(unnamedLine('argoproj.io/Application', 'argo-cd’s', 'opens')).toBe(
    'Lumovi opens no list of argoproj.io/Application at one name for argo-cd’s page: its file doesn’t name that kind under spec.opens.',
  )
  expect(unnamedLine('apps/Deployment', 'argo-cd’s', 'namespace')).toBe(
    'Lumovi opens no list of apps/Deployment at one name for argo-cd’s page: a name of that kind goes with its namespace where the kind has them, and with none where it hasn’t.',
  )
  // Told nothing of what it opens, a page opens no list at one object.
  expect(
    swapFor(page, () => undefined, undefined, kinds).destination({
      list: 'apps/Deployment',
      name: 'storefront',
      namespace: 'shop',
    }),
  ).toBeUndefined()
})

test('how a read was cut is the door’s numbers for its latest answer: a stale, borrowed or ended token says nothing', () => {
  const page = new Tokens({ objects: 0 })
  let stale = 0
  const swap = swapFor(
    page,
    () => undefined,
    () => stale++,
  )
  const first = page.cutFor(1, { at: 5000, of: 12345 })
  expect(swap.cut(first)).toEqual({ at: 5000, of: 12345 })
  expect(Object.isFrozen(swap.cut(first))).toBe(true)
  expect(handed(first, cut, swap)).toEqual({ at: 5000, of: 12345 })
  // Read again and cut again: a new token, and the one before it says nothing any more, so a
  // part still naming it (drawn from the answer before) has no cut to say.
  const second = page.cutFor(1, { at: 5000 })
  expect(second).not.toBe(first)
  expect(swap.cut(first)).toBeUndefined()
  expect(swap.cut(second)).toEqual({ at: 5000 })
  // Another read's token is that read's: ending one leaves the other.
  const other = page.cutFor(2, { at: 5000, of: 7000 })
  // A token of another page's, or one made up: nothing, whatever it looks like.
  const elsewhere = new Tokens({ objects: 0 }).cutFor(1, { at: 5000, of: 99999 })
  expect(swap.cut(elsewhere)).toBeUndefined()
  expect(swap.cut('cut-1')).toBeUndefined()
  // Answered whole: the read's token is no more. Ended, likewise; and every one with the page.
  page.uncut(1)
  expect(swap.cut(second)).toBeUndefined()
  expect(swap.cut(other)).toEqual({ at: 5000, of: 7000 })
  const third = page.cutFor(1, { at: 5000 })
  page.ended(1)
  expect(swap.cut(third)).toBeUndefined()
  page.close()
  expect(swap.cut(other)).toBeUndefined()
  // (Each one not held is said to its author as any token not held is, once a page.)
  expect(stale).toBe(6)
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

test('a press of a header’s button goes to the plugin only where that button was drawn, and isn’t off', () => {
  const drawn = {
    name: 'payments',
    buttons: [
      { key: 'logs', name: 'Show logs' },
      { key: 'sync', name: 'Sync', asks: true, off: 'A sync is running.' },
    ],
  }
  expect(callOf(header, 'press', 'h1', { button: 'logs' }, { drawn })).toBe(
    '{"call":"h1","carries":{"button":"logs"}}',
  )
  // One that's off, one it doesn't have (gone since, or never), and one where it has none.
  expect(callOf(header, 'press', 'h1', { button: 'sync' }, { drawn })).toBeUndefined()
  expect(callOf(header, 'press', 'h1', { button: 'delete' }, { drawn })).toBeUndefined()
  expect(
    callOf(header, 'press', 'h1', { button: 'logs' }, { drawn: { name: 'payments' } }),
  ).toBeUndefined()
  // Pressed with nothing said of what was drawn: nothing, never a press past the asking.
  expect(callOf(header, 'press', 'h1', { button: 'logs' })).toBeUndefined()
  expect(callOf(header, 'press', 'h1', { button: 'logs' }, {})).toBeUndefined()
  // The press's token, made only for a press that's sent: none for one that isn't.
  let made = 0
  const press = () => `token-${++made}`
  expect(callOf(header, 'press', 'h1', { button: 'sync' }, { drawn, press })).toBeUndefined()
  expect(callOf(header, 'press', 'h1', { button: 'logs' }, { press })).toBeUndefined()
  expect(made).toBe(0)
  expect(callOf(header, 'press', 'h1', { button: 'logs' }, { drawn, press })).toBe(
    '{"call":"h1","carries":{"button":"logs"},"press":"token-1"}',
  )
})

test('a press of a row’s button goes to the plugin only where that row has it, and it isn’t off; only one that changes has a token', () => {
  const button = (key: string, more: Record<string, unknown> = {}) => ({
    kind: 'button',
    key,
    name: 'Roll back',
    ...more,
  })
  const drawn = {
    title: 'History',
    headings: true,
    columns: [{ name: 'Roll back', kind: 'button' }],
    rows: [
      { key: '14', lead: { name: '14' }, cells: [{ kind: 'text', text: 'Current' }] },
      { key: '13', lead: { name: '13' }, cells: [button('back', { changes: true, asks: true })] },
      {
        key: '12',
        lead: { name: '12' },
        cells: [button('back', { changes: true, off: 'Auto-sync is on.' })],
      },
      { key: '11', lead: { name: '11' }, cells: [button('show')] },
    ],
  }
  let made = 0
  const press = () => `token-${++made}`
  const pressed = (row: string, key: string, with_ = drawn) =>
    callOf(table, 'press', 't1', { row, button: key }, { drawn: with_, press })
  expect(pressed('13', 'back')).toBe(
    '{"call":"t1","carries":{"row":"13","button":"back"},"press":"token-1"}',
  )
  // One that's off; a row without one; a button another row has; a row that isn't there (gone
  // since, or never); a key that's no row's (an object's own names); and nothing drawn.
  for (const [row, key] of [
    ['12', 'back'],
    ['14', 'back'],
    ['13', 'show'],
    ['10', 'back'],
    ['toString', 'back'],
    ['13', 'constructor'],
  ] as const) {
    expect(pressed(row, key), `${row} ${key}`).toBeUndefined()
  }
  expect(callOf(table, 'press', 't1', { row: '13', button: 'back' })).toBeUndefined()
  expect(pressed('13', 'back', { ...drawn, rows: [] })).toBeUndefined()
  expect(made).toBe(1)
  // Its token only where its button says it changes something: one that only reads has none.
  expect(table.changes(drawn, 'press', { row: '13', button: 'back' })).toBe(true)
  expect(table.changes(drawn, 'press', { row: '11', button: 'show' })).toBe(false)
  expect(table.changes(drawn, 'press', { row: '12', button: 'back' })).toBe(false)
  expect(table.changes(drawn, 'open', { row: '13' })).toBe(false)
  expect(rowButton(drawn, null)).toBeUndefined()
  expect(rowButton({}, { row: '13', button: 'back' })).toBeUndefined()
  // A header's is the same rule, declared on the header.
  const buttons = [{ key: 'sync', name: 'Sync', changes: true }]
  expect(header.changes({ name: 'a', buttons }, 'press', { button: 'sync' })).toBe(true)
  expect(header.changes({ name: 'a', buttons }, 'pick', { button: 'sync' })).toBe(false)
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
      expect(mayStart(does as never, layout), `${String(does)} ${layout}`).toEqual({
        refused: 'Lumovi doesn’t know what this would do, so it didn’t.',
      })
    }
  }
  // The rule takes no word of a plugin's at all: there's nowhere to hand it one.
  expect(mayStart.length).toBe(2)
})

test('a link to one of Lumovi’s places is one the door made: where its file says, for an object it handed, of a kind that place is for', () => {
  const page = new Tokens({ objects: 0 })
  const [pod, service, node] = page.hand(1, [
    { kind: 'Pod', namespace: 'shop', name: 'cart-1' },
    { kind: 'Service', namespace: 'shop', name: 'cart' },
    { kind: 'Node', name: 'worker-1' },
  ]) as string[]
  const unlinked: string[] = []
  const swap = swapFor(
    page,
    () => undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new Set(['logs', 'shell', 'port-forward']),
    (at) => unlinked.push(at),
  )
  const shell = swap.destination({ object: pod!, at: 'shell', container: 'app' })!
  expect(shell).toEqual({
    to: 'reach',
    at: 'shell',
    object: { kind: 'Pod', namespace: 'shop', name: 'cart-1' },
    container: 'app',
  })
  expect(Object.isFrozen(shell)).toBe(true)
  // Said the same way, the same one; and it's this page's to open, as a list it made is.
  expect(swap.destination({ object: pod!, at: 'shell', container: 'app' })).toBe(shell)
  expect(page.destinationOf(shell)).toBe(shell)
  expect(page.destinationOf({ ...shell })).toBeUndefined()
  expect(swap.destination({ object: service!, at: 'port-forward', port: 80 })).toMatchObject({
    to: 'reach',
    at: 'port-forward',
    port: 80,
  })
  // Each place is for its kinds only: no shell or logs of a Service, nothing of a Node.
  expect(swap.destination({ object: service!, at: 'shell' })).toBeUndefined()
  expect(swap.destination({ object: node!, at: 'logs' })).toBeUndefined()
  // An object it doesn't hold links to nothing.
  expect(swap.destination({ object: 'not-a-token-it-holds', at: 'logs' })).toBeUndefined()
  // A place its file doesn't name links to nothing, and its author is told which.
  const logsOnly = swapFor(
    page,
    () => undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new Set(['logs']),
    (at) => unlinked.push(at),
  )
  expect(logsOnly.destination({ object: pod!, at: 'shell' })).toBeUndefined()
  expect(logsOnly.destination({ object: pod!, at: 'logs' })).toMatchObject({ at: 'logs' })
  expect(unlinked).toEqual(['shell'])
})

test('a link is written as an object’s token and a place, a container only for Logs or Shell, a port only for a forward', () => {
  const problem = (value: unknown) =>
    wrongWithFields({ goes: value }, { goes: destination }, [], 'X')
  expect(problem({ object: 'abc', at: 'shell', container: 'app' })).toBeUndefined()
  expect(problem({ object: 'abc', at: 'port-forward', port: 8080 })).toBeUndefined()
  expect(problem({ object: 'abc', at: 'exec' })).toBe(
    'X.goes.at: should be one of logs, shell, port-forward',
  )
  expect(problem({ object: 'a/b', at: 'logs' })).toBe(
    'X.goes.object: should be an object’s token, as Lumovi handed it',
  )
  expect(problem({ object: 'abc', at: 'port-forward', container: 'app' })).toBe(
    'X.goes.container: goes with logs or shell',
  )
  expect(problem({ object: 'abc', at: 'logs', port: 80 })).toBe(
    'X.goes.port: goes with port-forward',
  )
  expect(problem({ object: 'abc', at: 'port-forward', port: 70000 })).toBe(
    'X.goes.port: should be a port, 1 to 65535',
  )
  expect(problem({ object: 'abc', at: 'shell', container: 'Not A Name' })).toBe(
    'X.goes.container: should be a container’s name',
  )
  expect(problem({ object: 'abc', at: 'logs', url: 'https://example.com' })).toBe(
    'X.goes: takes nothing named "url"',
  )
})

test('a header button that goes somewhere is never pressed to its plugin, and changes and asks nothing', () => {
  const goes = { object: 'abc', at: 'logs' }
  expect(pressable([{ key: 'logs', name: 'Logs', goes }], { button: 'logs' })).toBe(false)
  expect(pressable([{ key: 'back', name: 'Back up' }], { button: 'back' })).toBe(true)
  expect(headerProblem([{ key: 'logs', goes, changes: true }])).toBe(
    'Header button logs goes somewhere of Lumovi’s: it changes nothing and asks nothing first.',
  )
  expect(headerProblem([{ key: 'logs', goes, asks: true }])).toBe(
    'Header button logs goes somewhere of Lumovi’s: it changes nothing and asks nothing first.',
  )
  expect(headerProblem([{ key: 'logs', goes }])).toBeUndefined()
})

test('a press has a token a proposal can spend only where its button says it changes something', () => {
  const buttons = [
    { key: 'look', name: 'Look' },
    { key: 'sync', name: 'Sync', changes: true },
    { key: 'logs', name: 'Logs', goes: { to: 'reach', at: 'logs' } },
  ]
  expect(pressChanges(buttons, { button: 'sync' })).toBe(true)
  // One that only reads, or goes, or isn't there; or nothing drawn to say: none.
  for (const button of ['look', 'logs', 'gone', 'toString']) {
    expect(pressChanges(buttons, { button }), button).toBe(false)
  }
  expect(pressChanges(undefined, { button: 'sync' })).toBe(false)
  expect(pressChanges(buttons, null)).toBe(false)
})

test('a header’s last button that changes something is drawn at its end, the rest in their order', () => {
  const keys = (buttons: readonly { key: string }[]) => buttons.map((button) => button.key)
  // Several that change, the last of them before reads: it moves, so "…" never holds it.
  const several = [
    { key: 'restart', changes: true },
    { key: 'scale', changes: true },
    { key: 'look' },
    { key: 'logs' },
    { key: 'metrics' },
  ]
  expect(keys(filledLast(several))).toEqual(['restart', 'look', 'logs', 'metrics', 'scale'])
  // Off for now, it's still where the change is: it moves too.
  const off = [{ key: 'failover', changes: true, off: 'Not now.' }, { key: 'metrics' }]
  expect(keys(filledLast(off))).toEqual(['metrics', 'failover'])
  // Last already, or none that changes: the plugin's order, as it is.
  const last = [{ key: 'look' }, { key: 'sync', changes: true }]
  expect(filledLast(last)).toBe(last)
  const reads: { key: string; changes?: boolean }[] = [{ key: 'look' }, { key: 'logs' }]
  expect(filledLast(reads)).toBe(reads)
  expect(filledLast([])).toEqual([])
})

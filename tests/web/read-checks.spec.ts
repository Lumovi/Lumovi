/**
 * The door, for reading, tried in Lumovi's own built page: reads.spec's cases, with its values
 * and its words, each check made by the page's own door (the tests' stage lends it), so what's
 * measured of the door's reading is what ran in a page. reads.spec tries the same as plain
 * functions; none of its cases is left out. (A kind as the door resolves it, `resolvedAs`, is
 * plain data, and is made here as reads.spec makes it.)
 */
import type { JSHandle, Page } from '@playwright/test'
import { parse } from '../../src/shared/jsonpath.ts'
import {
  READ_LIMITS,
  READABLE,
  resolvedAs,
  type granted,
  type handedWhole,
  type kindAsked,
  type PageReads,
  type picked,
  type pickedRefusal,
  type readable,
  type readAsk,
  type readQuery,
  type secretsNamed,
  type selectors,
  type Grant,
  type Granted,
} from '../../src/shared/plugin-reads.ts'
import { expect, test, type ServeOptions, type Served } from './fixtures.ts'

/** What the stage lends the tests of the door's reading. */
interface ReadChecks {
  granted: typeof granted
  handedWhole: typeof handedWhole
  kindAsked: typeof kindAsked
  PageReads: typeof PageReads
  picked: typeof picked
  pickedRefusal: typeof pickedRefusal
  readable: typeof readable
  readAsk: typeof readAsk
  readQuery: typeof readQuery
  secretsNamed: typeof secretsNamed
  selectors: typeof selectors
}
/** The page's window, as the stage lends it. */
type Lent = { __lumoviDoor: { doorChecks: ReadChecks } }

/** Lumovi's page, built for the tests, with its door's checks there. */
async function opened(page: Page, serve: (options?: ServeOptions) => Promise<Served>) {
  const { url } = await serve()
  await page.goto(url)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  return page
}

/** The door's reading checks, each made in Lumovi's page with what it's given. */
function checksIn(page: Page) {
  const call = <R>(name: keyof ReadChecks, args: unknown[]) =>
    page.evaluate(
      ([name, args]) =>
        (
          (window as unknown as Lent).__lumoviDoor.doorChecks as unknown as Record<
            string,
            (...args: unknown[]) => unknown
          >
        )[name]!(...args),
      [name, args] as const,
    ) as Promise<R>
  return {
    granted: (...args: Parameters<typeof granted>) =>
      call<ReturnType<typeof granted>>('granted', args),
    picked: (...args: Parameters<typeof picked>) => call<ReturnType<typeof picked>>('picked', args),
    readable: (...args: Parameters<typeof readable>) =>
      call<ReturnType<typeof readable>>('readable', args),
    readQuery: (...args: Parameters<typeof readQuery>) =>
      call<ReturnType<typeof readQuery>>('readQuery', args),
    kindAsked: (...args: Parameters<typeof kindAsked>) =>
      call<ReturnType<typeof kindAsked>>('kindAsked', args),
    secretsNamed: (...args: Parameters<typeof secretsNamed>) =>
      call<ReturnType<typeof secretsNamed>>('secretsNamed', args),
    pickedRefusal: (...args: Parameters<typeof pickedRefusal>) =>
      call<ReturnType<typeof pickedRefusal>>('pickedRefusal', args),
    selectors: (...args: Parameters<typeof selectors>) =>
      call<ReturnType<typeof selectors>>('selectors', args),
  }
}

/**
 * A page's reads as the door counts them, in Lumovi's page: plugins (each a count shared by its
 * pages), pages, and one clock for them all.
 */
async function readsIn(page: Page, now = 0) {
  const held: JSHandle<{
    clock: { now: number }
    plugins: { lists: number; kept: number }[]
    pages: PageReads[]
  }> = await page.evaluateHandle((now) => ({ clock: { now }, plugins: [], pages: [] }), now)
  type Ask = Parameters<PageReads['take']>[0]
  return {
    /** A plugin's count, as reads.spec's `{ lists: 0, kept: 0 }`: its number here. */
    plugin: () => held.evaluate((on) => on.plugins.push({ lists: 0, kept: 0 }) - 1),
    counts: (plugin: number) => held.evaluate((on, plugin) => ({ ...on.plugins[plugin]! }), plugin),
    /** A page of that plugin, on the clock: its number here. */
    page: (plugin: number) =>
      held.evaluate((on, plugin) => {
        const { PageReads } = (window as unknown as Lent).__lumoviDoor.doorChecks
        return on.pages.push(new PageReads(on.plugins[plugin]!, () => on.clock.now)) - 1
      }, plugin),
    take: (at: number, ask: unknown) =>
      held.evaluate((on, [at, ask]) => on.pages[at]!.take(ask as Ask), [at, ask] as const),
    /** Each ask taken in turn: what each was answered. */
    takeAll: (at: number, asks: unknown[]) =>
      held.evaluate((on, [at, asks]) => asks.map((ask) => on.pages[at]!.take(ask as Ask)), [
        at,
        asks,
      ] as const),
    answered: (at: number, read: number) =>
      held.evaluate((on, [at, read]) => on.pages[at]!.answered(read), [at, read] as const),
    refused: (at: number, read: number) =>
      held.evaluate((on, [at, read]) => on.pages[at]!.refused(read), [at, read] as const),
    close: (at: number) => held.evaluate((on, at) => on.pages[at]!.close(), at),
    later: (ms: number) => held.evaluate((on, ms) => void (on.clock.now += ms), ms),
    /**
     * reads.spec's `fill`: `count` asks like `ask`, numbered on from `read`, each answered as it's
     * taken, a second passing every `asksASecond`: what each was answered.
     */
    fill: (at: number, ask: object, read: number, count: number, asksASecond: number) =>
      held.evaluate(
        (on, [at, ask, read, count, asksASecond]) => {
          const page = on.pages[at]!
          const said: unknown[] = []
          for (let i = 0; i < count; i++) {
            if (i % asksASecond === 0) on.clock.now += 1000
            said.push(page.take({ ...ask, read: ++read } as Ask))
            page.answered(read)
          }
          return said
        },
        [at, ask, read, count, asksASecond] as const,
      ),
  }
}

const fields = (...paths: string[]): Granted['fields'] =>
  paths.map((path) => ({ path, steps: parse(`.${path}`) }))
const says = (said: Partial<Granted>): Granted => ({
  fields: [],
  status: false,
  events: false,
  usage: false,
  ...said,
})

const GRANT: Grant = {
  groups: ['karpenter.sh'],
  own: ['karpenter.sh/NodePool'],
  reads: {
    '/Node': says({
      fields: fields('metadata.name', 'metadata.labels', 'status.capacity'),
      status: true,
      usage: true,
    }),
    '/Pod': says({ fields: fields('metadata.name', 'spec.nodeName') }),
    '/Event': says({ events: true }),
    // A kind of Kubernetes' that Lumovi keeps no list for.
    'apps/Deployment': says({ fields: fields('metadata.name'), events: true }),
  },
}

test('an ask is one of five things, each with exactly its own words', async ({ page, serve }) => {
  await opened(page, serve)
  const asks: unknown[] = [
    { read: 1, what: 'list', kind: '/Node' },
    { read: 2, what: 'list', kind: 'karpenter.sh/NodePool', namespace: 'kube-system' },
    { read: 3, what: 'object', kind: 'apps/Deployment', namespace: 'shop', name: 'cart' },
    { read: 4, what: 'object', kind: '/Node', name: 'ip-10-0-1-5.eu-west-1.compute.internal' },
    { read: 5, what: 'events', of: 'o_17' },
    { read: 6, what: 'list', kind: '/Node', usage: true },
    { read: 7, what: 'object', kind: '/Pod', namespace: 'shop', name: 'cart-7d9f', usage: true },
    // A list picked by its objects' fields and labels: pods on no node yet; nodes of a pool.
    { read: 8, what: 'list', kind: '/Pod', fields: { 'spec.nodeName': '' } },
    {
      read: 9,
      what: 'list',
      kind: '/Node',
      labels: ['karpenter.sh/nodepool', 'karpenter.sh/capacity-type=spot'],
    },
    {
      read: 10,
      what: 'list',
      kind: '/Pod',
      namespace: 'shop',
      usage: true,
      fields: {
        'status.phase': 'Pending',
        'spec.nodeName': 'ip-10-0-1-5.eu-west-1.compute.internal',
      },
      labels: ['app'],
    },
    { stop: 3 },
    { refresh: true },
  ]
  const said = await page.evaluate(
    (asks) =>
      asks.map((ask) =>
        (window as unknown as Lent).__lumoviDoor.doorChecks.readAsk(
          JSON.parse(JSON.stringify(ask)),
        ),
      ),
    asks,
  )
  for (const [i, ask] of asks.entries()) expect(said[i], JSON.stringify(ask)).toEqual(ask)
})

test('anything else stops the plugin: a word too many, a kind or a name that isn’t one, a path', async ({
  page,
  serve,
}) => {
  await opened(page, serve)
  const wrong: unknown[] = [
    null,
    'read',
    [],
    {},
    { read: 1 },
    { read: 0, what: 'list', kind: '/Node' },
    { read: 1.5, what: 'list', kind: '/Node' },
    { read: '1', what: 'list', kind: '/Node' },
    { read: 1, what: 'watch', kind: '/Node' },
    { read: 1, what: 'list' },
    { read: 1, what: 'list', kind: 'Node' },
    { read: 1, what: 'list', kind: '/node' },
    { read: 1, what: 'list', kind: '*/*' },
    { read: 1, what: 'list', kind: '/Node/../Secret' },
    { read: 1, what: 'list', kind: '/Node', namespace: '' },
    { read: 1, what: 'list', kind: '/Node', namespace: '../kube-system' },
    { read: 1, what: 'list', kind: '/Node', namespace: 'A' },
    { read: 1, what: 'list', kind: '/Node', name: 'a' },
    { read: 1, what: 'list', kind: '/Node', fields: ['data'] },
    { read: 1, what: 'list', kind: '/Node', selector: 'a=b' },
    { read: 1, what: 'object', kind: '/Node' },
    { read: 1, what: 'object', kind: '/Node', name: 'a/b' },
    { read: 1, what: 'object', kind: '/Node', name: 'a'.repeat(254) },
    { read: 1, what: 'events', kind: '/Node', name: 'a' },
    { read: 1, what: 'events' },
    { read: 1, what: 'events', of: { kind: 'Secret', name: 'a' } },
    { read: 1, what: 'events', of: '../o_1' },
    { read: 1, what: 'usage', of: 'o_1', kind: '/Node' },
    { read: 1, what: 'usage', of: 'o_1' },
    { read: 1, what: 'list', kind: '/Node', usage: false },
    { read: 1, what: 'object', kind: '/Node', name: 'a', usage: 'yes' },
    // One object is named, never picked.
    {
      read: 1,
      what: 'object',
      kind: '/Pod',
      namespace: 'a',
      name: 'b',
      fields: { 'spec.nodeName': '' },
    },
    { read: 1, what: 'object', kind: '/Node', name: 'a', labels: ['app'] },
    // Fields: one to four, each a path of field names and a value a selector reads as a value.
    { read: 1, what: 'list', kind: '/Pod', fields: {} },
    { read: 1, what: 'list', kind: '/Pod', fields: 'spec.nodeName=' },
    {
      read: 1,
      what: 'list',
      kind: '/Pod',
      fields: { 'a.b': '', 'a.c': '', 'a.d': '', 'a.e': '', 'a.f': '' },
    },
    { read: 1, what: 'list', kind: '/Pod', fields: { spec: '' } },
    { read: 1, what: 'list', kind: '/Pod', fields: { 'spec.node-name': '' } },
    { read: 1, what: 'list', kind: '/Pod', fields: { 'Spec.nodeName': '' } },
    { read: 1, what: 'list', kind: '/Pod', fields: { [`spec.${'n'.repeat(60)}`]: '' } },
    { read: 1, what: 'list', kind: '/Pod', fields: { 'spec.nodeName': 'a,status.phase=Running' } },
    { read: 1, what: 'list', kind: '/Pod', fields: { 'status.phase': '!Running' } },
    { read: 1, what: 'list', kind: '/Pod', fields: { 'status.phase': 1 } },
    // Labels: one to four terms, each once, as a list's filter writes them.
    { read: 1, what: 'list', kind: '/Node', labels: [] },
    { read: 1, what: 'list', kind: '/Node', labels: 'app' },
    { read: 1, what: 'list', kind: '/Node', labels: ['a', 'b', 'c', 'd', 'e'] },
    { read: 1, what: 'list', kind: '/Node', labels: ['app', 'app'] },
    { read: 1, what: 'list', kind: '/Node', labels: ['!app'] },
    { read: 1, what: 'list', kind: '/Node', labels: ['app in (a,b)'] },
    { read: 1, what: 'list', kind: '/Node', labels: [7] },
    { stop: 1, read: 2 },
    { stop: '1' },
    { refresh: 1 },
    { refresh: true, read: 1 },
    { read: 1, what: 'toString', kind: '/Node' },
    { read: 1, what: 'constructor' },
  ]
  const said = await page.evaluate(
    (wrong) => wrong.map((ask) => (window as unknown as Lent).__lumoviDoor.doorChecks.readAsk(ask)),
    wrong,
  )
  for (const [i, ask] of wrong.entries()) {
    expect(said[i], JSON.stringify(ask)).toMatchObject({ why: 'not-allowed' })
  }
  // The names every object answers to are no ask's words. (Read in the page, as the door reads
  // what it's sent: a name every object has, kept as one.)
  expect(
    await page.evaluate(() =>
      (window as unknown as Lent).__lumoviDoor.doorChecks.readAsk(
        JSON.parse('{"read":1,"what":"list","kind":"/Node","__proto__":{"a":1}}'),
      ),
    ),
  ).toMatchObject({
    why: 'not-allowed',
  })
})

const NODE = resolvedAs('', 'Node')
const POD = resolvedAs('', 'Pod')
const CONFIG_MAP = resolvedAs('', 'ConfigMap')
const SECRET = resolvedAs('', 'Secret')
const NODE_POOL = resolvedAs('karpenter.sh', 'NodePool')

test('what a file doesn’t say is refused: by kind, and by what’s read of it', async ({
  page,
  serve,
}) => {
  const { granted } = checksIn(await opened(page, serve))
  // Its own kinds, whole: everything of them.
  for (const what of ['objects', 'status', 'events', 'usage'] as const) {
    expect(await granted(GRANT, NODE_POOL, what)).toEqual({ whole: true })
  }
  // Of Kubernetes' own, what's named.
  expect(await granted(GRANT, NODE, 'objects')).toEqual({
    whole: false,
    granted: GRANT.reads['/Node'],
  })
  expect(await granted(GRANT, NODE, 'status')).toBeTruthy()
  expect(await granted(GRANT, NODE, 'usage')).toBeTruthy()
  expect(await granted(GRANT, NODE, 'events')).toBeUndefined()
  expect(await granted(GRANT, POD, 'status')).toBeUndefined()
  // Events of a kind with none of its fields: there's no such read. Nothing says "you may hear
  // what happened to things you may not see".
  for (const what of ['objects', 'status', 'events', 'usage'] as const) {
    expect(await granted(GRANT, resolvedAs('', 'Event'), what)).toBeUndefined()
  }
  // A kind of Kubernetes' that Lumovi keeps no list for can't be read, whatever a file says.
  for (const what of ['objects', 'status', 'events', 'usage'] as const) {
    expect(await granted(GRANT, resolvedAs('apps', 'Deployment'), what)).toBeUndefined()
  }
  // A kind it doesn't name; another's kind; a name every object answers to.
  for (const kind of [
    CONFIG_MAP,
    resolvedAs('argoproj.io', 'Application'),
    resolvedAs('', 'toString'),
    resolvedAs('', '__proto__'),
    resolvedAs('__proto__', 'constructor'),
  ]) {
    expect(await granted(GRANT, kind, 'objects'), JSON.stringify(kind)).toBeUndefined()
  }
  // A Secret, never: not even if a file's grant said so, or a plugin claimed the kind.
  const loose: Grant = {
    groups: [],
    own: ['/Secret', '/ConfigMap', 'apps/Deployment'],
    reads: { '/Secret': says({ fields: fields('data'), events: true }) },
  }
  for (const what of ['objects', 'status', 'events', 'usage'] as const) {
    expect(await granted(loose, SECRET, what)).toBeUndefined()
  }
  // And a kind of Kubernetes' own is never whole, whatever claims it: "its own" is a tool's kinds.
  expect(await granted(loose, CONFIG_MAP, 'objects')).toBeUndefined()
  expect(await granted(loose, resolvedAs('apps', 'Deployment'), 'objects')).toBeUndefined()
  // Nor one in a group under Kubernetes' own names, whatever claims it.
  const named: Grant = {
    groups: [],
    own: ['x.kubernetes.io/Thing', 'kubernetes.io/Thing', 'k8s.io/Thing', 'x.kubernetes.io/*'],
    reads: {},
  }
  for (const group of ['x.kubernetes.io', 'kubernetes.io', 'k8s.io']) {
    expect(await granted(named, resolvedAs(group, 'Thing'), 'objects'), group).toBeUndefined()
  }
})

test('a list is picked by fields the cluster picks its kind by, and only by what the plugin reads of it', async ({
  page,
  serve,
}) => {
  const { granted, pickedRefusal, selectors } = checksIn(await opened(page, serve))
  const pods = (await granted(GRANT, POD, 'objects'))!
  const nodes = (await granted(GRANT, NODE, 'objects'))!
  const own = (await granted(GRANT, NODE_POOL, 'objects'))!
  // Pods on no node yet: a field the cluster picks pods by, which its file grants.
  expect(await pickedRefusal(POD, pods, { 'spec.nodeName': '' }, undefined)).toBeUndefined()
  expect(await pickedRefusal(POD, pods, { 'metadata.name': 'cart' }, undefined)).toBeUndefined()
  // A phase the cluster picks by, which its file doesn't grant; labels it can't read.
  expect(await pickedRefusal(POD, pods, { 'status.phase': 'Pending' }, undefined)).toBe(
    'not-granted',
  )
  expect(await pickedRefusal(POD, pods, undefined, ['app'])).toBe('not-granted')
  // A field the cluster doesn't pick by, granted or not.
  expect(await pickedRefusal(NODE, nodes, { 'status.capacity': '4' }, undefined)).toBe(
    'not-pickable',
  )
  expect(await pickedRefusal(POD, pods, { 'spec.hostname': 'a' }, undefined)).toBe('not-pickable')
  // Labels where it reads an object's labels.
  expect(await pickedRefusal(NODE, nodes, undefined, ['karpenter.sh/nodepool'])).toBeUndefined()
  // Its own kinds, read whole: picked by their name and namespace, and any labels; no other
  // field, since the cluster picks a tool's kinds by no other.
  expect(
    await pickedRefusal(NODE_POOL, own, { 'metadata.namespace': 'a', 'metadata.name': 'b' }, ['x']),
  ).toBeUndefined()
  expect(await pickedRefusal(NODE_POOL, own, { 'spec.weight': '1' }, undefined)).toBe(
    'not-pickable',
  )
  // As the cluster is asked: a field selector and a label selector.
  expect(
    await selectors({
      fields: { 'spec.nodeName': '', 'status.phase': 'Pending' },
      labels: ['a', 'b=c'],
    }),
  ).toEqual({ fieldSelector: 'spec.nodeName=,status.phase=Pending', labelSelector: 'a,b=c' })
  expect(await selectors({})).toEqual({})
})

test('a plugin that claims every kind of a group reads each of them whole, and no other group’s', async ({
  page,
  serve,
}) => {
  const { granted } = checksIn(await opened(page, serve))
  const every: Grant = { groups: ['karpenter.sh'], own: ['karpenter.sh/*'], reads: {} }
  for (const kind of ['NodePool', 'NodeClaim']) {
    expect(await granted(every, resolvedAs('karpenter.sh', kind), 'objects')).toEqual({
      whole: true,
    })
  }
  for (const kind of [
    resolvedAs('karpenter.k8s.aws', 'EC2NodeClass'),
    resolvedAs('sh', 'NodePool'),
    resolvedAs('', 'Node'),
    // (`*` is no kind's name: what claims every kind doesn't make a kind named so another's.)
    resolvedAs('x.karpenter.sh', 'NodePool'),
  ]) {
    expect(await granted(every, kind, 'objects'), JSON.stringify(kind)).toBeUndefined()
  }
})

test('an object of its own kind is handed over whole: all but who manages it and kubectl’s copy', async ({
  page,
  serve,
}) => {
  await opened(page, serve)
  // (Read in the page, as the door reads what it's sent: a name every object has, kept as one.)
  const said = await page.evaluate(
    ([text, odds]) => {
      const { handedWhole } = (window as unknown as Lent).__lumoviDoor.doorChecks
      const pool = JSON.parse(text) as { metadata: { managedFields: unknown[] } }
      const handed = handedWhole(pool)
      return {
        handed,
        proto: Object.hasOwn(handed.metadata as object, '__proto__'),
        managed: pool.metadata.managedFields.length,
        odd: [...odds, [pool]].map((odd) => handedWhole(odd)),
      }
    },
    [
      `{
    "apiVersion": "karpenter.sh/v1",
    "kind": "NodePool",
    "metadata": {
      "name": "default",
      "managedFields": [{ "manager": "kubectl" }],
      "annotations": {
        "kubectl.kubernetes.io/last-applied-configuration": "{}",
        "control-plane.alpha.kubernetes.io/leader": "x",
        "karpenter.sh/nodepool-hash": "123"
      },
      "__proto__": { "polluted": true }
    },
    "spec": { "template": { "spec": { "nodeClassRef": { "name": "default" } } }, "limits": { "cpu": 100 } }
  }`,
      [null, 'text', 7],
    ] as const,
  )
  expect(said.handed).toEqual({
    apiVersion: 'karpenter.sh/v1',
    kind: 'NodePool',
    metadata: { name: 'default', annotations: { 'karpenter.sh/nodepool-hash': '123' } },
    // Its own kind's template is its own: whole, as everything of it is.
    spec: { template: { spec: { nodeClassRef: { name: 'default' } } }, limits: { cpu: 100 } },
  })
  expect(said.proto).toBe(false)
  // A copy: what was read is as it was.
  expect(said.managed).toBe(1)
  // (null, 'text', 7, and the object in a list)
  for (const handed of said.odd) expect(handed).toEqual({})
  // Metadata that isn't named values, or annotations that aren't, is handed as it is: there's
  // nothing in it to leave out. (Only a stand-in has such metadata: the API server never serves
  // an object whose metadata isn't one. It's no way round the pick.)
  const odd = [
    { metadata: 'x' },
    { metadata: null },
    { metadata: [] },
    { metadata: { annotations: 'x' } },
  ]
  expect(
    await page.evaluate((odd) => {
      const { handedWhole } = (window as unknown as Lent).__lumoviDoor.doorChecks
      return odd.map((object) => handedWhole(object))
    }, odd),
  ).toEqual(odd)
})

test('a read the backend takes from Lumovi’s page has exactly its keys, each of its kind', async ({
  page,
  serve,
}) => {
  const { readQuery, kindAsked } = checksIn(await opened(page, serve))
  // (What the page's code was handed with: its file's digest and its code's.)
  const handed = { digest: `sha256:${'a'.repeat(64)}`, codeDigest: `sha256:${'c'.repeat(64)}` }
  const fine = [
    { context: 'demo', plugin: 'karpenter', ...handed, kind: 'karpenter.sh/NodePool' },
    { context: 'demo', plugin: 'karpenter', ...handed, kind: '/Node', name: 'ip-10-0-1-5' },
    {
      context: 'demo',
      plugin: 'karpenter',
      ...handed,
      kind: '/Pod',
      namespace: 'shop',
      name: 'cart-7d9f',
    },
    { context: 'demo', plugin: 'karpenter', ...handed, kind: '/Node', usage: true },
    {
      context: 'demo',
      plugin: 'karpenter',
      ...handed,
      kind: '/Pod',
      fields: { 'spec.nodeName': '' },
      labels: ['app=cart'],
    },
  ]
  for (const query of fine) expect(await readQuery(query), JSON.stringify(query)).toEqual(query)
  // (Left out, and said as nothing, are the same. Made in the page, so the key is there, said as
  // nothing, as reads.spec has it.)
  expect(
    await page.evaluate(
      (handed) =>
        (window as unknown as Lent).__lumoviDoor.doorChecks.readQuery({
          context: 'demo',
          plugin: 'k',
          ...handed,
          kind: '/Node',
          namespace: undefined,
        }),
      handed,
    ),
  ).toEqual({ context: 'demo', plugin: 'k', ...handed, kind: '/Node' })
  const wrong: unknown[] = [
    null,
    'demo',
    [fine[0]],
    { ...fine[0], also: 1 },
    { ...fine[0], usage: false },
    { ...fine[0], usage: 'yes' },
    { ...fine[0], context: '' },
    { ...fine[0], digest: undefined },
    { ...fine[0], codeDigest: 'sha256:abc' },
    { ...fine[0], digest: `sha256:${'A'.repeat(64)}` },
    { ...fine[0], plugin: '' },
    { ...fine[0], plugin: 7 },
    { ...fine[0], kind: 'Node' },
    { ...fine[0], kind: 'core/secret' },
    { ...fine[0], kind: '/Secret/x' },
    { ...fine[0], namespace: '../kube-system' },
    { ...fine[0], namespace: 'Shop' },
    { ...fine[0], name: 'a/b' },
    { ...fine[0], name: '..' },
    { ...fine[0], name: 'cart%2F..' },
    { ...fine[0], name: ['cart'] },
    // Picked by the same rules as an ask, and only a list.
    { ...fine[1], fields: { 'spec.nodeName': '' } },
    { ...fine[1], labels: ['app'] },
    { ...fine[0], fields: { 'spec.nodeName': 'a,b' } },
    { ...fine[0], fields: [] },
    { ...fine[0], labels: ['!app'] },
    { ...fine[0], labels: [] },
  ]
  for (const query of wrong) expect(await readQuery(query), JSON.stringify(query)).toBeUndefined()
  // (And one whose name every object has, read in the page as the door reads what it's sent.)
  expect(
    await page.evaluate(() =>
      (window as unknown as Lent).__lumoviDoor.doorChecks.readQuery(
        JSON.parse('{"context":"demo","plugin":"k","kind":"/Node","__proto__":{"name":"x"}}'),
      ),
    ),
  ).toBeUndefined()
  expect(await kindAsked('karpenter.sh/NodePool')).toEqual({
    group: 'karpenter.sh',
    kind: 'NodePool',
  })
  expect(await kindAsked('/Node')).toEqual({ group: '', kind: 'Node' })
})

const pod = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: {
    name: 'cart-7d9f',
    namespace: 'shop',
    uid: 'abc',
    labels: { app: 'cart' },
    annotations: {
      'example.com/owner': 'team-a',
      'kubectl.kubernetes.io/last-applied-configuration':
        '{"spec":{"containers":[{"env":[{"name":"TOKEN","value":"hunter2"}]}]}}',
      'control-plane.alpha.kubernetes.io/leader': '{"holderIdentity":"a"}',
    },
    managedFields: [{ manager: 'kubelet' }],
  },
  spec: {
    nodeName: 'node-1',
    containers: [
      {
        name: 'cart',
        image: 'shop/cart:1.4',
        env: [{ name: 'TOKEN', value: 'hunter2' }],
        ports: [{ containerPort: 80 }],
      },
      { name: 'proxy', image: 'envoy:1.30', env: [{ name: 'KEY', value: 's3cret' }] },
    ],
    initContainers: [
      { name: 'init', image: 'busybox', env: [{ name: 'TOKEN', value: 'hunter2' }] },
    ],
  },
  status: { phase: 'Running', podIP: '10.0.1.9' },
}
/** Another tool's kind, shaped as a Pod: where Lumovi can have no list, the rules alone hold. */
const THING = resolvedAs('example.io', 'Thing')
/** reads.spec's `handed`: what of the pod a plugin is handed by these paths, picked in the page. */
const handedIn =
  (picked: ReturnType<typeof checksIn>['picked']) =>
  (...paths: string[]) =>
    picked(pod, THING, says({ fields: fields(...paths) }), [])
const SECRETS = /hunter2|s3cret|kubelet|holderIdentity/

test('of an object, a plugin is handed the fields its file names and nothing else', async ({
  page,
  serve,
}) => {
  const { picked } = checksIn(await opened(page, serve))
  const handed = handedIn(picked)
  expect(await handed('metadata.name', 'metadata.labels', 'spec.nodeName', 'status.phase')).toEqual(
    {
      metadata: { name: 'cart-7d9f', labels: { app: 'cart' } },
      spec: { nodeName: 'node-1' },
      status: { phase: 'Running' },
    },
  )
  // A path that isn't there leaves nothing; what isn't an object gives nothing.
  expect(
    await handed('spec.unschedulable', 'status.nodeInfo.osImage', 'metadata.name.first'),
  ).toEqual({})
  for (const value of [null, 'text', 5, [pod]]) {
    expect(await picked(value, THING, says({ fields: fields('metadata.name') }), [])).toEqual({})
  }
  // A path and one under it: the shorter has it all, whichever is named first.
  expect(await handed('status.phase', 'status')).toEqual({ status: pod.status })
  expect(await handed('status', 'status.phase')).toEqual({ status: pod.status })
})

test('a step into a list is taken of each item: its shape kept, and nothing else of an item', async ({
  page,
  serve,
}) => {
  const { picked } = checksIn(await opened(page, serve))
  const route = {
    spec: {
      rules: [
        { host: 'a.example.com', paths: [{ path: '/', port: 80 }], secretName: 'tls-a' },
        { host: 'b.example.com', paths: [] },
        { other: true },
      ],
    },
  }
  const of = (...paths: string[]) => picked(route, THING, says({ fields: fields(...paths) }), [])
  expect(await of('spec.rules.host')).toEqual({
    spec: { rules: [{ host: 'a.example.com' }, { host: 'b.example.com' }, {}] },
  })
  expect(await of('spec.rules.paths.port', 'spec.rules.host')).toEqual({
    spec: {
      rules: [
        { host: 'a.example.com', paths: [{ port: 80 }] },
        { host: 'b.example.com', paths: [] },
        {},
      ],
    },
  })
})

test('of a kind that isn’t its own, nothing hands over more than it names, and nothing inside a pod template', async ({
  page,
  serve,
}) => {
  const { picked } = checksIn(await opened(page, serve))
  const handed = handedIn(picked)
  for (const path of [
    'metadata',
    'metadata.annotations',
    'metadata.managedFields',
    'metadata.managedFields.manager',
    'spec',
    // A pod's spec, wherever a kind keeps one: not whole, and not a field of it.
    'spec.containers',
    'spec.containers.image',
    'spec.containers.name',
    'spec.containers.livenessProbe.httpGet.httpHeaders',
    'spec.containers.lifecycle',
    'spec.initContainers.image',
    'spec.ephemeralContainers',
    'spec.volumes',
    'spec.volumes.csi.volumeAttributes',
    'spec.template',
    'spec.template.metadata.labels',
    'spec.template.spec.containers.image',
    'spec.jobTemplate.spec.template.spec.containers.image',
  ]) {
    expect(await handed(path), path).toEqual({})
  }
  // What's left is what it names, of the object's own fields.
  expect(await handed('metadata.name', 'metadata.labels', 'spec.nodeName', 'status.phase')).toEqual(
    {
      metadata: { name: 'cart-7d9f', labels: { app: 'cart' } },
      spec: { nodeName: 'node-1' },
      status: { phase: 'Running' },
    },
  )
  // And what's handed over whole has no pod template in it, under whatever name.
  const rollout = {
    status: {
      phase: 'Healthy',
      lastTemplate: { template: { spec: { containers: [{ env: [{ value: 'hunter2' }] }] } } },
      podSpec: {
        containers: [{ args: ['--token=hunter2'] }],
        volumes: [{ csi: { volumeAttributes: { token: 'hunter2' } } }],
        nodeName: 'n',
      },
    },
  }
  expect(
    await picked(
      rollout,
      resolvedAs('argoproj.io', 'Rollout'),
      says({ fields: fields('status') }),
      [],
    ),
  ).toEqual({
    status: { phase: 'Healthy', lastTemplate: {}, podSpec: { nodeName: 'n' } },
  })
})

test('a container’s environment, and a tool’s own annotations, are never handed over, whoever names them', async ({
  page,
  serve,
}) => {
  const { picked } = checksIn(await opened(page, serve))
  const handed = handedIn(picked)
  // One annotation by its key, yes: but never the object as it was last applied, nor its kin.
  const one = (key: string, groups: string[] = []) =>
    picked(
      pod,
      THING,
      says({
        fields: [
          {
            path: `metadata.annotations["${key}"]`,
            steps: [{ key: 'metadata' }, { key: 'annotations' }, { key }],
          },
        ],
      }),
      groups,
    )
  // On another tool's kind too, an annotation only by a key under one of the plugin's own
  // groups: anyone else's is whatever that tool wrote, often its own copy of the object.
  expect(await one('example.com/owner')).toEqual({})
  expect(await one('example.com/owner', ['example.com'])).toEqual({
    metadata: { annotations: { 'example.com/owner': 'team-a' } },
  })
  expect(await one('kopf.zalando.org/last-handled-configuration')).toEqual({})
  expect(
    await one('kubectl.kubernetes.io/last-applied-configuration', ['kubectl.kubernetes.io']),
  ).toEqual({})
  expect(await one('kubectl.kubernetes.io/last-applied-configuration')).toEqual({})
  expect(await one('control-plane.alpha.kubernetes.io/leader')).toEqual({})
  // The environment: by name, under a name, or inside something handed over whole.
  expect(await handed('spec.containers.env')).toEqual({})
  expect(await handed('spec.containers.env.value', 'spec.initContainers.env.name')).toEqual({})
  const whole = {
    status: { copied: { env: [{ value: 'hunter2' }], managedFields: ['kubelet'], fine: 1 } },
  }
  expect(await picked(whole, THING, says({ fields: fields('status') }), [])).toEqual({
    status: { copied: { fine: 1 } },
  })
  // Every path one could write, together: none of it comes back.
  const everything = await handed(
    'metadata',
    'metadata.annotations',
    'metadata.managedFields',
    'spec',
    'spec.containers',
    'spec.containers.env',
    'spec.containers.env.value',
    'spec.initContainers',
    'spec.containers.image',
    'status',
  )
  expect(JSON.stringify(everything)).not.toMatch(SECRETS)
  expect(everything).toEqual({ status: pod.status })
})

test('of Kubernetes’ own kinds, only what’s on Lumovi’s list: nothing else is handed over, whoever names it', async ({
  page,
  serve,
}) => {
  const { picked, readable } = checksIn(await opened(page, serve))
  const realPod = {
    ...pod,
    metadata: {
      ...pod.metadata,
      ownerReferences: [
        {
          apiVersion: 'apps/v1',
          kind: 'ReplicaSet',
          name: 'cart-7d9f',
          uid: 'u-1',
          controller: true,
        },
      ],
      annotations: {
        ...pod.metadata.annotations,
        'karpenter.sh/do-not-disrupt': 'true',
        'kubernetes.io/change-cause':
          'kubectl create secret generic a --from-literal=password=hunter2',
        'kopf.zalando.org/last-handled-configuration': '{"env":"hunter2"}',
        'nginx.ingress.kubernetes.io/configuration-snippet':
          'proxy_set_header Authorization "Bearer hunter2";',
      },
    },
    spec: {
      ...pod.spec,
      containers: pod.spec.containers.map((container) => ({
        ...container,
        args: ['--token=hunter2'],
        command: ['run', '--token=hunter2'],
        resources: { requests: { cpu: '100m' } },
        livenessProbe: {
          httpGet: { httpHeaders: [{ name: 'Authorization', value: 'Bearer hunter2' }] },
        },
        lifecycle: { preStop: { exec: { command: ['curl', '-H', 'X-Token: hunter2'] } } },
      })),
      volumes: [{ name: 'v', csi: { volumeAttributes: { token: 'hunter2' } } }],
    },
    status: {
      ...pod.status,
      conditions: [
        {
          type: 'Ready',
          status: 'False',
          reason: 'ContainersNotReady',
          message: 'containers with unready status: [cart]',
        },
      ],
      containerStatuses: [
        {
          name: 'cart',
          ready: false,
          restartCount: 3,
          lastState: { terminated: { message: 'password=hunter2' } },
        },
      ],
    },
  }
  const of = (...paths: string[]) =>
    picked(realPod, POD, says({ fields: fields(...paths) }), ['karpenter.sh'])
  // Every line of the list, together: what a page of pods needs, and no credential in it.
  const all = await of(...READABLE['/Pod']!)
  expect(all).toEqual({
    metadata: {
      name: 'cart-7d9f',
      namespace: 'shop',
      labels: { app: 'cart' },
      ownerReferences: realPod.metadata.ownerReferences,
    },
    spec: {
      nodeName: 'node-1',
      containers: [
        { name: 'cart', image: 'shop/cart:1.4', resources: { requests: { cpu: '100m' } } },
        { name: 'proxy', image: 'envoy:1.30', resources: { requests: { cpu: '100m' } } },
      ],
    },
    status: {
      phase: 'Running',
      conditions: realPod.status.conditions,
      containerStatuses: [{ name: 'cart', ready: false, restartCount: 3 }],
    },
  })
  expect(JSON.stringify(all)).not.toMatch(/hunter2|s3cret/)
  // What isn't on the list, each a place a credential really sits: nothing, one by one and together.
  const off = [
    'metadata.uid',
    'metadata.annotations',
    'spec.containers.args',
    'spec.containers.command',
    'spec.containers.livenessProbe',
    'spec.containers.livenessProbe.httpGet.httpHeaders',
    'spec.containers.lifecycle',
    'spec.containers.ports',
    'spec.volumes',
    'spec.volumes.csi.volumeAttributes',
    'status',
    'status.podIP',
    'status.containerStatuses',
    'status.containerStatuses.lastState',
    'status.containerStatuses.lastState.terminated.message',
    'spec.containers',
    'spec.containers.resources.requests',
    'metadata.labels.app',
  ]
  for (const path of off) expect(await of(path), path).toEqual({})
  expect(await of(...off)).toEqual({})
  // An annotation: only by a key under one of the plugin's own groups. Nobody else's.
  const annotation = (key: string, groups: string[]) =>
    picked(
      realPod,
      POD,
      says({
        fields: [{ path: key, steps: [{ key: 'metadata' }, { key: 'annotations' }, { key }] }],
      }),
      groups,
    )
  expect(await annotation('karpenter.sh/do-not-disrupt', ['karpenter.sh'])).toEqual({
    metadata: { annotations: { 'karpenter.sh/do-not-disrupt': 'true' } },
  })
  for (const key of [
    'example.com/owner',
    'kubernetes.io/change-cause',
    'kopf.zalando.org/last-handled-configuration',
    'nginx.ingress.kubernetes.io/configuration-snippet',
    'kubectl.kubernetes.io/last-applied-configuration',
  ]) {
    expect(await annotation(key, ['karpenter.sh']), key).toEqual({})
  }
  // Kubernetes' own names are never a plugin's group, whatever its file claims: its own
  // annotations live there. An add-on's group under k8s.io can be.
  for (const group of [
    'kubernetes.io',
    'k8s.io',
    'nginx.ingress.kubernetes.io',
    'apps',
    'storage.k8s.io',
    '',
  ]) {
    const key = group === 'kubernetes.io' ? 'kubernetes.io/change-cause' : `${group}/x`
    const with_ = {
      ...realPod,
      metadata: {
        ...realPod.metadata,
        annotations: { ...realPod.metadata.annotations, [key]: 'hunter2' },
      },
    }
    expect(
      await picked(
        with_,
        POD,
        says({
          fields: [{ path: key, steps: [{ key: 'metadata' }, { key: 'annotations' }, { key }] }],
        }),
        [group],
      ),
      group,
    ).toEqual({})
  }
  const gateway = { metadata: { annotations: { 'gateway.networking.k8s.io/x': 'fine' } } }
  expect(
    await picked(
      gateway,
      POD,
      says({
        fields: [
          {
            path: 'x',
            steps: [
              { key: 'metadata' },
              { key: 'annotations' },
              { key: 'gateway.networking.k8s.io/x' },
            ],
          },
        ],
      }),
      ['gateway.networking.k8s.io'],
    ),
  ).toEqual(gateway)
  // Not by a group that only looks like its own, nor a key with no group; and never kubectl's,
  // even for a plugin that names that group.
  expect(
    await annotation('karpenter.sh/do-not-disrupt', ['sh', 'karpenter', 'karpenter.sh.evil.io']),
  ).toEqual({})
  expect(await annotation('karpenter.sh/do-not-disrupt', [])).toEqual({})
  expect(
    await annotation('kubectl.kubernetes.io/last-applied-configuration', ['kubectl.kubernetes.io']),
  ).toEqual({})
  // A Node's lines, and a kind with no list at all.
  const node = {
    metadata: { name: 'n', labels: { zone: 'a' }, annotations: { a: 'b' } },
    spec: { taints: [], providerID: 'aws:///i-0' },
    status: { capacity: { cpu: '8' }, addresses: [{ address: '10.0.0.1' }] },
  }
  expect(
    await picked(
      node,
      NODE,
      says({ fields: fields(...READABLE['/Node']!, 'spec.providerID', 'status.addresses') }),
      [],
    ),
  ).toEqual({
    metadata: { name: 'n', labels: { zone: 'a' } },
    spec: { taints: [] },
    status: { capacity: { cpu: '8' } },
  })
  expect(
    await picked(
      { metadata: { name: 'a' } },
      resolvedAs('apps', 'Deployment'),
      says({ fields: fields('metadata.name') }),
      [],
    ),
  ).toEqual({})
  // A line is matched step for step: a step with a dot in it doesn't spell one.
  expect(await readable(POD, [{ key: 'metadata.name' }], [])).toBe(false)
  expect(await readable(POD, [{ key: 'spec' }, { key: 'containers.image' }], [])).toBe(false)
  expect(
    await picked(
      { 'metadata.name': 'x', metadata: { name: 'a' } },
      POD,
      says({ fields: [{ path: 'metadata.name', steps: [{ key: 'metadata.name' }] }] }),
      [],
    ),
  ).toEqual({})
  // And `readable` is the one question, for the file checker too.
  expect(await readable(POD, parse('.spec.containers.image'), [])).toBe(true)
  expect(await readable(POD, parse('.spec.containers.args'), [])).toBe(false)
  expect(await readable(POD, parse('.spec.containers[0].image'), [])).toBe(false)
  expect(await readable(resolvedAs('', 'pod'), parse('.metadata.name'), [])).toBe(false)
  expect(await readable(SECRET, parse('.metadata.name'), [])).toBe(false)
  expect(await readable(THING, parse('.metadata.name'), [])).toBe(false)
  // One of the plugin's own annotations is read by its key, and nothing inside it is a path.
  const ownKey = [{ key: 'metadata' }, { key: 'annotations' }, { key: 'toys.example.com/a' }]
  expect(await readable(POD, ownKey, ['toys.example.com'])).toBe(true)
  expect(await readable(POD, [...ownKey, { key: 'b' }], ['toys.example.com'])).toBe(false)
})

/**
 * What of an object a plugin is handed by a grant, picked in the page with a count of what was
 * held back (reads.spec's `held`, which the door adds to): what's handed, and the count after.
 */
const pickedCounting = (
  page: Page,
  value: unknown,
  kind: ReturnType<typeof resolvedAs>,
  grant: Granted,
  groups: string[],
) =>
  page.evaluate(
    ([value, kind, grant, groups]) => {
      const held = { fields: 0 }
      const given = (window as unknown as Lent).__lumoviDoor.doorChecks.picked(
        value,
        kind,
        grant,
        groups,
        held,
      )
      return { given, fields: held.fields }
    },
    [value, kind, grant, groups] as const,
  )

test('a label named like a field is a label: what’s handed over is the object’s, not a wrong one', async ({
  page,
  serve,
}) => {
  const { picked } = checksIn(await opened(page, serve))
  const labels = {
    app: 'shop',
    env: 'prod',
    command: 'x',
    template: 'web',
    volumes: 'none',
    args: 'a',
    containers: '2',
    tier: 'front',
  }
  // A line of Lumovi's own list: as it is.
  expect(
    await picked({ metadata: { labels } }, POD, says({ fields: fields('metadata.labels') }), []),
  ).toEqual({ metadata: { labels } })
  const conditions = [{ type: 'Ready', status: 'True', message: 'env and args are fine' }]
  expect(
    await picked(
      { status: { conditions } },
      NODE,
      says({ fields: fields('status.conditions') }),
      [],
    ),
  ).toEqual({ status: { conditions } })
  // Another tool's kind: its labels and selectors whole and inside what's handed over whole;
  // the dropping reaches a real `env` beside them and not a label called that.
  const thing = {
    metadata: { labels },
    spec: {
      selector: { matchLabels: { env: 'prod', app: 'shop' } },
      placement: {
        nodeSelector: { env: 'prod' },
        env: [{ name: 'TOKEN', value: 'hunter2' }],
        size: 2,
      },
    },
  }
  const of = (...paths: string[]) => picked(thing, THING, says({ fields: fields(...paths) }), [])
  expect(await of('metadata.labels')).toEqual({ metadata: { labels } })
  expect(await of('spec.selector')).toEqual({ spec: { selector: thing.spec.selector } })
  expect(await of('spec.selector.matchLabels')).toEqual({
    spec: { selector: thing.spec.selector },
  })
  expect(await of('spec.placement')).toEqual({
    spec: { placement: { nodeSelector: { env: 'prod' }, size: 2 } },
  })
  expect(
    JSON.stringify(await of('spec.placement', 'spec.selector', 'metadata.labels')),
  ).not.toContain('hunter2')
  // One label by its key, whatever it's called: under a map of labels a step is a person's word.
  expect(await of('metadata.labels.env', 'spec.selector.matchLabels.env')).toEqual({
    metadata: { labels: { env: 'prod' } },
    spec: { selector: { matchLabels: { env: 'prod' } } },
  })
  // Only what labels really are is left alone: text to text. Anything else a kind keeps under
  // one of those names is a field like any other, whole or by a step.
  const odd = {
    spec: {
      deep: { labels: { env: { nested: 'hunter2' }, fine: 'a' } },
      matchLabels: { env: ['hunter2'], app: 'shop' },
      labels: [{ env: 'hunter2' }],
      nodeSelector: { containers: [{ args: ['hunter2'] }], template: { spec: 'hunter2' } },
    },
    status: { labels: { command: ['hunter2'] } },
  }
  const { given, fields: held } = await pickedCounting(
    page,
    odd,
    THING,
    says({
      fields: fields(
        'spec.deep',
        'spec.matchLabels',
        'spec.labels',
        'spec.nodeSelector',
        'status',
        'spec.deep.labels.env',
        'spec.matchLabels.env',
        'spec.nodeSelector.containers',
      ),
    }),
    [],
  )
  expect(given).toEqual({
    spec: {
      deep: { labels: { fine: 'a' } },
      matchLabels: { app: 'shop' },
      labels: [{}],
      nodeSelector: {},
    },
    status: { labels: {} },
  })
  expect(JSON.stringify(given)).not.toContain('hunter2')
  // And what was held back is counted, for the line that tells the plugin's author.
  expect(held).toBe(6)
  const told = await pickedCounting(
    page,
    { spec: { tags: { env: 'prod', a: 'b' }, size: 1 } },
    THING,
    says({ fields: fields('spec.tags', 'spec.size') }),
    [],
  )
  expect(told.fields).toBe(1)
  // A path refused outright is held back as much as a field taken out: counted the same.
  const refused = await pickedCounting(
    page,
    { spec: { env: [{ value: 'x' }], size: 1 } },
    THING,
    says({ fields: fields('spec.env', 'spec.size', 'spec') }),
    [],
  )
  expect(refused.fields).toBe(2)
  // Nothing is counted of a line of Lumovi's list, where nothing is held back.
  const none = await pickedCounting(
    page,
    { metadata: { labels } },
    POD,
    says({ fields: fields('metadata.labels') }),
    [],
  )
  expect(none.fields).toBe(0)
})

test('what a ConfigMap holds, anything of a Secret, and what isn’t a field’s own name: never', async ({
  page,
  serve,
}) => {
  const { picked } = checksIn(await opened(page, serve))
  const held = {
    metadata: { name: 'a' },
    data: { password: 'hunter2' },
    binaryData: { key: 'aGk=' },
  }
  const all = says({ fields: fields('metadata.name', 'data', 'data.password', 'binaryData') })
  // (A ConfigMap is a kind Lumovi keeps no list for: nothing of it, its name included. And
  // were it another tool's kind of that shape, its data still wouldn't be handed over by name.)
  expect(await picked(held, CONFIG_MAP, all, [])).toEqual({})
  expect(await picked(held, SECRET, all, [])).toEqual({})
  const odd = says({
    fields: [
      { path: '', steps: [] },
      { path: 'spec.containers[*]', steps: parse('.spec.containers[*]') },
      { path: 'spec.containers[0].image', steps: parse('.spec.containers[0].image') },
      {
        path: 'spec.containers[?(@.name)].image',
        steps: parse('.spec.containers[?(@.name)].image'),
      },
      { path: '__proto__', steps: [{ key: '__proto__' }] },
      { path: 'constructor.name', steps: [{ key: 'constructor' }, { key: 'name' }] },
      { path: 'metadata.toString', steps: [{ key: 'metadata' }, { key: 'toString' }] },
    ],
  })
  expect(await picked(pod, THING, odd, [])).toEqual({})
})

test('what’s handed over is a copy: nothing that holds it holds, or can change, what was read', async ({
  page,
  serve,
}) => {
  await opened(page, serve)
  // (Held and changed in the page, where the door handed it over.)
  const said = await page.evaluate(
    ([pod, kind, grant]) => {
      const before = JSON.stringify(pod)
      const given = (window as unknown as Lent).__lumoviDoor.doorChecks.picked(
        pod,
        kind,
        grant,
        [],
      ) as { status: { phase: string }; metadata: { labels: Record<string, string> } }
      const status = { ...given.status }
      const same = {
        status: given.status === pod.status,
        labels: given.metadata.labels === pod.metadata.labels,
      }
      given.status.phase = 'Changed'
      given.metadata.labels.app = 'changed'
      return { status, same, unchanged: JSON.stringify(pod) === before }
    },
    [
      pod,
      THING,
      says({ fields: fields('status', 'metadata.labels', 'spec.containers.ports') }),
    ] as const,
  )
  expect(said.status).toEqual(pod.status)
  expect(said.same.status).toBe(false)
  expect(said.same.labels).toBe(false)
  expect(said.unchanged).toBe(true)
})

test('a page’s reads are counted: lists kept, everything kept, asks in a second, asks waiting', async ({
  page,
  serve,
}) => {
  const reads = await readsIn(await opened(page, serve))
  const plugin = await reads.plugin()
  const list = (read: number) => ({ read, what: 'list', kind: '/Node' }) as const
  const one = (read: number) => ({ read, what: 'object', kind: '/Node', name: 'a' }) as const
  const lists = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => list(from + i))
  const nothing = (count: number) => Array.from({ length: count }, () => undefined)
  // Eight lists a page; the ninth stops it. Ending one makes room.
  const first = await reads.page(plugin)
  expect(await reads.takeAll(first, lists(1, READ_LIMITS.listsAPage))).toEqual(
    nothing(READ_LIMITS.listsAPage),
  )
  await reads.later(1000)
  expect(await reads.take(first, { stop: 3 })).toBeUndefined()
  expect(await reads.take(first, list(9))).toBeUndefined()
  expect(await reads.take(first, list(10))).toEqual({
    why: 'too-much',
    what: 'lists a page keeps: more than 8',
  })
  // Sixteen a plugin, across its pages; a page that's gone gives its lists back.
  const second = await reads.page(plugin)
  await reads.later(1000)
  expect(await reads.takeAll(second, lists(1, READ_LIMITS.listsAPage))).toEqual(
    nothing(READ_LIMITS.listsAPage),
  )
  expect((await reads.counts(plugin)).lists).toBe(READ_LIMITS.listsAPlugin)
  const third = await reads.page(plugin)
  await reads.later(1000)
  expect(await reads.take(third, list(1))).toEqual({
    why: 'too-much',
    what: 'lists a plugin keeps: more than 16',
  })
  await reads.close(second)
  await reads.close(second)
  await reads.close(first)
  await reads.close(third)
  expect(await reads.counts(plugin)).toEqual({ lists: 0, kept: 0 })

  // Everything kept going, lists or not, answered or not: fifty a page, a hundred a plugin.
  const keeps = [await reads.page(plugin), await reads.page(plugin), await reads.page(plugin)]
  let read = 0
  const fill = async (at: number, count: number) => {
    expect(await reads.fill(at, one(0), read, count, READ_LIMITS.asksASecond)).toEqual(
      nothing(count),
    )
    read += count
  }
  await fill(keeps[0]!, READ_LIMITS.keptAPage)
  await reads.later(1000)
  expect(await reads.take(keeps[0]!, one(++read))).toEqual({
    why: 'too-much',
    what: 'reads a page keeps going: more than 50',
  })
  await fill(keeps[1]!, READ_LIMITS.keptAPage)
  await reads.later(1000)
  expect(await reads.take(keeps[2]!, one(++read))).toEqual({
    why: 'too-much',
    what: 'reads a plugin keeps going: more than 100',
  })
  for (const at of keeps) await reads.close(at)
  expect(await reads.counts(plugin)).toEqual({ lists: 0, kept: 0 })

  // Ten asks a second, by Lumovi's clock; a clock set back starts the second again.
  const fast = await reads.page(await reads.plugin())
  await reads.later(1000)
  for (let i = 1; i <= READ_LIMITS.asksASecond; i++) {
    expect(await reads.take(fast, { read: i, what: 'events', of: 'o_1' })).toBeUndefined()
    await reads.answered(fast, i)
  }
  await reads.later(-5000)
  expect(await reads.take(fast, { read: 11, what: 'events', of: 'o_1' })).toBeUndefined()
  for (let i = 12; i <= 20; i++) await reads.take(fast, { read: i, what: 'events', of: 'o_1' })
  expect(await reads.take(fast, { read: 21, what: 'events', of: 'o_1' })).toEqual({
    why: 'too-much',
    what: 'asks in a second: more than 10',
  })

  // Twenty waiting at once; one answered, or refused, makes room.
  const slow = await reads.page(await reads.plugin())
  let asked = 0
  for (let second = 0; second < 2; second++) {
    await reads.later(1000)
    for (let i = 0; i < 10; i++) {
      expect(await reads.take(slow, { read: ++asked, what: 'events', of: 'o_1' })).toBeUndefined()
    }
  }
  await reads.later(1000)
  // (A read that isn't going, answered: there's nothing to mark.)
  await reads.answered(slow, 999)
  await reads.answered(slow, 1)
  await reads.refused(slow, 2)
  expect(await reads.take(slow, { read: ++asked, what: 'events', of: 'o_1' })).toBeUndefined()
  expect(await reads.take(slow, { read: ++asked, what: 'events', of: 'o_1' })).toBeUndefined()
  expect(await reads.take(slow, { read: asked + 1, what: 'events', of: 'o_1' })).toEqual({
    why: 'too-much',
    what: 'asks not yet answered: more than 20',
  })
})

test('a number is new once; and ending a read that’s already ended does nothing, since messages cross', async ({
  page,
  serve,
}) => {
  const reads = await readsIn(await opened(page, serve))
  const plugin = await reads.plugin()
  const at = await reads.page(plugin)
  expect(await reads.take(at, { read: 5, what: 'list', kind: '/Node' })).toBeUndefined()
  expect(await reads.take(at, { read: 5, what: 'events', of: 'o_1' })).toMatchObject({
    why: 'not-allowed',
  })
  expect(
    await reads.take(await reads.page(plugin), { read: 7, what: 'events', of: 'o_1' }),
  ).toBeUndefined()
  // Lumovi refused it; the plugin's own tidying ends it before it has heard: nothing to do.
  const tidy = await reads.page(await reads.plugin())
  expect(await reads.take(tidy, { read: 1, what: 'list', kind: '/Node' })).toBeUndefined()
  await reads.refused(tidy, 1)
  expect(await reads.take(tidy, { stop: 1 })).toBeUndefined()
  // Ended twice: the same.
  expect(await reads.take(tidy, { read: 2, what: 'list', kind: '/Node' })).toBeUndefined()
  expect(await reads.take(tidy, { stop: 2 })).toBeUndefined()
  expect(await reads.take(tidy, { stop: 2 })).toBeUndefined()
  // Only a read never asked for can't be ended.
  expect(await reads.take(tidy, { stop: 3 })).toEqual({
    why: 'not-allowed',
    what: 'ends a read it never asked for',
  })
})

test('a refresh too soon isn’t made, and doesn’t stop the plugin; but it’s one of its second’s asks', async ({
  page,
  serve,
}) => {
  const reads = await readsIn(await opened(page, serve), 50_000)
  const at = await reads.page(await reads.plugin())
  expect(await reads.take(at, { refresh: true })).toBeUndefined()
  await reads.later(READ_LIMITS.refreshEveryMs - 1)
  expect(await reads.take(at, { refresh: true })).toBe('too-soon')
  await reads.later(1)
  expect(await reads.take(at, { refresh: true })).toBeUndefined()
  // Held down: the eleventh in a second stops the page as any eleventh ask does.
  await reads.later(1000)
  expect(
    await reads.takeAll(
      at,
      Array.from({ length: READ_LIMITS.asksASecond }, () => ({ refresh: true })),
    ),
  ).toEqual(Array.from({ length: READ_LIMITS.asksASecond }, () => 'too-soon'))
  expect(await reads.take(at, { refresh: true })).toMatchObject({ why: 'too-much' })
})

test('a Secret is named only by a declared path of an object, as Lumovi holds it', async ({
  page,
  serve,
}) => {
  const { secretsNamed } = checksIn(await opened(page, serve))
  const certificate = {
    metadata: {
      name: 'shop',
      namespace: 'shop',
      labels: { secret: 'from-a-label' },
      annotations: { secret: 'from-an-annotation' },
    },
    spec: {
      secretName: 'shop-tls',
      issuers: [{ secret: { name: 'ca-a' } }, { secret: { name: 'ca-b' } }, {}],
      names: ['one', 'two'],
    },
    status: { secret: 'shop-tls-next', count: 3, odd: '../kube-system/admin', empty: '' },
  }
  const named = (path: string) => secretsNamed(certificate, parse(`.${path}`))
  expect(await named('spec.secretName')).toEqual(['shop-tls'])
  expect(await named('status.secret')).toEqual(['shop-tls-next'])
  // Into a list, of each item; and a list of names, each.
  expect(await named('spec.issuers.secret.name')).toEqual(['ca-a', 'ca-b'])
  expect(await named('spec.names')).toEqual(['one', 'two'])
  // Not under metadata; not what isn't a name; not a field that isn't there or isn't text.
  for (const path of [
    'metadata.labels.secret',
    'metadata.annotations.secret',
    'metadata.name',
    'status.odd',
    'status.empty',
    'status.count',
    'spec.missing',
    'spec',
    'spec.issuers',
  ]) {
    expect(await named(path), path).toEqual([])
  }
  // Field names only: no index, wildcard or filter, nor the names every object answers to.
  for (const steps of [
    parse('.spec.issuers[0].secret.name'),
    parse('.spec.issuers[*].secret.name'),
    [{ key: '__proto__' }],
    [{ key: 'spec' }, { key: 'constructor' }],
    [],
  ]) {
    expect(await secretsNamed(certificate, steps)).toEqual([])
  }
  // One name in a list that isn't a name: none of them. Twenty at most, and past that none.
  expect(
    await secretsNamed({ spec: { names: ['fine', 'Not A Name'] } }, parse('.spec.names')),
  ).toEqual([])
  const many = (count: number) => ({
    spec: { names: Array.from({ length: count }, (_, i) => `s-${i}`) },
  })
  expect(await secretsNamed(many(20), parse('.spec.names'))).toHaveLength(20)
  expect(await secretsNamed(many(21), parse('.spec.names'))).toEqual([])
  // The same name twice is one Secret.
  expect(await secretsNamed({ spec: { names: ['a', 'a'] } }, parse('.spec.names'))).toEqual(['a'])
  for (const value of [null, 'text', 5, [certificate]])
    expect(await secretsNamed(value, parse('.spec.secretName'))).toEqual([])
})

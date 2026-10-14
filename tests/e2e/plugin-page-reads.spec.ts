/**
 * A plugin's page reading through the door: what its code asks, what it's handed with a token
 * for each object, a list kept up to date, a refusal as a code and Lumovi's sentence; and an
 * ask that isn't one, or too many, stopping it. A test plugin on the tests' stage, as one of
 * Lumovi's own (only those carry code).
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { KubeObject } from '../mock-cluster/types.ts'
import { READ_LIMITS, READ_REFUSED } from '../../src/shared/plugin-reads.ts'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { DEMO } from '../mock-cluster/fixtures/demo.ts'
import { expect, openCluster, test } from './fixtures.ts'

const TOYS = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
  pages: [{ id: overview, title: Overview }]
`

/**
 * A test plugin's code: it asks `asks`, one after another, and shows each read's answers in a
 * Field of its own, named by the read: the objects' names and tokens, or how it ended.
 */
const reading = (...asks: object[]) => `box.then(({ post, listen }) => {
  const asks = ${JSON.stringify(asks)}
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  commit([['make', 1, 'Stack', {}], ['put', 0, 1]])
  const fields = new Map()
  let next = 100
  const show = (read, value) => {
    let id = fields.get(read)
    const props = { name: 'read ' + read, value: value.slice(0, 4000) }
    if (id === undefined) {
      fields.set(read, (id = next++))
      commit([['make', id, 'Field', props], ['put', 1, id]])
    } else commit([['change', id, props]])
  }
  listen((text) => {
    const said = JSON.parse(text)
    if (said.objects) show(said.read, '|' + said.objects.map((o) => o.object.metadata.name + '=' + o.token).sort().join('|') + '|')
    else if (said.ended) show(said.read, 'ended ' + said.ended + ': ' + said.said)
    else if (said.failing) show(said.read, 'failing ' + said.failing)
  })
  for (const ask of asks) post(JSON.stringify(ask))
})`

/**
 * Puts the plugin's page on the stage with `code` as its code: beside its file (`toys.js`), and
 * taken as Lumovi hands it over, the one way a page that reads is given code.
 */
async function show(page: Page, folder: string, code: string) {
  writeFileSync(join(folder, 'toys.js'), code)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  await page.evaluate(
    (shown) =>
      (window as unknown as { __lumoviDoor: { show(shown: object): void } }).__lumoviDoor.show(
        shown,
      ),
    { plugin: 'toys', name: 'Toys', version: '1.2.0', context: 'demo' },
  )
}

const field = (page: Page, read: number | string) =>
  page.locator('[data-part="Field"]').filter({ hasText: `read ${read}` })
const ended = (page: Page) => page.getByTestId('plugin-ended')

/** Each name a read shows, with its token. */
async function tokens(page: Page, read: number): Promise<Map<string, string>> {
  const text = (await field(page, read).textContent()) ?? ''
  return new Map(
    // (Each `|name=token|`: the Field's own words round it are no part of either.)
    [...text.matchAll(/\|([a-z0-9.-]+)=([A-Za-z0-9_-]+)(?=\|)/g)].map(([, name, token]) => [
      name!,
      token!,
    ]),
  )
}

function included(file = TOYS): string {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), file)
  return folder
}

/**
 * A test plugin's code that asks `asks` and shows each read's objects in a Field of its own:
 * each by its name with its usage (CPU in cores, memory in GiB) or a dash, and whether the
 * cluster measures any; or how the read ended.
 */
const usageReading = (...asks: object[]) => `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  commit([['make', 1, 'Stack', {}], ['put', 0, 1]])
  const fields = new Map()
  let next = 100
  const show = (read, value) => {
    let id = fields.get(read)
    const props = { name: 'read ' + read, value: value.slice(0, 4000) }
    if (id === undefined) {
      fields.set(read, (id = next++))
      commit([['make', id, 'Field', props], ['put', 1, id]])
    } else commit([['change', id, props]])
  }
  const used = (o) => o.usage ? o.usage.cpu.toFixed(2) + ':' + (o.usage.memory / 2 ** 30).toFixed(2) : '-'
  listen((text) => {
    const said = JSON.parse(text)
    if (said.objects) show(said.read, '|' + said.objects.map((o) => o.object.metadata.name + ':' + used(o)).sort().join('|') + '|' + (said.noUsage ? ' none measured' : ''))
    else if (said.ended) show(said.read, 'ended ' + said.ended)
  })
  for (const ask of ${JSON.stringify(asks)}) post(JSON.stringify(ask))
})`

test('a plugin’s page reads its own kind through the door: each object with a token, kept up to date', async ({
  launch,
  clusters,
}) => {
  const folder = included()
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  await show(
    page,
    folder,
    reading(
      { read: 1, what: 'list', kind: 'example.com/Widget' },
      { read: 2, what: 'list', kind: '/Node' },
      { read: 3, what: 'events', of: 'made-up' },
    ),
  )
  await expect(field(page, 1)).toContainText(`|${CUSTOM.widget}=`)
  // Kubernetes' own its file doesn't name, and the events of an object Lumovi never handed it:
  // refused, said with Lumovi's words.
  await expect(field(page, 2)).toContainText(`ended not-granted: ${READ_REFUSED['not-granted']}`)
  await expect(field(page, 3)).toContainText(`ended not-found: ${READ_REFUSED['not-found']}`)
  const first = await tokens(page, 1)

  // One more Widget: in the list once it's read again, the others with the tokens they had.
  const widget = clusters.demo.object('Widget.example.com', 'default', CUSTOM.widget)!
  const another = structuredClone(widget) as KubeObject
  another.metadata = { ...another.metadata, name: 'green-widget', uid: 'green-widget-uid' }
  clusters.demo.upsert(another)
  await expect(field(page, 1)).toContainText('|green-widget=', { timeout: 15_000 })
  const second = await tokens(page, 1)
  for (const [name, token] of first) expect(second.get(name), name).toBe(token)
  expect(new Set(second.values()).size).toBe(second.size)
  // And gone, once it's gone.
  clusters.demo.remove('Widget.example.com', 'default', 'green-widget')
  await expect(field(page, 1)).not.toContainText('green-widget', { timeout: 15_000 })
  await expect(ended(page)).toHaveCount(0)
})

/**
 * A test plugin's code that reads the pods and ReplicaSets of `shop`, then the warning events of
 * the pod and the ReplicaSet named, by the tokens Lumovi handed for them, each under the next
 * number as it's asked (whichever list answers first): each one's events in a Field of its own
 * (`read pod`, `read rs`: `|reason ×count: message|`, newest first), or how it ended.
 */
const eventsReading = (pod: string, replicaSet: string) => `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  commit([['make', 1, 'Stack', {}], ['put', 0, 1]])
  const fields = new Map()
  let next = 100
  const show = (read, value) => {
    let id = fields.get(read)
    const props = { name: 'read ' + read, value: value.slice(0, 4000) }
    if (id === undefined) {
      fields.set(read, (id = next++))
      commit([['make', id, 'Field', props], ['put', 1, id]])
    } else commit([['change', id, props]])
  }
  // (An ask's number is new each time: the next, whichever list answered first.)
  let asking = 3
  const named = new Map()
  const ofIt = (label, objects, name) => {
    const found = objects.find((o) => o.object.metadata.name === name)
    if (!found || [...named.values()].includes(label)) return
    named.set(asking, label)
    post(JSON.stringify({ read: asking++, what: 'events', of: found.token }))
  }
  listen((text) => {
    const said = JSON.parse(text)
    if (said.read === 1 && said.objects) ofIt('pod', said.objects, ${JSON.stringify(pod)})
    else if (said.read === 2 && said.objects) ofIt('rs', said.objects, ${JSON.stringify(replicaSet)})
    else if (said.events) show(named.get(said.read), '|' + said.events.map((e) => e.reason + ' ×' + e.count + ': ' + e.message + ' [' + Object.keys(e).sort().join(',') + ']').join('|') + '|')
    else if (said.ended) show(named.get(said.read), 'ended ' + said.ended)
  })
  post(JSON.stringify({ read: 1, what: 'list', kind: '/Pod', namespace: 'shop' }))
  post(JSON.stringify({ read: 2, what: 'list', kind: 'apps/ReplicaSet', namespace: 'shop' }))
})`

test('a plugin’s page reads a pod’s warning events by its token, a few fields of each, kept up to date; a ReplicaSet’s its file doesn’t say, refused', async ({
  launch,
  clusters,
}) => {
  const folder = included(
    `${TOYS}  reads:\n    - { group: '', kind: Pod, fields: [metadata.name], events: true }\n    - { group: apps, kind: ReplicaSet, fields: [metadata.name, status.readyReplicas] }\n`,
  )
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  const [pod] = DEMO.pods.recommendations
  await show(page, folder, eventsReading(pod!, DEMO.replicaSets.recommendations))
  // Its warnings, newest first, and nothing of its Normal one; each only its reason, message,
  // count and times.
  const fields = '[count,first,last,message,reason]'
  await expect(field(page, 'pod')).toContainText(
    `|Failed ×71: Error: ImagePullBackOff ${fields}|Failed ×9: `,
  )
  await expect(field(page, 'pod')).toContainText(`Failed ×9: Error: ErrImagePull ${fields}|`)
  await expect(field(page, 'pod')).not.toContainText('Back-off pulling image')
  // A ReplicaSet its file reads, but not its events: refused.
  await expect(field(page, 'rs')).toContainText('ended not-granted')

  // A new warning: there once they're read again, first.
  const target = clusters.demo.object('Pod', 'shop', pod!)!
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'Event',
    metadata: { name: `${pod}.new-warning`, namespace: 'shop', uid: 'new-warning-uid' },
    involvedObject: {
      kind: 'Pod',
      namespace: 'shop',
      name: pod,
      uid: target.metadata.uid,
      apiVersion: 'v1',
    },
    type: 'Warning',
    reason: 'Unhealthy',
    message: 'Liveness probe failed',
    count: 1,
    firstTimestamp: new Date().toISOString(),
    lastTimestamp: new Date().toISOString(),
  } as KubeObject)
  await expect(field(page, 'pod')).toContainText(
    `|Unhealthy ×1: Liveness probe failed ${fields}|`,
    {
      timeout: 15_000,
    },
  )
  await expect(ended(page)).toHaveCount(0)
})

test('a plugin’s page reads nodes with their live usage, read with them, where its file says it reads usage', async ({
  launch,
}) => {
  const folder = included(
    `${TOYS}  reads:\n    - { group: '', kind: Node, fields: [metadata.name], usage: true }\n`,
  )
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  await show(
    page,
    folder,
    usageReading(
      { read: 1, what: 'list', kind: '/Node', usage: true },
      { read: 2, what: 'object', kind: '/Node', name: DEMO.nodes.worker1, usage: true },
      // (Its file says it reads no pod.)
      { read: 3, what: 'list', kind: '/Pod', namespace: 'shop', usage: true },
    ),
  )
  // Each node with its own usage, as Lumovi's Nodes page shows it; one that isn't reporting has
  // none, and the read answers all the same.
  await expect(field(page, 1)).toContainText(
    `|${DEMO.nodes.controlPlane}:1.33:7.39|${DEMO.nodes.worker1}:6.49:19.15|${DEMO.nodes.worker2}:3.56:29.20|${DEMO.nodes.worker3}:-|`,
  )
  await expect(field(page, 1)).not.toContainText('none measured')
  await expect(field(page, 2)).toContainText(`|${DEMO.nodes.worker1}:6.49:19.15|`)
  await expect(field(page, 3)).toContainText('ended not-granted')
  await expect(ended(page)).toHaveCount(0)
})

test('a plugin’s page reads a list picked by its objects’ fields, as the cluster picks them, and by no field it may not', async ({
  launch,
}) => {
  const folder = included(
    `${TOYS}  reads:\n    - { group: '', kind: Pod, fields: [metadata.name, metadata.namespace, spec.nodeName] }\n`,
  )
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  const data = { what: 'list', kind: '/Pod', namespace: 'data' }
  await show(
    page,
    folder,
    reading(
      // Its pods on no node yet: the one the scheduler couldn't place, and none of the rest.
      { read: 1, ...data, fields: { 'spec.nodeName': '' } },
      // A field the cluster picks pods by, which its file doesn't grant; one it doesn't pick by.
      { read: 2, ...data, fields: { 'status.phase': 'Pending' } },
      { read: 3, ...data, fields: { 'spec.hostname': 'x' } },
    ),
  )
  await expect(field(page, 1)).toContainText('|redis-1=')
  await expect(field(page, 1)).not.toContainText('redis-0')
  await expect(field(page, 1)).not.toContainText('postgres-0')
  await expect(field(page, 2)).toContainText(`ended not-granted: ${READ_REFUSED['not-granted']}`)
  await expect(field(page, 3)).toContainText(`ended not-pickable: ${READ_REFUSED['not-pickable']}`)
  await expect(ended(page)).toHaveCount(0)
})

test('a page whose read was cut, or is failing, has Lumovi say so above it, whatever its code draws', async ({
  launch,
  clusters,
}) => {
  const folder = included(
    `${TOYS}  reads:\n    - { group: '', kind: Node, fields: [metadata.name] }\n`,
  )
  const { page } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder, LUMOVI_MAX_LIST_ITEMS: '2' },
  })
  await openCluster(page)
  await show(page, folder, reading({ read: 1, what: 'list', kind: '/Node' }))
  // The first two of the cluster's four nodes, handed as Lumovi's own lists have them: and said,
  // by Lumovi, above the page, where its code can't draw.
  await expect(field(page, 1)).toContainText(`|${DEMO.nodes.controlPlane}=`)
  expect((await tokens(page, 1)).size).toBe(2)
  await expect(page.getByTestId('plugin-cut')).toHaveText(
    'Some of what this page shows is from the first 2 of 4 of a list: the cluster has more than Lumovi reads at once.',
  )
  // Failing now: its last answer stays, and Lumovi says so above it, with a way to read it again.
  // (Lumovi's own page under the stage reads nodes too, and says so of its own.)
  const stale = page
    .getByTestId('plugin-stage')
    .getByRole('status')
    .filter({ hasText: 'Couldn’t refresh' })
  const mend = clusters.demo.fail('/api/v1/nodes', { status: 500 })
  await expect(stale).toContainText(READ_REFUSED.failed, { timeout: 15_000 })
  await expect(field(page, 1)).toContainText('failing failed')
  mend()
  await stale.getByRole('button', { name: 'Retry' }).click()
  await expect(stale).toHaveCount(0)
  await expect(field(page, 1)).toContainText(`|${DEMO.nodes.controlPlane}=`)
  await expect(page.getByTestId('plugin-cut')).toBeVisible()
  await expect(ended(page)).toHaveCount(0)
})

/**
 * A test plugin's code that lists nodes and draws three Tables of them, each naming a cut: the
 * token its read's latest answer came with; the first answer's, kept; and one it made up. (It
 * lists pods too, cut as well, and draws nothing of them.)
 */
const CUTS = `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  let first
  let made = false
  listen((text) => {
    const said = JSON.parse(text)
    if (said.read !== 1 || !said.objects) return
    if (first === undefined) first = said.cut
    const rows = said.objects.map((o) => ({ key: o.token, lead: { name: o.object.metadata.name }, cells: [] }))
    const table = (title, cut) => ({ title, columns: [], headings: false, rows, ...(cut ? { cut } : {}) })
    const tables = [['Now', said.cut], ['Before', first], ['Made up', 'made-up']]
    commit(made
      ? tables.map(([title, cut], i) => ['change', 2 + i, table(title, cut)])
      : [['make', 1, 'Stack', {}], ['put', 0, 1], ...tables.flatMap(([title, cut], i) => [['make', 2 + i, 'Table', table(title, cut)], ['put', 1, 2 + i]])])
    made = true
  })
  post(JSON.stringify({ read: 1, what: 'list', kind: '/Node' }))
  post(JSON.stringify({ read: 2, what: 'list', kind: '/Pod' }))
})`

test('a cut is said with the door’s numbers only where a part names its read’s latest token: never a stale or a made-up one', async ({
  launch,
}) => {
  const folder = included(
    `${TOYS}  reads:\n    - { group: '', kind: Node, fields: [metadata.name] }\n    - { group: '', kind: Pod, fields: [metadata.name, metadata.namespace] }\n`,
  )
  const { page } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder, LUMOVI_MAX_LIST_ITEMS: '2' },
  })
  await openCluster(page)
  await show(page, folder, CUTS)
  const line = 'These are from the first 2 of 4 Lumovi read.'
  const table = (name: string) => page.getByRole('region', { name: `${name} table` })
  await expect(table('Now')).toContainText(line)
  await expect(table('Made up')).toBeVisible()
  await expect(table('Made up')).not.toContainText('Lumovi read')
  // Read again: its latest answer's token says it; the first answer's says nothing any more.
  await expect(table('Before')).not.toContainText('Lumovi read', { timeout: 15_000 })
  await expect(table('Now')).toContainText(line)
  // And Lumovi's own line above the page, whatever the parts say: of two reads cut, of no one
  // count.
  await expect(page.getByTestId('plugin-cut')).toHaveText(
    'Some of what this page shows is from the first 2 of a list: the cluster has more than Lumovi reads at once.',
  )
})

test('a read the plugin ends is read no more; a refresh reads its own lists again, and one too soon isn’t made', async ({
  launch,
  clusters,
}) => {
  const folder = included()
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  const widgets = () =>
    clusters.demo.requests.filter(
      ({ method, path }) => method === 'GET' && path.endsWith('/widgets'),
    ).length
  // It ends read 1 once it has it, refreshes (twice: the second too soon), then asks read 2.
  await show(
    page,
    folder,
    `box.then(({ post, listen }) => {
      const commit = (steps) => post(JSON.stringify({ commit: steps }))
      commit([['make', 1, 'Stack', {}], ['put', 0, 1]])
      let next = 10
      listen((text) => {
        const said = JSON.parse(text)
        const id = next++
        commit([['make', id, 'Field', { name: 'read ' + said.read, value: said.objects ? 'objects' : 'ended' }], ['put', 1, id]])
        if (said.read === 1) {
          post(JSON.stringify({ stop: 1 }))
          post(JSON.stringify({ refresh: true }))
          post(JSON.stringify({ refresh: true }))
          post(JSON.stringify({ read: 2, what: 'object', kind: 'example.com/Widget', namespace: 'default', name: '${CUSTOM.widget}' }))
        }
      })
      post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Widget' }))
    })`,
  )
  await expect(field(page, 2)).toContainText('objects')
  // Read 1's list once, and read 2's object: the refresh found no list of its own going.
  expect(widgets()).toBe(1)
  await expect(ended(page)).toHaveCount(0)
})

/**
 * A test plugin's code that asks `asks` (then a refresh, once they're asked) and shows each
 * read's answer: its objects' names, and why none has usage where none has; or how it ended.
 */
const answering = (...asks: object[]) => `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  commit([['make', 1, 'Stack', {}], ['put', 0, 1]])
  const fields = new Map()
  let next = 100
  const show = (read, value) => {
    let id = fields.get(read)
    const props = { name: 'read ' + read, value: value.slice(0, 4000) }
    if (id === undefined) {
      fields.set(read, (id = next++))
      commit([['make', id, 'Field', props], ['put', 1, id]])
    } else commit([['change', id, props]])
  }
  listen((text) => {
    const said = JSON.parse(text)
    if (said.objects) show(said.read, '|' + said.objects.map((o) => o.object.metadata.name).sort().join('|') + '|' + (said.noUsage ? ' none measured: ' + said.noUsage : ''))
    else if (said.ended) show(said.read, 'ended ' + said.ended)
  })
  for (const ask of ${JSON.stringify(asks)}) post(JSON.stringify(ask))
  post(JSON.stringify({ refresh: true }))
})`

test('a read the cluster refuses ends in Lumovi’s words; usage it doesn’t measure, or the person may not read, is said', async ({
  launch,
  clusters,
}) => {
  const folder = included(
    `${TOYS}  reads:\n    - { group: '', kind: Node, fields: [metadata.name], usage: true }\n    - { group: '', kind: Pod, fields: [metadata.name, metadata.namespace, metadata.labels, spec.nodeName], usage: true }\n`,
  )
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  // What the cluster answers, path by path.
  const metrics = '/apis/metrics.k8s.io/v1beta1'
  clusters.demo.fail(`${metrics}/nodes`, { status: 403 })
  clusters.demo.fail(`${metrics}/namespaces/data/pods`, { status: 500 })
  clusters.demo.fail(`${metrics}/namespaces/shop/pods`, { status: 503 })
  clusters.demo.fail('/api/v1/namespaces/batch/pods', { status: 401 })
  clusters.demo.fail('/api/v1/namespaces/legacy/pods', { status: 403 })
  const pods = (namespace: string) => ({ what: 'list', kind: '/Pod', namespace, usage: true })
  await show(
    page,
    folder,
    answering(
      // The person may read the nodes and not their usage: handed all the same, said why.
      { read: 1, what: 'list', kind: '/Node', usage: true },
      // The metrics API failing outright: the read with usage fails, as Lumovi's own would.
      { read: 2, ...pods('data') },
      // No metrics there: none measured.
      { read: 3, ...pods('shop') },
      // Its own kind's usage: nothing measures a tool's kind.
      { read: 4, what: 'list', kind: 'example.com/Widget', usage: true },
      // Not signed in, and not allowed: each not allowed, in Lumovi's words.
      { read: 5, ...pods('batch') },
      { read: 6, ...pods('legacy') },
      // An object that isn't there.
      { read: 7, what: 'object', kind: '/Node', name: 'no-such-node' },
      // Picked by a label its file grants; and one object kept going while lists are refreshed.
      {
        read: 8,
        what: 'list',
        kind: '/Pod',
        namespace: 'data',
        labels: ['app.kubernetes.io/name=redis'],
      },
      { read: 9, what: 'object', kind: '/Node', name: DEMO.nodes.worker1 },
    ),
  )
  await expect(field(page, 1)).toContainText('none measured: not-allowed')
  await expect(field(page, 1)).toContainText(`|${DEMO.nodes.worker1}|`)
  await expect(field(page, 2)).toContainText('ended failed')
  await expect(field(page, 3)).toContainText('none measured: unmeasured')
  await expect(field(page, 4)).toContainText('ended not-granted')
  await expect(field(page, 5)).toContainText('ended not-allowed')
  await expect(field(page, 6)).toContainText('ended not-allowed')
  await expect(field(page, 7)).toContainText('ended not-found')
  await expect(field(page, 8)).toHaveText(/\|redis-0\|redis-1\|/)
  await expect(field(page, 9)).toContainText(`|${DEMO.nodes.worker1}|`)
  await expect(ended(page)).toHaveCount(0)
})

test('an ask that isn’t one, or more asks than a second takes, stops the plugin', async ({
  launch,
}) => {
  const folder = included()
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  await show(
    page,
    folder,
    reading({ read: 1, what: 'list', kind: 'example.com/Widget', label: 'x' }),
  )
  await expect(ended(page)).toHaveAttribute('data-why', 'not-allowed')
  await expect(ended(page)).toContainText('It sent something a plugin can’t.')

  // (A refresh too soon isn't made, and doesn't stop it: but it's one of its second's asks.)
  const many = Array.from({ length: READ_LIMITS.asksASecond + 1 }, () => ({ refresh: true }))
  await show(page, folder, reading(...many))
  await expect(ended(page)).toHaveAttribute('data-why', 'too-much')
})

test('a Secret an object of its own kind names comes down as a token of its own, never the Secret', async ({
  launch,
  clusters,
}) => {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(
    join(folder, 'toys.yaml'),
    `${TOYS}  showsSecrets:\n    - { group: example.com, kind: Widget, path: spec.secretName, keys: [tls.crt] }\n`,
  )
  const widget = clusters.demo.object('Widget.example.com', 'default', CUSTOM.widget)!
  clusters.demo.upsert({
    ...structuredClone(widget),
    metadata: { ...widget.metadata, name: 'tls-widget', uid: 'tls-widget-uid' },
    spec: { ...(widget.spec as object), secretName: 'shop-tls' },
  } as KubeObject)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  // It shows each object's name, its token, and its Secrets' tokens, every time it's handed them.
  await show(
    page,
    folder,
    `box.then(({ post, listen }) => {
      const commit = (steps) => post(JSON.stringify({ commit: steps }))
      commit([['make', 1, 'Stack', {}], ['put', 0, 1], ['make', 2, 'Field', { name: 'read 1', value: '' }], ['put', 1, 2]])
      let times = 0
      listen((text) => {
        const said = JSON.parse(text)
        if (!said.objects) return
        times++
        const value = said.objects
          .map((o) => '|' + o.object.metadata.name + '>' + (o.secrets || []).map((s) => s.path + '=' + s.tokens.join(',')).join(';'))
          .sort()
          .join('') + '|#' + times + '|'
        commit([['change', 2, { name: 'read 1', value }]])
      })
      post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Widget' }))
    })`,
  )
  const value = async () =>
    (await field(page, 1).textContent())?.match(
      /\|tls-widget>spec\.secretName=([A-Za-z0-9_-]*)\|/,
    )?.[1]
  await expect.poll(value).toMatch(/^[A-Za-z0-9_-]{24}$/)
  const token = await value()
  // A Widget that names none: the path, and no token.
  await expect(field(page, 1)).toContainText(`|${CUSTOM.widget}>spec.secretName=|`)
  // Read again: the same token. (Nothing of the Secret was read to make it, nor is.)
  // (The count ends the value; the Field's own words follow it.)
  await expect(field(page, 1)).toContainText('|#2|', { timeout: 15_000 })
  expect(await value()).toBe(token)
  expect(clusters.demo.requests.filter(({ path }) => path.endsWith('/secrets/shop-tls'))).toEqual(
    [],
  )
})

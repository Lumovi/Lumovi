/**
 * A hostile plugin against the door on the desktop, where it takes more than the door alone: a
 * change on a cluster that's read-only in Lumovi is shown nowhere and made nowhere, even by a
 * page that skips Lumovi's question; and a tool's server that sends the asker elsewhere, sets a
 * cookie or answers what would turn a line round gets none of it past Lumovi.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { DEMO } from '../mock-cluster/fixtures/demo.ts'
import { STAND_IN } from '../mock-cluster/server.ts'
import { holds } from '../holds.ts'
import { CONTEXTS, expect, openCluster, panel, test } from './fixtures.ts'

const TINKER = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: tinker }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Tinker
  kinds: [{ group: example.com, kind: Widget }]
  pages: [{ id: overview, title: Overview }]
  changes: [{ group: example.com, kind: Widget, actions: [patch] }]
`
/** Its code: a header whose one button proposes resizing the first widget; it says what came of it. */
const CODE = `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  const BUTTONS = [{ key: 'resize', name: 'Resize', changes: true }]
  let widget
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open) {
      post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Widget' }))
      commit([['make', 1, 'Header', { name: 'ready', buttons: BUTTONS, onPress: 'press' }], ['put', 0, 1]])
    }
    if (said.read === 1 && said.objects) widget = said.objects[0] && said.objects[0].token
    if (said.proposed) commit([['change', 1, { name: 'outcome ' + said.outcome, buttons: BUTTONS, onPress: 'press' }]])
    if (said.call === 'press') post(JSON.stringify({ propose: 1, press: said.press, change: { action: 'patch', target: widget, patch: { spec: { size: 9 } } } }))
  })
})
`
const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`

function included() {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'tinker.yaml'), TINKER)
  writeFileSync(join(folder, 'tinker.js'), CODE)
  return folder
}
const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)
const body = (page: Page) => page.locator('[data-plugin-body]')
const events = (page: Page, q: object = {}) =>
  page.evaluate((q) => window.lumovi!.audit.query(q), q).then((p) => p.events)

test('on a cluster read-only in Lumovi a plugin’s change is shown nowhere, and made nowhere, even asked straight', async ({
  launch,
  clusters,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  await page.evaluate((context) => window.lumovi!.app.setReadOnly(context, true), CONTEXTS.demo)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/tinker/overview`)
  await expect(body(page).getByRole('button', { name: 'Resize' })).toBeVisible({ timeout: 20_000 })
  const before = clusters.demo.requests.length
  await body(page).getByRole('button', { name: 'Resize' }).click()
  // Lumovi's question refuses it: its words, no dialog, and the page told only "refused".
  await expect(
    page.getByText('This cluster is read-only in Lumovi: Tinker’s change isn’t made here.'),
  ).toBeVisible()
  await expect(body(page)).toContainText('outcome refused')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // A page that skips the question and asks to make it straight is refused too.
  const made = await page.evaluate((asked) => window.lumovi!.kube.pluginChange(asked as never), {
    step: 'make',
    plugin: 'tinker',
    digest: sha(TINKER),
    codeDigest: sha(CODE),
    context: CONTEXTS.demo,
    action: 'patch',
    target: { kind: 'Widget.example.com', namespace: 'default', name: CUSTOM.widget },
    body: { spec: { size: 9 } },
    seen: {},
    fields: [],
  })
  expect(made).toMatchObject({ ok: false, refused: 'read-only' })
  // Nothing was written to the cluster.
  expect(
    clusters.demo.requests
      .slice(before)
      .filter((r) => r.method !== 'GET' && r.path.includes('widgets')),
  ).toEqual([])
})

/** Toys, whose tool's server answers what a hostile server would. */
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
  server:
    service: { name: toys-api }
    in: { group: example.com, kind: Widget }
    port: http
    paths: [/moved, /cookie, /bidi]
`
/** Its code: each path in turn, and what it came to drawn as a header's name. */
const ASKS = `box.then(({ post, listen }) => {
  const asks = ['/moved', '/cookie', '/bidi']
  let widget
  let done = 0
  const next = () => {
    if (done < asks.length) post(JSON.stringify({ read: 2 + done, what: 'server', in: widget, path: asks[done] }))
  }
  listen((text) => {
    const heard = JSON.parse(text)
    if (heard.open) {
      post(JSON.stringify({ commit: [['make', 1, 'Stack', {}], ['put', 0, 1]] }))
      post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Widget', namespace: 'default' }))
    }
    if (heard.read === 1 && heard.objects && widget === undefined) {
      widget = heard.objects[0].token
      next()
    } else if (heard.read >= 2) {
      // (Everything it's handed, said whole: the test sees no more came down than the JSON.)
      const came = 'json' in heard ? (heard.json && heard.json.name ? heard.json.name : 'json ' + JSON.stringify(heard)) : heard.ended + ': ' + heard.said
      post(JSON.stringify({ commit: [['make', 10 + done, 'Header', { name: came.slice(0, 120) }], ['put', 1, 10 + done]] }))
      done++
      next()
    }
  })
})
`

test('a tool’s server that redirects, sets a cookie or answers what turns a line round gets none of it past Lumovi', async ({
  launch,
  clusters,
}) => {
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: 'toys-api',
      namespace: 'default',
      creationTimestamp: new Date().toISOString(),
      labels: { [STAND_IN]: 'toys-api' },
    },
    spec: { ports: [{ name: 'http', port: 8080 }] },
  })
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), TOYS)
  writeFileSync(join(folder, 'toys.js'), ASKS)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  // A redirect isn't followed: Lumovi's sentence for its status, and nothing asked where it pointed.
  await expect(body(page)).toContainText('error: toys-api answered 302.', { timeout: 20_000 })
  // A cookie set by the server: only the JSON reaches the page, as a read's answer, and nothing else.
  await expect(body(page)).toContainText('json {"read":3,"json":{"healthy":true}}')
  // What would turn a line round is a mark of Lumovi's, drawn as the plugin's text.
  // (In a heading the mark is part of its name: the override spelled, nothing turned round.)
  await expect(body(page).getByRole('heading', { name: 'invoice U+202E txt.exe' })).toBeVisible()
  const proxied = clusters.demo.requests.filter((r) =>
    r.path.includes('/services/toys-api:http/proxy'),
  )
  expect(proxied.map((r) => `${r.method} ${r.path.replace(/^.*\/proxy/, '')}`)).toEqual([
    'GET /moved',
    'GET /cookie',
    'GET /bidi',
  ])
  // Asked with nothing of Lumovi's but its credentials for the API server: no cookie of anyone's.
  for (const r of proxied) {
    expect(r.headers.cookie).toBeUndefined()
    expect(r.headers.accept).toBe('application/json')
  }
})

/** Toys again, whose server's `in` is a kind of its own that's in no namespace. */
const CLUSTER_WIDE = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }, { group: example.com, kind: Gizmo }]
  pages: [{ id: overview, title: Overview }]
  server:
    service: { name: toys-api }
    in: { group: example.com, kind: Gizmo }
    port: http
    paths: [/api/v1/status]
`
/** Its code: the Gizmos, and its server asked about the first. */
const ABOUT_A_GIZMO = `box.then(({ post, listen }) => {
  listen((text) => {
    const heard = JSON.parse(text)
    if (heard.open) post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Gizmo' }))
    if (heard.read === 1 && heard.objects && heard.objects[0]) {
      post(JSON.stringify({ read: 2, what: 'server', in: heard.objects[0].token, path: '/api/v1/status' }))
    }
    if (heard.read === 2) {
      const came = 'json' in heard ? 'json' : heard.ended + ': ' + heard.said
      post(JSON.stringify({ commit: [['make', 1, 'Header', { name: came }], ['put', 0, 1]] }))
    }
  })
})
`

test('a server asked about an object of a kind that’s in no namespace is refused, and nothing is asked of the cluster', async ({
  launch,
  clusters,
}) => {
  const now = new Date().toISOString()
  clusters.demo.upsert({
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: { name: 'gizmos.example.com', creationTimestamp: now },
    spec: {
      group: 'example.com',
      scope: 'Cluster',
      names: { kind: 'Gizmo', plural: 'gizmos', singular: 'gizmo', listKind: 'GizmoList' },
      versions: [
        {
          name: 'v1',
          served: true,
          storage: true,
          schema: {
            openAPIV3Schema: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
          },
        },
      ],
    },
    status: { conditions: [{ type: 'Established', status: 'True' }] },
  })
  clusters.demo.upsert({
    apiVersion: 'example.com/v1',
    kind: 'Gizmo',
    metadata: { name: 'big-gizmo', creationTimestamp: now },
  })
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), CLUSTER_WIDE)
  writeFileSync(join(folder, 'toys.js'), ABOUT_A_GIZMO)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  // (Lumovi's own file check can't know a kind's scope without its CRD: Lumovi-plugins' check
  // does. At run time it fails closed.)
  await expect(body(page)).toContainText(
    'not-granted: This plugin’s file doesn’t ask to read this.',
    {
      timeout: 20_000,
    },
  )
  // Nothing asked of any Service: every ask through the API server's proxy is Lumovi's own, of
  // the cluster's usage.
  const usage = '/api/v1/namespaces/monitoring/services/prometheus:web/proxy/api/v1/'
  expect(
    clusters.demo.requests.filter((r) => r.path.includes('/proxy') && !r.path.startsWith(usage)),
  ).toEqual([])
})

/** Toys again, whose server says how it is. */
const ASKING = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
  pages: [{ id: overview, title: Overview }]
  server:
    service: { name: toys-api }
    in: { group: example.com, kind: Widget }
    port: http
    paths: [/api/v1/status]
`
/** Its code: two asks of its server once it holds a widget (as many as a page may), and what came. */
const TWICE = `box.then(({ post, listen }) => {
  let asked = false
  let answered = 0
  const say = (name) => post(JSON.stringify({ commit: [['change', 1, { name }]] }))
  listen((text) => {
    const heard = JSON.parse(text)
    if (heard.open) {
      post(JSON.stringify({ commit: [['make', 1, 'Header', { name: 'reading' }], ['put', 0, 1]] }))
      post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Widget', namespace: 'default' }))
    }
    if (heard.read === 1 && heard.objects && heard.objects[0] && !asked) {
      asked = true
      for (const read of [2, 3]) {
        post(JSON.stringify({ read, what: 'server', in: heard.objects[0].token, path: '/api/v1/status' }))
      }
      say('asked 2')
    }
    if (heard.read === 2 || heard.read === 3) {
      if ('json' in heard) answered++
      say('json' in heard ? 'answered ' + answered : heard.ended + ': ' + heard.said)
    }
  })
})
`

test('a plugin’s pages ask its server four at a time between them: the rest wait their turn, and none is lost', async ({
  launch,
  clusters,
}) => {
  test.setTimeout(90_000)
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: 'toys-api',
      namespace: 'default',
      creationTimestamp: new Date().toISOString(),
      labels: { [STAND_IN]: 'toys-api' },
    },
    spec: { ports: [{ name: 'http', port: 8080 }] },
  })
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), ASKING)
  writeFileSync(join(folder, 'toys.js'), TWICE)
  const { page } = await launch({
    env: {
      LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder,
      // (Lumovi waits for its server for as long as this test holds an answer back: nothing here
      // ends by the clock, however slow the machine.)
      LUMOVI_TEST_PLUGIN_SERVER_WAIT_MS: '60000',
    },
  })
  await openCluster(page)
  const toys = `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`
  const asked = () =>
    clusters.demo.requests.filter((r) => r.path.includes('/services/toys-api:http/proxy/'))
  // Its server holds every ask, unanswered, until the test lets them go.
  let letGo!: () => void
  const held = new Promise<void>((done) => (letGo = done))
  const holding = clusters.demo.fail(/\/services\/toys-api:http\/proxy\//, { until: held })
  // The page twice, each left while its two asks are still with the server: still asked, so
  // still counted.
  for (const reached of [2, 4]) {
    await go(page, toys)
    await expect.poll(() => asked().length, { timeout: 20_000 }).toBe(reached)
    await go(page, `#/cluster/${CONTEXTS.demo}/pods`)
    await expect(body(page)).toHaveCount(0)
  }
  // A third time: its two wait their turn, and nothing more reaches the server meanwhile.
  await go(page, toys)
  await expect(body(page).getByRole('heading', { name: 'asked 2' })).toBeVisible({
    timeout: 20_000,
  })
  await holds(() => asked().length === 4, 1000, 'no fifth ask reaches the server')
  // (And the four were with the server all that while: none answered, none given up on.)
  expect(asked().map((r) => r.ms)).toEqual([undefined, undefined, undefined, undefined])
  // Its server answers again: the four it held, and whatever is asked from here on.
  holding()
  letGo()
  // The first ones answered, the third page's two are asked, and answered.
  await expect(body(page).getByRole('heading', { name: 'answered 2' })).toBeVisible({
    timeout: 30_000,
  })
  await expect
    .poll(() => asked().map((r) => r.ms !== undefined))
    .toEqual([true, true, true, true, true, true])
  // Never more than four with the server at once.
  const spans = asked().map((r) => [r.at!, r.at! + r.ms!] as const)
  const most = Math.max(
    ...spans.map(([start]) => spans.filter(([from, to]) => from <= start && start < to).length),
  )
  expect(most).toBe(4)
})

const POD = DEMO.pods.storefront[0]!
/** A line a container writes while a plugin's page shows its logs. */
const MARK = 'only-lumovi-reads-this-line'

/** Toys, whose pages show logs: Lumovi reads and draws them, and its code never sees them. */
const SHOWS = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
  reads: [{ group: '', kind: Pod, fields: [metadata.name] }]
  pages: [{ id: overview, title: Overview }]
  logs: shown
`
/** Its code: the envoy's logs in a Logs part, and every word it hears counted, a line of them looked for. */
const LISTENS = `box.then(({ post, listen }) => {
  let heard = 0
  let saw = false
  let drawn = false
  listen((text) => {
    heard++
    if (text.includes(${JSON.stringify(MARK)})) saw = true
    const said = JSON.parse(text)
    if (said.open) post(JSON.stringify({ read: 1, what: 'list', kind: '/Pod', namespace: 'shop' }))
    if (said.read === 1 && said.objects && !drawn) {
      drawn = true
      const pod = said.objects.find((o) => o.object.metadata.name === ${JSON.stringify(POD)})
      post(JSON.stringify({ commit: [
        ['make', 1, 'Stack', {}], ['put', 0, 1],
        ['make', 2, 'Header', { name: 'heard', buttons: [{ key: 'ask', name: 'What did you hear?' }], onPress: 'press' }], ['put', 1, 2],
        ['make', 3, 'Logs', { title: 'Its proxy', pod: pod.token, container: 'envoy' }], ['put', 1, 3],
      ] }))
    }
    if (said.call === 'press') {
      post(JSON.stringify({ commit: [['change', 2, { name: 'heard ' + heard + (saw ? ', a line of its logs' : ', none of its logs'), buttons: [{ key: 'ask', name: 'What did you hear?' }], onPress: 'press' }]] }))
    }
  })
})
`

test('logs shown on a plugin’s page never reach its code, and stop being read when the page goes', async ({
  launch,
  clusters,
}) => {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), SHOWS)
  writeFileSync(join(folder, 'toys.js'), LISTENS)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  const log = body(page).getByRole('log', { name: 'Logs for envoy' })
  await expect(log).toBeVisible({ timeout: 20_000 })
  clusters.demo.appendLogs('shop', POD, 'envoy', [MARK])
  await expect(log).toContainText(MARK)
  // Its code heard Lumovi, and never a line of what Lumovi showed.
  await body(page).getByRole('button', { name: 'What did you hear?' }).click()
  await expect(body(page).getByRole('heading', { level: 2 })).toContainText(', none of its logs')
  expect(clusters.demo.logFollowers()).toBeGreaterThan(0)
  // The page goes: what Lumovi followed for it is followed no more.
  await go(page, `#/cluster/${CONTEXTS.demo}/pods`)
  await expect.poll(() => clusters.demo.logFollowers()).toBe(0)
})

/** Toys, whose page links to a pod's Shell tab and its Port forward dialog. */
const LINKS = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
  reads: [{ group: '', kind: Pod, fields: [metadata.name] }]
  pages: [{ id: overview, title: Overview }]
  links: [shell, port-forward]
`
const LINKING = `box.then(({ post, listen }) => {
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open) post(JSON.stringify({ read: 1, what: 'list', kind: '/Pod', namespace: 'shop' }))
    if (said.read !== 1 || !said.objects) return
    const pod = said.objects.find((o) => o.object.metadata.name === ${JSON.stringify(POD)})
    if (!pod) return
    post(JSON.stringify({ commit: [
      ['make', 1, 'Header', { name: 'Storefront', buttons: [
        { key: 'app', name: 'Shell into app', goes: { object: pod.token, at: 'shell', container: 'app' } },
        { key: 'forward', name: 'Forward 8080', goes: { object: pod.token, at: 'port-forward', port: 8080 } },
      ] }],
      ['put', 0, 1],
    ] }))
  })
})
`

async function linked(launch: Parameters<Parameters<typeof test>[2]>[0]['launch']) {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), LINKS)
  writeFileSync(join(folder, 'toys.js'), LINKING)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  await expect(body(page).getByRole('button', { name: 'Shell into app' })).toBeVisible({
    timeout: 20_000,
  })
  return page
}

test('a link to a shell arrives where the person may not open one: Lumovi’s refusal, never a Start', async ({
  launch,
  clusters,
}) => {
  // Their account may not exec in shop.
  clusters.demo.deny({ verb: 'create', resource: 'pods', subresource: 'exec', namespace: 'shop' })
  const page = await linked(launch)
  await body(page).getByRole('button', { name: 'Shell into app' }).click()
  const detail = panel(page, 'Pod', POD)
  await expect(detail).toContainText('Your account can’t open shells in shop.')
  await expect(page.locator('[data-shell-start]')).toHaveCount(0)
  expect(clusters.demo.requests.filter((r) => r.path.endsWith(`/pods/${POD}/exec`))).toEqual([])
})

test('a link to a shell on a cluster read-only in Lumovi: Lumovi’s own words, never a Start', async ({
  launch,
  clusters,
}) => {
  const page = await linked(launch)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: `Make ${CONTEXTS.demo} read-only` }).click()
  await body(page).getByRole('button', { name: 'Shell into app' }).click()
  await expect(panel(page, 'Pod', POD)).toContainText(
    `${CONTEXTS.demo} is read-only in Lumovi, and a shell can change a container.`,
  )
  await expect(page.locator('[data-shell-start]')).toHaveCount(0)
  expect(clusters.demo.requests.filter((r) => r.path.endsWith(`/pods/${POD}/exec`))).toEqual([])
})

test('a forward a link opened, started by the person, is in the history as the plugin’s page’s', async ({
  launch,
}) => {
  const page = await linked(launch)
  await body(page).getByRole('button', { name: 'Forward 8080' }).click()
  const dialog = page.getByRole('dialog', { name: `Forward a port to ${POD}` })
  await dialog.getByRole('button', { name: 'Start forwarding' }).click()
  await expect
    .poll(async () => (await events(page, { actions: ['port-forward.open'] }))[0])
    .toMatchObject({ outcome: 'success', details: { plugin: 'toys' } })
})

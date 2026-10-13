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
import { CONTEXTS, expect, openCluster, test } from './fixtures.ts'

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

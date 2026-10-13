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
import { CONTEXTS, expect, openCluster, panel, row, test } from './fixtures.ts'

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

/**
 * Its code: buttons that only read, whose presses it tries to propose a change with; and one that
 * says it changes something, whose press it keeps. What became of each proposal is the header's
 * name.
 */
const PRESSES = `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  let widget
  let kept
  let n = 0
  const buttons = (looking) => [
    { key: 'look', name: 'Look', ...(looking ? { changes: true } : {}) },
    { key: 'forge', name: 'Forge' },
    { key: 'again', name: 'Again' },
    { key: 'resize', name: 'Resize', changes: true },
  ]
  const say = (name, looking) => commit([['change', 1, { name, buttons: buttons(looking), onPress: 'press' }]])
  const propose = (press) => post(JSON.stringify({ propose: ++n, press, change: { action: 'patch', target: widget, patch: { spec: { size: 9 } } } }))
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open) {
      post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Widget' }))
      commit([['make', 1, 'Header', { name: 'ready', buttons: buttons(false), onPress: 'press' }], ['put', 0, 1]])
    }
    if (said.read === 1 && said.objects) widget = said.objects[0] && said.objects[0].token
    if (said.proposed) say('outcome ' + said.proposed + ' ' + said.outcome, false)
    if (said.call === 'press') {
      const { button } = said.carries
      // Said to change something only once it's pressed: the press was of a button that reads.
      if (button === 'look') {
        say('looking', true)
        propose(said.press)
      }
      // A token of its own making.
      if (button === 'forge') propose('made-up-token')
      // A real one, kept...
      if (button === 'resize') {
        kept = said.press
        propose(said.press)
      }
      // ...and spent again, from a button that only reads.
      if (button === 'again') propose(kept)
    }
  })
})
`

test('a press of a button that only reads proposes nothing, whatever its code does with it: redeclared, forged, or a spent one again', async ({
  launch,
  clusters,
}) => {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'tinker.yaml'), TINKER)
  writeFileSync(join(folder, 'tinker.js'), PRESSES)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/tinker/overview`)
  /** Presses one of the header's buttons: in its place, or in its More menu. */
  const press = async (name: string) => {
    const button = body(page).getByRole('button', { name, exact: true })
    if (await button.isVisible()) return button.click()
    await body(page)
      .getByRole('button', { name: /^More for / })
      .click()
    await page.getByRole('menuitem', { name, exact: true }).click()
  }
  const said = body(page).locator('h2').first()
  await expect(said).toContainText('ready', { timeout: 20_000 })
  const before = clusters.demo.requests.length
  // A button that only reads, said to change something as soon as it's pressed.
  await press('Look')
  await expect(said).toContainText('outcome 1 refused')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // A token the code made up.
  await press('Forge')
  await expect(said).toContainText('outcome 2 refused')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // A button that says it changes something proposes, in Lumovi's dialog; the person says no.
  await press('Resize')
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Escape')
  await expect(said).toContainText('outcome 3 cancelled')
  // Its press, spent, used again from a button that only reads.
  await press('Again')
  await expect(said).toContainText('outcome 4 refused')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // Asked of the cluster: the one trial behind Lumovi's dialog, which changes nothing; the
  // three refused asked nothing, and nothing was written.
  expect(
    clusters.demo.requests
      .slice(before)
      .filter((r) => r.method !== 'GET' && r.path.includes('widgets'))
      .map((r) => `${r.method} ${r.path}?${r.search}`),
  ).toEqual([`PATCH /apis/example.com/v1/namespaces/default/widgets/${CUSTOM.widget}?dryRun=All`])
})

/**
 * Its code: what reads like an address, or a class, wherever a page's parts take a plugin's words
 * (but a Graph's and a Split's, which hold the same names and notes).
 */
const ADDRESSES = `box.then(({ post, listen }) => {
  listen((text) => {
    if (!JSON.parse(text).open) return
    post(JSON.stringify({ commit: [
      ['make', 1, 'Stack', {}],
      ['make', 2, 'Header', {
        name: 'https://evil.example/header x-plugin-class',
        status: { level: 'warning', word: 'https://evil.example/word', detail: 'www.evil.example/detail' },
        buttons: [
          { key: 'b1', name: 'https://evil.example/button', note: 'www.evil.example/button-note' },
          { key: 'b2', name: 'x-plugin-class button', off: 'https://evil.example/off' },
        ],
      }],
      ['make', 3, 'Card', { title: 'bg-[#ff00aa] x-plugin-class', note: 'www.evil.example/note', about: 'https://evil.example/about x-plugin-class' }],
      ['make', 4, 'Tiles', { tiles: [
        { key: 't', label: 'javascript:alert(1)', value: { kind: 'words', text: 'https://evil.example/tile' }, detail: 'mailto:someone@evil.example' },
        { key: 'u', label: 'Second', value: { kind: 'figure', text: 'www.evil.example/figure' } },
      ] }],
      ['make', 5, 'Counts', { groups: [{ title: 'x-plugin-class counts', rows: [{ value: 'https://evil.example/count', count: 1 }] }] }],
      ['make', 6, 'Table', {
        title: 'https://evil.example/table',
        headings: true,
        leadHeading: 'www.evil.example/lead',
        columns: [{ name: 'https://evil.example/column', kind: 'text' }, { name: 'x-plugin-class column', kind: 'status' }],
        rows: [{
          key: 'r',
          lead: { name: 'https://evil.example/row', beside: 'www.evil.example/beside', under: 'https://evil.example/under' },
          cells: [
            { kind: 'text', text: 'https://evil.example/cell', full: 'https://evil.example/full' },
            { kind: 'status', level: 'healthy', word: 'https://evil.example/status' },
          ],
          note: 'https://evil.example/row-note',
        }],
      }],
      ['make', 7, 'Card', { title: 'Markup', note: '<a href="https://evil.example/a" class="x-plugin-class">www.evil.example/text</a>' }],
      ['make', 8, 'Table', {
        title: 'Failed',
        headings: false,
        columns: [{ name: 'One', kind: 'text' }],
        rows: [],
        state: { is: 'failed', title: 'https://evil.example/failed', said: 'style="background:url(https://evil.example/said)"' },
      }],
      ['put', 3, 5],
      ['put', 7, 8],
      ['put', 1, 2], ['put', 1, 3], ['put', 1, 4], ['put', 1, 6], ['put', 1, 7],
      ['put', 0, 1],
    ] }))
  })
})
`

test('a plugin’s words are drawn as text wherever its parts take them: no link, class, style or attribute is made of them', async ({
  launch,
}) => {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'tinker.yaml'), TINKER)
  writeFileSync(join(folder, 'tinker.js'), ADDRESSES)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/tinker/overview`)
  // All of it drawn, as its words. (A button's "off" is its tooltip, and a cell's "full" its
  // own: what's in an attribute's value is swept below with the rest.)
  for (const words of [
    'https://evil.example/header x-plugin-class',
    'https://evil.example/word',
    'www.evil.example/detail',
    'https://evil.example/button',
    'www.evil.example/button-note',
    'x-plugin-class button',
    'bg-[#ff00aa] x-plugin-class',
    'www.evil.example/note',
    'https://evil.example/about x-plugin-class',
    'javascript:alert(1)',
    'https://evil.example/tile',
    'mailto:someone@evil.example',
    'www.evil.example/figure',
    'x-plugin-class counts',
    'https://evil.example/count',
    'https://evil.example/table',
    'www.evil.example/lead',
    'https://evil.example/column',
    'x-plugin-class column',
    'https://evil.example/row',
    'www.evil.example/beside',
    'https://evil.example/under',
    'https://evil.example/cell',
    'https://evil.example/status',
    'https://evil.example/row-note',
    '<a href="https://evil.example/a" class="x-plugin-class">www.evil.example/text</a>',
    'https://evil.example/failed',
    'style="background:url(https://evil.example/said)"',
  ]) {
    await expect(body(page), words).toContainText(words, { timeout: 20_000 })
  }
  // Nothing on the page is a link to any of it, nor anything else made of its words: no class,
  // no style, and no attribute's name.
  const made = await page.evaluate(() => {
    const found: string[] = []
    for (const element of document.querySelectorAll('*')) {
      for (const { name, value } of element.attributes) {
        if (/plugin-class|evil/.test(name)) found.push(`an attribute ${name}`)
        if (name === 'class' && /x-plugin-class|#ff00aa/.test(value)) found.push(`class ${value}`)
        if (name === 'style' && /evil|#ff00aa|url\(/.test(value)) found.push(`style ${value}`)
        if (['href', 'src', 'action', 'formaction', 'xlink:href'].includes(name)) {
          if (/evil\.example|^mailto:|^javascript:/.test(value)) found.push(`${name} ${value}`)
        }
      }
    }
    return found
  })
  expect(made).toEqual([])
  // The one link on it is Lumovi's own, in its strip.
  await expect(body(page).getByRole('link')).toHaveText(['What it may do →'])
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

/** Its code: the same part, a button that takes it off its page, and one that sends what no plugin may. */
const TAKES = `box.then(({ post, listen }) => {
  let drawn = false
  const buttons = [{ key: 'take', name: 'Take it off' }, { key: 'break', name: 'Break' }]
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open) post(JSON.stringify({ read: 1, what: 'list', kind: '/Pod', namespace: 'shop' }))
    if (said.read === 1 && said.objects && !drawn) {
      drawn = true
      const pod = said.objects.find((o) => o.object.metadata.name === ${JSON.stringify(POD)})
      post(JSON.stringify({ commit: [
        ['make', 1, 'Stack', {}], ['put', 0, 1],
        ['make', 2, 'Header', { name: 'Its proxy', buttons, onPress: 'press' }], ['put', 1, 2],
        ['make', 3, 'Logs', { title: 'Its proxy', pod: pod.token, container: 'envoy' }], ['put', 1, 3],
      ] }))
    }
    if (said.call === 'press' && said.carries.button === 'take') post(JSON.stringify({ commit: [['take', 1, 3]] }))
    if (said.call === 'press' && said.carries.button === 'break') post(JSON.stringify({ commit: [['make', 9, 'Canvas', {}]] }))
  })
})
`

test('a follow never outlives its part: taken off the page by its code, or with a page Lumovi stops, it’s followed no more', async ({
  launch,
  clusters,
}) => {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), SHOWS)
  writeFileSync(join(folder, 'toys.js'), TAKES)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  const toys = `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`
  const log = body(page).getByRole('log', { name: 'Logs for envoy' })
  await go(page, toys)
  await expect(log).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => clusters.demo.logFollowers()).toBeGreaterThan(0)
  // Its code takes the part off its page: nothing is followed for it any more.
  await body(page).getByRole('button', { name: 'Take it off' }).click()
  await expect(log).toHaveCount(0)
  await expect.poll(() => clusters.demo.logFollowers()).toBe(0)
  // The page opened again, the part with it; then its code sends what no plugin may, and
  // Lumovi stops the page: what was followed for it ends with it.
  await go(page, `#/cluster/${CONTEXTS.demo}/pods`)
  await go(page, toys)
  await expect(log).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => clusters.demo.logFollowers()).toBeGreaterThan(0)
  await body(page).getByRole('button', { name: 'Break' }).click()
  await expect(page.getByTestId('plugin-ended')).toBeVisible()
  await expect(log).toHaveCount(0)
  await expect.poll(() => clusters.demo.logFollowers()).toBe(0)
})

/** A pod Lumovi's own list of pods draws without scrolling. */
const AGED = DEMO.pods.checkout[0]!

/** Toys, which reads pods' names and when they were made. */
const AGES = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
  reads: [{ group: '', kind: Pod, fields: [metadata.name, metadata.creationTimestamp] }]
  pages: [{ id: overview, title: Overview }]
`
/**
 * Its code, with a clock of its own thirty days fast: the pod's age as a cell (a time, which
 * Lumovi draws), and how old its own clock makes it, in words.
 */
const SKEWED = `const real = Date.now.bind(Date)
Date.now = () => real() + 30 * 24 * 60 * 60 * 1000
box.then(({ post, listen }) => {
  let drawn = false
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open) post(JSON.stringify({ read: 1, what: 'list', kind: '/Pod', namespace: 'shop' }))
    if (said.read !== 1 || !said.objects || drawn) return
    drawn = true
    const pod = said.objects.find((o) => o.object.metadata.name === ${JSON.stringify(AGED)})
    const made = pod.object.metadata.creationTimestamp
    const mine = Math.floor((Date.now() - Date.parse(made)) / (24 * 60 * 60 * 1000))
    post(JSON.stringify({ commit: [
      ['make', 1, 'Stack', {}], ['put', 0, 1],
      ['make', 2, 'Header', { name: 'by its own clock ' + mine + 'd' }], ['put', 1, 2],
      ['make', 3, 'Card', { title: 'Pods' }], ['put', 1, 3],
      ['make', 4, 'Table', { title: 'Pods', headings: true, columns: [{ name: 'Age', kind: 'age' }], rows: [
        { key: 'p', lead: { name: ${JSON.stringify(AGED)} }, cells: [{ kind: 'age', time: made }] },
      ] }], ['put', 3, 4],
    ] }))
  })
})
`

test('an age on a plugin’s page is Lumovi’s own, whatever the plugin’s clock says: the same as Lumovi’s list shows', async ({
  launch,
}) => {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), AGES)
  writeFileSync(join(folder, 'toys.js'), SKEWED)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  /** Its age on the plugin's page, and in Lumovi's own list of pods, one look after the other. */
  const ages = async () => {
    await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
    const theirs = body(page).getByRole('row').filter({ hasText: AGED })
    await expect(theirs).toBeVisible({ timeout: 20_000 })
    const drawn = (await theirs.getByRole('gridcell').last().innerText()).trim()
    await go(page, `#/cluster/${CONTEXTS.demo}/pods`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
    const grid = page.getByRole('grid', { name: 'Pods' })
    const column = (await grid.getByRole('columnheader').allInnerTexts()).findIndex(
      (name) => name.trim().toLowerCase() === 'age',
    )
    expect(column).toBeGreaterThanOrEqual(0)
    const own = (await row(page, 'Pods', AGED).getByRole('gridcell').nth(column).innerText()).trim()
    return { drawn, own }
  }
  let { drawn, own } = await ages()
  // (A minute may turn between the two looks; never twice running.)
  if (drawn !== own) ({ drawn, own } = await ages())
  expect(drawn).toMatch(/^\d+[smhd]/)
  expect(drawn).toBe(own)
  // And its own clock is a month off: what it makes of the pod's age is nothing Lumovi drew.
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  const itsOwn = body(page).getByRole('heading', { level: 2 }).first()
  await expect(itsOwn).toContainText(/by its own clock 3\dd/)
  expect(drawn).not.toMatch(/^3\dd/)
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

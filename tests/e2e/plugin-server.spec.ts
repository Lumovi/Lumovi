/**
 * A plugin's tool's own server (`spec.server`), proved on a stand-in: the tests' Toys' server
 * behind a Service in the cluster. Its code asks Lumovi for a path its file lists, in the
 * namespace of a Widget its page read; Lumovi asks through the API server, as the person, and
 * hands back JSON, or its own sentence for why not. The Plugins page says so first, in red.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { STAND_IN } from '../mock-cluster/server.ts'
import { CONTEXTS, expect, openCluster, test } from './fixtures.ts'

/** Its own server's Service, in the Widget's namespace. */
const TOYS_API = {
  apiVersion: 'v1',
  kind: 'Service',
  metadata: {
    name: 'toys-api',
    namespace: 'default',
    creationTimestamp: new Date().toISOString(),
    labels: { 'app.kubernetes.io/name': 'toys-api', [STAND_IN]: 'toys-api' },
  },
  spec: { ports: [{ name: 'http', port: 8080 }] },
}

const toys = (paths: string[]) => `apiVersion: lumovi.dev/v1beta1
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
    paths: [${paths.map((path) => JSON.stringify(path)).join(', ')}]
`

/**
 * Its code: it reads the default namespace's Widgets, then asks its server for each of `asks`
 * in turn (a path, filled with the Widget's name where it says `{widget}`), and draws what each
 * came to, one Header a path.
 */
const code = (asks: string[]) => `box.then(({ post, listen }) => {
  const asks = ${JSON.stringify(asks)}
  let widget
  let done = 0
  const next = () => {
    const path = asks[done]
    if (path === undefined) return
    post(JSON.stringify({ read: 2 + done, what: 'server', in: widget, path,
      ...(path.includes('{widget}') ? { with: { widget } } : {}) }))
  }
  listen((text) => {
    const heard = JSON.parse(text)
    if (heard.open) {
      post(JSON.stringify({ commit: [['make', 1, 'Stack', {}], ['put', 0, 1]] }))
      post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Widget', namespace: 'default' }))
    }
    if (heard.read === 1 && heard.objects && widget === undefined) {
      widget = heard.objects.find((o) => o.object.metadata.name === ${JSON.stringify(CUSTOM.widget)}).token
      next()
    } else if (heard.read >= 2) {
      const came = 'json' in heard ? 'json ' + JSON.stringify(heard.json) : heard.ended + ': ' + heard.said
      post(JSON.stringify({ commit: [['make', 10 + done, 'Header', { name: came.slice(0, 120) }], ['put', 1, 10 + done]] }))
      done++
      next()
    }
  })
})
`

function included(paths: string[], asks = paths) {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), toys(paths))
  writeFileSync(join(folder, 'toys.js'), code(asks))
  return folder
}

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)
const body = (page: Page) => page.locator('[data-plugin-body]')
const events = (page: Page, q: object = {}) =>
  page.evaluate((q) => window.lumovi!.audit.query(q), q).then((p) => p.events)

test('a plugin’s code asks its tool’s server for a path its file lists, through Lumovi, and gets JSON back', async ({
  launch,
  clusters,
}) => {
  clusters.demo.upsert(TOYS_API)
  // (A fixed query is asked as listed.)
  const paths = ['/api/v1/status?verbose=1', '/api/v1/widgets/{widget}/history']
  const { page } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(paths, [...paths, '/api/v1/secrets']) },
  })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  // Its code drew what came back: JSON, the second for its Widget by name; a path its file
  // doesn't list isn't asked.
  await expect(body(page)).toContainText('json {"healthy":true,"widgets":1}', { timeout: 20_000 })
  await expect(body(page)).toContainText(`json {"widget":"${CUSTOM.widget}","sizes":[1,2,3]}`)
  await expect(body(page)).toContainText('not-listed: This plugin’s file doesn’t list that path.')
  // Asked through the API server's service proxy, as the person.
  const proxied = clusters.demo.requests
    .filter((r) => r.path.includes('/services/toys-api:http/proxy'))
    .map((r) => r.path)
  expect(proxied).toEqual([
    '/api/v1/namespaces/default/services/toys-api:http/proxy/api/v1/status',
    `/api/v1/namespaces/default/services/toys-api:http/proxy/api/v1/widgets/${CUSTOM.widget}/history`,
  ])
  const sent = clusters.demo.requests.find((r) => r.path.endsWith('/proxy/api/v1/status'))!
  expect(sent.search).toBe('verbose=1')
  expect(sent.headers.accept).toBe('application/json')
  expect(sent.headers.cookie).toBeUndefined()
  // The history names the plugin, and the path as its file lists it. One its file doesn't list
  // is the page's own text: the entry says that it isn't listed, and not what it was.
  await expect
    .poll(async () =>
      (await events(page, { actions: ['plugin.server'] }))
        .map((e) => [e.outcome, e.summary])
        .sort(),
    )
    .toEqual(
      [
        [
          'success',
          'Asked the Service toys-api in default for /api/v1/status?verbose=1, for the plugin Toys’ page',
        ],
        [
          'success',
          'Asked the Service toys-api in default for /api/v1/widgets/{widget}/history, for the plugin Toys’ page',
        ],
        [
          'refused',
          'Asked the Service toys-api in default for a path its file doesn’t list, for the plugin Toys’ page',
        ],
      ].sort(),
    )
})

test('what isn’t JSON, is too much, is an error or comes too late is Lumovi’s sentence, never the server’s', async ({
  launch,
  clusters,
}) => {
  test.slow()
  clusters.demo.upsert(TOYS_API)
  clusters.demo.fail('/api/v1/namespaces/default/services/toys-api:http/proxy/slow', {
    delayMs: 7000,
  })
  const paths = ['/page', '/everything', '/missing', '/slow']
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(paths) } })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  for (const said of [
    'not-json: toys-api answered with something other than JSON.',
    'too-big: toys-api answered with more than 1 MiB.',
    'error: toys-api answered 404.',
  ]) {
    await expect(body(page)).toContainText(said, { timeout: 20_000 })
  }
  await expect(body(page)).toContainText('timeout: toys-api didn’t answer in 5 seconds.', {
    timeout: 15_000,
  })
  await expect(body(page)).not.toContainText('no such path')
})

test('where there’s no such Service, Lumovi says so, and asks nothing of it', async ({
  launch,
  clusters,
}) => {
  const { page } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(['/api/v1/status']) },
  })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  await expect(body(page)).toContainText('no-service: There’s no Service toys-api in default.', {
    timeout: 20_000,
  })
  expect(
    clusters.demo.requests.filter((r) => r.path.includes('/services/toys-api:http/proxy')),
  ).toEqual([])
})

test('the Plugins page says first, in red, which server its code asks, and every path', async ({
  launch,
}) => {
  const twenty = Array.from({ length: 20 }, (_, i) => `/api/v1/widgets/{widget}/part${i + 1}`)
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(twenty) } })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins?plugin=toys`)
  const may = page.getByRole('region', { name: 'May read' })
  const line = may.locator('[data-red-line="server"]')
  await expect(line.locator('p').first()).toHaveText(
    'Asks the server toys-api in this cluster, through Lumovi, and its code reads what it answers:',
  )
  await expect(line.locator('p').first()).toHaveClass(/text-critical-text/)
  await expect(line.locator('p').nth(1)).toHaveText(
    'The Service toys-api, port http, in the namespace of the Widget its page shows.',
  )
  // Six paths, as listed; the rest in place, on a press.
  await expect(line.getByRole('listitem')).toHaveCount(6)
  await expect(line.getByRole('listitem').first()).toHaveText('/api/v1/widgets/{widget}/part1')
  await line.getByRole('button', { name: '14 more paths' }).click()
  await expect(line.getByRole('listitem')).toHaveCount(20)
  await expect(line.getByRole('listitem').last()).toHaveText('/api/v1/widgets/{widget}/part20')
})

test('a Service found by its labels is said by them, each whole', async ({ launch }) => {
  const folder = included(['/api/v1/status'])
  writeFileSync(
    join(folder, 'toys.yaml'),
    toys(['/api/v1/status']).replace(
      'service: { name: toys-api }',
      'service: { labels: { app.kubernetes.io/name: toys-api, tier: api } }',
    ),
  )
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins?plugin=toys`)
  const line = page.getByRole('region', { name: 'May read' }).locator('[data-red-line="server"]')
  await expect(line.locator('p').first()).toHaveText(
    'Asks a server in this cluster, through Lumovi, and its code reads what it answers:',
  )
  await expect(line.locator('p').nth(1)).toHaveText(
    'The one Service with the labels app.kubernetes.io/name=toys-api, tier=api, port http, in the namespace of the Widget its page shows.',
  )
  await expect(line.locator('p').nth(1).locator('.font-mono')).toHaveText([
    'app.kubernetes.io/name=toys-api',
    'tier=api',
  ])
})

test('where the organization’s policy lets no plugin talk to servers, its code asks none, and the Plugins page says why', async ({
  launch,
  clusters,
}) => {
  clusters.demo.upsert(TOYS_API)
  const policy = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(policy, JSON.stringify({ pluginServers: 'off' }))
  const { page } = await launch({
    env: {
      LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(['/api/v1/status']),
      LUMOVI_POLICY: policy,
    },
  })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  await expect(body(page)).toContainText(
    'servers-off: Your organization’s policy doesn’t let plugins talk to servers in the cluster.',
    { timeout: 20_000 },
  )
  expect(
    clusters.demo.requests.filter((r) => r.path.includes('/services/toys-api:http/proxy')),
  ).toEqual([])
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins?plugin=toys`)
  const line = page.getByRole('region', { name: 'May read' }).locator('[data-red-line="server"]')
  await expect(line).toContainText(
    'Turned off by your organization’s policy (pluginServers: off): Lumovi asks no server for it.',
  )
  await expect(line.locator('p').first()).not.toHaveClass(/text-critical-text/)
})

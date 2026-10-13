/**
 * Prometheus Operator's Target health page, as Lumovi is built with it: it asks the Prometheus
 * server in each namespace with a Prometheus for its targets, through Lumovi and as the person,
 * and shows what's up and what's down. The Plugins page says so first, in red, and each ask is
 * in the history.
 */
import type { Page } from '@playwright/test'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { STAND_IN, type MockCluster } from '../mock-cluster/server.ts'
import { CONTEXTS, expect, openCluster, test } from './fixtures.ts'

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)
const body = (page: Page) => page.locator('[data-plugin-body]')
const events = (page: Page, q: object = {}) =>
  page.evaluate((q) => window.lumovi!.audit.query(q), q).then((p) => p.events)

/** The Service the operator makes for a namespace's Prometheus servers, with a stand-in behind it. */
const OPERATED = {
  apiVersion: 'v1',
  kind: 'Service',
  metadata: {
    name: 'prometheus-operated',
    namespace: 'monitoring',
    creationTimestamp: new Date().toISOString(),
    labels: { [STAND_IN]: 'prometheus' },
  },
  spec: { clusterIP: 'None', ports: [{ name: 'web', port: 9090 }] },
}
const ASKED = '/api/v1/namespaces/monitoring/services/prometheus-operated:web/proxy/api/v1/targets'
const asked = (cluster: MockCluster) => cluster.requests.filter((r) => r.path === ASKED)

test('Prometheus Operator’s Target health asks its Prometheus server through Lumovi, as the person, and shows what’s up and down', async ({
  launch,
  clusters,
}) => {
  clusters.demo.upsert(OPERATED)
  const { page } = await launch()
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/prometheus-operator/targets`)
  // What the server said, counted: three up, one down, one not scraped yet.
  await expect(body(page)).toContainText('of 5 targets', { timeout: 30_000 })
  await expect(body(page)).toContainText('not scraped yet')
  // The one that's down, with why, and whose it is.
  const down = body(page).getByRole('row').filter({ hasText: '10.0.3.7:8080' }).first()
  await expect(down).toContainText('Get "http://10.0.3.7:8080/metrics": context deadline exceeded')
  await expect(down).toContainText(`Prometheus ${CUSTOM.prometheus}`)
  // Its server's card: whose answer it is, and who else could have it.
  await expect(
    body(page).getByRole('heading', { name: `Prometheus ${CUSTOM.prometheus}` }),
  ).toBeVisible()
  await expect(body(page)).toContainText('in monitoring')
  await expect(body(page)).toContainText(
    'Whoever may reach it sees its targets in every namespace. Asked of this Prometheus server, as you.',
  )
  // Its scrape pools, by what watches them.
  const pool = (kind: string) =>
    body(page).getByRole('row').filter({ hasText: kind }).filter({ hasNotText: '10.0.3.7:8080' })
  await expect(pool('ServiceMonitor · shop')).toContainText('storefront')
  await expect(pool('PodMonitor · shop')).toContainText('1 target not scraped yet')
  await expect(pool('ServiceMonitor · monitoring')).toContainText('node-exporter')
  // Asked once, through the API server's proxy to the operator's Service, as its file lists it,
  // with nothing of Lumovi's but the person's credentials for the API server.
  expect(asked(clusters.demo).map((r) => `${r.method} ${r.search}`)).toEqual(['GET state=active'])
  expect(asked(clusters.demo)[0]!.headers.accept).toBe('application/json')
  expect(asked(clusters.demo)[0]!.headers.cookie).toBeUndefined()
  // The history names the plugin, the Service and the path.
  const said =
    'Asked the Service prometheus-operated in monitoring for /api/v1/targets?state=active, for the plugin Prometheus Operator’s page'
  await expect
    .poll(async () =>
      (await events(page, { actions: ['plugin.server'] })).map((e) => [e.outcome, e.summary]),
    )
    .toEqual([['success', said]])
  // Ask again asks again, once.
  await body(page).getByRole('button', { name: 'Ask again' }).click()
  await expect.poll(() => asked(clusters.demo).length).toBe(2)
})

test('where a namespace’s Prometheus has no such Service, the page says so in Lumovi’s words, and nothing is asked of any server', async ({
  launch,
  clusters,
}) => {
  const { page } = await launch()
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/prometheus-operator/targets`)
  await expect(
    body(page).getByRole('heading', { name: `Prometheus ${CUSTOM.prometheus}` }),
  ).toBeVisible({ timeout: 30_000 })
  await expect(body(page)).toContainText('Couldn’t ask its server')
  await expect(body(page)).toContainText('There’s no Service prometheus-operated in monitoring.')
  // Lumovi looked for the Service, once, and asked nothing through the proxy.
  const seen = clusters.demo.requests.filter((r) => r.path.includes('prometheus-operated'))
  expect(seen.map((r) => `${r.method} ${r.path} → ${r.status}`)).toEqual([
    'GET /api/v1/namespaces/monitoring/services/prometheus-operated → 404',
  ])
  // And the history says it asked, and that it failed.
  await expect
    .poll(async () => (await events(page, { actions: ['plugin.server'] })).map((e) => e.outcome))
    .toEqual(['failure'])
})

test('the Plugins page says first, in red, which server Prometheus Operator’s code asks, and the path', async ({
  launch,
}) => {
  const { page } = await launch()
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins?plugin=prometheus-operator`)
  const line = page.getByRole('region', { name: 'May read' }).locator('[data-red-line="server"]')
  await expect(line.locator('p').first()).toHaveText(
    'Asks the server prometheus-operated in this cluster, through Lumovi, and its code reads what it answers:',
  )
  await expect(line.locator('p').first()).toHaveClass(/text-critical-text/)
  await expect(line.locator('p').nth(1)).toHaveText(
    'The Service prometheus-operated, port web, in the namespace of the Prometheus its page shows.',
  )
  await expect(line.getByRole('listitem')).toHaveText(['/api/v1/targets?state=active'])
})

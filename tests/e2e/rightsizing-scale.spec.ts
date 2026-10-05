/**
 * Right-sizing a cluster of many namespaces: they're asked about a few at a
 * time, not one by one, and what's measured shows while the rest are, a page
 * at a time.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { manyNamespacesCluster } from '../mock-cluster/fixtures/many-namespaces.ts'
import { writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { startMockCluster } from '../mock-cluster/server.ts'
import { clusterOption, expect, test } from './fixtures.ts'

const NAMESPACES = 120
/**
 * Names as long as they can be, as some tenants' are: a batch's names are
 * capped too, so these come in three batches (one waits for the two asked about
 * at once), of a pod each, which the mock's Prometheus works out quickly, unlike
 * batches of a thousand containers.
 */
const name = (i: number) =>
  `a-tenant-whose-namespace-has-a-name-as-long-as-they-can-be-${String(i).padStart(4, '0')}`

test('right-sizing many namespaces', async ({ launch }) => {
  test.slow()
  const cluster = await startMockCluster({
    fixture: () => manyNamespacesCluster(NAMESPACES, { name, replicas: () => 1 }),
    gitVersion: 'v1.33.4',
    tls: true,
  })
  try {
    const kubeconfig = writeKubeconfig(mkdtempSync(join(tmpdir(), 'lumovi-many-')), {
      clusters: [{ name: 'tenants', server: cluster.url, caPem: cluster.caPem }],
      users: [{ name: 'admin' }],
      contexts: [{ name: 'tenants', cluster: 'tenants', user: 'admin' }],
    })
    // Prometheus takes a moment over a week of usage; one batch (the first namespace's) longer,
    // so that the others show first.
    cluster.fail(/\/proxy\/api\/v1\/query$/, { delayMs: 500 })
    cluster.fail(new RegExp(`/proxy/api/v1/query\\?.*\\b${name(0)}\\b`), { delayMs: 4_000 })
    // (The mock's Prometheus works out a week on this test's own CPU, slowly on a busy runner:
    // given the time it takes, nothing's split for it.)
    const { page } = await launch({
      env: { KUBECONFIG: kubeconfig, LUMOVI_REQUEST_TIMEOUT_MS: '90000' },
    })
    await clusterOption(page, 'tenants').click()
    await page
      .getByRole('navigation', { name: 'Resources' })
      .getByRole('link', { name: 'Metrics' })
      .click()
    await page
      .getByRole('navigation', { name: 'Metrics views' })
      .getByRole('link', { name: 'Right-sizing' })
      .click()

    // What's measured shows while the rest is.
    const measuring = page.getByRole('status', { name: 'Measuring' })
    await expect(measuring).toContainText(
      new RegExp(`of ${NAMESPACES.toLocaleString('en')} namespaces so far`),
      // (Once a first batch is.)
      { timeout: 60_000 },
    )
    await expect(page.locator('tbody tr').first()).toBeVisible()
    await expect(measuring).toHaveCount(0, { timeout: 120_000 })
    // Every one of them answered for.
    await expect(page.getByRole('alert')).toHaveCount(0)

    // A few namespaces at a time: a handful of batches of eight queries, not eight a namespace.
    const queries = cluster.requests.filter(
      (r) => r.path.endsWith('/proxy/api/v1/query') && r.query.query!.includes('namespace'),
    )
    expect(queries.length).toBe(8 * 3)
    expect(
      queries.some((r) => new RegExp(`namespace=~"[^"]*\\b${name(0)}\\b`).test(r.query.query!)),
    ).toBe(true)

    // Every workload, a page at a time.
    const pages = page.getByRole('navigation', { name: 'Pagination' })
    await expect(pages).toContainText(`1–50 of ${NAMESPACES.toLocaleString('en')}`)
    await expect(page.locator('tbody tr')).toHaveCount(50)
    await pages.getByRole('button', { name: 'Next page' }).click()
    await expect(pages).toContainText(`51–100 of ${NAMESPACES.toLocaleString('en')}`)
  } finally {
    await cluster.close()
  }
})

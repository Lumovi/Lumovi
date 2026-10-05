/**
 * Right-sizing a cluster of more than a thousand namespaces: they're asked
 * about a few at a time, not one by one, and what's measured shows while the
 * rest are, a page at a time.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { manyNamespacesCluster, tenant } from '../mock-cluster/fixtures/many-namespaces.ts'
import { writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { startMockCluster } from '../mock-cluster/server.ts'
import { clusterOption, expect, test } from './fixtures.ts'

const NAMESPACES = 1_200

test('right-sizing more than a thousand namespaces', async ({ launch }) => {
  test.slow()
  const cluster = await startMockCluster({
    fixture: () => manyNamespacesCluster(NAMESPACES),
    gitVersion: 'v1.33.4',
    tls: true,
  })
  try {
    const kubeconfig = writeKubeconfig(mkdtempSync(join(tmpdir(), 'lumovi-many-')), {
      clusters: [{ name: 'tenants', server: cluster.url, caPem: cluster.caPem }],
      users: [{ name: 'admin' }],
      contexts: [{ name: 'tenants', cluster: 'tenants', user: 'admin' }],
    })
    // Prometheus takes its time over a week of thousands of containers.
    cluster.fail(/\/proxy\/api\/v1\/query$/, { delayMs: 1_000 })
    const { page } = await launch({ env: { KUBECONFIG: kubeconfig } })
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
    )
    await expect(page.locator('tbody tr').first()).toBeVisible()
    await expect(measuring).toHaveCount(0, { timeout: 120_000 })

    // A few namespaces at a time: a handful of batches of eight queries, not eight a namespace.
    const queries = cluster.requests.filter((r) => r.path.endsWith('/proxy/api/v1/query'))
    expect(queries.length).toBeLessThanOrEqual(8 * 6)
    expect(
      queries.some((r) => new RegExp(`namespace=~"[^"]*\\b${tenant(0)}\\b`).test(r.query.query!)),
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

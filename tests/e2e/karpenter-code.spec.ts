/**
 * Karpenter's overview as its plugin's code draws it, from the release of Lumovi's plugins its lock
 * pins: Lumovi's own parts, under the strip that says whose it is. And with its code turned off,
 * Lumovi's own overview of Karpenter in its place (karpenter.spec.ts holds that one to its word).
 */
import type { Page } from '@playwright/test'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { CONTEXTS, expect, openCluster, test } from './fixtures.ts'

const { nodePools } = CUSTOM.karpenter

async function openKarpenter(page: Page) {
  await openCluster(page, CONTEXTS.demo)
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'Karpenter', exact: true })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview')
}
const grid = (page: Page, name: string) => page.getByRole('grid', { name, exact: true })
const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)

test('Karpenter’s overview, drawn by its code: its tiles, its node pools against their limits, its nodes, and what’s coming and going', async ({
  page,
}) => {
  await openKarpenter(page)
  // What's ready, coming and going, a tile each.
  await expect(page.getByRole('region', { name: 'Node pools ready' })).toContainText('2/3')
  await expect(page.getByRole('region', { name: 'Nodes ready' })).toContainText('2/3')
  await expect(page.getByRole('region', { name: 'Launching' })).toContainText('1 pod waiting')
  // Each node pool, with what its nodes take of its limits.
  const pools = grid(page, 'Node pools').getByRole('row')
  await expect(pools.filter({ hasText: nodePools.general })).toContainText('24 of 64 cores')
  await expect(pools.filter({ hasText: nodePools.general }).getByRole('meter')).toHaveCount(2)
  await expect(pools.filter({ hasText: 'arm' })).toContainText('EC2NodeClass "arm" is not ready')
  // Its nodes, with their live usage; one not ready, one launching.
  const nodes = grid(page, 'Nodes').getByRole('row')
  await expect(nodes.filter({ hasText: 'worker-1' })).toContainText(/CPU\s*82%/)
  await expect(nodes.filter({ hasText: 'worker-3' })).toContainText('NotReady')
  await expect(nodes.filter({ hasText: 'general-x2w5m' })).toContainText('Launching')
  // What's being replaced, and what waits for a node.
  await expect(grid(page, 'Disruption')).toContainText('Drifted')
  await expect(grid(page, 'Waiting for a node')).toContainText('redis-1')
})

test('with its code turned off, Lumovi’s own overview of Karpenter stands in', async ({ page }) => {
  await page.evaluate(() => window.lumovi!.app.setPluginCode('karpenter', false))
  await page.reload()
  await openKarpenter(page)
  // Lumovi's own: nothing of the plugin's, its node pools as Lumovi lists them.
  await expect(page.getByTestId('plugin-whose')).toHaveCount(0)
  await expect(page.getByTestId('plugin-ended')).toHaveCount(0)
  await expect(page.getByRole('list', { name: 'Node pools' }).getByRole('listitem')).toHaveCount(3)
  // The Plugins page says so, under its name.
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins`)
  await expect(page.locator('[data-plugin-code-off="karpenter"]')).toHaveText(
    'Its pages don’t run: you turned off its code. Lumovi shows its own overview of Karpenter instead.',
  )
  await page.goBack()
  await expect(page.getByRole('list', { name: 'Node pools' })).toBeVisible()
  // On again: its code's page, where it was.
  await page.evaluate(() => window.lumovi!.app.setPluginCode('karpenter', true))
  await page.reload()
  await expect(grid(page, 'Node pools')).toBeVisible()
})

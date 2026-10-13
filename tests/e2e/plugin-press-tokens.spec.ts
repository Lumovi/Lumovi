/**
 * A press has a token a proposal can spend only where its button says it changes something. The
 * bundled plugins' buttons that change things say so, and still propose, through Lumovi's own
 * dialog: Argo CD's Refresh, Sync and Delete, on an Application, and CloudNativePG's Back up now.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { demoWithCloudNativePg } from '../mock-cluster/fixtures/cloudnative-pg.ts'
import { writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { startMockCluster } from '../mock-cluster/server.ts'
import { CONTEXTS, expect, openCluster, test } from './fixtures.ts'

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)

/** Presses a header button of a plugin's page, and its proposal opens in Lumovi's dialog. */
async function proposes(page: Page, name: string) {
  await page.locator('[data-plugin-body]').getByRole('button', { name, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog, name).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
}

test('Argo CD’s Refresh, Sync and Delete, on an Application, still propose', async ({ launch }) => {
  const { page } = await launch()
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/argo-cd/overview`)
  const applications = page.getByRole('grid', { name: 'Applications' })
  await applications.getByRole('row').filter({ hasText: 'storefront' }).first().click()
  await page.waitForFunction(() => window.location.hash.includes('open='))
  await page.getByRole('complementary').getByRole('tab', { name: 'Argo CD' }).click()
  for (const name of ['Refresh…', 'Sync…', 'Delete…']) await proposes(page, name)
})

test('CloudNativePG’s Back up now still proposes', async ({ launch }) => {
  const cluster = await startMockCluster({ fixture: () => demoWithCloudNativePg(), tls: true })
  const kubeconfig = writeKubeconfig(mkdtempSync(join(tmpdir(), 'lumovi-tokens-')), {
    currentContext: 'databases',
    clusters: [{ name: 'databases', server: cluster.url, caPem: cluster.caPem }],
    users: [{ name: 'databases', token: 'a-token' }],
    contexts: [{ name: 'databases', cluster: 'databases', user: 'databases' }],
  })
  const { page } = await launch({ env: { KUBECONFIG: kubeconfig } })
  await page.getByRole('option', { name: /databases/ }).click()
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible({
    timeout: 30_000,
  })
  await go(page, '#/cluster/databases/plugins/cloudnative-pg')
  await expect(
    page
      .locator('[data-plugin-body]')
      .getByRole('heading', { name: /^reports-db/ })
      .first(),
  ).toBeVisible({ timeout: 30_000 })
  await proposes(page, 'Back up now…')
  await cluster.close()
})

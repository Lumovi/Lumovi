/**
 * CloudNativePG's page, as Lumovi is built with it: of the cluster picked it links to Lumovi's own
 * Shell tab and Port forward for the primary's pod, each instance's row opens that pod at its Logs
 * tab, and the primary's log is on the page, read and drawn by Lumovi. Nothing starts until the
 * person starts it in Lumovi's own place.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { demoWithCloudNativePg } from '../mock-cluster/fixtures/cloudnative-pg.ts'
import { writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { startMockCluster, type MockCluster } from '../mock-cluster/server.ts'
import { expect, panel, test } from './fixtures.ts'

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)
const body = (page: Page) => page.locator('[data-plugin-body]')
const events = (page: Page, q: object = {}) =>
  page.evaluate((q) => window.lumovi!.audit.query(q), q).then((p) => p.events)

/** A cluster with CloudNativePG's databases, its page open at orders-db. */
async function opened(
  launch: Parameters<Parameters<typeof test>[2]>[0]['launch'],
): Promise<{ page: Page; cluster: MockCluster }> {
  const cluster = await startMockCluster({ fixture: () => demoWithCloudNativePg(), tls: true })
  const kubeconfig = writeKubeconfig(mkdtempSync(join(tmpdir(), 'lumovi-reach-')), {
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
  await body(page).getByRole('option').filter({ hasText: 'orders-db' }).first().click()
  await expect(
    body(page)
      .getByRole('heading', { name: /^orders-db/ })
      .first(),
  ).toBeVisible({ timeout: 30_000 })
  return { page, cluster }
}

test('CloudNativePG’s Overview links to its primary’s shell and port in Lumovi’s own places, and neither starts by itself', async ({
  launch,
}) => {
  const { page, cluster } = await opened(launch)
  // A shell: Lumovi's words for where the link goes, and its own Shell tab, opened from the page.
  const shell = body(page).getByRole('button', { name: 'Shell into primary' })
  await expect(shell).toHaveAccessibleDescription('Opens Pod shop/orders-db-1 at its Shell tab')
  await shell.click()
  const detail = panel(page, 'Pod', 'orders-db-1')
  await expect(detail.getByRole('tab', { name: 'Shell' })).toHaveAttribute('aria-selected', 'true')
  await expect(detail.locator('[data-shell-via]')).toHaveText('Opened from CloudNativePG’s page')
  // Nothing was asked of the cluster for it, and nothing is in the history.
  expect(cluster.requests.filter((r) => r.path.endsWith('/pods/orders-db-1/exec'))).toEqual([])
  expect(await events(page, { actions: ['shell.open'] })).toEqual([])
  await page.keyboard.press('Escape')
  // A forward: Lumovi's own dialog, PostgreSQL's port filled in; nothing starts until it's pressed.
  await body(page).getByRole('button', { name: 'Forward 5432' }).click()
  const dialog = page.getByRole('dialog', { name: 'Forward a port to orders-db-1' })
  await expect(dialog).toContainText('kubectl port-forward pod/orders-db-1')
  await expect(dialog).toContainText(':5432')
  expect(await events(page, { actions: ['port-forward.open'] })).toEqual([])
  await cluster.close()
})

test('each instance’s row opens that pod at its Logs tab, and the primary’s log is on the page, read by Lumovi as the page’s', async ({
  launch,
}) => {
  const { page, cluster } = await opened(launch)
  // The primary's log, under its instances: Lumovi's own log view, and Lumovi's line on whose it is.
  const log = body(page).getByRole('log', { name: 'Logs for postgres' })
  await log.scrollIntoViewIfNeeded()
  await expect(log).toBeVisible({ timeout: 20_000 })
  await expect(body(page)).toContainText('Shown by Lumovi: CloudNativePG’s code never sees them.')
  // Read as the person, and in the history as shown for the plugin's page.
  await expect
    .poll(async () =>
      (await events(page, { actions: ['logs.read'] })).map((event) => [
        event.target?.name,
        (event.details as { plugin?: string } | undefined)?.plugin,
      ]),
    )
    .toContainEqual(['orders-db-1', 'cloudnative-pg'])
  // A row says where it goes, in Lumovi's words; pressed, it's there, at PostgreSQL's container.
  const row = body(page)
    .getByRole('grid', { name: 'Instances' })
    .getByRole('row', { name: /orders-db-2/ })
  await expect(row).toHaveAttribute('title', 'Opens Pod shop/orders-db-2 at its Logs tab')
  await row.click()
  const detail = panel(page, 'Pod', 'orders-db-2')
  await expect(detail.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true')
  await expect(detail.getByRole('combobox', { name: 'Container' })).toHaveValue('postgres')
  await cluster.close()
})

test('the Plugins page says where CloudNativePG’s pages link to, and that it shows logs its code never sees', async ({
  launch,
}) => {
  const { page, cluster } = await opened(launch)
  await go(page, '#/cluster/databases/plugins?plugin=cloudnative-pg')
  await expect(page.locator('[data-plugin-links]')).toHaveText(
    'Its pages may open Lumovi’s Logs and Shell tabs for pods they show, and its Port forward dialog for pods and services. You start a shell or a forward there yourself.',
  )
  await expect(
    page
      .getByRole('region', { name: 'May read' })
      .getByText('It shows containers’ logs: Lumovi reads them, and its code never sees them.', {
        exact: true,
      }),
  ).toBeVisible()
  await cluster.close()
})

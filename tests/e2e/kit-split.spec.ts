/**
 * A plugin's split, a pick list beside the picked one's page, by the width it's given: side by
 * side where there's room; where there isn't (beside a row's panel), two pages in its pane, as on
 * a phone. What was open stays, with Back to the list, and widening again puts them side by side.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { demoWithCloudNativePg } from '../mock-cluster/fixtures/cloudnative-pg.ts'
import { writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { startMockCluster } from '../mock-cluster/server.ts'
import { placed } from '../placed.ts'
import { expect, test, type LaunchOptions, type Lumovi } from './fixtures.ts'

const CONTEXT = 'databases'

/** Lumovi at a width itself (not zoomed out to the tests' usual one), on CloudNativePG's page. */
async function databases(launch: (options?: LaunchOptions) => Promise<Lumovi>, width = 1024) {
  const cluster = await startMockCluster({ fixture: () => demoWithCloudNativePg(), tls: true })
  const kubeconfig = writeKubeconfig(mkdtempSync(join(tmpdir(), 'lumovi-split-')), {
    currentContext: CONTEXT,
    clusters: [{ name: CONTEXT, server: cluster.url, caPem: cluster.caPem }],
    users: [{ name: CONTEXT, token: 'a-token' }],
    contexts: [{ name: CONTEXT, cluster: CONTEXT, user: CONTEXT }],
  })
  const { page } = await launch({
    env: { KUBECONFIG: kubeconfig, LUMOVI_E2E_WINDOW: `${width}x900` },
    fullLayout: false,
  })
  await page.getByRole('option', { name: new RegExp(CONTEXT) }).click()
  // (Once the cluster's own Overview is open: going elsewhere sooner, it would open over it.)
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible({
    timeout: 30_000,
  })
  await page.evaluate((context) => {
    window.location.hash = `#/cluster/${context}/plugins/cloudnative-pg`
  }, CONTEXT)
  return { page, cluster }
}

const parts = (page: Page) => {
  const body = page.locator('[data-plugin-body]')
  return {
    body,
    list: body.getByRole('listbox', { name: 'Clusters' }),
    picked: body.getByRole('heading', { name: /^reports-db/ }).first(),
    back: body.getByRole('button', { name: 'Back to Clusters' }),
    instances: body.getByRole('grid', { name: 'Instances' }),
  }
}

/** Whether what holds the plugin's page scrolls sideways: something in it is too wide. */
const sideways = (page: Page) =>
  page.locator('[data-plugin-body]').evaluate((body) => {
    for (let el: Element | null = body; el; el = el.parentElement) {
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'hidden') {
        return true
      }
    }
    return false
  })

test('beside a row’s panel at 1024, a split is two pages in its pane: what was open stays, with Back to the list', async ({
  launch,
}) => {
  const { page, cluster } = await databases(launch)
  const { list, picked, back, instances } = parts(page)
  // Room for both: side by side, the list at the left.
  await expect(picked).toBeVisible({ timeout: 30_000 })
  await expect(list).toBeVisible()
  expect((await placed(list)).x).toBeLessThan((await placed(picked)).x)
  await expect(back).toHaveCount(0)
  // A row's panel opens: the pane is narrow, and the picked one's page stays, the row pressed in
  // view, with Back above it.
  const row = instances.getByRole('row').filter({ hasText: 'reports-db-1' }).first()
  await row.click()
  await page.waitForFunction(() => window.location.hash.includes('open='))
  await expect(back).toBeVisible()
  await expect(list).toBeHidden()
  await expect(row).toBeInViewport()
  expect(await sideways(page)).toBe(false)
  // Its header: the name on a line of its own, its status under it, and its buttons, which haven't
  // room beside the status, under that, from where it starts, "…" first. Nothing reaches past the
  // pane.
  const header = body(page).getByRole('group', { name: 'reports-db' })
  await header.scrollIntoViewIfNeeded()
  const [status, more, button] = [
    await placed(header.locator('[data-health]').first()),
    await placed(header.getByRole('button', { name: 'More for reports-db' })),
    await placed(header.getByRole('button', { name: 'Back up now…' })),
  ]
  expect(button.y).toBeGreaterThanOrEqual(status.y + status.height)
  expect(Math.abs(more.x - status.x)).toBeLessThan(2)
  expect(more.x).toBeLessThan(button.x)
  expect(
    await header.evaluate((at) => {
      let pane = at.parentElement
      while (pane && getComputedStyle(pane).overflowY !== 'auto') pane = pane.parentElement
      return pane!.scrollWidth - pane!.clientWidth
    }),
  ).toBe(0)
  // Back stays at the pane's top as the page scrolls under it.
  await expect(back).toBeInViewport()
  await row.evaluate((el) => el.closest('.overflow-auto')!.scrollBy(0, 4000))
  await expect(back).toBeInViewport()
  // Back: the list, the pane's width, each row whole.
  await back.click()
  await expect(list).toBeVisible()
  await expect(picked).toBeHidden()
  const edge = (await placed(list)).x + (await placed(list)).width
  for (const status of await list.getByText(/^(Failed|Healthy|Switching over)$/).all()) {
    const box = await placed(status)
    expect(box.x + box.width).toBeLessThanOrEqual(edge)
  }
  expect(await sideways(page)).toBe(false)
  // A name keeps a table's least: one status that won't fit beside it, and every status goes
  // under its name, at the name's edge.
  expect(await statuses(list)).toEqual(['under', 'under', 'under'])
  // A pick there opens its page, with Back.
  await list.getByRole('option').filter({ hasText: 'orders-db' }).click()
  await expect(
    body(page)
      .getByRole('heading', { name: /^orders-db/ })
      .first(),
  ).toBeVisible()
  await expect(back).toBeVisible()
  // The panel closed: side by side again, the same one picked.
  await page.keyboard.press('Escape')
  await expect(list).toBeVisible()
  await expect(back).toHaveCount(0)
  await expect(list.getByRole('option', { selected: true })).toContainText('orders-db')
  await cluster.close()
})

test('arriving at a split already narrow starts at its list', async ({ launch }) => {
  const { page, cluster } = await databases(launch)
  const { list, picked, back, instances } = parts(page)
  await instances.getByRole('row').filter({ hasText: 'reports-db-1' }).first().click()
  await page.waitForFunction(() => window.location.hash.includes('open='))
  await expect(back).toBeVisible()
  // Read again, with the panel still open: the list first.
  await page.reload()
  await expect(list).toBeVisible({ timeout: 30_000 })
  await expect(picked).toBeHidden()
  await expect(back).toHaveCount(0)
  await cluster.close()
})

test('side by side, a split’s list keeps each status beside its name, where all of them fit', async ({
  launch,
}) => {
  const { page, cluster } = await databases(launch, 1440)
  const { list, picked } = parts(page)
  await expect(picked).toBeVisible({ timeout: 30_000 })
  expect(await statuses(list)).toEqual(['beside', 'beside', 'beside'])
  await cluster.close()
})

const body = (page: Page) => page.locator('[data-plugin-body]')

/** Where each whole name's status stands: beside it, or under it at its edge. */
async function statuses(list: Locator) {
  return Promise.all(
    ['reports-db', 'sessions-db', 'orders-db'].map(async (said) => {
      const row = list.getByRole('option').filter({ hasText: said })
      // (The name as drawn, the last of a middle cut's copies: it reads so only while it's whole.)
      const name = await placed(row.getByText(said, { exact: true }).last())
      const pill = await placed(row.locator('[data-pill]'))
      if (pill.y >= name.y + name.height && Math.abs(pill.x - name.x) <= 1) return 'under'
      if (pill.x >= name.x + name.width && pill.y < name.y + name.height) return 'beside'
      return `neither (${JSON.stringify({ name, pill })})`
    }),
  )
}

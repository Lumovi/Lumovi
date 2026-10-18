/**
 * Map (LMV-172): everything in the namespaces picked as one picture, in bands by namespace, node
 * or app, each card saying how it is in words; Find dims what doesn't match; the same as a list;
 * and on 2,500 pods, pods counted on their workloads, those of no workload as one, and what's
 * healthy folded.
 */
import type { Page } from '@playwright/test'
import { placed } from '../placed.ts'
import { CONTEXTS, expect, openCluster, panel, test } from './fixtures.ts'

async function openMap(page: Page, context: string = CONTEXTS.demo, query = '') {
  await page.evaluate(
    ([context, query]) => (location.hash = `#/cluster/${encodeURIComponent(context!)}/map${query}`),
    [context, query],
  )
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Map')
}

const band = (page: Page, name: string) =>
  page.getByRole('main').getByRole('region', { name, exact: true })
const card = (page: Page, label: RegExp | string) =>
  page.getByRole('main').getByRole('button', { name: label })

test('the namespaces picked, a band each, every card saying how it is; a card opens over the map', async ({
  page,
}) => {
  await openCluster(page)
  await openMap(page)
  const shop = band(page, 'shop')
  await expect(shop.getByRole('heading', { name: 'shop' })).toBeVisible()
  await expect(shop).toContainText(/\d+ workloads? · \d+ pods? · \d+ services?/)
  // How it is in words, not colour alone: the Deployment's card, and its pods'.
  await expect(card(page, /^Deployment checkout, /)).toBeVisible()
  await expect(card(page, /^Pods checkout, \d+\/\d+ ready$/)).toBeVisible()
  // What nothing uses isn't drawn: every namespace's kube-root-ca.crt.
  await expect(page.getByRole('main')).not.toContainText('kube-root-ca.crt')
  // A card opens over the map, which stays as it is under it.
  await card(page, /^Deployment checkout, /).click()
  await expect(panel(page, 'Deployment', 'checkout')).toHaveAttribute('data-over', 'true')
  await page.keyboard.press('Escape')

  // Folded, and back.
  await shop.getByRole('button', { name: 'Fold shop' }).click()
  await expect(card(page, /^Deployment checkout, /)).toHaveCount(0)
  await shop.getByRole('button', { name: 'Show shop' }).click()
  await expect(card(page, /^Deployment checkout, /)).toBeVisible()

  // One namespace picked: its band alone.
  await openMap(page, CONTEXTS.demo, '?namespaces=monitoring')
  await expect(band(page, 'monitoring')).toBeVisible()
  await expect(band(page, 'shop')).toHaveCount(0)
})

test('Find on the map dims what doesn’t match and folds the bands without one; the same as a list', async ({
  page,
}) => {
  await openCluster(page)
  await openMap(page)
  const find = page.getByRole('textbox', { name: 'Find on the map' })
  await find.fill('checkout')
  await expect(page.getByRole('main').getByRole('status')).toContainText(/\d+ found/)
  await expect(band(page, 'monitoring')).toContainText('No match')
  await find.press('Enter')
  await find.fill('nothing-is-called-this')
  await expect(page.getByRole('main').getByRole('status')).toHaveText('Nothing matches')
  await find.press('Escape')
  await expect(find).toHaveValue('')

  // As a list: the same bands, a row a workload.
  await page.getByRole('button', { name: 'As a list' }).click()
  const list = page.getByRole('table', { name: 'Map' })
  await expect(list.getByRole('rowgroup', { name: 'shop' })).toContainText('checkout')
  // A name three objects go by, once, with their kinds.
  await expect(
    list
      .getByRole('rowgroup', { name: 'shop' })
      .getByRole('row')
      .filter({ hasText: /^storefront/ }),
  ).toContainText('storefront (Ingress, HTTPRoute, Service), edge')
  await list
    .getByRole('rowgroup', { name: 'shop' })
    .getByRole('row')
    .filter({ hasText: 'checkout' })
    .first()
    .click()
  // Beside the list, as from any list.
  await expect(panel(page, 'Deployment', 'checkout')).toBeVisible()
  await expect(panel(page, 'Deployment', 'checkout')).not.toHaveAttribute('data-over')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'As a map' }).click()
  await expect(card(page, /^Deployment checkout, /)).toBeVisible()
})

test('grouped by node or by app, each kept for the cluster; G then Y goes there', async ({
  page,
}) => {
  await openCluster(page)
  await openMap(page)
  await page.getByRole('combobox', { name: 'Group by' }).selectOption('node')
  await expect(page.getByRole('main').getByRole('region').first()).toContainText(
    /pods? of \d+ workloads?/,
  )
  // A workload on several nodes counted once; a node's band is as its pods there and it are.
  await expect(page.getByRole('main')).toContainText('5 nodes · 18 workloads · 34 pods')
  await expect(band(page, 'control-plane-1')).toContainText('All healthy')
  // A DaemonSet is on every node: each node's card of it counts its pods there.
  await expect(card(page, /^DaemonSet node-exporter, /).first()).toContainText(/\d+ here/)
  await page.getByRole('combobox', { name: 'Group by' }).selectOption('app')
  await expect(band(page, 'checkout')).toBeVisible()
  // Kept: back after leaving.
  await page.evaluate(() => (location.hash = '#/cluster/demo/pods'))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  await page.getByRole('grid', { name: 'Pods' }).focus()
  await page.keyboard.press('g')
  await page.keyboard.press('y')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Map')
  await expect(page.getByRole('combobox', { name: 'Group by' })).toHaveValue('app')
})

test('narrow, pods are counted on their workloads, and a band with something unwell folds the rest', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_E2E_WINDOW: '1024x768' }, fullLayout: false })
  await openCluster(page)
  await openMap(page, CONTEXTS.demo, '?namespaces=shop')
  await expect(page.getByRole('main').getByText('Pods', { exact: true })).toHaveCount(0)
  await expect(card(page, /^Deployment checkout, /)).toContainText('2 of 3 failing')
  const shop = band(page, 'shop')
  await expect(card(page, /^Deployment cart, /)).toHaveCount(0)
  // Only workloads fold: a service with no pods behind it is drawn.
  await expect(card(page, /^Service payments-gateway/)).toBeVisible()
  await shop
    .getByRole('button', { name: /more workloads?, all healthy, with their .*Show them$/ })
    .click()
  await expect(card(page, /^Deployment cart, /)).toContainText('2 pods')
  // Opened, a card stays lit over the panel, the map moved along to clear it.
  await card(page, /^Deployment cart, /).click()
  await expect(panel(page, 'Deployment', 'cart')).toHaveAttribute('data-over', 'true')
  const lit = page.locator('[data-open]')
  await expect(lit).toHaveAccessibleName(/^Deployment cart, /)
  await expect(async () => {
    const [cardBox, panelBox] = await Promise.all([
      placed(lit),
      placed(panel(page, 'Deployment', 'cart')),
    ])
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(panelBox.x)
  }).toPass()
  // Lit above the shade, where the card is.
  await expect(page.locator('[data-lifted]')).toContainText('cart')
  const [at, lifted] = await Promise.all([placed(lit), placed(page.locator('[data-lifted]'))])
  expect(Math.abs(at.x - lifted.x) + Math.abs(at.y - lifted.y)).toBeLessThan(2)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-open]')).toHaveCount(0)
  await expect(page.locator('[data-lifted]')).toHaveCount(0)
})

test('on 2,500 pods, pods are counted on their workloads and a healthy band folds', async ({
  page,
}) => {
  await openCluster(page, CONTEXTS.large)
  const opened = Date.now()
  await openMap(page, CONTEXTS.large)
  // The Pods column goes; a workload says its pods.
  await expect(page.getByRole('main')).toContainText(/\d[\d,]* (pods|of [\d,]+ failing)/)
  expect(Date.now() - opened).toBeLessThan(15_000)
  await expect(page.getByRole('main').getByText('Pods', { exact: true })).toHaveCount(0)
  // Healthy, folded; shown, its pods of no workload are one card, not one each.
  await page.getByRole('main').getByRole('button', { name: /Show$/ }).first().click()
  await expect(card(page, 'Pods of no workload, 2,500 pods')).toHaveCount(1)
  await expect(page.getByRole('main').getByRole('button', { name: /^Pod / })).toHaveCount(0)
})

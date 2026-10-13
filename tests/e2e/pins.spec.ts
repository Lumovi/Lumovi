/**
 * Pinned objects: pinned from an object's detail (⌥P), its list's row and its menu; in the
 * sidebar with their status now and their number key (⌥1–⌥9); in the palette first, moved and
 * unpinned there from the keyboard; one that's gone kept in its place; twenty at most; and kept
 * for each cluster across restarts.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { DEMO } from '../mock-cluster/fixtures/demo.ts'
import { toasts } from './action-helpers.ts'
import { CONTEXTS, expect, hoverForTooltip, openCluster, panel, rows, test } from './fixtures.ts'

const go = (page: Page, to: string) =>
  page.evaluate((hash) => {
    window.location.hash = hash
  }, to)
const pinned = (page: Page) => page.getByRole('list', { name: 'Pinned objects' })
const pins = (page: Page) => pinned(page).getByRole('listitem')
/** A number key as it's written here: "⌥1" on a Mac, "Alt+1" off one. */
const key = (n: number) => (process.platform === 'darwin' ? `⌥${n}` : `Alt+${n}`)
const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette' })
const group = (page: Page, name: string) =>
  palette(page).getByRole('group', { name, exact: true }).getByRole('option')
const pinButton = (page: Page, name: string) =>
  panel(page, 'Deployment', name).getByRole('button', { name: /^(Pin|Pinned)$/ })

/** A deployment's row, by its name's cell. */
const deployment = (page: Page, name: string) =>
  page
    .getByRole('grid', { name: 'Deployments' })
    .getByRole('row')
    .filter({ has: page.getByRole('gridcell', { name, exact: true }) })

/** The pointer off what it was over, so a tooltip opens afresh on the next hover. */
const away = (page: Page) =>
  page.getByRole('heading', { level: 1 }).hover({ position: { x: 2, y: 2 } })

/** Opens a deployment of the shop's in its list. */
async function openDeployment(page: Page, name: string) {
  await go(page, `#/cluster/demo/deployments?namespaces=shop&open=Deployment/shop/${name}`)
  await expect(panel(page, 'Deployment', name)).toBeVisible()
}

/** Pins a deployment of the shop's from its row's menu. */
async function pinFromMenu(page: Page, name: string) {
  await deployment(page, name).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Pin', exact: true }).click()
  await expect(toasts(page)).toContainText(`Pinned Deployment ${name}`)
}

test('an object pinned from its detail is in the sidebar with its status, and opens with its number key', async ({
  page,
}) => {
  await openCluster(page)
  await openDeployment(page, DEMO.deployments.cart)
  const button = pinButton(page, 'cart')
  await expect(button).toHaveText('Pin')
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  await hoverForTooltip(button, 'Pin Deployment cart to the sidebar')
  await button.click()
  await expect(button).toHaveText('Pinned')
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await away(page)
  await hoverForTooltip(button, 'Unpin Deployment cart from the sidebar')
  await expect(toasts(page)).toContainText('Pinned Deployment cart')

  // In the sidebar: its kind, name and namespace, its status now, and its key.
  await expect(pins(page)).toHaveCount(1)
  const link = pins(page).getByRole('link')
  await expect(link).toHaveAccessibleName(/^Deployment cart in shop, \w/)
  await expect(link).toContainText(key(1))

  // ⌥1 opens it from anywhere nothing is being typed.
  await go(page, '#/cluster/demo/nodes')
  await expect(page.getByRole('grid', { name: 'Nodes' })).toBeVisible()
  await page.keyboard.press('Alt+1')
  await expect(panel(page, 'Deployment', 'cart')).toBeVisible()
  await expect(link).toHaveAttribute('aria-current', 'page')
  // Not while a field has the focus: there it types.
  await page.keyboard.press('Escape')
  await page.getByPlaceholder(/^Filter/).focus()
  await page.keyboard.press('Alt+1')
  await expect(panel(page, 'Deployment', 'cart')).toHaveCount(0)

  // ⌥P unpins the open object; Undo puts it back in its place.
  await pinFromRow(page, DEMO.deployments.checkout)
  await openDeployment(page, DEMO.deployments.cart)
  await page.getByRole('heading', { name: 'cart', level: 2 }).click()
  await page.keyboard.press('Alt+p')
  await expect(pinButton(page, 'cart')).toHaveText('Pin')
  await expect(toasts(page)).toContainText('Unpinned Deployment cart')
  await expect(pins(page)).toHaveCount(1)
  await toasts(page).getByRole('button', { name: 'Undo' }).last().click()
  await expect(pins(page)).toHaveCount(2)
  await expect(pins(page).first()).toContainText('cart')
  await expect(pins(page).first()).toContainText(key(1))
  await expect(pinButton(page, 'cart')).toHaveText('Pinned')

  // The shortcuts say so.
  await page.keyboard.press('Escape')
  await page.keyboard.press('?')
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(shortcuts).toContainText('Open a pinned object (the first nine)')
  await expect(shortcuts).toContainText('Pin or unpin the open object')
})

/** Pins a deployment from its list's row: the pin in its last cell, shown under the pointer. */
async function pinFromRow(page: Page, name: string) {
  await go(page, '#/cluster/demo/deployments?namespaces=shop')
  const each = deployment(page, name)
  await each.hover()
  await each.getByRole('button', { name: `Pin Deployment ${name} to the sidebar` }).click()
  await expect(toasts(page)).toContainText(`Pinned Deployment ${name}`)
  // Pinned, its pin stays, saying it unpins.
  await expect(
    each.getByRole('button', { name: `Unpin Deployment ${name} from the sidebar` }),
  ).toHaveAttribute('aria-pressed', 'true')
}

test('the palette lists the pins first with their keys; ⌥↑ ⌥↓ move one, ⌫ unpins it with an empty field', async ({
  page,
}) => {
  await openCluster(page)
  await go(page, '#/cluster/demo/deployments?namespaces=shop')
  await expect(rows(page, 'Deployments').first()).toBeVisible()
  for (const name of ['cart', 'checkout', 'storefront']) await pinFromMenu(page, name)
  // (Each row is named for a screen reader: its kind, name and namespace, then its status.)
  const names = () =>
    group(page, 'Pinned').evaluateAll((options) =>
      options.map((option) => option.getAttribute('aria-label')!.split(',')[0]),
    )

  await page.keyboard.press('ControlOrMeta+k')
  await expect(group(page, 'Pinned')).toHaveCount(3)
  expect(await names()).toEqual([
    'Deployment cart in shop',
    'Deployment checkout in shop',
    'Deployment storefront in shop',
  ])
  await expect(group(page, 'Pinned').first()).toContainText(key(1))
  await expect(group(page, 'Pinned').first()).toHaveAccessibleName(/^Deployment cart in shop, \w/)
  await expect(group(page, 'Pinned').first()).toHaveAttribute('aria-selected', 'true')
  await expect(palette(page)).toContainText('to move the pin')

  // ⌥↓ moves the chosen pin down, and it stays chosen; the sidebar follows (seen once the
  // palette, a dialog, has closed).
  await page.keyboard.press('Alt+ArrowDown')
  await expect(group(page, 'Pinned').nth(1)).toContainText('cart')
  await expect(group(page, 'Pinned').nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(group(page, 'Pinned').nth(1)).toContainText(key(2))
  await page.keyboard.press('Escape')
  await expect(pins(page).nth(1)).toContainText('cart')
  await expect(pins(page).nth(1)).toContainText(key(2))
  await page.keyboard.press('ControlOrMeta+k')
  await expect(group(page, 'Pinned').nth(1)).toContainText('cart')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Alt+ArrowUp')
  await expect(group(page, 'Pinned').first()).toContainText('cart')

  // ⌫ with something typed edits it; with nothing, unpins the chosen pin. Its row stays in its
  // place while the palette's open, with its Undo (↵), and a screen reader is told.
  await page.keyboard.type('c')
  await page.keyboard.press('Backspace')
  await expect(group(page, 'Pinned').first()).toHaveAccessibleName(/^Deployment cart in shop, /)
  await page.keyboard.press('Backspace')
  const unpinned = group(page, 'Pinned').first()
  await expect(unpinned).toHaveAccessibleName('Deployment cart: unpinned. Enter undoes it.')
  await expect(unpinned).toContainText('Unpinned · Undo')
  await expect(unpinned).toHaveAttribute('aria-selected', 'true')
  await expect(palette(page).getByRole('status')).toHaveText('Unpinned Deployment cart.')
  await expect(palette(page)).toContainText('to undo')
  // ⌫ again does nothing; ↵ undoes, in its place.
  await page.keyboard.press('Backspace')
  await expect(unpinned).toHaveAccessibleName(/unpinned/)
  await page.keyboard.press('Enter')
  await expect(group(page, 'Pinned').first()).toHaveAccessibleName(/^Deployment cart in shop, /)
  await expect(palette(page)).toBeVisible()
  // Unpinned again, and the palette closed: it's gone, and no toast says so.
  await page.keyboard.press('Backspace')
  await expect(group(page, 'Pinned').first()).toHaveAccessibleName(/unpinned/)
  await page.keyboard.press('Escape')
  await expect(pins(page)).toHaveCount(2)
  await expect(toasts(page)).not.toContainText('Unpinned Deployment cart')
  await page.keyboard.press('ControlOrMeta+k')
  await expect(group(page, 'Pinned')).toHaveCount(2)
  await page.keyboard.press('Escape')

  // ⌥2 in the palette opens the second, and closes it.
  await page.keyboard.press('ControlOrMeta+k')
  await expect(group(page, 'Pinned')).toHaveCount(2)
  await page.keyboard.press('Alt+2')
  await expect(palette(page)).toHaveCount(0)
  await expect(panel(page, 'Deployment', 'storefront')).toBeVisible()

  // The open object's actions offer Pin or Unpin.
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('unpin')
  await palette(page)
    .getByRole('option', { name: /^Unpin Deployment storefront/ })
    .click()
  await expect(toasts(page)).toContainText('Unpinned Deployment storefront')
  await expect(pins(page)).toHaveCount(1)
})

test('an Event is never offered to pin: not in its list, not on its page, nor in the palette', async ({
  page,
}) => {
  await openCluster(page)
  await go(page, '#/cluster/demo/events')
  const events = page.getByRole('grid', { name: 'Events' })
  await expect(events.getByRole('row').nth(1)).toBeVisible()
  // No pins' column in its list.
  await expect(events.getByRole('columnheader', { name: 'Pinned' })).toHaveCount(0)
  // None on its page, nor from the keyboard.
  await events.getByRole('row').nth(1).getByRole('gridcell').nth(1).click()
  const side = page
    .getByRole('complementary')
    .filter({ has: page.getByRole('tablist') })
    .last()
  await expect(side).toBeVisible()
  await expect(side.getByRole('button', { name: /^(Pin|Pinned)$/ })).toHaveCount(0)
  await page.keyboard.press('Alt+p')
  // Nor in the palette: no Actions at all, as it has none.
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette(page)).toBeVisible()
  await expect(palette(page).getByRole('group', { name: 'Actions' })).toHaveCount(0)
  await expect(palette(page).getByRole('option', { name: /^Pin Event/ })).toHaveCount(0)
  // And by now, nothing came of ⌥P: no pins, here or in the sidebar.
  await expect(palette(page).getByRole('group', { name: 'Pinned', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(pinned(page)).toHaveCount(0)
})

test('a pin whose object is gone keeps its place, struck through; it opens its list filtered to its name, and unpins where it is', async ({
  page,
  clusters,
}) => {
  await openCluster(page)
  await go(page, '#/cluster/demo/deployments?namespaces=shop')
  await expect(rows(page, 'Deployments').first()).toBeVisible()
  await pinFromMenu(page, 'cart')
  await pinFromMenu(page, 'checkout')
  clusters.demo.remove('Deployment', 'shop', DEMO.deployments.cart)
  const gone = pins(page).first().getByRole('link')
  await expect(gone).toHaveAccessibleName('Deployment cart in shop: not in the cluster any more', {
    timeout: 15_000,
  })
  await expect(gone).toHaveAttribute(
    'title',
    'Deployment cart in shop isn’t in the cluster any more.',
  )
  await expect(gone).toContainText(key(1))
  await expect(gone.locator('.line-through')).toHaveCount(1)
  await gone.click()
  await expect(page).toHaveURL(/#\/cluster\/demo\/deployments\?q=cart(&|$)/)
  await pins(page)
    .first()
    .getByRole('button', { name: 'Unpin Deployment cart from the sidebar' })
    .click()
  await expect(pins(page)).toHaveCount(1)
  await expect(pins(page).first()).toContainText(key(1))

  // Its context menu unpins one that's there too.
  await pins(page).first().getByRole('link').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Unpin' }).click()
  await expect(pinned(page)).toHaveCount(0)
})

test('twenty pins are the most: the twenty-first is refused in Lumovi’s words, and a detail’s Pin says why', async ({
  page,
}) => {
  await openCluster(page)
  await go(page, '#/cluster/demo/pods?namespaces=')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  const listed = rows(page, 'Pods')
  for (let i = 0; i < 20; i++) {
    const each = listed.nth(i)
    await each.hover()
    await each.getByRole('button', { name: /^Pin Pod / }).click()
    await expect(each.getByRole('button', { name: /^Unpin Pod / })).toBeVisible()
  }
  await expect(pins(page)).toHaveCount(20)
  // Nine have a number; the rest none.
  await expect(pins(page).nth(8)).toContainText(key(9))
  await expect(pins(page).nth(9).locator('kbd')).toHaveCount(0)

  const next = listed.nth(20)
  await next.hover()
  const press = next.getByRole('button', { name: /^Pin Pod / })
  const name = /^Pin Pod (.+) to the sidebar$/.exec((await press.getAttribute('aria-label'))!)![1]
  await press.click()
  await expect(toasts(page)).toContainText(
    `20 objects are pinned in this cluster, the most there can be. Unpin one to pin Pod ${name}.`,
  )
  await expect(pins(page)).toHaveCount(20)
  await next.click()
  const pin = page.getByRole('complementary').getByRole('button', { name: 'Pin', exact: true })
  await expect(pin).toBeDisabled()
  await hoverForTooltip(
    pin.locator('..'),
    `20 objects are pinned in this cluster, the most there can be. Unpin one to pin Pod ${name}.`,
  )
})

test('pins are kept for each cluster across restarts', async ({ launch }) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const first = await launch({ userDataDir })
  await openCluster(first.page)
  await go(first.page, '#/cluster/demo/deployments?namespaces=shop')
  await expect(rows(first.page, 'Deployments').first()).toBeVisible()
  await pinFromMenu(first.page, 'cart')
  await first.close()

  const { page } = await launch({ userDataDir })
  await openCluster(page)
  await expect(pins(page)).toHaveCount(1)
  await expect(pins(page).first()).toContainText('cart')
  // Another cluster has its own: none.
  await go(page, `#/cluster/${CONTEXTS.large}`)
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toContainText(CONTEXTS.large)
  await expect(pinned(page)).toHaveCount(0)
})

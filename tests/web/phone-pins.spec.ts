/**
 * Pins and saved views on a phone: the detail's Pin and the drawer's rows a finger's size, no
 * number keys; a long press, or a row's "⋯", opens a sheet to open or unpin it; and the views a
 * square by the filter, the open one said under the bar.
 */
import type { Locator } from '@playwright/test'
import { DEMO_TOKEN, expect, test } from './fixtures.ts'
import { expectFingerSized, expectNoSidewaysScroll, FINGER, PHONE, signInNarrow } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

const height = (target: Locator) =>
  target.evaluate((element) => Math.round(element.getBoundingClientRect().height))

test('pins on a phone: a finger’s Pin and rows, and a long press or “⋯” to open or unpin', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(
    page,
    `${served.url}cluster/demo/deployments?namespaces=shop&open=Deployment/shop/cart`,
    DEMO_TOKEN,
  )
  const pin = page.getByRole('button', { name: 'Pin', exact: true })
  await expect(pin).toBeVisible()
  expect(await height(pin)).toBeGreaterThanOrEqual(FINGER)
  await pin.tap()
  await expect(page.getByRole('button', { name: 'Pinned', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  await page.getByRole('button', { name: 'Back' }).tap()
  await page.getByRole('button', { name: 'Menu' }).tap()
  const row = page.getByRole('list', { name: 'Pinned objects' }).getByRole('listitem').first()
  const link = row.getByRole('link')
  await expect(link).toHaveAccessibleName(/^Deployment cart in shop/)
  expect(await height(link)).toBeGreaterThanOrEqual(FINGER)
  // No number keys on a phone.
  await expect(row.locator('kbd')).toHaveCount(0)
  await expectFingerSized(page, 'the drawer with a pin, on a phone')
  await expectNoSidewaysScroll(page, 'the drawer with a pin, on a phone')

  // "⋯" opens its sheet: Open, and Unpin.
  await row.getByRole('button', { name: 'More for Deployment cart' }).tap()
  const sheet = page.getByRole('dialog', { name: 'Deployment cart' })
  await expect(sheet.getByRole('button', { name: 'Open' })).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Unpin' })).toBeVisible()
  await expectFingerSized(page, 'a pin’s sheet, on a phone')
  await sheet.getByRole('button', { name: 'Close' }).tap()
  await expect(sheet).toHaveCount(0)

  // So does a long press.
  await link.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true })
  // (Open, it's a dialog: the page under it, the row too, is out of a screen reader's reach.)
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: 'Unpin' }).tap()
  // In the drawer, a dialog, it stays where it was with its Undo, a finger's size, and a screen
  // reader is told (no toast: under the drawer, it would be out of reach).
  const list = page.getByRole('list', { name: 'Pinned objects' })
  await expect(list.getByRole('listitem')).toHaveCount(1)
  await expect(list).toContainText('Unpinned')
  const undo = list.getByRole('button', { name: 'Undo unpinning Deployment cart' })
  expect(await height(undo)).toBeGreaterThanOrEqual(FINGER)
  await expect(page.getByRole('status').filter({ hasText: 'Unpinned' })).toHaveText(
    'Unpinned Deployment cart.',
  )
  await expectFingerSized(page, 'a pin unpinned in the drawer, on a phone')
  await undo.tap()
  await expect(list.getByRole('link')).toHaveAccessibleName(/^Deployment cart in shop/)

  // Unpinned again, and the drawer closed: it's gone.
  await row.getByRole('button', { name: 'More for Deployment cart' }).tap()
  await sheet.getByRole('button', { name: 'Unpin' }).tap()
  await expect(list).toContainText('Unpinned')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Menu' }).tap()
  await expect(list).toHaveCount(0)
})

test('views on a phone: a square a finger’s size, a sheet, and the open view said under the bar', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(page, `${served.url}cluster/demo/pods?namespaces=shop`, DEMO_TOKEN)
  const button = page.getByRole('button', { name: 'Views', exact: true })
  const size = await button.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return [Math.round(box.width), Math.round(box.height)]
  })
  expect(size).toEqual([FINGER, FINGER])
  await expectNoSidewaysScroll(page, 'a list with its views’ button, on a phone')

  await button.tap()
  const sheet = page.getByRole('dialog', { name: 'Views' })
  await sheet.getByRole('button', { name: 'Save view…' }).tap()
  await sheet.getByPlaceholder('Name this view').fill('Mine')
  await sheet.getByRole('button', { name: 'Save', exact: true }).tap()
  await expect(sheet.getByRole('button', { name: 'Mine', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  )
  await expectFingerSized(page, 'the views’ sheet, on a phone')
  await sheet.getByRole('button', { name: 'Close' }).tap()
  await expect(page.getByRole('button', { name: 'Views: Mine' })).toBeVisible()
  await expect(page.getByText('View: Mine', { exact: true })).toBeVisible()

  await page.getByPlaceholder('Filter pods').fill('cart')
  await expect(page.getByText('View: Mine · changed', { exact: true })).toBeVisible()
})

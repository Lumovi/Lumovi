/**
 * Lumovi's page on a phone: one column at 390 px, the sidebar behind a button, and a few
 * things to do, each a finger's size. Nothing scrolls sideways, held upright or on its side.
 */
import type { Page } from '@playwright/test'
import { DEMO, DEMO_TOKEN, expect, signIn, test } from './fixtures.ts'
import { expectNoSidewaysScroll, PHONE, PHONE_ON_ITS_SIDE } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true })

const menu = (page: Page) => page.getByRole('button', { name: 'Menu' })
const drawer = (page: Page) => page.getByRole('dialog', { name: 'Sidebar' })

test('the sidebar is a drawer: behind a button, holding focus, closed by Escape or going somewhere', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo`, DEMO_TOKEN)
  // No sidebar beside the page, and no back and forward of its own: the browser has them.
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Back/ })).toHaveCount(0)
  await menu(page).click()
  await expect(drawer(page).getByRole('navigation', { name: 'Resources' })).toBeVisible()
  // Focus is in it, and stays in it.
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab')
    expect(await drawer(page).evaluate((d) => d.contains(document.activeElement))).toBe(true)
  }
  // Escape closes it, and focus is back on its button.
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toHaveCount(0)
  await expect(menu(page)).toBeFocused()
  // Going somewhere closes it too.
  await menu(page).click()
  await drawer(page).getByRole('link', { name: 'Pods' }).click()
  await expect(drawer(page)).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  // And the scrim does.
  await menu(page).click()
  await page.mouse.click(PHONE.width - 10, PHONE.height / 2)
  await expect(drawer(page)).toHaveCount(0)
})

test('the overview never scrolls sideways, upright or on its side, in either theme', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo`, DEMO_TOKEN)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview')
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await page.setViewportSize(PHONE)
    await expectNoSidewaysScroll(page, `the overview, ${colorScheme}`)
    await page.setViewportSize(PHONE_ON_ITS_SIDE)
    await expectNoSidewaysScroll(page, `the overview on its side, ${colorScheme}`)
  }
})

test('on a phone an object offers restart and scale, and nothing else, by any way', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signIn(
    page,
    `${served.url}cluster/demo/deployments?open=Deployment/shop/${DEMO.deployments.storefront}`,
    DEMO_TOKEN,
  )
  const detail = page.getByRole('complementary', {
    name: `Deployment ${DEMO.deployments.storefront}`,
  })
  await expect(detail.getByRole('button', { name: 'Scale' })).toBeVisible()
  await expect(detail.getByRole('button', { name: 'Restart' })).toBeVisible()
  // No menu of more, and nothing in the page that isn't offered: not hidden, not there.
  await expect(detail.getByRole('button', { name: 'More actions' })).toHaveCount(0)
  for (const gone of ['Delete', 'Edit YAML', 'Roll back', 'Change image', 'Edit labels']) {
    await expect(page.getByRole('button', { name: new RegExp(`^${gone}`) })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: new RegExp(`^${gone}`) })).toHaveCount(0)
  }
  // Nor by the keys that open the menu or start a delete where there's a keyboard.
  await page.keyboard.press('.')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Backspace')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // With room for them (a tablet), all of them are back.
  await page.setViewportSize({ width: 800, height: 1000 })
  await detail.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitem', { name: /^Delete/ })).toBeVisible()
})

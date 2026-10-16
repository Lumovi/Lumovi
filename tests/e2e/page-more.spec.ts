/**
 * The page's More (⋯), at the end of the bar on every cluster page, Lumovi's own: Copy link to
 * this view, on a plugin's page what the plugin may do, then Keyboard shortcuts. And the palette's
 * Actions there.
 */
import type { Page } from '@playwright/test'
import { CONTEXTS, expect, openCluster, test } from './fixtures.ts'

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)
const bar = (page: Page) => page.locator('header:has(button[aria-label^="Back ("])')
const address = (page: Page) => page.evaluate(() => window.location.hash)

test('every cluster page has the same More: Copy link and Keyboard shortcuts, and on a plugin’s page what it may do between', async ({
  lumovi: { page },
}) => {
  await openCluster(page)
  // Lumovi's own page: its link, a line, and the shortcuts, which it opens.
  await bar(page).getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('menuitem')).toHaveText([
    'Copy link to this view',
    /^Keyboard shortcuts\s*\?$/,
  ])
  await expect(page.getByRole('menu').getByRole('separator')).toHaveCount(1)
  await page.getByRole('menuitem', { name: /^Keyboard shortcuts/ }).click()
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  await page.keyboard.press('Escape')

  // A plugin's page: the same button, what it may do between the link and the shortcuts.
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/argo-cd/overview`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview')
  await bar(page).getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('menuitem')).toHaveText([
    'Copy link to this view',
    'What Argo CD may do',
    /^Keyboard shortcuts/,
  ])
  await expect(page.getByRole('menu').getByRole('separator')).toHaveCount(2)
  await page.getByRole('menuitem', { name: 'What Argo CD may do' }).click()
  await expect.poll(() => address(page)).toBe(`#/cluster/${CONTEXTS.demo}/plugins?plugin=argo-cd`)
})

test('on a plugin’s page the palette’s Actions say what it may do, and go there', async ({
  lumovi: { page },
}) => {
  await openCluster(page)
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('option', { name: /may do/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/argo-cd/overview`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview')
  await page.keyboard.press('ControlOrMeta+k')
  const actions = page.getByRole('group', { name: 'Actions' })
  await expect(actions.getByRole('option', { name: 'What Argo CD may do' })).toBeVisible()
  await page.getByRole('combobox').fill('permissions')
  await expect(page.getByRole('option', { name: 'What Argo CD may do' })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect.poll(() => address(page)).toBe(`#/cluster/${CONTEXTS.demo}/plugins?plugin=argo-cd`)
})

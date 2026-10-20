/**
 * A row of tabs that doesn't fit: never scrolled, wrapped or cut. Those that fit stay in their
 * order and the rest go into More, the row's last stop, a menu; the open tab always has a place
 * in the row. Held as a rule of whatever the row is (fonts differ by platform), not one row.
 */
import type { Locator, Page } from '@playwright/test'
import { DEMO } from '../mock-cluster/fixtures/demo.ts'
import { expect, goTo, openCluster, panel, row, test } from './fixtures.ts'

/** A pod's panel at a true 1024, where its eight tabs don't fit. */
async function podPanel(launch: Parameters<Parameters<typeof test>[2]>[0]['launch']) {
  const { page } = await launch({ env: { LUMOVI_E2E_WINDOW: '1024x768' }, fullLayout: false })
  await openCluster(page)
  await goTo(page, 'Pods')
  await row(page, 'Pods', DEMO.pods.debugShell).getByRole('gridcell').nth(1).click()
  const side = panel(page, 'Pod', DEMO.pods.debugShell)
  await expect(side.getByRole('tablist')).toBeVisible()
  return { page, side }
}

const more = (side: Locator) => side.getByRole('button', { name: 'More tabs' })

/** What the row shows, which is open, what More holds, and whether anything is past its edge. */
async function seen(page: Page, side: Locator) {
  const inRow = await side.getByRole('tab').allInnerTexts()
  const open = await side.getByRole('tab', { selected: true }).innerText()
  let inMore: string[] = []
  if (await more(side).count()) {
    await more(side).click()
    inMore = await page.getByRole('menuitem').allInnerTexts()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
  }
  const past = await side
    .getByRole('tablist')
    .evaluate((list) => list.parentElement!.scrollWidth - list.parentElement!.clientWidth)
  return { inRow, open, inMore, past }
}

test('tabs that don’t fit go into More, in their order; the open one always has a place in the row, and nothing scrolls', async ({
  launch,
}) => {
  const { page, side } = await podPanel(launch)
  // Every tab, in its order: the panel expanded has room for all, and no More.
  await side.getByRole('button', { name: 'Expand panel' }).click()
  await expect(more(side)).toHaveCount(0)
  const all = await side.getByRole('tab').allInnerTexts()
  expect(all).toEqual(['Overview', 'Logs', 'Shell', 'Metrics', 'Map', 'Events', 'Audit', 'YAML'])
  await side.getByRole('button', { name: 'Restore panel' }).click()

  // Beside the list: More, and the row and More together are every tab, in order.
  await expect(more(side)).toBeVisible()
  const atRest = await seen(page, side)
  expect(atRest.past).toBe(0)
  expect(atRest.inMore.length).toBeGreaterThan(0)
  expect([...atRest.inRow, ...atRest.inMore]).toEqual(all)
  expect(atRest.open).toBe('Overview')
  // (More is no tab: the list holds the tabs alone.)
  await expect(side.getByRole('tablist').getByRole('button')).toHaveCount(0)

  // The last of More's chosen: it takes the row's last place before More, open; the row is the
  // same tabs up to it, and More the rest, each in order.
  const last = atRest.inMore.at(-1)!
  await more(side).click()
  await page.getByRole('menuitem', { name: last }).click()
  await expect(side.getByRole('tab', { name: last })).toBeFocused()
  const picked = await seen(page, side)
  expect(picked.open).toBe(last)
  expect(picked.inRow.at(-1)).toBe(last)
  expect(picked.past).toBe(0)
  expect(picked.inMore).not.toContain(last)
  expect([...picked.inRow.slice(0, -1), ...picked.inMore, last]).toEqual(all)
  // Back to a tab of the row: the row is as it was.
  await side.getByRole('tab', { name: 'Overview' }).click()
  expect(await seen(page, side)).toEqual(atRest)
})

test('More from the keyboard: the row’s last stop, its menu opened with its first item lit, a tab chosen there focused in the row', async ({
  launch,
}) => {
  const { page, side } = await podPanel(launch)
  await expect(more(side)).toBeVisible()
  const inRow = await side.getByRole('tab').allInnerTexts()
  // Past the last tab: More (not round to the first).
  await side.getByRole('tab', { name: inRow.at(-1)! }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(more(side)).toBeFocused()
  // And back.
  await page.keyboard.press('ArrowLeft')
  await expect(side.getByRole('tab', { name: inRow.at(-1)! })).toBeFocused()
  // End: More, from anywhere in the row.
  await side.getByRole('tab', { name: 'Overview' }).focus()
  await page.keyboard.press('End')
  await expect(more(side)).toBeFocused()
  // ↓ opens it, its first item lit; Esc closes it, and More has the focus again.
  await page.keyboard.press('ArrowDown')
  const items = page.getByRole('menuitem')
  await expect(items.first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(more(side)).toBeFocused()
  // Enter opens it too; ↓ and Enter choose the second, which is open, in the row, focused.
  await page.keyboard.press('Enter')
  await expect(items.first()).toBeFocused()
  const second = await items.nth(1).innerText()
  await page.keyboard.press('ArrowDown')
  await expect(items.nth(1)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(side.getByRole('tab', { name: second })).toBeFocused()
  await expect(side.getByRole('tab', { name: second })).toHaveAttribute('aria-selected', 'true')
})

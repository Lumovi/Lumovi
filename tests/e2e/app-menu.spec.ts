/**
 * The app's menu on Windows and Linux (LMV-20, LMV-133): their window hides its title bar, and with
 * it the menu bar, so a button in its top left corner, at the same place in every view, opens the
 * application menu under it; so do Alt on its own, and F10. macOS has its menu bar, and no button.
 * The menu itself is the system's: what opens it is recorded here, not drawn.
 */
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { clusterOption, expect, hoverForTooltip, openCluster, test } from './fixtures.ts'

const hasButton = process.platform !== 'darwin'

/** Records where the application menu is opened, and with what, instead of opening it. */
async function recordMenus(app: ElectronApplication) {
  await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()!
    const opened: { x?: number; y?: number; menus: string[] }[] = []
    Object.assign(globalThis, { opened })
    menu.popup = (options = {}) => {
      opened.push({ x: options.x, y: options.y, menus: menu.items.map((item) => item.label) })
      options.callback?.()
    }
  })
  return () => app.evaluate(() => (globalThis as unknown as { opened: unknown[] }).opened.length)
}

/** Once the menu it opened is closed (it opens one at a time). */
const closed = (button: Locator) => expect(button).not.toHaveAttribute('data-state', 'open')

/** The button, where every view has it: 12 px in, centered in the window controls' 52 px band. */
async function expectInTheCorner(page: Page) {
  const button = page.getByRole('button', { name: 'Menu', exact: true })
  await expect(button).toBeVisible()
  // (Zoomed to fit a small screen, a pixel comes out a hair off.)
  expect(await button.boundingBox()).toEqual({
    x: expect.closeTo(12, 0),
    y: expect.closeTo(10, 0),
    width: expect.closeTo(32, 0),
    height: expect.closeTo(32, 0),
  })
  return button
}

test('on Windows and Linux, a button in the window’s corner opens the app’s menu, in every view', async ({
  lumovi,
}) => {
  test.skip(!hasButton, 'macOS has its menu bar')
  const { page, app } = lumovi
  const opened = await recordMenus(app)
  const zoom = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
  )

  // The start screen.
  let button = await expectInTheCorner(page)
  await expect(button).toHaveAttribute('aria-haspopup', 'menu')
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  await hoverForTooltip(button, /Menu\s*Alt/)
  await button.click()
  // The whole menu, 4 px under the button's bottom left corner (in the window's pixels, to the
  // nearest one).
  const last = (await app.evaluate(() =>
    (globalThis as unknown as { opened: unknown[] }).opened.at(-1),
  )) as { x: number; y: number; menus: string[] }
  expect(Math.abs(last.x - 12 * zoom)).toBeLessThanOrEqual(1)
  expect(Math.abs(last.y - 46 * zoom)).toBeLessThanOrEqual(1)
  // (macOS's has its app's own first.)
  expect(last.menus).toEqual([
    ...(process.platform === 'darwin' ? ['Lumovi'] : []),
    ...['File', 'Edit', 'View', 'Go', 'Window', 'Help'],
  ])

  // Alt on its own opens it; Alt with another key doesn't; F10 does.
  await closed(button)
  await page.keyboard.press('Alt')
  await expect.poll(opened).toBe(2)
  await closed(button)
  await page.keyboard.press('Alt+KeyX')
  await page.keyboard.press('F10')
  await expect.poll(opened).toBe(3)

  // In a cluster: the sidebar's top band, the cluster below it.
  await openCluster(page)
  button = await expectInTheCorner(page)
  await button.click()
  await expect.poll(opened).toBe(4)
  const cluster = page.getByRole('button', { name: /^(Switch cluster|Cluster)$/ })
  expect((await cluster.boundingBox())?.y).toBeCloseTo(52 + 12, 0)

  // In a terminal, F10 and Alt are its program's (F10 quits htop): the menu stays shut.
  await closed(button)
  await page.keyboard.press('Control+Backquote')
  await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(1)
  await page.keyboard.press('F10')
  await page.keyboard.press('Alt')
  await page.waitForTimeout(500)
  expect(await opened()).toBe(4)
  await page.keyboard.press('Control+Backquote')

  // A page of its own.
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.getMenuItemById('assistants')!.click(),
  )
  await expect(page.getByRole('heading', { name: /^AI assistants/ })).toBeVisible()
  button = await expectInTheCorner(page)
  await button.click()
  await expect.poll(opened).toBe(5)
})

test('on macOS, the menu bar has it all: no button, and Alt is Option', async ({ lumovi }) => {
  test.skip(hasButton, 'Windows and Linux have the button')
  const { page, app } = lumovi
  const opened = await recordMenus(app)
  await expect(clusterOption(page, 'demo')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toHaveCount(0)
  await page.keyboard.press('Alt')
  await page.keyboard.press('F10')
  expect(await opened()).toBe(0)
})

test('the menu opens only at a point of the page', async ({ lumovi }) => {
  const { page, app } = lumovi
  const opened = await recordMenus(app)
  for (const at of [
    ['12', 46],
    [12, Number.NaN],
    [12, undefined],
  ]) {
    await expect(
      page.evaluate((at) => window.lumovi!.desktop!.openMenu(...(at as [number, number])), at),
    ).rejects.toThrow('two numbers')
  }
  expect(await opened()).toBe(0)
})

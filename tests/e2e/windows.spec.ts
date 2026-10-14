/**
 * More than one window, each with its own pages and its own streams. Another opens from the File
 * menu beside the one in front; two show two clusters at once; what one window's page started (a
 * pod's log, followed) goes on whatever the other does, reloaded or closed, and ends with its own.
 * They open again where they were.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  clusterOption,
  CONTEXTS,
  DEMO,
  expect,
  goTo,
  openCluster,
  panel,
  row,
  test,
} from './fixtures.ts'

/** File → New Window, as chosen in the menu: the window it opens. */
async function newWindow(app: ElectronApplication): Promise<Page> {
  const opened = app.waitForEvent('window')
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.getMenuItemById('new-window')!.click(),
  )
  const page = await opened
  await page.emulateMedia({ reducedMotion: 'reduce' })
  return page
}

const windowCount = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

test('two windows on two clusters: each window’s log is its own, and goes on whatever the other does', async ({
  launch,
  clusters,
}) => {
  const { app, page } = await launch()
  await openCluster(page)
  const second = await newWindow(app)
  await openCluster(second, CONTEXTS.sandbox)
  // Each its own cluster.
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toContainText(CONTEXTS.demo)
  await expect(second.getByRole('button', { name: 'Switch cluster' })).toContainText(
    CONTEXTS.sandbox,
  )

  // A pod's log, followed in the first window.
  const pod = DEMO.pods.storefront[0]!
  await goTo(page, 'Pods')
  await page.getByPlaceholder('Filter pods').fill(pod)
  await row(page, 'Pods', pod).first().click()
  const detail = panel(page, 'Pod', pod)
  await detail.getByRole('tab', { name: 'Logs' }).click()
  const log = detail.getByRole('log')
  clusters.demo.appendLogs('shop', pod, 'app', ['before the other window reloads'])
  await expect(log).toContainText('before the other window reloads')
  await expect.poll(() => clusters.demo.logFollowers()).toBe(1)

  // The other window reloads: the first's log goes on, its lines heard there.
  await second.reload()
  await expect(second.getByRole('button', { name: 'Switch cluster' })).toContainText(
    CONTEXTS.sandbox,
  )
  clusters.demo.appendLogs('shop', pod, 'app', ['after the other window reloaded'])
  await expect(log).toContainText('after the other window reloaded')
  expect(clusters.demo.logFollowers()).toBe(1)

  // The other window closes: the first goes on.
  await (await app.browserWindow(second)).evaluate((win) => win.close())
  await expect.poll(() => windowCount(app)).toBe(1)
  clusters.demo.appendLogs('shop', pod, 'app', ['after the other window closed'])
  await expect(log).toContainText('after the other window closed')
  expect(clusters.demo.logFollowers()).toBe(1)
})

test('a window’s log ends with its window, and the other windows go on', async ({
  launch,
  clusters,
}) => {
  const { app } = await launch()
  const second = await newWindow(app)
  await openCluster(second)
  const pod = DEMO.pods.storefront[0]!
  await goTo(second, 'Pods')
  await second.getByPlaceholder('Filter pods').fill(pod)
  await row(second, 'Pods', pod).first().click()
  await panel(second, 'Pod', pod).getByRole('tab', { name: 'Logs' }).click()
  await expect.poll(() => clusters.demo.logFollowers()).toBe(1)
  await (await app.browserWindow(second)).evaluate((win) => win.close())
  await expect.poll(() => clusters.demo.logFollowers()).toBe(0)
  expect(await windowCount(app)).toBe(1)
})

test('the palette opens a new window too: on the start screen, the size of the one asked from, just below it', async ({
  launch,
}) => {
  const { app, page } = await launch()
  await openCluster(page)
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('palette')!.click())
  const opened = app.waitForEvent('window')
  await page
    .getByRole('dialog', { name: 'Command palette' })
    .getByRole('option', { name: /^New window/ })
    .click()
  const second = await opened
  await expect(clusterOption(second, CONTEXTS.demo)).toBeVisible()
  const [first, next] = await Promise.all(
    [page, second].map(async (each) =>
      (await app.browserWindow(each)).evaluate((win) => win.getBounds()),
    ),
  )
  // Just below it, where its display has room for that; on one no wider than the window (a
  // macOS runner's is 1024 points, Lumovi's least width), the system keeps it on the screen.
  const area = await app.evaluate(
    ({ screen }, bounds) => screen.getDisplayMatching(bounds).workArea,
    first!,
  )
  const room =
    first!.x + 24 + first!.width <= area.x + area.width &&
    first!.y + 24 + first!.height <= area.y + area.height
  expect(next).toMatchObject({
    ...(room ? { x: first!.x + 24, y: first!.y + 24 } : {}),
    width: first!.width,
    height: first!.height,
  })
  if (!room) {
    expect(next!.x).toBeGreaterThanOrEqual(area.x)
    expect(next!.x + next!.width).toBeLessThanOrEqual(area.x + area.width)
  }
})

test('the windows open again where they were', async ({ launch }) => {
  // (Lumovi launched, quit and launched again in one test: on a Windows runner, most of a minute.)
  test.slow()
  const first = await launch()
  await newWindow(first.app)
  expect(await windowCount(first.app)).toBe(2)
  const userDataDir = first.userDataDir
  await first.close()
  const settings = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8'))
  expect(settings.windows).toHaveLength(2)

  const again = await launch({ userDataDir })
  await expect.poll(() => windowCount(again.app)).toBe(2)
  // Each where it was as Lumovi quit, as it kept it. (Where a display had no room for the second
  // just below the first, the system put it where that was: there, too.)
  const bounds = await again.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .map((win) => ({ id: win.id, ...win.getBounds() }))
      .sort((a, b) => a.id - b.id),
  )
  for (const [i, kept] of (settings.windows as { x: number; y: number }[]).entries()) {
    expect(Math.abs(bounds[i]!.x - kept.x), `window ${i + 1}'s x`).toBeLessThanOrEqual(2)
    expect(Math.abs(bounds[i]!.y - kept.y), `window ${i + 1}'s y`).toBeLessThanOrEqual(2)
  }
  await again.close()
})

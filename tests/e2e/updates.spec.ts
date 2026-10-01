import type { ElectronApplication } from '@playwright/test'
import { toasts } from './action-helpers.ts'
import { expect, mockOpenExternal, test } from './fixtures.ts'

/** The harness's stand-in for electron-updater, in the main process. */
interface FakeUpdater {
  checks: number
  installs: number
  result: object | null
  emit(event: string, arg?: unknown): void
}

/** Plays electron-updater's part: an event, as a check or download would send it. */
function emit(app: ElectronApplication, event: string, arg?: unknown) {
  return app.evaluate(
    (_electron, [event, arg]) => {
      const updater = (globalThis as unknown as { __updater: FakeUpdater }).__updater
      updater.emit(event as string, event === 'error' ? new Error(arg as string) : arg)
    },
    [event, arg] as const,
  )
}

const fake = (app: ElectronApplication) =>
  app.evaluate(() => {
    const { checks, installs } = (globalThis as unknown as { __updater: FakeUpdater }).__updater
    return { checks, installs }
  })

/** What the next check resolves to; null when the app can't update itself. */
const checksResolveTo = (app: ElectronApplication, result: object | null) =>
  app.evaluate((_electron, result) => {
    ;(globalThis as unknown as { __updater: FakeUpdater }).__updater.result = result
  }, result)

const menu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.click(), id)

// The page listens for updates once it's up; the start screen showing means it is.
test.beforeEach(async ({ page }) => {
  await expect(page.getByPlaceholder('Search clusters…')).toBeVisible()
})

test('a new version downloads in the background, then installs on restart', async ({
  kubestacks,
}) => {
  const { app, page } = kubestacks
  const opened = await mockOpenExternal(app)
  // Nothing to install yet.
  await page.evaluate(() => window.kubestacks.updates.install())
  expect((await fake(app)).installs).toBe(0)

  await emit(app, 'checking-for-update')
  await emit(app, 'update-available', { version: '9.9.9' })
  await emit(app, 'download-progress', { percent: 41.7 })
  expect(await page.evaluate(() => window.kubestacks.updates.state())).toEqual({
    state: { status: 'downloading', version: '9.9.9', percent: 41 },
    manual: false,
  })
  // In the background, nothing to say until it's ready.
  await expect(toasts(page)).toBeEmpty()

  await emit(app, 'update-downloaded', { version: '9.9.9' })
  const notice = page.getByRole('status', { name: 'Update' })
  await expect(notice).toContainText('KubeStacks 9.9.9 is ready')
  await notice.getByRole('button', { name: 'What’s new' }).click()
  await expect.poll(opened).toEqual(['https://github.com/kotapeter/kubestacks/releases/tag/v9.9.9'])
  // The main process keeps it: still there after a reload.
  await page.reload()
  await expect(notice).toContainText('KubeStacks 9.9.9 is ready')
  await notice.getByRole('button', { name: 'Restart now' }).click()
  await expect.poll(async () => (await fake(app)).installs).toBe(1)
  await notice.getByRole('button', { name: 'Later' }).click()
  await expect(notice).toHaveCount(0)
})

test('Check for Updates says what it found', async ({ kubestacks }) => {
  const { app, page } = kubestacks
  const opened = await mockOpenExternal(app)
  const notifications = toasts(page)

  await menu(app, 'check-updates')
  await expect.poll(async () => (await fake(app)).checks).toBeGreaterThan(0)
  await emit(app, 'checking-for-update')
  await emit(app, 'update-not-available')
  await expect(notifications).toContainText('KubeStacks is up to date')

  await menu(app, 'check-updates')
  await emit(app, 'error', 'net::ERR_INTERNET_DISCONNECTED')
  await expect(notifications).toContainText('Couldn’t check for updates')
  await expect(notifications).toContainText('net::ERR_INTERNET_DISCONNECTED')

  // A copy that can't update itself (while developing it, say) points to the downloads.
  await checksResolveTo(app, null)
  await menu(app, 'check-updates')
  await expect(notifications).toContainText('This copy of KubeStacks doesn’t update itself')
  await notifications.getByRole('button', { name: 'Download' }).click()
  await expect.poll(opened).toEqual(['https://github.com/kotapeter/kubestacks/releases/latest'])

  // From the page, too.
  await checksResolveTo(app, {})
  await page.evaluate(() => window.kubestacks.updates.check())
  await emit(app, 'update-available', { version: '9.9.9' })
  await expect(notifications).toContainText('Downloading KubeStacks 9.9.9…')
  await emit(app, 'update-downloaded', { version: '9.9.9' })
  const notice = page.getByRole('status', { name: 'Update' })
  await notice.getByRole('button', { name: 'Later' }).click()
  await expect(notice).toHaveCount(0)
  // Asked again, the answer is the version waiting to be installed.
  await menu(app, 'check-updates')
  await expect(notice).toContainText('KubeStacks 9.9.9 is ready')
})

test('checks in the background stay quiet, and can be turned off', async ({ kubestacks }) => {
  const { app, page } = kubestacks
  // The first one comes a few seconds after starting.
  await expect.poll(async () => (await fake(app)).checks, { timeout: 10_000 }).toBe(1)
  await emit(app, 'checking-for-update')
  await emit(app, 'error', 'getaddrinfo ENOTFOUND github.com')
  await emit(app, 'update-not-available')
  await expect(toasts(page)).toBeEmpty()

  const autoUpdate = () =>
    page.evaluate(async () => (await window.kubestacks.app.settings()).autoUpdate)
  await menu(app, 'auto-updates')
  expect(await autoUpdate()).toBe(false)
  await menu(app, 'auto-updates')
  expect(await autoUpdate()).toBe(true)
})

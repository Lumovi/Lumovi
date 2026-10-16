/**
 * A tab below moved into a window of its own (its tab's menu, Move to a new window): the tab
 * alone, under a band that names it, over the window it came from. A terminal's shell goes on
 * there, running, and back again with Put back below; with no other window to go back to, its
 * window becomes Lumovi's own. Quit, it opens again where it was.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { holds } from '../holds.ts'
import { DEMO_TOKEN, writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { DEMO, expect, goTo, openCluster, PACKAGED, panel, row, test } from './fixtures.ts'

const WINDOWS = process.platform === 'win32'

const below = (page: Page) => page.getByRole('region', { name: 'Tabs below', exact: true })
const tabs = (page: Page) => below(page).getByRole('tablist', { name: 'Tabs below' })
/** What a terminal shows: below, or alone in its window. */
const screen = (page: Page) =>
  page.getByRole('region', { name: /^Terminal / }).locator('.xterm-rows')

const windowCount = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

/** A tab's menu, Move to a new window: the window it opens. */
async function moveOut(app: ElectronApplication, page: Page, tab: RegExp | string) {
  const opened = app.waitForEvent('window')
  await tabs(page).getByRole('tab', { name: tab }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to a new window' }).click()
  const moved = await opened
  await moved.emulateMedia({ reducedMotion: 'reduce' })
  await expect(moved.getByRole('button', { name: 'Put back below' })).toBeVisible()
  return moved
}

/** The window whose title starts so. */
async function windowTitled(app: ElectronApplication, start: string): Promise<Page> {
  let found: Page | undefined
  await expect
    .poll(async () => {
      for (const each of app.windows()) if ((await each.title()).startsWith(start)) found = each
      return found !== undefined
    })
    .toBe(true)
  return found!
}

/** Types a line into the terminal shown, and runs it. */
async function run(page: Page, line: string) {
  await page.getByRole('region', { name: /^Terminal / }).click()
  await page.keyboard.type(line)
  await page.keyboard.press('Enter')
}

/** A pod's logs, kept open below. */
async function keepLogs(page: Page, pod: string) {
  await goTo(page, 'Pods')
  await page.getByPlaceholder('Filter pods').fill(pod)
  await row(page, 'Pods', pod).first().click()
  const detail = panel(page, 'Pod', pod)
  await detail.getByRole('tab', { name: 'Logs' }).click()
  await detail.getByRole('button', { name: 'Keep open below' }).click()
  await expect(tabs(page).getByRole('tab', { name: `Pod ${pod}, Logs` })).toBeVisible()
}

test('a terminal moved to a window of its own goes on with its shell there, and back below', async ({
  launch,
}) => {
  // (Windows PowerShell can take most of a minute to give a prompt on a busy runner.)
  test.slow(WINDOWS)
  const { app, page } = await launch({ env: { SHELL: '/bin/sh' } })
  await openCluster(page)
  await page.keyboard.press('Control+Shift+Backquote')
  await expect
    .poll(async () => /in this terminal\..*[$#>]/s.test((await screen(page).textContent()) ?? ''), {
      timeout: 60_000,
    })
    .toBe(true)
  // Something only this shell knows.
  await run(page, WINDOWS ? `$X='kept'` : 'X=kept')

  const moved = await moveOut(app, page, /^demo/)
  await expect(tabs(page).getByRole('tab')).toHaveCount(0)
  await expect(moved).toHaveTitle('Terminal · demo — Lumovi')
  // What it showed came with it, and it's the same shell, running.
  await expect(screen(moved)).toContainText('in this terminal.')
  await run(moved, 'echo "moved-$X"')
  await expect(screen(moved)).toContainText('moved-kept')
  // A window smaller than Lumovi's own, as small as a tab below goes.
  const window = await app.browserWindow(moved)
  expect(await window.evaluate((win) => win.getMinimumSize())).toEqual([560, 360])

  // Put back: below, in the window it came from, its shell still the same.
  await moved.getByRole('button', { name: 'Put back below' }).click()
  await expect.poll(() => windowCount(app)).toBe(1)
  await expect(tabs(page).getByRole('tab')).toHaveCount(1)
  await run(page, 'echo "back-$X"')
  await expect(screen(page)).toContainText('back-kept')
})

/** Waits for the terminal shown below to have its shell's prompt. */
async function prompted(page: Page) {
  await expect
    .poll(async () => /in this terminal\..*[$#>]/s.test((await screen(page).textContent()) ?? ''), {
      timeout: 60_000,
    })
    .toBe(true)
}

test('a terminal’s window closed before its page takes the shell ends that shell', async ({
  launch,
}) => {
  test.slow(WINDOWS)
  test.skip(PACKAGED, 'The packaged app runs without the tests’ counters of its shells.')
  const { app, page } = await launch({ env: { SHELL: '/bin/sh' } })
  await openCluster(page)
  await page.keyboard.press('Control+Shift+Backquote')
  await prompted(page)
  // The new window goes as soon as it's there: before its page could ask for the shell.
  await app.evaluate(({ app }) => {
    app.once('browser-window-created', (_event, win) => setImmediate(() => win.destroy()))
  })
  await tabs(page).getByRole('tab', { name: /^demo/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to a new window' }).click()
  await expect.poll(() => windowCount(app)).toBe(1)
  await expect(tabs(page).getByRole('tab')).toHaveCount(0)
  // Its shell's ended, not left running where no one sees it.
  await expect
    .poll(() =>
      app.evaluate(
        () => (globalThis as unknown as { __ptys: { ended: number | null }[] }).__ptys[0]!.ended,
      ),
    )
    .not.toBeNull()
})

test('a terminal whose shell exits in its own window has nothing to put back below', async ({
  launch,
}) => {
  test.slow(WINDOWS)
  const { app, page } = await launch({ env: { SHELL: '/bin/sh' } })
  await openCluster(page)
  await page.keyboard.press('Control+Shift+Backquote')
  await prompted(page)
  const moved = await moveOut(app, page, /^demo/)
  await run(moved, 'exit')
  await expect(moved.getByText('The shell exited with code 0.')).toBeVisible()
  await expect(moved.getByRole('button', { name: 'Put back below' })).toHaveCount(0)
})

test('a kept pod in a window of its own: its logs go on there, named in its band, and closing the window closes it', async ({
  launch,
  clusters,
}) => {
  const { app, page } = await launch()
  const pod = DEMO.pods.storefront[0]!
  await openCluster(page)
  await keepLogs(page, pod)
  const moved = await moveOut(app, page, `Pod ${pod}, Logs`)
  await expect(tabs(page).getByRole('tab')).toHaveCount(0)
  await expect(moved).toHaveTitle(`${pod}, Logs · demo — Lumovi`)
  await expect(moved.getByRole('banner')).toContainText(`${pod}Logs · shop · demo`)
  // There's no panel here to open it in.
  await expect(moved.getByRole('button', { name: 'Open in the panel' })).toHaveCount(0)
  clusters.demo.appendLogs('shop', pod, 'app', ['said in its own window'])
  await expect(moved.getByRole('log')).toContainText('said in its own window')

  // Closed, it's gone: not back below.
  await (await app.browserWindow(moved)).evaluate((win) => win.close())
  await expect.poll(() => windowCount(app)).toBe(1)
  await expect(tabs(page).getByRole('tab')).toHaveCount(0)
})

test('with no other window to go back to, a tab’s window becomes Lumovi’s own, the tab below; quit with only it, it opens again so', async ({
  launch,
}) => {
  test.slow()
  const pod = DEMO.pods.storefront[0]!
  const first = await launch()
  await openCluster(first.page)
  await keepLogs(first.page, pod)
  await moveOut(first.app, first.page, `Pod ${pod}, Logs`)
  await (await first.app.browserWindow(first.page)).evaluate((win) => win.close())
  await expect.poll(() => windowCount(first.app)).toBe(1)
  // Quit with only the tab's window: it opens again as Lumovi's own, the tab below.
  const userDataDir = first.userDataDir
  await first.close()

  const again = await launch({ userDataDir })
  await expect(again.page.getByRole('button', { name: 'Switch cluster' })).toContainText('demo')
  await expect(tabs(again.page).getByRole('tab', { name: `Pod ${pod}, Logs` })).toBeVisible()
  await expect.poll(() => windowCount(again.app)).toBe(1)

  // And put back with no other window: this one becomes Lumovi's own, on the tab's cluster.
  const out = await moveOut(again.app, again.page, `Pod ${pod}, Logs`)
  await (await again.app.browserWindow(again.page)).evaluate((win) => win.close())
  await expect.poll(() => windowCount(again.app)).toBe(1)
  await out.getByRole('button', { name: 'Put back below' }).click()
  await expect(out.getByRole('button', { name: 'Switch cluster' })).toContainText('demo')
  await expect(tabs(out).getByRole('tab', { name: `Pod ${pod}, Logs` })).toBeVisible()
  expect(
    await (await again.app.browserWindow(out)).evaluate((win) => win.getMinimumSize()),
  ).toEqual([1024, 640])
})

test('quit with a terminal in a window of its own, it opens again there, ended, its shell started only when asked', async ({
  launch,
}) => {
  test.slow()
  const first = await launch({ env: { SHELL: '/bin/sh' } })
  await openCluster(first.page)
  await first.page.keyboard.press('Control+Shift+Backquote')
  await expect
    .poll(
      async () => /in this terminal\..*[$#>]/s.test((await screen(first.page).textContent()) ?? ''),
      { timeout: 60_000 },
    )
    .toBe(true)
  await tabs(first.page).getByRole('tab', { name: /^demo/ }).click({ button: 'right' })
  await first.page.getByRole('menuitem', { name: 'Rename…' }).click()
  await first.page.keyboard.type('migrations')
  await first.page.keyboard.press('Enter')
  await moveOut(first.app, first.page, 'migrations')
  // (What a window has is said a moment after it changes.)
  await new Promise((settle) => setTimeout(settle, 1_000))
  const userDataDir = first.userDataDir
  await first.close()

  const again = await launch({ userDataDir, env: { SHELL: '/bin/sh' } })
  await expect.poll(() => windowCount(again.app)).toBe(2)
  const moved = await windowTitled(again.app, 'migrations')
  await expect(moved).toHaveTitle('migrations · demo — Lumovi')
  await expect(moved.getByRole('tabpanel')).toContainText('The shell ended when Lumovi quit.')
  await moved.getByRole('button', { name: 'Start a new shell' }).click()
  await expect(moved.getByRole('tabpanel')).not.toContainText('The shell ended when Lumovi quit.')
})

test('a kept pod’s window opened again on a cluster that signs in through a program waits to be asked before it’s read', async ({
  launch,
  clusters,
}) => {
  const { url, caPem } = clusters.demo
  const pod = DEMO.pods.storefront[0]!
  const tools = mkdtempSync(join(tmpdir(), 'lumovi-plugin-'))
  const ran = join(tools, 'ran')
  const plugin = join(tools, 'credential.mjs')
  writeFileSync(
    plugin,
    `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(ran)}, 'ran\\n')
console.log(JSON.stringify({ apiVersion: 'client.authentication.k8s.io/v1', kind: 'ExecCredential', status: { token: ${JSON.stringify(DEMO_TOKEN)} } }))
`,
  )
  const kubeconfig = writeKubeconfig(mkdtempSync(join(tmpdir(), 'lumovi-kubeconfig-')), {
    currentContext: 'plugged',
    clusters: [{ name: 'plugged', server: url, caPem }],
    users: [{ name: 'plugged', exec: { command: process.execPath, args: [plugin] } }],
    contexts: [{ name: 'plugged', cluster: 'plugged', user: 'plugged' }],
  })
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({
      theme: 'system',
      // (Alone: a start screen beside it checks each cluster itself, another matter.)
      windows: [
        {
          x: 80,
          y: 80,
          width: 980,
          height: 560,
          maximized: false,
          tab: {
            kind: 'kept',
            context: 'plugged',
            object: { kind: 'Pod', name: pod, namespace: 'shop' },
            tab: 'logs',
          },
        },
      ],
    }),
  )
  const { app } = await launch({ userDataDir, env: { KUBECONFIG: kubeconfig } })
  const moved = await windowTitled(app, pod)
  await expect(moved.getByRole('button', { name: 'Read it now' })).toBeVisible()
  await holds(() => !existsSync(ran), 3_000, 'nothing signs in before it’s asked')
  await moved.getByRole('button', { name: 'Read it now' }).click()
  await expect.poll(() => existsSync(ran), { timeout: 15_000 }).toBe(true)
  await expect(moved.getByRole('log')).toBeVisible()
})

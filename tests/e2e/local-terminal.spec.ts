/**
 * Terminals on this computer: a dock under a cluster's pages, each tab your
 * shell with kubectl pointed at a cluster (in that terminal only), and the
 * commands Lumovi shows pasted in to run.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { dialog, open, writes } from './action-helpers.ts'
import { CONTEXTS, DEMO, expect, goTo, openCluster, panel, row, test } from './fixtures.ts'

const WINDOWS = process.platform === 'win32'
const MAC = process.platform === 'darwin'

/**
 * A key as the system sends it, before the menu has it (as Playwright's keys
 * aren't): for macOS's ⌘ keys, which the menu would otherwise take.
 */
async function native(app: ElectronApplication, keyCode: string, modifiers: string[]) {
  await app.evaluate(
    ({ BrowserWindow }, [keyCode, modifiers]) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents
      for (const type of ['keyDown', 'char', 'keyUp'] as const) {
        contents.sendInputEvent({ type, keyCode, modifiers: modifiers as never })
      }
    },
    [keyCode, modifiers] as const,
  )
}
/** A plain shell, so prompts are predictable (Windows: PowerShell, whatever SHELL says). */
const SHELL = { SHELL: '/bin/sh' }
const REPORT = resolve('tests/e2e/terminal/kubeconfig.mjs')

const dock = (page: Page) => page.getByRole('region', { name: 'Terminal', exact: true })
/** What the shown terminal shows. */
const screen = (page: Page) =>
  dock(page).getByRole('tabpanel').getByRole('region').locator('.xterm-rows')

/** The line the cursor is on: what's typed at the prompt. */
async function inputLine(page: Page) {
  const rows = await screen(page).locator('> div').allInnerTexts()
  return (
    rows
      .map((row) => row.trim())
      .filter(Boolean)
      .at(-1) ?? ''
  )
}

/** Waits for the shell's prompt (after Lumovi's line), and for the terminal to have focus. */
async function ready(page: Page) {
  await expect(screen(page)).toContainText(/in this terminal\..*[$#>]/s)
  await focused(page)
}

/** Waits for a terminal to have focus. */
async function focused(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')),
    )
    .toBe(true)
}

/** Runs the report of what kubectl uses, in the terminal that has focus. */
async function report(page: Page) {
  const command = WINDOWS
    ? `& '${process.execPath}' '${REPORT}'`
    : `'${process.execPath}' '${REPORT}'`
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

test('a terminal on this computer, with kubectl pointed at the cluster', async ({ launch }) => {
  const { page } = await launch({ env: SHELL })
  await openCluster(page)
  // ⌃` opens it, with a terminal for the cluster that's open.
  const bar = dock(page).getByRole('button', { name: 'Terminal', exact: true })
  await page.keyboard.press('Control+Backquote')
  await expect(bar).toHaveAttribute('aria-expanded', 'true')
  const tabs = dock(page).getByRole('tablist', { name: 'Terminals' })
  await expect(tabs.getByRole('tab')).toHaveText(['demo'])
  await expect(screen(page)).toContainText('› kubectl points at demo in this terminal.')
  await ready(page)
  await report(page)
  await expect(screen(page)).toContainText(
    'kubectl: context=demo namespace=- then=1 file(s) found=1 term=Lumovi',
  )
  const text = await screen(page).innerText()
  const kubeconfig = /kubeconfig: \[(.+?)\]/.exec(text.replace(/\s*\n\s*/g, ''))?.[1]

  // Each terminal is its own: in the namespace picked, it's that namespace's.
  await page.getByRole('button', { name: 'Namespace' }).click()
  await page.getByPlaceholder('Find a namespace…').fill('shop')
  await page.keyboard.press('Enter')
  await dock(page)
    .getByRole('button', { name: /^New terminal/ })
    .click()
  await expect(tabs.getByRole('tab')).toHaveText(['demo', 'demoshop'])
  await expect(tabs.getByRole('tab').last()).toHaveAccessibleName('demo, namespace shop')
  await expect(screen(page)).toContainText(
    '› kubectl points at demo, namespace shop, in this terminal.',
  )
  await ready(page)
  await report(page)
  await expect(screen(page)).toContainText('context=demo namespace=shop')
  // The first one's still there, as it was.
  await tabs.getByRole('tab', { name: 'demo', exact: true }).click()
  await expect(screen(page)).toContainText('namespace=-')

  // Hidden and shown again, nothing's lost; nor across pages and clusters.
  await page.keyboard.press('Control+Backquote')
  await expect(bar).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Control+Backquote')
  await expect(screen(page)).toContainText('namespace=-')
  await page.getByRole('button', { name: 'Switch cluster' }).click()
  await page.getByRole('dialog').getByRole('option', { name: CONTEXTS.sandbox }).click()
  await expect(tabs.getByRole('tab')).toHaveText(['demo', 'demoshop'])
  // Nor on the start screen, which has no dock: back at a cluster, they're as they were.
  await page.locator('#content').focus()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: 'All clusters' }).click()
  await expect(dock(page)).toHaveCount(0)
  await openCluster(page)
  await expect(tabs.getByRole('tab')).toHaveText(['demo', 'demoshop'])
  await expect(screen(page)).toContainText('namespace=-')

  // A shell that exits says so, and starts again in its tab.
  await tabs.getByRole('tab', { name: 'demo, namespace shop' }).click()
  await ready(page)
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await expect(tabs.getByRole('tab', { name: 'demo, namespace shop, exited' })).toBeVisible()
  const notice = dock(page).getByRole('status')
  await expect(notice).toContainText('The shell exited with code 0.')
  await notice.getByRole('button', { name: 'Restart' }).click()
  await expect(tabs.getByRole('tab')).toHaveText(['demo', 'demoshop'])
  await expect(screen(page)).toContainText('namespace shop, in this terminal.')

  // Closing a tab ends its shell; closing the last hides the dock.
  await dock(page).getByRole('button', { name: 'Close the terminal demo', exact: true }).click()
  await expect(tabs.getByRole('tab')).toHaveText(['demoshop'])
  await expect.poll(() => existsSync(kubeconfig!)).toBe(false)
  await dock(page).getByRole('button', { name: 'Close the terminal demo, namespace shop' }).click()
  await expect(bar).toHaveAttribute('aria-expanded', 'false')
})

test('the bar at the bottom, and the dock’s own keys', async ({ launch }) => {
  const { page, app } = await launch({ env: SHELL })
  await openCluster(page)
  // Always there, a thin bar: it opens with a click.
  const bar = dock(page).getByRole('button', { name: 'Terminal', exact: true })
  await expect(bar).toHaveAttribute('aria-expanded', 'false')
  await bar.click()
  const tabs = dock(page).getByRole('tablist', { name: 'Terminals' })
  await expect(tabs.getByRole('tab')).toHaveText(['demo'])
  await expect(bar).toHaveAttribute('aria-expanded', 'true')
  await ready(page)

  // In the terminal, a new one (⌃⇧` everywhere; and ⌘T or ⌘N on macOS, Ctrl+Shift+T
  // elsewhere), the next and the one before, and one closed (⌘W, Ctrl+Shift+W).
  await page.keyboard.press('Control+Shift+Backquote')
  await expect(tabs.getByRole('tab')).toHaveCount(2)
  await ready(page)
  if (MAC) await native(app, 'T', ['meta'])
  else await page.keyboard.press('Control+Shift+KeyT')
  await expect(tabs.getByRole('tab')).toHaveCount(3)
  await expect(tabs.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true')
  await ready(page)
  await page.keyboard.press('Control+PageDown')
  await expect(tabs.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Control+PageUp')
  await expect(tabs.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true')
  if (MAC) {
    await page.keyboard.press('Meta+Shift+BracketLeft')
    await expect(tabs.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Meta+Shift+BracketRight')
    await expect(tabs.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true')
    // ⌘N too, not the menu's New from YAML; and ⌘K clears it, as Terminal's do.
    await ready(page)
    await page.keyboard.type('echo before-clear')
    await page.keyboard.press('Enter')
    await expect(screen(page)).toContainText('before-clear')
    await native(app, 'K', ['meta'])
    await expect(screen(page)).not.toContainText('before-clear')
    await native(app, 'N', ['meta'])
    await expect(tabs.getByRole('tab')).toHaveCount(4)
    await ready(page)
    // ⌘W closes it, not the window; the one cleared shows again, as it was.
    await native(app, 'W', ['meta'])
    await expect(tabs.getByRole('tab')).toHaveCount(3)
    await expect(screen(page)).not.toContainText('in this terminal')
    await focused(page)
    await native(app, 'W', ['meta'])
  } else {
    await page.keyboard.press('Control+Shift+KeyW')
  }
  await expect(tabs.getByRole('tab')).toHaveCount(2)
  await ready(page)
  await page.keyboard.press('Control+Shift+KeyW')
  await expect(tabs.getByRole('tab')).toHaveCount(1)
  // Closed, the bar shows what runs; a tab there opens it.
  await page.keyboard.press('Control+Backquote')
  await expect(bar).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#content')).toBeFocused()
  // Its keys do nothing then; ⌘T and ⌘N are the menu's again (New from YAML).
  await page.keyboard.press('Control+PageDown')
  if (MAC) {
    await native(app, 'N', ['meta'])
    await expect(dialog(page).getByRole('textbox', { name: 'YAML to create' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toBeHidden()
  }
  await expect(tabs.getByRole('tab')).toHaveCount(1)
  await tabs.getByRole('tab').click()
  await expect(bar).toHaveAttribute('aria-expanded', 'true')
  await ready(page)

  // Renamed: F2 on its tab, Enter keeps it. (Its other keys are a button's: Enter shows it.)
  const tab = tabs.getByRole('tab').first()
  await tab.focus()
  await page.keyboard.press('Enter')
  await focused(page)
  await tab.focus()
  await page.keyboard.press('F2')
  const name = tabs.getByRole('textbox', { name: 'Terminal name' })
  await expect(name).toBeFocused()
  await name.fill('deploys')
  await page.keyboard.press('Enter')
  await expect(tabs.getByRole('tab')).toHaveText(['deploys'])
  await expect(dock(page).getByRole('tabpanel').getByRole('region')).toHaveAccessibleName(
    'Terminal deploys',
  )
  // Double-clicked, Escape leaves it as it was; an empty name goes back to the cluster's.
  await tabs.getByRole('tab').dblclick()
  await name.fill('nope')
  await name.press('Escape')
  await expect(tabs.getByRole('tab')).toHaveText(['deploys'])
  await tabs.getByRole('tab').dblclick()
  await name.fill('  ')
  await name.press('Enter')
  await expect(tabs.getByRole('tab')).toHaveText(['demo'])

  // Its menu: renamed, another like it, the others closed, closed.
  await tabs.getByRole('tab').click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^Rename/ }).click()
  await expect(name).toBeFocused()
  await name.fill('logs')
  await name.blur()
  await expect(tabs.getByRole('tab')).toHaveText(['logs'])
  await tabs.getByRole('tab').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'New terminal like it' }).click()
  await expect(tabs.getByRole('tab')).toHaveText(['logs', 'demo'])
  // (Each its own name.)
  await tabs.getByRole('tab', { name: 'demo' }).dblclick()
  await name.fill('tail')
  await name.press('Enter')
  await expect(tabs.getByRole('tab')).toHaveText(['logs', 'tail'])
  // One that isn't shown is, once it's renamed; its name keeps focus meanwhile.
  await tabs.getByRole('tab', { name: 'logs' }).focus()
  await page.keyboard.press('F2')
  await page.waitForTimeout(100)
  await expect(name).toBeFocused()
  await name.press('Escape')
  await expect(tabs.getByRole('tab', { name: 'logs' })).toHaveAttribute('aria-selected', 'true')
  await tabs.getByRole('tab', { name: 'logs' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Close the others' }).click()
  await expect(tabs.getByRole('tab')).toHaveText(['logs'])
  await tabs.getByRole('tab').click({ button: 'right' })
  await page
    .getByRole('menuitem', { name: /^Close/ })
    .first()
    .click()
  await expect(bar).toHaveAttribute('aria-expanded', 'false')
  await expect(tabs.getByRole('tab')).toHaveCount(0)
  // And the shortcuts are listed.
  await page.locator('#content').focus()
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toContainText(
    'New terminal',
  )
})

test('the dock’s size, and terminals for every cluster', async ({ launch }) => {
  const { page } = await launch({ env: SHELL })
  await openCluster(page)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: /^New terminal/ }).click()
  const bar = dock(page).getByRole('button', { name: 'Terminal', exact: true })
  await expect(bar).toHaveAttribute('aria-expanded', 'true')
  // It has focus: typing goes there.
  await ready(page)
  await page.keyboard.type('echo typed-$((40 + 2))')
  await page.keyboard.press('Enter')
  await expect(screen(page)).toContainText('typed-42')

  // Taller with the keyboard; maximized and back.
  const resize = dock(page).getByRole('separator', { name: 'Resize the terminal' })
  const height = async () => (await dock(page).boundingBox())!.height
  const before = await height()
  await resize.focus()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await expect.poll(height).toBeGreaterThan(before + 40)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Home')
  await dock(page).getByRole('button', { name: 'Maximize the terminal' }).click()
  await expect.poll(height).toBeGreaterThan(before * 1.5)
  await dock(page).getByRole('button', { name: 'Restore the terminal' }).click()
  // Dragged: as tall as it may be at most.
  const box = (await resize.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, 0, { steps: 4 })
  await page.mouse.up()
  // (As tall as most of what it shares with the page.)
  const shared = (await dock(page).locator('xpath=..').boundingBox())!.height
  await expect.poll(height).toBeLessThanOrEqual(Math.ceil(shared * 0.85) + 1)
  await expect.poll(height).toBeGreaterThan(before)
  // The size is kept for next time.
  await dock(page)
    .getByRole('button', { name: /^Hide the terminal/ })
    .click()
  await expect(bar).toHaveAttribute('aria-expanded', 'false')
  // (Its button, still there, keeps focus.)
  await expect(dock(page).getByRole('button', { name: /^Show the terminal/ })).toBeFocused()
  await page.keyboard.press('Control+Backquote')
  await expect.poll(height).toBeGreaterThan(before)

  // The theme follows the app's, light or dark.
  const lightness = () =>
    dock(page)
      .getByRole('tabpanel')
      .locator('.xterm-scrollable-element')
      .evaluate((terminal) => {
        const [r, g, b] = getComputedStyle(terminal).backgroundColor.match(/\d+/g)!.map(Number)
        return (r! + g! + b!) / 3
      })
  for (const theme of ['light', 'dark']) {
    await page.locator('#content').focus()
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByRole('option', { name: `Use ${theme} theme` }).click()
    if (theme === 'light') await expect.poll(lightness).toBeGreaterThan(200)
    else await expect.poll(lightness).toBeLessThan(60)
  }
  await expect(bar).toHaveAttribute('aria-expanded', 'true')
})

test('a command Lumovi shows, pasted in to run', async ({ launch, clusters }) => {
  const { page } = await launch({ env: SHELL })
  await openCluster(page)
  await open(page, 'Deployments', DEMO.deployments.storefront)
  const detail = panel(page, 'Deployment', DEMO.deployments.storefront)
  await detail.getByRole('button', { name: 'Scale' }).click()
  await dialog(page).getByRole('button', { name: 'Paste in terminal' }).click()
  await expect(dialog(page)).toBeHidden()
  // Typed, not run: it's there to read, change, and run with Enter.
  await expect(screen(page)).toContainText(
    'kubectl scale deployment/storefront --replicas=3 -n shop --context demo',
  )
  await ready(page)
  await page.waitForTimeout(500)
  await expect(screen(page)).not.toContainText('scaled')
  await page.keyboard.press('Control+c')
  // In the terminal that's shown, when there's one.
  await detail.getByRole('button', { name: 'Scale' }).click()
  await dialog(page).getByRole('button', { name: 'Paste in terminal' }).click()
  await expect(dock(page).getByRole('tab')).toHaveCount(1)
  await expect.poll(() => inputLine(page)).toContain('kubectl scale deployment/storefront')
  await page.keyboard.press('Control+c')

  // Commands on several lines (one per namespace) come as one: none runs until Enter.
  await goTo(page, 'Pods')
  for (const pod of [DEMO.pods.checkout[0]!, 'redis-1']) {
    await row(page, 'Pods', pod).first().getByRole('checkbox').click()
  }
  await page
    .getByRole('toolbar', { name: 'Selected rows' })
    .getByRole('button', { name: 'Delete' })
    .click()
  await dialog(page).getByRole('button', { name: 'Paste in terminal' }).click()
  // (Joined as the shell runs them in turn: Windows PowerShell 5.1 has no &&. A long line wraps
  // on the screen, whose rows run together here.)
  const joined = WINDOWS ? '; ' : ' && '
  await expect(screen(page)).toContainText(
    new RegExp(
      `kubectl delete pod/\\S+ -n \\S+ --context demo${joined}kubectl delete pod/\\S+ -n \\S+ --context demo`,
    ),
  )
  await page.waitForTimeout(500)
  expect(writes(clusters.demo, 'DELETE', /\/pods\//)).toHaveLength(0)
  await page.keyboard.press('Control+c')

  // Lumovi's read-only switch is Lumovi's: a terminal says so. (Out of the terminal, whose
  // shell takes Ctrl+K.)
  await page.locator('#content').focus()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: 'Make demo read-only' }).click()
  await dock(page)
    .getByRole('button', { name: /^New terminal/ })
    .click()
  await expect(screen(page)).toContainText(
    'Lumovi’s read-only switch doesn’t apply to what you run here.',
  )
})

test('a shell that isn’t there, and terminals that end with the app', async ({ launch }) => {
  test.skip(WINDOWS, 'Windows terminals run PowerShell, whatever SHELL says')
  const { page } = await launch({ env: { SHELL: '/nowhere/sh' } })
  await openCluster(page)
  await page.keyboard.press('Control+Backquote')
  const notice = dock(page).getByRole('status')
  await expect(notice).toContainText(
    'Your shell, /nowhere/sh, isn’t there: set SHELL to one that is.',
  )
  await expect(dock(page).getByRole('tab', { name: /exited/ })).toBeVisible()
})

test('a KUBECONFIG relative to where Lumovi started', async ({ launch, clusters }) => {
  // The shell starts in your home folder: it's given the same files, wherever that is.
  const { page } = await launch({
    env: { ...SHELL, KUBECONFIG: relative(process.cwd(), clusters.kubeconfigPath) },
  })
  await openCluster(page)
  await page.keyboard.press('Control+Backquote')
  await ready(page)
  await report(page)
  await expect(screen(page)).toContainText('then=1 file(s) found=1')
})

test('kubeconfigs a Lumovi that’s gone left behind are swept on start', async ({ launch }) => {
  // One of a Lumovi that crashed, and one of a Lumovi that runs (this test's own process).
  const gone = mkdtempSync(join(tmpdir(), 'lumovi-terminal-2147483646-'))
  const running = mkdtempSync(join(tmpdir(), `lumovi-terminal-${process.pid}-`))
  writeFileSync(join(gone, 'kubeconfig'), '{}')
  await launch({ env: SHELL })
  await expect.poll(() => existsSync(gone)).toBe(false)
  expect(existsSync(running)).toBe(true)
  rmSync(running, { recursive: true })
})

test('without SHELL, the system’s own shell', async ({ launch }) => {
  test.skip(WINDOWS, 'Windows terminals run PowerShell, whatever SHELL says')
  const { page } = await launch({ env: { SHELL: '' } })
  await openCluster(page)
  await page.keyboard.press('Control+Backquote')
  await expect(screen(page)).toContainText('in this terminal.')
  await focused(page)
  // zsh on macOS (a login one), bash elsewhere.
  await page.keyboard.type('echo "shell=$0"')
  await page.keyboard.press('Enter')
  await expect(screen(page)).toContainText(MAC ? 'shell=/bin/zsh' : 'shell=/bin/bash')
})

test('terminals end, and their kubeconfigs go, when the app quits', async ({ launch }) => {
  const lumovi = await launch({ env: SHELL })
  const { page } = lumovi
  await openCluster(page)
  await page.keyboard.press('Control+Backquote')
  await ready(page)
  await report(page)
  await expect(screen(page)).toContainText('kubeconfig: ')
  // An id in use isn't used twice.
  const twice = await page.evaluate(async () => {
    const terminal = window.lumovi!.terminal
    const request = { target: 'local' as const, context: 'demo' }
    await terminal.open('local-twice-1', request)
    const again = await terminal.open('local-twice-1', request)
    return again.ok ? 'opened' : again.error.message
  })
  expect(twice).toBe('A new terminal needs a new id')
  const text = await screen(page).innerText()
  const kubeconfig = /kubeconfig: \[(.+?)\]/.exec(text.replace(/\s*\n\s*/g, ''))![1]!
  expect(existsSync(kubeconfig)).toBe(true)
  await lumovi.close()
  expect(existsSync(kubeconfig)).toBe(false)
})

test('on the start screen, ⌃` has nothing to point a terminal at', async ({ page }) => {
  await page.keyboard.press('Control+Backquote')
  await expect(dock(page)).toHaveCount(0)
})

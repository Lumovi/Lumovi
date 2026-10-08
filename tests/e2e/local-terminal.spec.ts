/**
 * Terminals on this computer: a dock under a cluster's pages, each tab your
 * shell with kubectl pointed at a cluster (in that terminal only), and the
 * commands Lumovi shows pasted in to run.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { dialog, open, writes } from './action-helpers.ts'
import {
  CONTEXTS,
  DEMO,
  expect,
  goTo,
  openCluster,
  PACKAGED,
  panel,
  row,
  test,
} from './fixtures.ts'
import { HELM_VERSION } from '../../scripts/helm.ts'
import { DEMO_TOKEN, writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import type { MockDownloads } from '../mock-downloads/server.ts'

const WINDOWS = process.platform === 'win32'
const MAC = process.platform === 'darwin'
/** This computer, as Kubernetes names platforms in its downloads. */
const GO_PLATFORM = `${WINDOWS ? 'windows' : process.platform}/${process.arch === 'x64' ? 'amd64' : process.arch}`

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

/** Waits for the terminal shown to have focus: not one in a tab that's hidden. */
async function focused(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const focus = document.activeElement
        return focus?.classList.contains('xterm-helper-textarea') && !focus.closest('[hidden]')
      }),
    )
    .toBe(true)
}

/** What the report says in brackets after `said`, its lines' wrapping undone. */
async function reported(
  page: Page,
  said: 'kubeconfig: ' | 'path: first=' | 'path: last=' | 'startup: ',
) {
  const text = (await screen(page).innerText()).replace(/\s*\n\s*/g, '')
  return new RegExp(`${said}\\[(.+?)\\]`).exec(text)?.[1]
}

/** Runs the report of what kubectl uses, in the terminal that has focus. */
async function report(page: Page) {
  const command = WINDOWS
    ? `& '${process.execPath}' '${REPORT}'`
    : `'${process.execPath}' '${REPORT}'`
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

test('the helm Lumovi ships with: its Helm actions run it, and terminals have it', async ({
  launch,
}) => {
  test.skip(!process.env.LUMOVI_E2E_EXECUTABLE, 'A packaged app has it (see scripts/helm.ts).')
  const { page } = await launch({ env: { ...SHELL, LUMOVI_HELM: '' } })
  const cli = await page.evaluate(() => window.lumovi!.helm.cli())
  expect(cli).toMatchObject({
    available: true,
    version: expect.stringContaining(`v${HELM_VERSION}+`),
  })
  expect(cli.command).toMatch(/[\\/]helm[\\/]helm(\.exe)?$/)
  await openCluster(page)
  await page.keyboard.press('Control+Backquote')
  await ready(page)
  await report(page)
  await expect(screen(page)).toContainText('path: last=')
  expect(await reported(page, 'path: last=')).toBe(dirname(cli.command))
})

/** Where terminals' kubectl matching a cluster on `version` is kept. */
const kept = (userDataDir: string, version: string) => join(userDataDir, 'kubectl', version)

/** A kept kubectl's own SHA-256. */
const sha256Of = (dir: string) =>
  createHash('sha256')
    .update(readFileSync(join(dir, WINDOWS ? 'kubectl.exe' : 'kubectl')))
    .digest('hex')

/**
 * How a kept kubectl was checked, as Lumovi says it beside it: `signed` or `unsigned`, from
 * `host`, naming the kubectl by its SHA-256.
 */
function mark(dir: string, how: 'signed' | 'unsigned', host: string, sha256 = sha256Of(dir)) {
  writeFileSync(join(dir, how), `${host}\n${sha256}\n`)
}

/** That the terminal's PATH starts with the kubectl kept for `version` (Electron's path to it). */
async function firstOnPath(page: Page, userDataDir: string, version: string) {
  const first = await reported(page, 'path: first=')
  expect(first && realpathSync.native(first)).toBe(realpathSync.native(kept(userDataDir, version)))
}

/** The stand-in's kubectl downloads (not their checksums'). */
const kubectls = (requests: string[]) => requests.filter((path) => /\/kubectl(\.exe)?$/.test(path))

/** A policy file, as IT would deploy it (LUMOVI_POLICY points at it). */
function policyFile(policy: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(path, JSON.stringify(policy))
  return path
}

/** Waits for the terminal to show `text`, however its lines wrap. */
async function shows(page: Page, text: string, timeout?: number) {
  const squeezed = (text: string) => text.replace(/\s+/g, '')
  await expect
    .poll(async () => squeezed(await screen(page).innerText()), { timeout })
    .toContain(squeezed(text))
}

/** Opens the terminal of the open cluster, and waits for its shell. */
async function terminal(page: Page) {
  await page.keyboard.press('Control+Backquote')
  await ready(page)
}

test('a terminal on this computer, with kubectl pointed at the cluster', async ({
  launch,
  downloads,
}) => {
  const { page, userDataDir } = await launch({ env: SHELL })
  await openCluster(page)
  // ⌃` opens it, with a terminal for the cluster that's open.
  const bar = dock(page).getByRole('button', { name: 'Terminal', exact: true })
  await page.keyboard.press('Control+Backquote')
  await expect(bar).toHaveAttribute('aria-expanded', 'true')
  const tabs = dock(page).getByRole('tablist', { name: 'Terminals' })
  await expect(tabs.getByRole('tab')).toHaveText(['demo'])
  // Its kubectl is the newest of the cluster's minor version (v1.34.1's), first on its PATH.
  await shows(
    page,
    '› kubectl points at demo in this terminal. It’s v1.34.9, to match the cluster.',
  )
  await ready(page)
  await report(page)
  await expect(screen(page)).toContainText(
    'kubectl: context=demo namespace=- then=1 file(s) found=1 term=Lumovi',
  )
  await firstOnPath(page, userDataDir, 'v1.34.9')
  if (!WINDOWS) {
    await page.keyboard.type('kubectl')
    await page.keyboard.press('Enter')
    await expect(screen(page)).toContainText("kubectl v1.34.9, the tests' stand-in")
  }
  const kubeconfig = await reported(page, 'kubeconfig: ')
  // Last on its PATH, for when there's none of your own: the helm Lumovi runs (the tests').
  expect(await reported(page, 'path: last=')).toBe(resolve('tests/e2e/helm'))

  // Each terminal is its own: in the namespace picked, it's that namespace's.
  await page.getByRole('button', { name: 'Namespace' }).click()
  await page.getByPlaceholder('Find a namespace…').fill('shop')
  await page.keyboard.press('Enter')
  await dock(page)
    .getByRole('button', { name: /^New terminal/ })
    .click()
  await expect(tabs.getByRole('tab')).toHaveText(['demo', 'demoshop'])
  await expect(tabs.getByRole('tab').last()).toHaveAccessibleName('demo, namespace shop')
  await shows(page, '› kubectl points at demo, namespace shop, in this terminal. It’s v1.34.9')
  await ready(page)
  await report(page)
  await expect(screen(page)).toContainText('context=demo namespace=shop')
  // The same one: downloaded once.
  expect(kubectls(downloads.requests)).toEqual([
    `/release/v1.34.9/bin/${GO_PLATFORM}/kubectl${WINDOWS ? '.exe' : ''}`,
  ])
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

test('terminals read the kubeconfig files chosen in Lumovi', async ({ launch, clusters }) => {
  // Two, each with a context for the demo cluster, chosen in place of KUBECONFIG's.
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-chosen-'))
  const files = ['alpha', 'beta'].map((name) =>
    writeKubeconfig(
      dir,
      {
        currentContext: name,
        clusters: [{ name, server: clusters.demo.url, caPem: clusters.demo.caPem }],
        users: [{ name, token: DEMO_TOKEN }],
        contexts: [{ name, cluster: name, user: name }],
      },
      name,
    ),
  )
  const { page, app } = await launch({ env: SHELL })
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths,
    })) as unknown as typeof dialog.showOpenDialog
  }, files)
  await page.evaluate(() => window.lumovi!.kubeconfigFiles!.choose('replace'))
  await page.reload()
  await openCluster(page, 'alpha')
  await page.keyboard.press('Control+Backquote')
  await ready(page)
  await report(page)
  // Its own, then the two: not KUBECONFIG's.
  await expect(screen(page)).toContainText('then=2 file(s) found=2')
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

test('kubectl matching the cluster: kept for next time, and yours when it can’t be had', async ({
  launch,
  downloads,
}) => {
  // What was downloaded isn't what was published: it's not used, nor kept.
  downloads.fail = 'checksum'
  const first = await launch({ env: SHELL })
  await openCluster(first.page)
  await terminal(first.page)
  await shows(
    first.page,
    `It’s the one on your PATH: Lumovi couldn’t get kubectl 1.34 to match the cluster (what was downloaded isn’t what ${new URL(downloads.url).host} published).`,
  )
  await report(first.page)
  await expect(screen(first.page)).toContainText('path: first=')
  expect(await reported(first.page, 'path: first=')).not.toContain('v1.34.9')
  expect(existsSync(kept(first.userDataDir, 'v1.34.9'))).toBe(false)
  // Nor tried again at once, by the terminals opened meanwhile.
  const asked = downloads.requests.length
  await dock(first.page)
    .getByRole('button', { name: /^New terminal/ })
    .click()
  await shows(first.page, 'It’s the one on your PATH')
  expect(downloads.requests.length).toBe(asked)
  await first.close()

  // Offline, the newest one kept of the cluster's minor version does; older ones went as Lumovi
  // started.
  downloads.reset()
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  for (const version of ['v1.34.5', 'v1.34.7']) {
    mkdirSync(kept(userDataDir, version), { recursive: true })
    writeFileSync(join(kept(userDataDir, version), WINDOWS ? 'kubectl.exe' : 'kubectl'), '')
    // As checked against Kubernetes' signature, when it was downloaded.
    mark(kept(userDataDir, version), 'signed', 'dl.k8s.io')
  }
  // And one a crash cut short.
  const partial = join(kept(userDataDir, 'v1.34.7'), '.kubectl.99999')
  writeFileSync(partial, 'half')
  downloads.fail = 'lookup'
  const second = await launch({ env: SHELL, userDataDir })
  await openCluster(second.page)
  await terminal(second.page)
  await shows(second.page, 'It’s v1.34.7, to match the cluster.')
  expect(existsSync(kept(userDataDir, 'v1.34.5'))).toBe(false)
  expect(existsSync(partial)).toBe(false)
  expect(kubectls(downloads.requests)).toEqual([])
  await second.close()

  // With none kept, it says why.
  const third = await launch({ env: SHELL })
  await openCluster(third.page)
  await terminal(third.page)
  await shows(
    third.page,
    `Lumovi couldn’t get kubectl 1.34 to match the cluster (${new URL(downloads.url).host} answered 503).`,
  )
})

/** Why each signature that isn't right isn't taken (`host`, the stand-in dl.k8s.io's). */
const refusals = (host: string): [NonNullable<MockDownloads['signing']>, string][] => {
  const notVerified = `${host}’s kubectl v1.34.9 couldn’t be verified as Kubernetes’ own`
  const notKubernetes = (why: string) => `${notVerified}, and may have been changed: ${why}`
  // Where what this Lumovi knows could be what's out of date, that's said too: before why, as a
  // terminal's line may be cut short.
  const orChanged = (what: string, why: string) =>
    `${notVerified}, so it may have been changed, or ${what} and Lumovi needs an update: ${why}`
  return [
    // What was downloaded, and its SHA-256, changed together: only the signature says so.
    ['tampered', notKubernetes('its signature isn’t for what was downloaded')],
    // Signed, but not by Kubernetes' release, or not as it signs in.
    [
      'identity',
      orChanged(
        'Kubernetes has changed how it signs',
        'it’s signed by someone@example.com, not Kubernetes’ release as this Lumovi knows it',
      ),
    ],
    [
      'issuer',
      orChanged(
        'Kubernetes has changed how it signs',
        'its signer signed in with https://token.actions.githubusercontent.com, not as this Lumovi knows Kubernetes’ release does',
      ),
    ],
    // A certificate Sigstore's authority didn't issue, though logged as if it had.
    [
      'authority',
      orChanged(
        'Sigstore has changed its certificate authority',
        'its certificate isn’t from Sigstore’s certificate authority as this Lumovi knows it',
      ),
    ],
    // Its certificate's timestamp: none, forged, from a log Sigstore doesn't run, or too late.
    ['unlogged', notKubernetes('its certificate wasn’t logged')],
    [
      'forged-log',
      orChanged(
        'Sigstore has changed its logs',
        'its certificate wasn’t logged where this Lumovi knows Sigstore logs them',
      ),
    ],
    [
      'foreign-log',
      orChanged(
        'Sigstore has changed its logs',
        'its certificate wasn’t logged where this Lumovi knows Sigstore logs them',
      ),
    ],
    ['logged-late', notKubernetes('its certificate wasn’t valid when it was logged')],
    // For something other than signing code.
    ['usage', notKubernetes('its certificate isn’t for signing code')],
    // Half a signature, or none: from dl.k8s.io, where every kubectl Lumovi gets is signed.
    ['no-certificate', `${host} published kubectl v1.34.9’s signature without its certificate`],
    ['no-signature', `${host} published kubectl v1.34.9’s certificate without its signature`],
    ['unsigned', `${host} published no signature for kubectl v1.34.9`],
  ]
}

// The packaged app takes no stand-in for Sigstore (nor for dl.k8s.io): these run on the build.
for (const signing of refusals('').map(([signing]) => signing)) {
  test(`kubectl that isn’t Kubernetes’ own is refused: ${signing}`, async ({
    launch,
    downloads,
  }) => {
    test.skip(PACKAGED, 'The packaged app takes no stand-in for Sigstore.')
    const why = new Map(refusals(new URL(downloads.url).host)).get(signing)!
    downloads.signing = signing
    const lumovi = await launch({ env: SHELL })
    await openCluster(lumovi.page)
    await terminal(lumovi.page)
    await shows(
      lumovi.page,
      `It’s the one on your PATH: Lumovi couldn’t get kubectl 1.34 to match the cluster (${why}).`,
    )
    expect(existsSync(kept(lumovi.userDataDir, 'v1.34.9'))).toBe(false)
  })
}

test('dl.k8s.io however it’s spelled is dl.k8s.io, not a mirror', async ({ launch, downloads }) => {
  test.skip(PACKAGED, 'The packaged app takes no stand-in for dl.k8s.io.')
  // Its scheme's case and a trailing slash: still dl.k8s.io, where every kubectl is signed.
  downloads.signing = 'unsigned'
  const url = new URL(downloads.url)
  const lumovi = await launch({
    env: { ...SHELL, LUMOVI_KUBECTL_MIRROR: `HTTP://${url.hostname}:${url.port}/` },
  })
  await openCluster(lumovi.page)
  await terminal(lumovi.page)
  await shows(lumovi.page, `(${url.host} published no signature for kubectl v1.34.9).`)
})

test('kubectl kept from before Lumovi checked signatures is got again, checked', async ({
  launch,
  downloads,
}) => {
  test.skip(PACKAGED, 'The packaged app takes no stand-in for Sigstore.')
  // Kept by 1.12 or earlier: it says nothing of how it was checked.
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  mkdirSync(kept(userDataDir, 'v1.34.9'), { recursive: true })
  writeFileSync(
    join(kept(userDataDir, 'v1.34.9'), WINDOWS ? 'kubectl.exe' : 'kubectl'),
    'unchecked',
  )
  const lumovi = await launch({ env: SHELL, userDataDir })
  await openCluster(lumovi.page)
  await terminal(lumovi.page)
  await shows(lumovi.page, 'It’s v1.34.9, to match the cluster.')
  // Downloaded again, and checked against Kubernetes' signature this time.
  expect(kubectls(downloads.requests)).toEqual([expect.stringMatching(/\/v1\.34\.9\//)])
  expect(downloads.requests).toContainEqual(expect.stringMatching(/kubectl(\.exe)?\.sig$/))
  expect(readFileSync(join(kept(userDataDir, 'v1.34.9'), 'signed'), 'utf8')).toBe(
    `${new URL(downloads.url).host}\n${sha256Of(kept(userDataDir, 'v1.34.9'))}\n`,
  )
})

test('a mirror’s kubectl: checked against Kubernetes’ signature, or said to have none', async ({
  launch,
  downloads,
}) => {
  test.skip(PACKAGED, 'The packaged app takes no stand-in for Sigstore.')
  // Lumovi started four times (on Windows, each takes long).
  test.slow()
  // A host of its own (the stand-in for dl.k8s.io's, by another name): a mirror is by its host.
  const mirror = new URL('/mirror', downloads.url)
  mirror.hostname = 'localhost'
  const env = { ...SHELL, LUMOVI_KUBECTL_MIRROR: mirror.href }
  const host = mirror.host
  const unsigned = `${host} has no Kubernetes signature for it, so Lumovi checked it against its SHA-256 only.`
  // A mirror that keeps no signatures: its SHA-256 is all there is, as every terminal says.
  downloads.signing = 'unsigned'
  const first = await launch({ env })
  await openCluster(first.page)
  await terminal(first.page)
  await shows(first.page, `It’s v1.34.9, to match the cluster. ${unsigned}`)
  await first.close()
  // Kept: the next start's terminals say so too.
  downloads.reset()
  const again = await launch({ env, userDataDir: first.userDataDir })
  await openCluster(again.page)
  await terminal(again.page)
  await shows(again.page, `It’s v1.34.9, to match the cluster. ${unsigned}`)
  await again.close()

  // One with a signature that isn't Kubernetes' is refused: not taken as one with none.
  downloads.signing = 'tampered'
  const tampered = await launch({ env })
  await openCluster(tampered.page)
  await terminal(tampered.page)
  await shows(
    tampered.page,
    `It’s the one on your PATH: Lumovi couldn’t get kubectl 1.34 to match the cluster (${host}’s kubectl v1.34.9 couldn’t be verified as Kubernetes’ own, and may have been changed: its signature isn’t for what was downloaded).`,
  )
  await tampered.close()

  // And one signed as dl.k8s.io's are is checked, and said no more of.
  downloads.reset()
  const signed = await launch({ env })
  await openCluster(signed.page)
  await terminal(signed.page)
  await shows(signed.page, 'It’s v1.34.9, to match the cluster.')
  await expect(screen(signed.page)).not.toContainText('SHA-256 only')
  expect(kubectls(downloads.requests)).toEqual([
    expect.stringMatching(/^\/mirror\/release\/v1\.34\.9\//),
  ])
})

test('the organization’s policy can require Kubernetes’ signature from its mirror too', async ({
  launch,
  downloads,
}) => {
  test.skip(PACKAGED, 'The packaged app takes no stand-in for Sigstore.')
  test.slow()
  const mirror = new URL('/mirror', downloads.url)
  mirror.hostname = 'localhost'
  const host = mirror.host
  // Taken from it unsigned, before the policy said otherwise.
  downloads.signing = 'unsigned'
  const before = await launch({ env: { ...SHELL, LUMOVI_KUBECTL_MIRROR: mirror.href } })
  await openCluster(before.page)
  await terminal(before.page)
  await shows(before.page, 'checked it against its SHA-256 only.')
  await before.close()
  const userDataDir = before.userDataDir

  // Once it does: neither that one, nor a new one without a signature.
  const policy = policyFile({ kubectl: mirror.href, kubectlSignatures: 'required' })
  const required = await launch({ env: { ...SHELL, LUMOVI_POLICY: policy }, userDataDir })
  await openCluster(required.page)
  await terminal(required.page)
  await shows(
    required.page,
    `It’s the one on your PATH: Lumovi couldn’t get kubectl 1.34 to match the cluster (${host} published no signature for kubectl v1.34.9, and your organization’s policy requires one).`,
  )
  await required.close()

  // One signed as dl.k8s.io's are: taken, and kept as checked against its signature.
  downloads.reset()
  const signed = await launch({ env: { ...SHELL, LUMOVI_POLICY: policy }, userDataDir })
  await openCluster(signed.page)
  await terminal(signed.page)
  await shows(signed.page, 'It’s v1.34.9, to match the cluster.')
  await expect(screen(signed.page)).not.toContainText('SHA-256 only')
  expect(readFileSync(join(kept(userDataDir, 'v1.34.9'), 'signed'), 'utf8')).toBe(
    `${host}\n${sha256Of(kept(userDataDir, 'v1.34.9'))}\n`,
  )
  expect(existsSync(join(kept(userDataDir, 'v1.34.9'), 'unsigned'))).toBe(false)
})

test('under a policy requiring signatures, a signed kubectl is kept for offline; a broken policy gets none', async ({
  launch,
  downloads,
}) => {
  test.skip(PACKAGED, 'The packaged app takes no stand-in for Sigstore.')
  test.slow()
  const mirror = new URL('/mirror', downloads.url)
  mirror.hostname = 'localhost'
  const host = mirror.host
  const policy = policyFile({ kubectl: mirror.href, kubectlSignatures: 'required' })

  // Offline, the newest signed one kept of the minor version, though a newer one came unsigned:
  // kept as Lumovi starts, for this.
  const offline = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  for (const [version, how] of [
    ['v1.34.7', 'signed'],
    ['v1.34.8', 'signed'],
    ['v1.34.9', 'unsigned'],
  ] as const) {
    mkdirSync(kept(offline, version), { recursive: true })
    writeFileSync(join(kept(offline, version), WINDOWS ? 'kubectl.exe' : 'kubectl'), version)
    mark(kept(offline, version), how, host)
  }
  downloads.fail = 'lookup'
  const cut = await launch({ env: { ...SHELL, LUMOVI_POLICY: policy }, userDataDir: offline })
  await openCluster(cut.page)
  await terminal(cut.page)
  await shows(cut.page, 'It’s v1.34.8, to match the cluster.')
  expect(existsSync(kept(offline, 'v1.34.9'))).toBe(true)
  expect(existsSync(kept(offline, 'v1.34.7'))).toBe(false)
  await cut.close()

  // A policy that can't be used, as one meaning to require them would be by a slip: no kubectl
  // is got at all, from anywhere (whatever it meant, it didn't mean looser), and it's locked.
  downloads.reset()
  downloads.signing = 'unsigned'
  const slip = await launch({
    env: {
      ...SHELL,
      LUMOVI_KUBECTL_MIRROR: mirror.href,
      LUMOVI_POLICY: policyFile({ kubectl: false, kubectlSignatures: 'Required' }),
    },
  })
  expect(
    await slip.app.evaluate(({ Menu }) => {
      const { enabled, checked } = Menu.getApplicationMenu()!.getMenuItemById('matching-kubectl')!
      return { enabled, checked }
    }),
  ).toEqual({ enabled: false, checked: false })
  await openCluster(slip.page)
  await terminal(slip.page)
  await expect(screen(slip.page)).not.toContainText('It’s')
  expect(downloads.requests).toEqual([])
})

test('a kept kubectl is used only as what was said of it says: of that kubectl', async ({
  launch,
  downloads,
}) => {
  test.skip(PACKAGED, 'The packaged app takes no stand-in for Sigstore.')
  const mirror = new URL('/mirror', downloads.url)
  mirror.hostname = 'localhost'
  const host = mirror.host
  // A kubectl taken unsigned, being got again signed (as a policy requiring it has it), when
  // Lumovi stopped between the two: "signed" said, of another kubectl than the one there.
  const stopped = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const dir = kept(stopped, 'v1.34.9')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, WINDOWS ? 'kubectl.exe' : 'kubectl'), 'taken unsigned')
  mark(dir, 'signed', host, createHash('sha256').update('the signed one').digest('hex'))
  downloads.signing = 'unsigned'
  const policy = policyFile({ kubectl: mirror.href, kubectlSignatures: 'required' })
  const lumovi = await launch({ env: { ...SHELL, LUMOVI_POLICY: policy }, userDataDir: stopped })
  await openCluster(lumovi.page)
  await terminal(lumovi.page)
  await shows(
    lumovi.page,
    `It’s the one on your PATH: Lumovi couldn’t get kubectl 1.34 to match the cluster (${host} published no signature for kubectl v1.34.9, and your organization’s policy requires one).`,
  )
  await lumovi.close()

  // Said as Lumovi before 1.15 said it (without the kubectl's SHA-256): got again, and said anew.
  downloads.reset()
  const before = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  mkdirSync(kept(before, 'v1.34.9'), { recursive: true })
  writeFileSync(join(kept(before, 'v1.34.9'), WINDOWS ? 'kubectl.exe' : 'kubectl'), 'kept')
  writeFileSync(join(kept(before, 'v1.34.9'), 'signed'), new URL(downloads.url).host)
  const again = await launch({ env: SHELL, userDataDir: before })
  await openCluster(again.page)
  await terminal(again.page)
  await shows(again.page, 'It’s v1.34.9, to match the cluster.')
  expect(kubectls(downloads.requests)).toEqual([expect.stringMatching(/\/v1\.34\.9\//)])
  expect(readFileSync(join(kept(before, 'v1.34.9'), 'signed'), 'utf8')).toBe(
    `${new URL(downloads.url).host}\n${sha256Of(kept(before, 'v1.34.9'))}\n`,
  )
})

test('a terminal waits for neither a cluster that doesn’t answer nor a long download', async ({
  launch,
  clusters,
  downloads,
}) => {
  // A cluster that doesn't say its version (its VPN is off, say): the terminal starts at once.
  const answers = clusters.demo.fail('/version', { hang: true })
  const { page, userDataDir } = await launch({ env: SHELL })
  await openCluster(page)
  await terminal(page)
  await shows(
    page,
    'It’s the one on your PATH: Lumovi couldn’t ask the cluster its version (it didn’t answer within 3 seconds).',
  )
  answers()

  // A kubectl that takes long: the terminal starts with yours, and the next has it.
  downloads.delayMs = 11_000
  const tabs = dock(page).getByRole('tablist', { name: 'Terminals' })
  await dock(page)
    .getByRole('button', { name: /^New terminal/ })
    .click()
  await expect(tabs.getByRole('tab')).toHaveCount(2)
  await shows(page, 'Getting kubectl v1.34.9, to match the cluster…')
  // (After the 10 seconds a terminal waits for it.)
  await shows(
    page,
    'It’s the one on your PATH: kubectl v1.34.9 is still downloading, for the terminals opened once it’s done.',
    20_000,
  )
  const kubectl = join(kept(userDataDir, 'v1.34.9'), WINDOWS ? 'kubectl.exe' : 'kubectl')
  await expect.poll(() => existsSync(kubectl), { timeout: 15_000 }).toBe(true)
  await dock(page)
    .getByRole('button', { name: /^New terminal/ })
    .click()
  await expect(tabs.getByRole('tab')).toHaveCount(3)
  await shows(page, 'It’s v1.34.9, to match the cluster.')
  expect(kubectls(downloads.requests)).toHaveLength(1)
})

test('a cluster that can’t be reached as Lumovi starts gets the kubectl it had', async ({
  launch,
  clusters,
}) => {
  const first = await launch({ env: SHELL })
  await openCluster(first.page)
  await terminal(first.page)
  await shows(first.page, 'It’s v1.34.9, to match the cluster.')
  await first.close()
  // Kept as the person's alone: context names can name customers.
  const remembered = join(first.userDataDir, 'kubectl', 'clusters.json')
  expect(JSON.parse(readFileSync(remembered, 'utf8'))).toEqual({ demo: '1.34' })
  if (!WINDOWS) expect(statSync(remembered).mode & 0o777).toBe(0o600)
  // Its version was kept with it: no waiting for a cluster that doesn't answer.
  clusters.demo.fail('/version', { hang: true })
  const again = await launch({ env: SHELL, userDataDir: first.userDataDir })
  await openCluster(again.page)
  await terminal(again.page)
  await shows(again.page, 'It’s v1.34.9, to match the cluster.')
})

test('what a cluster says can’t write over a terminal, nor choose an old kubectl', async ({
  launch,
  clusters,
  downloads,
}) => {
  // A version with a terminal's control sequences: clear the screen, go home, set the title.
  const version = (gitVersion: string) =>
    clusters.demo.fail('/version', {
      status: 200,
      body: JSON.stringify({ gitVersion, platform: 'linux/amd64' }),
    })
  const answers = version('x\u001b[2J\u001b[H\u001b]0;pwned\u0007 Everything is fine.')
  const { page } = await launch({ env: SHELL })
  await openCluster(page)
  await terminal(page)
  // Said as text, with what makes it act left out: nothing was cleared.
  await shows(page, 'Lumovi can’t tell which kubectl matches x[2J[H]0;pwned Everything')
  await expect(screen(page)).toContainText('› kubectl points at demo in this terminal.')
  answers()

  // One older than Lumovi's oldest isn't downloaded: kubectl that old lacks years of fixes.
  version('v1.13.12')
  await dock(page)
    .getByRole('button', { name: /^New terminal/ })
    .click()
  await shows(
    page,
    'It’s the one on your PATH: the cluster says it’s Kubernetes 1.13, and Lumovi gets kubectl for 1.25 or later.',
  )
  expect(downloads.requests).toEqual([])
})

test('kubectl matching each cluster can be turned off, and an organization can', async ({
  launch,
  downloads,
}) => {
  const { page, app, userDataDir } = await launch({ env: SHELL })
  const item = () =>
    app.evaluate(({ Menu }) => {
      const { enabled, checked } = Menu.getApplicationMenu()!.getMenuItemById('matching-kubectl')!
      return { enabled, checked }
    })
  expect(await item()).toEqual({ enabled: true, checked: true })
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.getMenuItemById('matching-kubectl')!.click(),
  )
  expect(await item()).toEqual({ enabled: true, checked: false })
  expect(JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8'))).toMatchObject({
    matchingKubectl: false,
  })
  await openCluster(page)
  await terminal(page)
  await expect(screen(page)).toContainText('› kubectl points at demo in this terminal.')
  await expect(screen(page)).not.toContainText('It’s')
  expect(downloads.requests).toEqual([])

  // The organization's policy: off, and locked.
  const off = await launch({ env: { ...SHELL, LUMOVI_POLICY: policyFile({ kubectl: false }) } })
  expect(
    await off.app.evaluate(({ Menu }) => {
      const { enabled, checked } = Menu.getApplicationMenu()!.getMenuItemById('matching-kubectl')!
      return { enabled, checked }
    }),
  ).toEqual({ enabled: false, checked: false })
  await openCluster(off.page)
  await terminal(off.page)
  await expect(screen(off.page)).not.toContainText('It’s')
  expect(downloads.requests).toEqual([])

  // Or from its own mirror, whatever else is set.
  const mirrored = await launch({
    env: {
      ...SHELL,
      LUMOVI_KUBECTL_MIRROR: 'http://127.0.0.1:9',
      LUMOVI_POLICY: policyFile({ kubectl: `${downloads.url}/` }),
    },
  })
  await openCluster(mirrored.page)
  await terminal(mirrored.page)
  await shows(mirrored.page, 'It’s v1.34.9, to match the cluster.')

  // Only over HTTPS (or from this computer): over plain http, its checksum could be changed too.
  const plain = await launch({
    env: { ...SHELL, LUMOVI_KUBECTL_MIRROR: 'http://lumovi:s3cret@mirror.corp.example.com/k8s' },
  })
  await openCluster(plain.page)
  await terminal(plain.page)
  await shows(
    plain.page,
    'It’s the one on your PATH: Lumovi gets kubectl only over HTTPS, and http://mirror.corp.example.com/k8s isn’t (LUMOVI_KUBECTL_MIRROR).',
  )
  // Without the password the URL had in it.
  await expect(screen(plain.page)).not.toContainText('s3cret')
})

// Your startup files run, and the kubectl matching the cluster is still first: theirs put a
// folder first, as macOS's path_helper and version managers do.
for (const shell of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
  test(`${shell}: your startup files, then kubectl matching the cluster first`, async ({
    launch,
  }) => {
    test.skip(WINDOWS || !existsSync(shell), `There’s no ${shell} here.`)
    const name = shell.split('/').at(-1)!
    const home = mkdtempSync(join(tmpdir(), 'lumovi-home-'))
    // (And a prompt ready() knows: zsh's own ends in %.)
    const yours = `export LUMOVI_TEST_STARTUP=${name}\nPATH="/startup-first:$PATH"\nPS1='$ '\n`
    for (const file of ['.zshrc', '.bashrc', '.bash_profile', 'shrc']) {
      writeFileSync(join(home, file), yours)
    }
    const { page, userDataDir } = await launch({
      env: {
        SHELL: shell,
        ...(name === 'zsh' && { ZDOTDIR: home }),
        ...(name === 'bash' && { HOME: home }),
        ...(name === 'sh' && { ENV: join(home, 'shrc') }),
      },
    })
    await openCluster(page)
    await terminal(page)
    await shows(page, 'It’s v1.34.9, to match the cluster.')
    await report(page)
    await expect(screen(page)).toContainText('startup: ')
    expect(await reported(page, 'startup: ')).toBe(name)
    await firstOnPath(page, userDataDir, 'v1.34.9')
    // And what it changed to get there is as it was.
    const variable = { zsh: 'ZDOTDIR', bash: 'LUMOVI_LOGIN', sh: 'ENV' }[name]!
    await page.keyboard.type(`echo "${variable}=[$${variable}] [$LUMOVI_KUBECTL]"`)
    await page.keyboard.press('Enter')
    await expect(screen(page)).toContainText(
      `${variable}=[${{ zsh: home, bash: '', sh: join(home, 'shrc') }[name]}] []`,
    )
  })
}

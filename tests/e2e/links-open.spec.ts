/**
 * What a lumovi:// link opens, and when: nothing signs in or writes before a press, the card is in
 * the window that shows the link's cluster, the clusters here that could be the link's are picked
 * from, unsaved work isn't left, a burst makes one card, and every page a link may open only reads.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { pluginsAndCode, readLock, takePlugins, trust } from '../../scripts/plugins-bundle.ts'
import { clusterFingerprint } from '../../src/main/links.ts'
import { addressOf, parseLink, READING_TABS } from '../../src/shared/links.ts'
import { parsePlugin } from '../../src/shared/plugins.ts'
import { RESOURCES } from '../../src/shared/resources.ts'
import { holds } from '../holds.ts'
import { DEMO_TOKEN, writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import type { MockCluster } from '../mock-cluster/server.ts'
import { open } from './action-helpers.ts'
import { CONTEXTS, DEMO, clusterOption, expect, openCluster, panel, test } from './fixtures.ts'

/** A link handed to Lumovi, as the system hands one over. */
const hand = (app: ElectronApplication, link: string) =>
  app.evaluate(({ app }, url) => {
    app.emit('open-url', { preventDefault: () => {} }, url)
  }, link)

/** The link Copy link would make for a view of this window's clusters (the app's address of it). */
const linkFor = (page: Page, address: string, tab?: string) =>
  page.evaluate(
    ([to, at]) =>
      (
        window as unknown as {
          lumovi: { desktop: { linkFor(address: string, tab?: string): Promise<string> } }
        }
      ).lumovi.desktop.linkFor(to!, at),
    [address, tab] as const,
  )

/** The person is in Lumovi as a link comes: its windows are the ones in use, not another app's. */
const inUse = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.isFocused = () => true
  })

/**
 * Lumovi started again, on the same user data, as Windows and Linux start it with a link: these
 * arguments after its own. Its exit code, once it has handed over to the one running and gone.
 */
function startedAgain(userDataDir: string, args: string[]): Promise<number | null> {
  const electron = createRequire(import.meta.url)('electron') as string
  const again = spawn(electron, ['.', `--user-data-dir=${userDataDir}`, ...args], {
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RENDERER_URL: undefined },
  })
  return new Promise((resolve) => again.on('exit', resolve))
}

/** A key typed into the window of Lumovi's own, as the system sends it, with no link coming. */
const typedHere = (app: ElectronApplication, keyCode: string) =>
  app.evaluate(({ BrowserWindow }, code) => {
    const win = BrowserWindow.getAllWindows().find(
      (one) => !one.webContents.getURL().includes('#/tab'),
    )!
    for (const type of ['keyDown', 'char', 'keyUp'] as const) {
      win.webContents.sendInputEvent({ type, keyCode: code })
    }
  }, keyCode)

/**
 * What the page sends its terminals' shells from now on: what's typed into one, without the
 * terminal's own word that it gained or lost the keyboard (a focus report, which a shell such as
 * Windows' PowerShell asks for: the card taking the keyboard sends one).
 */
async function typedFromNow(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ ipcMain }) => {
    const typed: string[] = []
    ;(globalThis as unknown as { __typed: string[] }).__typed = typed
    ipcMain.on('terminal:input', (_event, _id, data: unknown) => {
      if (typeof data === 'string' && data !== '\u001b[I' && data !== '\u001b[O') typed.push(data)
    })
  })
  return () => app.evaluate(() => [...(globalThis as unknown as { __typed: string[] }).__typed])
}

/** The terminals' shells started, and whether each has ended (the harness keeps them). */
const ptys = (app: ElectronApplication) =>
  app.evaluate(() =>
    (globalThis as unknown as { __ptys: { ended: number | null }[] }).__ptys.map(
      (each) => each.ended !== null,
    ),
  )
/**
 * A link handed over, and the person typing on as it comes: keys as the system sends them (through
 * what Lumovi's main process hears first, as Playwright's don't), from the hand-over on, to the
 * window of Lumovi's own (one made for the link too). Each a key (`Shift+Tab`), or a pause in ms;
 * `gap` ms between keys.
 */
const handedWhileTyping = (
  app: ElectronApplication,
  link: string,
  keys: (string | number)[] = Array.from({ length: 16 }, (_, at) =>
    at % 4 === 3 ? 'Return' : 'x',
  ),
  gap = 50,
) =>
  app.evaluate(
    async ({ app, BrowserWindow }, [url, keys, gap]) => {
      app.emit('open-url', { preventDefault: () => {} }, url)
      for (const each of keys) {
        if (typeof each === 'number') {
          await new Promise((resolve) => setTimeout(resolve, each))
          continue
        }
        const win = BrowserWindow.getAllWindows().find(
          (one) => !one.webContents.getURL().includes('#/tab'),
        )!
        const parts = each.split('+')
        const keyCode = parts.pop()!
        const modifiers = parts.map((part) => part.toLowerCase()) as never
        for (const type of ['keyDown', 'char', 'keyUp'] as const) {
          win.webContents.sendInputEvent({ type, keyCode, modifiers })
        }
        await new Promise((resolve) => setTimeout(resolve, gap))
      }
    },
    [link, keys, gap] as const,
  )
const windowCount = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
/** A terminal below, opened, with its prompt, and the keyboard. */
async function terminal(page: Page) {
  await page.keyboard.press('Control+Backquote')
  const rows = page.getByRole('region', { name: 'Tabs below', exact: true }).locator('.xterm-rows')
  // (A shell's prompt: sh's `$`, or PowerShell's `>` on Windows, which can take a while there.)
  await expect(rows.first()).toContainText(/[$>]/, { timeout: 60_000 })
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('.xterm') !== null))
    .toBe(true)
}

const card = (page: Page) => page.getByRole('alertdialog')
const address = (page: Page) => page.evaluate(() => window.location.hash)
const POD = DEMO.pods.storefront[0]!

/** What a cluster was asked that changes something: any but a read (a review of access reads). */
const writes = (cluster: MockCluster) =>
  cluster.requests
    .filter((r) => r.method !== 'GET' && !/\/selfsubject(access|rules)reviews$/.test(r.path))
    .map((r) => `${r.method} ${r.path}`)

/** A kubeconfig of `demo` and of `plugged`, the same cluster signed in to by a stand-in program. */
function signingIn(demo: MockCluster) {
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
    currentContext: 'demo',
    clusters: [
      { name: 'demo', server: demo.url, caPem: demo.caPem! },
      { name: 'plugged', server: demo.url, caPem: demo.caPem! },
    ],
    users: [
      { name: 'demo', token: DEMO_TOKEN },
      { name: 'plugged', exec: { command: process.execPath, args: [plugin] } },
    ],
    contexts: [
      { name: 'demo', cluster: 'demo', user: 'demo' },
      { name: 'plugged', cluster: 'plugged', user: 'plugged' },
    ],
  })
  const starts = () => (existsSync(ran) ? readFileSync(ran, 'utf8').split('\n').length - 1 : 0)
  // (Both are the demo cluster: a link names `plugged` by its name, among the two.)
  const at = clusterFingerprint({
    server: demo.url,
    caData: Buffer.from(demo.caPem!).toString('base64'),
  })
  return { kubeconfig, starts, link: `lumovi://cluster/plugged/pods?at=${at}` }
}

test('a link to a cluster that signs in through a program says so, and nothing signs in before Open', async ({
  launch,
  clusters,
}) => {
  const { kubeconfig, starts, link } = signingIn(clusters.demo)
  const { app, page } = await launch({ env: { KUBECONFIG: kubeconfig } })
  await openCluster(page)
  await hand(app, link)
  await expect(card(page)).toContainText('Open Pods in plugged?')
  await expect(card(page)).toContainText(`Opening it signs in with ${basename(process.execPath)}.`)
  await holds(() => starts() === 0, 3_000, 'nothing signs in while the card asks')
  await card(page).getByRole('button', { name: 'Open', exact: true }).click()
  await expect.poll(starts, { timeout: 15_000 }).toBeGreaterThan(0)
  await expect.poll(() => address(page)).toBe('#/cluster/plugged/pods')
})

test('a link that starts Lumovi asks once the windows are back, and nothing signs in before a press', async ({
  launch,
  clusters,
}) => {
  test.slow()
  const { kubeconfig, starts, link } = signingIn(clusters.demo)
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({
      theme: 'system',
      windows: [
        {
          x: 40,
          y: 40,
          width: 1200,
          height: 800,
          maximized: false,
          page: '#/cluster/plugged/pods',
        },
      ],
    }),
  )
  const { page } = await launch({
    userDataDir,
    env: { KUBECONFIG: kubeconfig },
    args: ['--', link],
  })
  // The window is back, on the start screen (its cluster waits for a press), and then it asks.
  await expect(clusterOption(page, 'plugged')).toBeVisible()
  await expect(card(page)).toContainText('Open Pods in plugged?')
  await expect(card(page)).toContainText(`Opening it signs in with ${basename(process.execPath)}.`)
  await holds(() => starts() === 0, 3_000, 'nothing signs in at launch, or while the card asks')
  await card(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(card(page)).toHaveCount(0)
  await holds(() => starts() === 0, 1_000, 'nothing signs in once it’s cancelled')
})

test('where several clusters here are the link’s, it’s picked from: Open and New window wait for a pick', async ({
  launch,
  clusters,
}) => {
  const { url, caPem } = clusters.demo
  const kubeconfig = writeKubeconfig(mkdtempSync(join(tmpdir(), 'lumovi-kubeconfig-')), {
    currentContext: 'eu-admin',
    clusters: [{ name: 'eu', server: url, caPem: caPem! }],
    users: [
      { name: 'admin', token: DEMO_TOKEN },
      { name: 'viewer', token: DEMO_TOKEN },
    ],
    contexts: [
      { name: 'eu-admin', cluster: 'eu', user: 'admin' },
      { name: 'eu-view', cluster: 'eu', user: 'viewer', namespace: 'shop' },
    ],
  })
  const { app, page } = await launch({ env: { KUBECONFIG: kubeconfig } })
  // A colleague's link: the same cluster, as they call it.
  const link = (await linkFor(page, '/cluster/eu-admin/pods')).replace('/eu-admin/', '/prod/')
  await hand(app, link)
  await expect(card(page)).toContainText('Open Pods in which context?')
  const contexts = card(page).getByRole('radiogroup', { name: 'Context' })
  await expect(contexts.getByRole('radio')).toHaveCount(2)
  await expect(contexts).toContainText('eu-admin')
  await expect(contexts).toContainText('viewer · shop')
  await expect(card(page).getByRole('button', { name: 'Open', exact: true })).toBeDisabled()
  await expect(card(page).getByRole('button', { name: 'New window' })).toBeDisabled()
  await contexts.getByText('eu-view').click()
  await expect(card(page)).toContainText('Open Pods in eu-view?')
  await expect(card(page)).toContainText('the link calls it prod')
  await card(page).getByRole('button', { name: 'Open', exact: true }).click()
  // (At the context's own namespace, as opening it anyhow is.)
  await expect.poll(() => address(page)).toMatch(/^#\/cluster\/eu-view\/pods(\?|$)/)
})

test('a link to the cluster another window shows asks in that window', async ({ lumovi }) => {
  const { app, page } = lumovi
  await openCluster(page)
  const link = await linkFor(page, `/cluster/${CONTEXTS.demo}/pods`)
  // A second window, in front, on another cluster.
  const opened = app.waitForEvent('window')
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.getMenuItemById('new-window')!.click(),
  )
  const other = await opened
  await other.emulateMedia({ reducedMotion: 'reduce' })
  await openCluster(other, CONTEXTS.sandbox)
  await hand(app, link)
  await expect(card(page)).toContainText('Go to Pods in demo?')
  await expect(card(other)).toHaveCount(0)
})

test('with an edit that isn’t saved, the card offers a new window first, and the edit stays', async ({
  lumovi,
}) => {
  const { app, page } = lumovi
  await openCluster(page)
  const link = await linkFor(page, `/cluster/${CONTEXTS.sandbox}/pods`)
  await open(page, 'Pods', POD)
  const detail = panel(page, 'Pod', POD)
  await detail.getByRole('tab', { name: 'YAML' }).click()
  await detail.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(detail.getByRole('button', { name: 'Review changes' })).toBeVisible()
  await hand(app, link)
  await expect(card(page)).toContainText(
    'This window has an edit that isn’t saved, so it opens in a new one.',
  )
  const opened = app.waitForEvent('window')
  await card(page).getByRole('button', { name: 'New window' }).click()
  const other = await opened
  await expect.poll(() => address(other)).toBe(`#/cluster/${CONTEXTS.sandbox}/pods`)
  await expect(detail.getByRole('button', { name: 'Review changes' })).toBeVisible()
  await expect.poll(() => address(page)).toContain(`#/cluster/${CONTEXTS.demo}/pods`)
})

test('a link that comes while a dialog is open waits, said by a line a screen reader hears; it asks once the key that closed the dialog is up', async ({
  lumovi,
}) => {
  const { app, page } = lumovi
  await openCluster(page)
  const link = await linkFor(page, `/cluster/${CONTEXTS.demo}/pods`)
  const before = await address(page)
  await inUse(app)
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog').filter({ has: page.getByRole('combobox') })
  await expect(palette).toBeVisible()
  // Two while it's open: only the newer waits.
  await hand(app, `lumovi://cluster/${CONTEXTS.demo}/nodes`)
  await hand(app, link)
  const line = page.getByRole('status').filter({ hasText: 'A link is waiting.' })
  await expect(line).toHaveText('A link is waiting. Lumovi asks about it when this dialog closes.')
  // Heard: nothing around it is hidden from a screen reader, as the dialog hides the rest.
  expect(
    await line.evaluate((at) => at.closest('[aria-hidden="true"]') === null && at.isConnected),
  ).toBe(true)
  // (By what's drawn, not the roles: a dialog hides the rest from those.)
  await holds(
    async () =>
      (await page.locator('[data-link-card]').count()) === 0 && (await palette.count()) === 1,
    1_000,
    'no card over the dialog',
  )
  // ⌘L is the dialog's while a link waits: it goes on to the page, as it does without one.
  await page.evaluate(() => {
    const heard: string[] = []
    ;(window as unknown as { heard: string[] }).heard = heard
    document.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() === 'l') heard.push(event.key)
    })
  })
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+l' : 'Control+Shift+L')
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { heard: string[] }).heard.length))
    .toBe(1)
  // Esc held: the dialog closes as it goes down, and the card waits for it to be let go.
  await page.keyboard.down('Escape')
  await expect(palette).toHaveCount(0)
  await holds(
    async () => (await page.locator('[data-link-card]').count()) === 0,
    700,
    'no card while the key that closed the dialog is down',
  )
  await page.keyboard.up('Escape')
  await expect(card(page)).toContainText('Go to Pods in demo?')
  await expect(line).toHaveCount(0)
  // Asking, as ever: closing the dialog chose nothing, and an Esc just after doesn't either.
  await expect(card(page).getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Escape')
  await holds(
    async () => (await card(page).count()) === 1 && (await address(page)) === before,
    700,
    'one card, still asking',
  )
})

test('fifty links in a second make one card, and nothing is said of those let go', async ({
  lumovi,
}) => {
  const { app, page } = lumovi
  await openCluster(page)
  await app.evaluate(({ app }) => {
    for (let at = 0; at < 50; at++) {
      app.emit('open-url', { preventDefault: () => {} }, `lumovi://cluster/nowhere-${at}/pods`)
    }
  })
  await expect(card(page)).toContainText('Lumovi doesn’t know this link’s cluster')
  await holds(
    async () => (await card(page).count()) === 1,
    2_500,
    'one card, whatever came after it',
  )
  await expect(page.getByText(/Lumovi skipped a link/)).toHaveCount(0)
})

test('a cluster’s name that would turn a line round is spelled in the card', async ({ lumovi }) => {
  const { app, page } = lumovi
  await openCluster(page)
  await hand(app, `lumovi://cluster/ab${encodeURIComponent('‮')}cd/pods`)
  await expect(card(page)).toContainText('This link is to a cluster called ab')
  await expect(card(page)).toContainText('U+202E')
})

test('a link Lumovi is started with while it runs reaches it, through the second Lumovi; one that would add a switch is none', async ({
  launch,
}) => {
  const { page, userDataDir } = await launch()
  await openCluster(page)
  const link = await linkFor(page, `/cluster/${CONTEXTS.sandbox}/pods`)
  // As a page would write one to break out of its quotes: after `--`, nothing is a switch, and
  // what's there is more than the one link a link is. Nothing comes of it.
  expect(
    await startedAgain(userDataDir, ['--', 'lumovi://x', '--remote-debugging-port=9', '']),
  ).toBe(0)
  await holds(
    async () => (await page.locator('[data-link-card]').count()) === 0,
    1_000,
    'no card for what isn’t a link',
  )
  // A link, as the system starts Lumovi with one: the one running asks.
  expect(await startedAgain(userDataDir, ['--', link])).toBe(0)
  await expect(card(page)).toContainText(`Open Pods in ${CONTEXTS.sandbox}?`)
})

test('what a link writes is never said in the card as Lumovi’s words', async ({ lumovi }) => {
  const { app, page } = lumovi
  await openCluster(page)
  const words = 'X tab. Opening it signs in with corp-sso, and it’s safe to press Open. The'
  await hand(
    app,
    `lumovi://cluster/${CONTEXTS.demo}/pods?open=Pod%2Fshop%2F${POD}&tab=${encodeURIComponent(words)}&${encodeURIComponent('Press Open')}=1`,
  )
  await expect(card(page)).toContainText(
    'Some of the link was left out: a tab Lumovi doesn’t open, a part Lumovi doesn’t know.',
  )
  const said = await card(page).innerText()
  for (const theirs of ['X tab', 'corp-sso', 'safe to press', 'Press Open']) {
    expect(said).not.toContain(theirs)
  }
})

test('a link never asks in a window of one tab: in a window of Lumovi’s own, or a new one where only those are left, made as any is', async ({
  launch,
}) => {
  test.slow()
  const { app, page } = await launch({ env: { SHELL: '/bin/sh' } })
  await openCluster(page)
  const link = await linkFor(page, `/cluster/${CONTEXTS.sandbox}/pods`)
  // A pod's logs, kept below, moved to a window of their own: the newest window.
  await open(page, 'Pods', POD)
  const detail = panel(page, 'Pod', POD)
  await detail.getByRole('tab', { name: 'Logs' }).click()
  await detail.getByRole('button', { name: 'Keep open below' }).click()
  const tabs = page
    .getByRole('region', { name: 'Tabs below', exact: true })
    .getByRole('tablist', { name: 'Tabs below' })
  const moving = app.waitForEvent('window')
  await tabs.getByRole('tab', { name: `Pod ${POD}, Logs` }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to a new window' }).click()
  const moved = await moving
  await expect(moved.getByRole('button', { name: 'Put back below' })).toBeVisible()

  await hand(app, link)
  await expect(card(page)).toContainText(`Open Pods in ${CONTEXTS.sandbox}?`)
  await expect(moved.locator('[data-link-card]')).toHaveCount(0)
  await card(page).getByRole('button', { name: 'Cancel' }).click()

  // Only the window of one tab left: a new window of Lumovi's own asks, as from another app (the
  // person wasn't in it): Cancel has the keyboard, and a Tab and an Enter are nothing.
  await page.close()
  await expect.poll(() => windowCount(app)).toBe(1)
  // eslint-disable-next-line no-restricted-syntax -- links are let go for 2 s after an answer: only time ends that
  await moved.waitForTimeout(2_100)
  // (The person typing on as it comes: a Tab and an Enter 300 ms apart, then a run of keys.)
  const opening = app.waitForEvent('window')
  const typing = handedWhileTyping(
    app,
    link,
    [
      'Tab',
      300,
      'Return',
      ...Array.from({ length: 20 }, (_, at) => ['Tab', 'Return', 'x'][at % 3]!),
    ],
    100,
  )
  const fresh = await opening
  await typing
  await expect(card(fresh)).toContainText(`Open Pods in ${CONTEXTS.sandbox}?`)
  await expect(moved.locator('[data-link-card]')).toHaveCount(0)
  const cancel = card(fresh).getByRole('button', { name: 'Cancel' })
  await expect(cancel).toBeFocused()
  expect(await windowCount(app)).toBe(2)
  await cancel.click()

  // It's made as any window is: its terminal's keys are its own, and what it starts ends with it.
  const started = (await ptys(app)).length
  await openCluster(fresh)
  await terminal(fresh)
  if (process.platform === 'darwin') {
    // (As the system sends it: Playwright's ⌘ keys aren't the main process's to see. Again until
    // it's taken, as the page's word that its terminal has the keyboard may still be on its way.)
    const below = fresh.getByRole('region', { name: 'Tabs below', exact: true }).getByRole('tab')
    await expect(async () => {
      if ((await below.count()) < 2) {
        await app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows().find(
            (each) => !each.webContents.getURL().includes('#/tab'),
          )!
          for (const type of ['keyDown', 'char', 'keyUp'] as const) {
            win.webContents.sendInputEvent({ type, keyCode: 'T', modifiers: ['meta'] })
          }
        })
      }
      // (At least: one slow rather than lost would make a third.)
      await expect.poll(() => below.count(), { timeout: 1_000 }).toBeGreaterThanOrEqual(2)
    }).toPass({ timeout: 10_000 })
  }
  expect((await ptys(app)).slice(started)).not.toEqual([])
  await fresh.close()
  await expect.poll(async () => (await ptys(app)).slice(started).every(Boolean)).toBe(true)

  // A link let go (within 2 s of an answer) where only windows of one tab are left: no window
  // is made just to say so.
  await expect.poll(() => windowCount(app)).toBe(1)
  // eslint-disable-next-line no-restricted-syntax -- links are let go for 2 s after an answer: only time ends that
  await moved.waitForTimeout(2_100)
  const again = app.waitForEvent('window')
  await hand(app, link)
  const another = await again
  await card(another).getByRole('button', { name: 'Cancel' }).click()
  await another.close()
  await expect.poll(() => windowCount(app)).toBe(1)
  await hand(app, link)
  await holds(async () => (await windowCount(app)) === 1, 1_000, 'no window made for a skip')
})

test('keys typed as a link raises Lumovi from another app are nothing, before any card: not a terminal’s, nor an open dialog’s', async ({
  launch,
}) => {
  // (Windows' PowerShell can take most of a minute to give its prompt.)
  test.slow(process.platform === 'win32')
  const { app, page } = await launch({ env: { SHELL: '/bin/sh' } })
  await openCluster(page)
  const link = await linkFor(page, `/cluster/${CONTEXTS.sandbox}/pods`)
  // A terminal had the keyboard: the typing that goes on as the link raises the window is
  // nothing, from the hand-over on (before the card is drawn: it's the page's, a moment later).
  await terminal(page)
  const typed = await typedFromNow(app)
  // (A control: a key typed with no link coming is the terminal's, and recorded.)
  await typedHere(app, 'z')
  await expect.poll(typed).toEqual(['z'])
  await handedWhileTyping(app, link)
  await expect(card(page)).toBeVisible()
  expect(await typed()).toEqual(['z'])
  await card(page).getByRole('button', { name: 'Cancel' }).click()

  // A dialog open: the link waits for it, and the typing is nothing there either (its field
  // stays empty, its Enter chooses nothing).
  // eslint-disable-next-line no-restricted-syntax -- links are let go for 2 s after an answer: only time ends that
  await page.waitForTimeout(2_100)
  const address = await page.evaluate(() => window.location.hash)
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog').filter({ has: page.getByRole('combobox') })
  await expect(palette.getByRole('combobox')).toBeFocused()
  await handedWhileTyping(app, link)
  await expect(palette.getByRole('combobox')).toHaveValue('')
  await expect(palette).toBeVisible()
  expect(await page.evaluate(() => window.location.hash)).toBe(address)
  expect(await typed()).toEqual(['z'])
})

test('every page and tab a link may open only reads, and a plugin’s page from one takes nothing else', async ({
  lumovi,
  clusters,
}) => {
  test.slow()
  const { app, page } = lumovi
  await openCluster(page)
  const before = writes(clusters.demo).length
  // A plugin's page, with all a hostile page could add: left out, and said.
  const plugin = await linkFor(page, `/cluster/${CONTEXTS.demo}/plugins/argo-cd/applications`)
  await hand(
    app,
    `${plugin}&open=Application.argoproj.io%2Fargocd%2Fpayments&q=x&switch=1&developer-mode=1&tab=yaml`,
  )
  await expect(card(page)).toContainText('Some of the link was left out:')
  await card(page).getByRole('button', { name: 'Go' }).click()
  await expect
    .poll(() => address(page))
    .toBe(`#/cluster/${CONTEXTS.demo}/plugins/argo-cd/applications`)

  // Every page a link may open, as the card's Go opens it: the app's address of it.
  const go = (to: string) =>
    page.evaluate((hash) => {
      window.location.hash = hash
    }, to)
  const pages = [
    '',
    'workloads',
    'metrics',
    'metrics/right-sizing',
    'alerts',
    'helm',
    'api-resources',
    'plugins',
    'r/Application.argoproj.io',
    'plugins/argo-cd',
    ...RESOURCES.map((resource) => resource.plural),
  ]
  for (const each of pages) {
    await go(`#/cluster/${CONTEXTS.demo}/${each}`)
    await expect(page.getByRole('heading', { level: 1 })).not.toBeEmpty()
  }
  // Every page of every plugin Lumovi comes with, from a link with all a page could add: it
  // takes none of it, and opens as the card's Go opens it.
  const shipped = pluginsAndCode(await takePlugins(readLock(), trust())).plugins
  const pluginPages = Object.entries(shipped).flatMap(([file, text]) => {
    const { plugin } = parsePlugin(text, file, { carriesCode: true })
    return (plugin?.added.pages ?? []).map(({ id }) => `plugins/${plugin!.name}/${id}`)
  })
  expect(pluginPages).toContain('plugins/argo-cd/applications')
  for (const each of pluginPages) {
    const hostile = parseLink(
      `lumovi://cluster/${CONTEXTS.demo}/${each}?open=Pod%2Fshop%2F${POD}&q=x&switch=1&developer-mode=1&tab=yaml`,
    )
    expect(hostile.view).toEqual([])
    expect(hostile.tab).toBeUndefined()
    await go(`#${addressOf(hostile, CONTEXTS.demo)}`)
    await expect(page.getByRole('heading', { level: 1 })).not.toBeEmpty()
  }
  // And an object at each tab that reads.
  await open(page, 'Pods', POD)
  const detail = panel(page, 'Pod', POD)
  for (const tab of READING_TABS.filter((each) => each !== 'pods')) {
    const name = tab === 'yaml' ? 'YAML' : tab[0]!.toUpperCase() + tab.slice(1)
    await detail.getByRole('tab', { name, exact: true }).click()
    await expect(detail.getByRole('tab', { name, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  }
  await holds(
    () => writes(clusters.demo).length === before,
    3_000,
    'nothing but reads reach the cluster',
  )
  expect(writes(clusters.demo).slice(before)).toEqual([])
})

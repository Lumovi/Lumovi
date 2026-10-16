/**
 * lumovi:// links in the desktop app: Copy link, and the card a link handed to Lumovi asks in
 * before it goes anywhere. Links are handed over as macOS does (`open-url`), never by registering
 * the scheme on this computer.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import type { TestClusters } from '../mock-cluster/kubeconfig.ts'
import { holds } from '../holds.ts'
import { open } from './action-helpers.ts'
import { CONTEXTS, DEMO, DEMO_TOKEN, expect, openCluster, panel, test } from './fixtures.ts'

/** A link handed to Lumovi, as the system hands one over. */
const hand = (app: ElectronApplication, link: string) =>
  app.evaluate(({ app }, url) => {
    app.emit('open-url', { preventDefault: () => {} }, url)
  }, link)

/**
 * The person is in Lumovi as a link comes: its windows are the ones in use, not another app's.
 * (The tests' windows never are by themselves: they're shown without taking focus.)
 */
const inUse = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.isFocused = () => true
  })

/** The keyboard's ring, as drawn: its outline. */
/**
 * The keyboard's ring, as drawn: whether its outline is there, solid, in the accent. (Not its
 * width in pixels: a test's window may be zoomed to fit its screen, and that comes out fractional.)
 */
const ring = (button: Locator) =>
  button.evaluate((at) => {
    const { outlineStyle, outlineWidth, outlineColor } = getComputedStyle(at)
    const probe = document.body.appendChild(document.createElement('div'))
    probe.style.color = 'var(--color-accent)'
    const accent = getComputedStyle(probe).color
    probe.remove()
    return Number.parseFloat(outlineWidth) > 0 && outlineColor === accent ? outlineStyle : 'none'
  })

/** The link Copy link would make for a view of this window's clusters (the app's address of it). */
const linkFor = (page: Page, address: string) =>
  page.evaluate(
    (to) =>
      (
        window as unknown as {
          lumovi: { desktop: { linkFor(address: string): Promise<string> } }
        }
      ).lumovi.desktop.linkFor(to),
    address,
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

const card = (page: Page) => page.getByRole('alertdialog')
const POD = DEMO.pods.storefront[0]!

/** A colleague's kubeconfig: the demo cluster, as they call it, and nothing else. */
function colleagues(clusters: TestClusters, name: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'lumovi-colleague-')), 'config')
  writeFileSync(
    path,
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Config',
      'current-context': name,
      clusters: [
        {
          name: 'theirs',
          cluster: {
            server: clusters.demo.url,
            'certificate-authority-data': Buffer.from(clusters.demo.caPem!).toString('base64'),
          },
        },
      ],
      users: [{ name: 'me', user: { token: DEMO_TOKEN } }],
      contexts: [{ name, context: { cluster: 'theirs', user: 'me' } }],
    }),
  )
  return path
}

/**
 * What this window's page puts on the clipboard from now on, kept in the page: the clipboard is
 * the computer's, and tests beside each other would read each other's.
 */
const recordCopies = (page: Page) =>
  page.evaluate(() => {
    const copies: string[] = []
    ;(window as unknown as { copies: string[] }).copies = copies
    navigator.clipboard.writeText = async (text: string) => {
      copies.push(text)
    }
  })
const lastCopy = (page: Page) =>
  page.evaluate(() => (window as unknown as { copies: string[] }).copies.at(-1) ?? '')

/** The link Copy link copies, from an object's More actions. */
async function copied(page: Page): Promise<string> {
  await recordCopies(page)
  await open(page, 'Pods', POD)
  const detail = panel(page, 'Pod', POD)
  await detail.getByRole('tab', { name: 'YAML' }).click()
  await detail.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Copy link' }).click()
  await expect(
    page.getByText('Link copied. It names the cluster, not how to reach it.'),
  ).toBeVisible()
  return lastCopy(page)
}

test('the bar’s More copies the page as it stands: with the panel’s object on its tab, the same link as the object’s', async ({
  lumovi,
}) => {
  const { page } = lumovi
  await openCluster(page)
  const objects = await copied(page)
  await page.locator('header').getByRole('button', { name: 'More', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Copy link to this view' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { copies: string[] }).copies.length))
    .toBe(2)
  expect(await lastCopy(page)).toBe(objects)
})

test('the palette has one Copy link, heading Actions: the page’s, or with an object open, the object’s', async ({
  lumovi,
}) => {
  const { page } = lumovi
  await openCluster(page)
  await recordCopies(page)
  await page.keyboard.press('ControlOrMeta+k')
  const actions = page.getByRole('group', { name: 'Actions' })
  await expect(actions.getByRole('option').first()).toHaveText('Copy link to this view')
  await page.keyboard.press('Escape')
  await open(page, 'Pods', POD)
  await page.keyboard.press('ControlOrMeta+k')
  await expect(actions.getByRole('option').first()).toHaveText(new RegExp(`^Copy link\\s*${POD}$`))
  await expect(page.getByRole('option', { name: /^Copy link to this view/ })).toHaveCount(0)
  await actions.getByRole('option').first().click()
  await expect
    .poll(() => lastCopy(page))
    .toMatch(
      new RegExp(
        `^lumovi://cluster/demo/pods\\?q=${POD}&open=Pod%2Fshop%2F${POD}&tab=overview&at=`,
      ),
    )
})

test('where an organization’s policy turns links off, none is offered, and one handed over is let go', async ({
  launch,
}) => {
  const path = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(path, JSON.stringify({ links: 'off' }))
  const { app, page } = await launch({ env: { LUMOVI_POLICY: path } })
  await openCluster(page)
  await page.locator('header').getByRole('button', { name: 'More', exact: true }).click()
  await expect(page.getByRole('menuitem')).toHaveText([/^Keyboard shortcuts/])
  await page.keyboard.press('Escape')
  await open(page, 'Pods', POD)
  const detail = panel(page, 'Pod', POD)
  await detail.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitem').first()).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /^Copy link/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  // (The panel's object is open: where links are offered, its Copy link heads Actions.)
  await page.keyboard.press('ControlOrMeta+k')
  const actions = page.getByRole('group', { name: 'Actions' })
  await expect(actions.getByRole('option').first()).toBeVisible()
  await expect(actions.getByRole('option', { name: /^Copy link/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  // Handed over all the same: nothing waits for the window, so no card.
  await hand(app, `lumovi://cluster/${CONTEXTS.demo}/pods`)
  const waiting = await page.evaluate(() =>
    (
      window as unknown as { lumovi: { desktop: { takeLink(): Promise<unknown> } } }
    ).lumovi.desktop.takeLink(),
  )
  expect(waiting).toBeNull()
  await expect(card(page)).toHaveCount(0)
})

test('a copied link opens the same object, on its tab, where a colleague calls the cluster otherwise', async ({
  launch,
  clusters,
}) => {
  const mine = await launch()
  await openCluster(mine.page)
  const link = await copied(mine.page)
  expect(link).toMatch(
    new RegExp(
      `^lumovi://cluster/demo/pods\\?q=${POD}&open=Pod%2Fshop%2F${POD}&tab=yaml&at=[0-9a-f]{12}$`,
    ),
  )
  // Nothing in it that reaches the cluster: no address, no token.
  expect(link).not.toContain(String(clusters.demo.port))
  expect(link).not.toContain(DEMO_TOKEN)

  const theirs = await launch({ env: { KUBECONFIG: colleagues(clusters, 'prod-eu') } })
  const asked = clusters.demo.requests.length
  await hand(theirs.app, link)
  const asks = card(theirs.page)
  await expect(asks).toContainText(`Open ${POD} in prod-eu?`)
  await expect(asks).toContainText('Pod in shop, on its YAML tab · the link calls it demo')
  // Nothing read before a press, and Cancel has the keyboard.
  expect(clusters.demo.requests.slice(asked).filter((r) => r.path.includes(POD))).toEqual([])
  // (From another app: the card's, as ever.)
  await expect(asks.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await asks.getByRole('button', { name: 'Open', exact: true }).click()
  const detail = panel(theirs.page, 'Pod', POD)
  await expect(detail.getByRole('tab', { name: 'YAML' })).toHaveAttribute('aria-selected', 'true')
  await expect(asks).toHaveCount(0)
})

test('where the cluster isn’t here, at another address, or the link can’t be read, the card says so', async ({
  lumovi,
}) => {
  const { app, page } = lumovi
  await openCluster(page)
  await inUse(app)
  // Its name is here, at another address.
  await hand(app, `lumovi://cluster/${CONTEXTS.demo}/pods?at=000000000000`)
  await expect(card(page)).toContainText(
    'You have a cluster called demo, but at another address than the link’s.',
  )
  // Cancel has the keyboard, and its ring says so, though no key gave it.
  const cancel = card(page).getByRole('button', { name: 'Cancel' })
  await expect(cancel).toBeFocused()
  await expect.poll(() => ring(cancel)).toBe('solid')
  await expect(card(page).getByRole('button', { name: 'Open demo anyway' })).toBeVisible()
  // eslint-disable-next-line no-restricted-syntax -- Esc is dead for the card's first 500 ms: only time ends that
  await page.waitForTimeout(500)
  await page.keyboard.press('Escape')
  await expect(card(page)).toHaveCount(0)
  // A link that came within 2 s of the answer: let go, and said once.
  await hand(app, 'lumovi://cluster/nowhere/pods?at=000000000000')
  await hand(app, 'lumovi://cluster/nowhere/nodes?at=000000000000')
  await expect(
    page.getByText(
      'Lumovi skipped a link that came right after the last one. Open it again if you meant to.',
    ),
  ).toHaveCount(1)
  await expect(card(page)).toHaveCount(0)
  // Not here at all: Add a cluster takes there.
  // eslint-disable-next-line no-restricted-syntax -- links are let go for 2 s after an answer: only time ends that
  await page.waitForTimeout(2_100)
  await hand(app, 'lumovi://cluster/nowhere/pods?at=000000000000')
  await expect(card(page)).toContainText('Lumovi doesn’t know this link’s cluster')
  await expect(card(page)).toContainText(
    'This link is to a cluster called nowhere that isn’t in your kubeconfig. Ask whoever sent it which one it is, then add it.',
  )
  await card(page)
    .getByRole('button', { name: /^Add a cluster/ })
    .click()
  const adding = page.getByRole('dialog', { name: 'Add a cluster' })
  await expect(adding).toBeVisible()
  await adding.getByRole('button', { name: 'Cancel' }).click()
  await expect(adding).toHaveCount(0)
  // One that can't be read: refused whole.
  // eslint-disable-next-line no-restricted-syntax -- links are let go for 2 s after an answer: only time ends that
  await page.waitForTimeout(2_100)
  await hand(app, 'lumovi://cluster:9222/demo/pods')
  await expect(card(page)).toContainText(
    'This link can’t be opened: it names a port, and a link never does.',
  )
  await card(page).getByRole('button', { name: 'Close' }).click()
})

test('a link to the cluster this window shows asks Go; Enter does nothing at first, and while a field is typed in, ⌘L answers', async ({
  lumovi,
}) => {
  const { app, page } = lumovi
  await openCluster(page)
  const link = await copied(page)
  await page.keyboard.press('Escape')
  // Typing in the filter, in Lumovi: the card doesn't take the keyboard, and says which key goes
  // to it.
  await inUse(app)
  await page.getByPlaceholder('Filter pods').fill('')
  await hand(app, link)
  await expect(card(page)).toContainText(`Go to ${POD} in demo?`)
  await expect(card(page)).toContainText(
    `${process.platform === 'darwin' ? '⌘L' : 'Ctrl+⇧L'} to answer`,
  )
  await page.keyboard.type('abc')
  await expect(page.getByPlaceholder('Filter pods')).toHaveValue('abc')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+l' : 'Control+Shift+L')
  await expect(card(page).getByRole('button', { name: 'Cancel' })).toBeFocused()
  // eslint-disable-next-line no-restricted-syntax -- Enter is dead for the card's first 500 ms: only time ends that
  await page.waitForTimeout(500)
  await card(page).getByRole('button', { name: 'Go' }).focus()
  await page.keyboard.press('Enter')
  await expect(card(page)).toHaveCount(0)
})

test('Enter, Space or Esc as the card comes up isn’t an answer; Esc after is Cancel', async ({
  lumovi,
}) => {
  const { app, page } = lumovi
  await openCluster(page)
  const link = await copied(page)
  const before = await page.evaluate(() => window.location.hash)
  await inUse(app)
  await hand(app, link)
  await expect(card(page)).toContainText(`Go to ${POD} in demo?`)
  await card(page).getByRole('button', { name: 'Go' }).focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press(' ')
  await page.keyboard.press('Escape')
  await holds(
    async () =>
      (await card(page).count()) === 1 &&
      (await page.evaluate(() => window.location.hash)) === before,
    700,
    'the card still asks, and nothing was opened',
  )
  await page.keyboard.press('Escape')
  await expect(card(page)).toHaveCount(0)
})

test('a link from another app: Cancel has the keyboard, and what the person goes on typing is nothing, there or behind it, until they stop', async ({
  launch,
}) => {
  // (Windows' PowerShell can take most of a minute to give its prompt.)
  test.slow(process.platform === 'win32')
  const { app, page } = await launch({ env: { SHELL: '/bin/sh' } })
  await openCluster(page)
  const link = await linkFor(page, `/cluster/${CONTEXTS.sandbox}/pods`)
  // A terminal had the keyboard before the person went to another app.
  await page.keyboard.press('Control+Backquote')
  const rows = page.getByRole('region', { name: 'Tabs below', exact: true }).locator('.xterm-rows')
  // (A shell's prompt: sh's `$`, or PowerShell's `>` on Windows.)
  await expect(rows).toContainText(/[$>]/, { timeout: 60_000 })
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('.xterm') !== null))
    .toBe(true)
  const typed = await typedFromNow(app)
  // (A control: a key typed with no link coming is the terminal's, and recorded.)
  await typedHere(app, 'z')
  await expect.poll(typed).toEqual(['z'])
  const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

  // As Lumovi comes forward, the person types on: a Tab and an Enter 300 ms apart, then a run of
  // keys every 100 ms, from the hand-over on (before the card is drawn, and after).
  const run = ['a', 'Tab', 'Shift+Tab', 'Return', 'Space', 'b', 'Escape', 'Tab', 'Return', 'c']
  await handedWhileTyping(app, link, ['Tab', 300, 'Return', ...run, ...run], 100)
  await expect(card(page)).toContainText(`Open Pods in ${CONTEXTS.sandbox}?`)
  const cancel = card(page).getByRole('button', { name: 'Cancel' })
  await expect(cancel).toBeFocused()
  await expect.poll(() => ring(cancel)).toBe('solid')
  await expect(card(page)).not.toContainText('to answer')
  expect(await windows()).toBe(1)
  expect(await typed()).toEqual(['z'])
  // Typing stopped: the card's keys are its own, and Tab goes round its buttons alone.
  // eslint-disable-next-line no-restricted-syntax -- typing stopped for more than 500 ms: only time says so
  await page.waitForTimeout(600)
  await page.keyboard.press('Shift+Tab')
  await expect(card(page).getByRole('button', { name: 'Open', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(cancel).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(card(page).getByRole('button', { name: 'New window' })).toBeFocused()
  const opened = app.waitForEvent('window')
  await page.keyboard.press('Enter')
  await opened
  await expect(card(page)).toHaveCount(0)
  expect(await typed()).toEqual(['z'])
})

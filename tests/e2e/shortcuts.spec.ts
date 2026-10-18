/**
 * Keyboard shortcuts (LMV-358): a command's keys changed in Settings are its keys everywhere (the
 * page, the menu, the ? sheet, tooltips) and are kept; put back one by one or all at once; keys
 * another command has are asked about first, keys that can't be taken refused with why; a place's
 * keys follow too; and what an organization's policy sets is locked.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, openCluster, panel, test } from './fixtures.ts'

const MAC = process.platform === 'darwin'
/** The ⌘ key, as the system sends it (Ctrl off a Mac). */
const MOD = MAC ? 'meta' : 'control'
/** And as a sentence says it. */
const said = (key: string) => (MAC ? `⌘ ${key}` : `Ctrl+${key}`)

async function openShortcuts(page: Page) {
  await page.evaluate(() => (location.hash = '#/cluster/demo/settings?section=shortcuts'))
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts', level: 2 })).toBeVisible()
}

const row = (page: Page, name: string) =>
  page.getByRole('main').getByRole('group', { name, exact: true })

/**
 * A key as the system sends it, before the menu has it (Playwright's keys reach the page alone):
 * how Settings hears the keys it records on the desktop.
 */
async function native(app: ElectronApplication, keyCode: string, modifiers: string[] = []) {
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

/** Records a command's new keys: its row's button, then the keys. */
async function record(
  page: Page,
  app: ElectronApplication,
  name: string,
  keyCode: string,
  modifiers: string[] = [],
) {
  await row(page, name)
    .getByRole('button', { name: `Change ${name}’s keys` })
    .click()
  await expect(row(page, name)).toContainText('Press the new keys · Esc to cancel')
  await native(app, keyCode, modifiers)
}

const accelerator = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.accelerator, id)

test('a command’s keys changed in Settings are its keys everywhere, kept, and put back', async ({
  launch,
}) => {
  const lumovi = await launch()
  const { page, app, userDataDir } = lumovi
  await openCluster(page)
  await openShortcuts(page)
  // Built in: said so, with nothing to change.
  await expect(row(page, 'Move through rows (or J / K)')).toContainText('Built in')
  await expect(row(page, 'Move through rows (or J / K)').getByRole('button')).toHaveCount(0)

  await record(page, app, 'Command palette', 'P', [MOD])
  await expect(row(page, 'Command palette')).toContainText('Changed')
  await expect(row(page, 'Command palette')).toContainText('P')
  // The menu's, the search's in the bar, the sheet's.
  expect(await accelerator(app, 'palette')).toBe('CmdOrCtrl+P')
  await expect(page.locator('header').getByRole('button', { name: /Search/ })).toContainText('P')
  // The page's: ⌘P opens the palette, and ⌘K doesn't any more.
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+p')
  const palette = page.getByRole('dialog').filter({ has: page.getByRole('combobox') })
  await expect(palette).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+?')
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(sheet.getByText('Command palette').locator('..')).toContainText('P')
  await page.keyboard.press('Escape')

  // Another: Refresh, whose tooltip says it.
  await record(page, app, 'Refresh', 'R', [MOD, 'shift'])
  await expect(
    page.getByRole('button', { name: MAC ? 'Refresh (⌘⇧R)' : 'Refresh (Ctrl+Shift+R)' }),
  ).toBeVisible()
  expect(await accelerator(app, 'refresh')).toBe('CmdOrCtrl+Shift+R')

  const kept = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as {
    preferences: object
  }
  expect(kept.preferences).toEqual({
    shortcuts: { palette: ['Mod+P'], refresh: ['Mod+Shift+R'] },
  })
  await lumovi.close()

  const again = await launch({ userDataDir })
  await openCluster(again.page)
  expect(await accelerator(again.app, 'palette')).toBe('CmdOrCtrl+P')
  await openShortcuts(again.page)
  // ↺ puts one back; Reset all… asks once, then puts every one back.
  await row(again.page, 'Command palette')
    .getByRole('button', { name: 'Put Command palette’s keys back' })
    .click()
  await expect(row(again.page, 'Command palette')).not.toContainText('Changed')
  expect(await accelerator(again.app, 'palette')).toBe('CmdOrCtrl+K')
  await again.page.getByRole('button', { name: 'Reset all…' }).click()
  await again.page.getByRole('button', { name: 'Reset all', exact: true }).click()
  await expect(row(again.page, 'Refresh')).not.toContainText('Changed')
  await expect(again.page.getByRole('button', { name: 'Reset all…' })).toBeDisabled()
  expect(await accelerator(again.app, 'refresh')).toBe('CmdOrCtrl+R')
  // A search finds a command, or a key.
  await again.page.getByRole('textbox', { name: 'Search commands or keys' }).fill('forw')
  await expect(row(again.page, 'Forward')).toBeVisible()
  await expect(row(again.page, 'Back')).toHaveCount(0)
})

test('keys another command has are asked about first, and keys that can’t be taken refused with why', async ({
  lumovi,
}) => {
  const { page, app } = lumovi
  await openCluster(page)
  await openShortcuts(page)

  // Back's, in the same place: asked, and taken from it.
  await record(page, app, 'Forward', '[', [MOD])
  const forward = row(page, 'Forward')
  await expect(forward.getByRole('alert')).toHaveText(
    `${said('[')} is Back’s. Use it here, and Back has no keys until you give it some.Use it hereCancel`,
  )
  await forward.getByRole('button', { name: 'Use it here' }).click()
  await expect(row(page, 'Back')).toContainText('None')
  await expect(forward).toContainText('Changed')
  // Back's ↺ asks to give it back, and Forward is left with none.
  await row(page, 'Back').getByRole('button', { name: 'Put Back’s keys back' }).click()
  await expect(row(page, 'Back').getByRole('alert')).toContainText(
    `${said('[')} is Forward’s now. Give it back to Back, and Forward has no keys?`,
  )
  await row(page, 'Back').getByRole('button', { name: 'Give it back' }).click()
  await expect(forward).toContainText('None')
  await expect(row(page, 'Back')).not.toContainText('None')

  // The system's, built in, a terminal's: refused, and it still records.
  await record(page, app, 'Forward', MAC ? 'W' : 'C', [MOD])
  await expect(forward.getByRole('alert')).toHaveText(
    MAC
      ? '⌘ W stays the system’s: it closes the window. Press other keys, or Esc.'
      : 'Ctrl+C stays the system’s: it copies. Press other keys, or Esc.',
  )
  // ⌘Q, while recording, is refused too: Lumovi stays open.
  if (MAC) {
    await native(app, 'Q', [MOD])
    await expect(forward.getByRole('alert')).toHaveText(
      '⌘ Q stays the system’s: it quits Lumovi. Press other keys, or Esc.',
    )
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  }
  await native(app, 'J')
  await expect(forward.getByRole('alert')).toHaveText(
    'J is built in: it moves through a list. Press other keys, or Esc.',
  )
  // Esc stops, with nothing changed.
  await native(app, 'Escape')
  await expect(forward.getByRole('alert')).toHaveCount(0)
  await expect(forward).toContainText('None')
  await record(page, app, 'Close the terminal', 'D', MAC ? ['control'] : [MOD])
  await expect(row(page, 'Close the terminal').getByRole('alert')).toContainText(
    'is the terminal’s while it has the keyboard.',
  )
  await native(app, 'Escape')

  // Everywhere, a key a terminal has: it keeps it while it has the keyboard; asked.
  await record(page, app, 'Command palette', 'T', MAC ? [MOD] : [MOD, 'shift'])
  await expect(row(page, 'Command palette').getByRole('alert')).toContainText(
    `In a terminal, ${MAC ? '⌘ T' : 'Ctrl+Shift+T'} is still New terminal, from a terminal. Use it anyway?`,
  )
  await native(app, 'Escape')
  // An open object's, a key everywhere has: asked the other way round, and Enter says yes.
  await record(page, app, 'Pin or unpin the open object', 'R', [MOD])
  const pin = row(page, 'Pin or unpin the open object')
  await expect(pin.getByRole('alert')).toContainText(
    `Everywhere else, ${said('R')} is Refresh. Use it anyway?`,
  )
  await native(app, 'Enter')
  await expect(pin).toContainText('Changed')

  // In an open object it pins (the menu's Refresh lets it), and elsewhere it refreshes.
  await page.evaluate(
    () => (location.hash = '#/cluster/demo/deployments?namespaces=shop&open=Deployment/shop/cart'),
  )
  const cart = panel(page, 'Deployment', 'cart')
  await expect(cart).toBeVisible()
  // (The open object holds R once its panel is drawn and its claim is live: until then the menu's
  // Refresh is everywhere's, which refreshes. Pressed again only while it isn't pinned yet.)
  const pinned = cart.getByRole('button', { name: 'Pinned' })
  await expect(async () => {
    if ((await pinned.count()) === 0) {
      await app.evaluate(({ Menu, BrowserWindow }) =>
        Menu.getApplicationMenu()!
          .getMenuItemById('refresh')!
          .click(undefined, BrowserWindow.getAllWindows()[0]),
      )
    }
    await expect(pinned).toBeVisible({ timeout: 1000 })
  }).toPass()

  // The window losing focus while it records ends the recording: the menu's keys are its own.
  await openShortcuts(page)
  await row(page, 'Forward').getByRole('button', { name: 'Change Forward’s keys' }).click()
  await expect(row(page, 'Forward')).toContainText('Press the new keys')
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(row(page, 'Forward')).not.toContainText('Press the new keys')
  await native(app, 'K', [MOD])
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  await page.keyboard.press('Escape')
  // So does a click elsewhere.
  await row(page, 'Forward').getByRole('button', { name: 'Change Forward’s keys' }).click()
  await page.getByRole('heading', { name: 'Keyboard shortcuts', level: 2 }).click()
  await expect(row(page, 'Forward')).not.toContainText('Press the new keys')

  // A page that goes while it records (a reload) takes its recording with it: the window's
  // keys are its own again, the menu's too.
  await openShortcuts(page)
  await row(page, 'Forward').getByRole('button', { name: 'Change Forward’s keys' }).click()
  await expect(row(page, 'Forward')).toContainText('Press the new keys')
  await page.reload()
  await openCluster(page)
  await native(app, 'K', [MOD])
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
})

test('a place’s keys follow Settings: an open object’s, a list’s, the Clusters page’s, a terminal’s', async ({
  lumovi,
}) => {
  const { page, app } = lumovi
  await openCluster(page)
  await openShortcuts(page)
  await record(page, app, 'Actions: scale, restart, edit…', 'A')
  await record(page, app, 'Select the row (Shift for a range)', 'S')
  await record(
    page,
    app,
    'Show or hide the terminal',
    'Y',
    MAC ? ['control', 'shift'] : [MOD, 'shift'],
  )
  await expect(
    page.getByRole('button', { name: `Open a terminal (${MAC ? '⌃⇧Y' : 'Ctrl+Shift+Y'})` }),
  ).toBeVisible()

  await page.evaluate(
    () => (location.hash = '#/cluster/demo/deployments?namespaces=shop&open=Deployment/shop/cart'),
  )
  await expect(panel(page, 'Deployment', 'cart')).toBeVisible()
  await page.getByRole('heading', { name: 'cart', level: 2 }).click()
  await page.keyboard.press('.')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.keyboard.press('a')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')

  // A list's row is selected by S (with Shift, a range), and X does nothing.
  await page.keyboard.press('Escape')
  const toolbar = page.getByRole('toolbar', { name: 'Selected rows' })
  await page.getByRole('grid', { name: 'Deployments' }).focus()
  await page.keyboard.press('x')
  await expect(toolbar).toHaveCount(0)
  await page.keyboard.press('s')
  await expect(toolbar).toContainText('1 selected')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Shift+S')
  await expect(toolbar).toContainText('2 selected')

  // The terminal's own key.
  await page.keyboard.press('Control+Shift+Y')
  await expect(page.getByRole('region', { name: 'Tabs below', exact: true })).toBeVisible()
})

test('what a policy sets for a command’s keys is locked; one whose keys clash can’t be used', async ({
  launch,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-policy-'))
  const policy = join(dir, 'policy.json')
  writeFileSync(policy, JSON.stringify({ settings: { shortcuts: { palette: ['Mod+P'] } } }))
  const lumovi = await launch({ env: { LUMOVI_POLICY: policy } })
  const { page, app } = lumovi
  await openCluster(page)
  await openShortcuts(page)
  await expect(row(page, 'Command palette').getByLabel('Set by your organization')).toBeVisible()
  await expect(row(page, 'Command palette').getByRole('button')).toHaveCount(0)
  await expect(
    page
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('button', { name: /^Keyboard shortcuts/ })
      .getByLabel('Set by your organization'),
  ).toBeVisible()
  expect(await accelerator(app, 'palette')).toBe('CmdOrCtrl+P')
  // Its key isn't another's to take, and the page's change to it is refused.
  await record(page, app, 'Filter the list', 'P', [MOD])
  await expect(row(page, 'Filter the list').getByRole('alert')).toHaveText(
    `${said('P')} is Command palette’s, which your organization set. Press other keys, or Esc.`,
  )
  await native(app, 'Escape')
  expect(
    await page.evaluate(() =>
      window.lumovi!.app.setPreferences({ shortcuts: { palette: ['Mod+J'] } }),
    ),
  ).toMatchObject({ ok: false, error: { message: 'shortcuts.palette: set by your organization.' } })
  // A key the system keeps isn't taken through the page either.
  expect(
    await page.evaluate(() =>
      window.lumovi!.app.setPreferences({ shortcuts: { filter: ['Mod+C'] } }),
    ),
  ).toMatchObject({ ok: false, error: { message: /^shortcuts: Mod\+C stays the system’s/ } })
  await lumovi.close()

  // Keys that do two things where both work: the policy can't be used, and says why.
  writeFileSync(policy, JSON.stringify({ settings: { shortcuts: { filter: ['Mod+R'] } } }))
  const again = await launch({ env: { LUMOVI_POLICY: policy } })
  expect((await again.page.evaluate(() => window.lumovi!.app.settings())).managed?.problem).toMatch(
    /settings: shortcuts: Mod\+R can’t be both Filter the list’s and Refresh’s\./,
  )
})

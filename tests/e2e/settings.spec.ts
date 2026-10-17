/**
 * Settings on the desktop (LMV-357): each applies at once, in every window, and survives a
 * restart; the time zone and clock are every date's; the terminal's font is an open terminal's at
 * once; the shell Settings names is the one a terminal starts; a cluster opens in the namespace it
 * says; and what an organization's policy sets is shown locked, and refused.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { HELM } from '../mock-cluster/fixtures/helm.ts'
import { expect, openCluster, test, type Lumovi } from './fixtures.ts'

const WINDOWS = process.platform === 'win32'

async function openSettings(page: Page, section?: string) {
  await page.evaluate(
    (section) => (location.hash = `#/cluster/demo/settings${section ? `?section=${section}` : ''}`),
    section,
  )
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings')
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Settings' })
const zoom = (lumovi: Lumovi, i = 0) =>
  lumovi.app.evaluate(
    ({ BrowserWindow }, i) => BrowserWindow.getAllWindows()[i]!.webContents.getZoomFactor(),
    i,
  )

test('appearance applies at once, in every window, and is kept across a restart', async ({
  launch,
}) => {
  const lumovi = await launch()
  const { page, app, userDataDir } = lumovi
  await openCluster(page)
  await openSettings(page)
  const root = page.locator('html')

  // Another window, open as it changes.
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.getMenuItemById('new-window')!.click(),
  )
  const other = await app.waitForEvent('window')
  await other.waitForLoadState('domcontentloaded')

  await page.getByRole('radio', { name: 'Violet' }).click()
  await expect(root).toHaveAttribute('data-accent', 'violet')
  await expect(other.locator('html')).toHaveAttribute('data-accent', 'violet')
  await page.getByRole('radio', { name: 'Compact' }).click()
  await expect(root).toHaveAttribute('data-density', 'compact')
  await expect(page.getByRole('group', { name: 'Accent' })).toContainText(
    'Violet. Statuses keep their own colours',
  )

  // Text size is the windows' zoom, every one.
  await page.getByRole('button', { name: 'Larger text size' }).click()
  await expect(page.getByRole('group', { name: 'Text size' })).toContainText('110%')
  await expect.poll(() => zoom(lumovi)).toBeCloseTo(1.1)
  await expect.poll(() => zoom(lumovi, 1)).toBeCloseTo(1.1)
  // The View menu's Actual Size is the same setting.
  await app.evaluate(({ Menu, BrowserWindow }) =>
    Menu.getApplicationMenu()!
      .getMenuItemById('text-actual')!
      .click(undefined, BrowserWindow.getAllWindows()[0]),
  )
  await expect(page.getByRole('group', { name: 'Text size' })).toContainText('100%')
  await expect.poll(() => zoom(lumovi)).toBeCloseTo(1)

  // A compact list's rows.
  await page.evaluate(() => (location.hash = '#/cluster/demo/pods'))
  const firstRow = page.getByRole('grid', { name: 'Pods' }).getByRole('row').nth(1)
  await expect(firstRow).toHaveCSS('height', '36px')

  const kept = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as {
    preferences: object
  }
  expect(kept.preferences).toEqual({ accent: 'violet', density: 'compact' })
  await lumovi.close()

  const again = await launch({ userDataDir })
  await openCluster(again.page)
  await expect(again.page.locator('html')).toHaveAttribute('data-accent', 'violet')
  await openSettings(again.page)
  await expect(again.page.getByRole('radio', { name: 'Compact' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  // Restore puts the section's back, and then has nothing left to restore.
  await again.page.getByRole('button', { name: 'Restore this section’s defaults' }).click()
  await expect(again.page.locator('html')).not.toHaveAttribute('data-accent')
  await expect(again.page.locator('html')).not.toHaveAttribute('data-density')
  await expect(
    again.page.getByRole('button', { name: 'Restore this section’s defaults' }),
  ).toHaveCount(0)
})

test('the time zone and clock are every date’s', async ({ page }) => {
  await openCluster(page)
  await openSettings(page, 'time')
  const set = async (zone: string, clock: string) => {
    await page.getByRole('combobox', { name: 'Time zone' }).selectOption(zone)
    await page.getByRole('radio', { name: clock }).click()
  }
  const installed = async () => {
    await page.evaluate(
      (name) => (location.hash = `#/cluster/demo/helm?release=shop/${name}`),
      HELM.storefront,
    )
    const release = page.getByRole('complementary', { name: `Helm release ${HELM.storefront}` })
    const line = release.getByText(/ago\)$/).first()
    await expect(line).toBeVisible()
    return (await line.textContent())!
  }
  await set('Pacific/Kiritimati', '24-hour')
  const east = await installed()
  expect(east).not.toMatch(/AM|PM/)
  await openSettings(page, 'time')
  await set('Pacific/Pago_Pago', '12-hour')
  const west = await installed()
  expect(west).toMatch(/AM|PM/)
  // A day apart: UTC+14 and UTC−11 never say the same date and time.
  expect(west).not.toBe(east)
})

test('the terminal’s font is an open terminal’s at once; a shell Settings names that isn’t there is said so', async ({
  launch,
}) => {
  test.skip(WINDOWS, 'Windows starts PowerShell, whatever path is set here')
  const lumovi = await launch({ env: { SHELL: '/bin/sh' } })
  const { page } = lumovi
  await openCluster(page)
  await page.keyboard.press('Control+Backquote')
  const rows = page
    .getByRole('region', { name: 'Tabs below', exact: true })
    .getByRole('tabpanel')
    .getByRole('region')
    .locator('.xterm-rows')
  await expect(rows).toContainText('in this terminal.')
  await expect(rows).toHaveCSS('font-size', '12px')
  await openSettings(page, 'terminal')
  await page.getByRole('button', { name: 'Larger terminal font size' }).click()
  await page.getByRole('button', { name: 'Larger terminal font size' }).click()
  await expect(page.getByRole('group', { name: 'Font' })).toContainText('14 px')
  await expect(page.getByLabel('Terminal preview')).toHaveCSS('font-size', '14px')
  await expect(rows).toHaveCSS('font-size', '14px')

  // A shell that isn't there: the next terminal says so, and where to change it.
  await page.getByRole('combobox', { name: 'Shell' }).selectOption('other')
  await page.getByRole('textbox', { name: 'Shell’s path' }).fill('/nowhere/lumovi-no-shell')
  await page.getByRole('button', { name: 'Use it' }).click()
  await expect(page.getByRole('combobox', { name: 'Shell' })).toHaveValue('other')
  await page.keyboard.press('Control+Shift+Backquote')
  await expect(page.getByRole('region', { name: 'Tabs below', exact: true })).toContainText(
    'The shell Settings names, /nowhere/lumovi-no-shell, isn’t there: choose another in Settings.',
  )
})

test('a cluster opens in the namespace Settings names', async ({ page }) => {
  await openCluster(page)
  await openSettings(page, 'namespaces')
  await page.getByRole('textbox', { name: 'Namespace a cluster opens in' }).fill('kube-system')
  await page.getByRole('radio', { name: 'This one' }).click()
  await expect(page.getByRole('radio', { name: 'This one' })).toBeChecked()
  // Open again, fresh: the start, then the cluster (in Recent now).
  await page.evaluate(() => (location.hash = '#/'))
  await page
    .getByRole('option', { name: /^demo current/ })
    .first()
    .click()
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toContainText('demo')
  await expect(page.getByRole('button', { name: 'Namespace' })).toContainText('kube-system')
})

test('what the organization’s policy sets is shown locked, and refused', async ({ launch }) => {
  const policy = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(
    policy,
    JSON.stringify({ updates: false, settings: { accent: 'graphite', shell: '/bin/sh' } }),
  )
  const { page } = await launch({ env: { LUMOVI_POLICY: policy } })
  await openCluster(page)
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'graphite')
  await openSettings(page)
  const accent = page.getByRole('group', { name: 'Accent' })
  await expect(accent).toContainText('Set by your organization')
  await expect(accent.getByRole('radio', { name: 'Blue' })).toBeDisabled()
  // The sections it sets carry the lock; Updates' check is off, and Check now stays.
  await expect(
    nav(page)
      .getByRole('button', { name: /Terminal/ })
      .getByLabel('Set by your organization'),
  ).toBeVisible()
  await nav(page)
    .getByRole('button', { name: /Updates/ })
    .click()
  await expect(page.getByRole('switch', { name: 'Check for updates' })).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Check now' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Restore this section’s defaults' })).toHaveCount(0)
  // Whatever the page sends, what it sets stays.
  const refused = await page.evaluate(() => window.lumovi!.app.setPreferences({ accent: 'blue' }))
  expect(refused).toMatchObject({
    ok: false,
    error: { message: 'accent: set by your organization.' },
  })
})

test('every setting’s control does what it says, and Restore puts each section back', async ({
  launch,
}) => {
  const lumovi = await launch({ env: { SHELL: '/bin/sh' } })
  const { page, app } = lumovi
  await openCluster(page)
  const root = page.locator('html')
  const restore = () => page.getByRole('button', { name: 'Restore this section’s defaults' })

  // Appearance: each theme; text size up, past its top, and down again, from the menu too.
  await openSettings(page)
  for (const theme of ['Light', 'Dark', 'System']) {
    await page.getByRole('radio', { name: theme }).click()
    await expect(page.getByRole('radio', { name: theme })).toHaveAttribute('aria-checked', 'true')
  }
  const menu = (id: string) =>
    app.evaluate(
      ({ Menu, BrowserWindow }, id) =>
        Menu.getApplicationMenu()!
          .getMenuItemById(id)!
          .click(undefined, BrowserWindow.getAllWindows()[0]),
      id,
    )
  const size = page.getByRole('group', { name: 'Text size' })
  for (const expected of ['110%', '125%', '125%']) {
    await menu('text-bigger')
    await expect(size).toContainText(expected)
  }
  await expect(page.getByRole('button', { name: 'Larger text size' })).toBeDisabled()
  await menu('text-smaller')
  await expect(size).toContainText('110%')
  await page.getByRole('button', { name: 'Smaller text size' }).click()
  await page.getByRole('button', { name: 'Smaller text size' }).click()
  await expect(size).toContainText('90%')
  await page.getByRole('radio', { name: 'Cyan' }).click()
  await expect(root).toHaveAttribute('data-accent', 'cyan')
  await restore().click()
  await expect(size).toContainText('100%')
  await expect(root).not.toHaveAttribute('data-accent')

  // Time: a zone and each clock; then back.
  await nav(page).getByRole('button', { name: 'Time' }).click()
  await page.getByRole('combobox', { name: 'Time zone' }).selectOption('UTC')
  for (const clock of ['12-hour', '24-hour', 'System']) {
    await page.getByRole('radio', { name: clock }).click()
    await expect(page.getByRole('radio', { name: clock })).toHaveAttribute('aria-checked', 'true')
  }
  await expect(page.getByRole('group', { name: 'Clock' })).toContainText('System:')
  await restore().click()
  await expect(page.getByRole('combobox', { name: 'Time zone' })).toHaveValue('local')

  // Terminal: another font, copy on select, a shell the computer lists, and back.
  await nav(page).getByRole('button', { name: 'Terminal' }).click()
  await page.getByRole('combobox', { name: 'Terminal font' }).selectOption('Menlo')
  await expect(page.getByLabel('Terminal preview')).toHaveCSS('font-family', /Menlo/)
  await page.getByRole('button', { name: 'Smaller terminal font size' }).click()
  await expect(page.getByRole('group', { name: 'Font' })).toContainText('11 px')
  await page.getByRole('switch', { name: 'Copy what I select' }).click()
  await expect(page.getByRole('group', { name: 'Copy on select' })).toContainText(
    'On: what you select is copied at once.',
  )
  const shell = page.getByRole('combobox', { name: 'Shell' })
  const listed = await shell
    .locator('option')
    .evaluateAll((options) =>
      options.map((o) => (o as HTMLOptionElement).value).filter((v) => v && v !== 'other'),
    )
  if (listed[0]) {
    await shell.selectOption(listed[0])
    await expect(shell).toHaveValue(listed[0])
  }
  await restore().click()
  await expect(page.getByRole('combobox', { name: 'Terminal font' })).toHaveValue('JetBrains Mono')
  await expect(shell).toHaveValue('')

  // Namespaces: all, and back to the last picked.
  await nav(page).getByRole('button', { name: 'Namespaces' }).click()
  await page.getByRole('radio', { name: 'All namespaces' }).click()
  await expect(page.getByRole('radio', { name: 'All namespaces' })).toBeChecked()
  await restore().click()
  await expect(page.getByRole('radio', { name: /The one I last picked there/ })).toBeChecked()

  // Updates: the automatic check off (Help's menu says so too), Check now, and back.
  await nav(page).getByRole('button', { name: 'Updates' }).click()
  await page.getByRole('switch', { name: 'Check for updates' }).click()
  await expect(page.getByRole('switch', { name: 'Check for updates' })).not.toBeChecked()
  expect(
    await app.evaluate(
      ({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('auto-updates')!.checked,
    ),
  ).toBe(false)
  await page.getByRole('button', { name: 'Check now' }).click()
  await expect(page.getByRole('group', { name: 'This version' })).toContainText(/Lumovi \d/)
  await restore().click()
  await expect(page.getByRole('switch', { name: 'Check for updates' })).toBeChecked()

  // What the page sends that isn't a setting, or its value, is refused in Lumovi's words.
  expect(
    await page.evaluate(() => window.lumovi!.app.setPreferences({ accent: 'pink' })),
  ).toMatchObject({
    ok: false,
    error: { message: 'accent can’t be "pink".' },
  })
  expect(
    await page.evaluate(() => window.lumovi!.app.setPreferences({ autoUpdate: 'no' })),
  ).toMatchObject({
    ok: false,
    error: { message: 'autoUpdate must be true or false.' },
  })
})

test('every setting a policy sets is locked where it’s shown; a policy whose settings aren’t settings can’t be used', async ({
  launch,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-policy-'))
  const policy = join(dir, 'policy.json')
  writeFileSync(
    policy,
    JSON.stringify({
      updates: false,
      settings: {
        theme: 'dark',
        accent: 'violet',
        density: 'compact',
        textSize: 110,
        timeZone: 'UTC',
        clock: '24',
        terminalFont: 'Menlo',
        terminalFontSize: 14,
        copyOnSelect: true,
        shell: '/bin/sh',
        namespaces: { mode: 'named', namespace: 'shop' },
      },
    }),
  )
  const lumovi = await launch({ env: { LUMOVI_POLICY: policy } })
  const { page } = lumovi
  await openCluster(page)
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact')
  // (Its text size is the windows' zoom from the start; the tests' window fits itself to its
  // screen after that, so it's read where Settings shows it, below.)
  for (const [section, locked] of [
    ['Appearance', ['Theme', 'Accent', 'Density', 'Text size']],
    ['Time', ['Time zone', 'Clock']],
    ['Terminal', ['Font', 'Copy on select', 'Shell']],
    ['Namespaces', ['When a cluster opens']],
    ['Updates', ['Check automatically']],
  ] as const) {
    await openSettings(page, section.toLowerCase())
    for (const name of locked) {
      await expect(page.getByRole('group', { name, exact: true })).toContainText(
        'Set by your organization',
      )
    }
    await expect(page.getByRole('button', { name: 'Restore this section’s defaults' })).toHaveCount(
      0,
    )
  }
  await openSettings(page)
  await expect(page.getByRole('group', { name: 'Text size', exact: true })).toContainText('110%')
  // The theme, too: the page's change is let go, and what's set stays.
  expect(await page.evaluate(() => window.lumovi!.app.setTheme('light'))).toMatchObject({
    theme: 'dark',
  })
  // The View menu's zoom can't change what it sets.
  expect(
    await page.evaluate(() => window.lumovi!.app.setPreferences({ textSize: 125 })),
  ).toMatchObject({
    ok: false,
    error: { message: 'textSize: set by your organization.' },
  })
  await lumovi.close()

  // Settings that aren't settings, or a theme that isn't one: it can't be used, and says why.
  writeFileSync(
    policy,
    JSON.stringify({ settings: { theme: 'neon', autoUpdate: false, clock: null } }),
  )
  const again = await launch({ env: { LUMOVI_POLICY: policy } })
  expect((await again.page.evaluate(() => window.lumovi!.app.settings())).managed?.problem).toMatch(
    /settings: .*theme must be system, light or dark\. autoUpdate isn’t set here/,
  )
})

/**
 * Keyboard shortcuts on a server (LMV-358): a person's own keys, kept for them and followed in
 * every browser they sign in from; what LUMOVI_SETTINGS sets is locked; keys that can't be are
 * refused; and the desktop app's commands aren't there.
 */
import { expect, test } from './fixtures.ts'
import { as } from './fleet.ts'
import { lockedSettings } from '../../src/server/preferences.ts'

test('on a server, a person’s keys are theirs in every browser; what it sets is locked; clashes are refused', async ({
  page,
  context,
  browser,
  serve,
}) => {
  expect(() => lockedSettings('{"shortcuts": {"filter": ["Mod+R"]}}')).toThrow(
    'LUMOVI_SETTINGS: shortcuts: Mod+R can’t be both Filter the list’s and Refresh’s.',
  )
  const served = await serve({
    env: {
      LUMOVI_AUTH: 'proxy',
      LUMOVI_SETTINGS: JSON.stringify({ shortcuts: { refresh: ['Mod+Shift+R'] } }),
    },
  })
  await as(context, 'alice@example.com', 'developers')
  await page.goto(`${served.url}cluster/demo/settings?section=shortcuts`)
  const main = page.getByRole('main')
  const row = (name: string) => main.getByRole('group', { name, exact: true })
  await expect(row('Refresh').getByLabel('Set by your organization')).toBeVisible()
  // The desktop app's aren't here.
  await expect(row('Command palette')).toBeVisible()
  await expect(row('Create…')).toHaveCount(0)
  await expect(main.getByRole('heading', { name: 'Terminal' })).toHaveCount(0)
  await expect(main.getByRole('heading', { name: 'Clusters page' })).toHaveCount(0)

  // Recorded in the page itself: ⌘J (Ctrl+J) for the palette.
  await row('Command palette')
    .getByRole('button', { name: 'Change Command palette’s keys' })
    .click()
  // (Off a Mac, a ⊞ key is the system's: refused, never taken for another.)
  if (process.platform !== 'darwin') {
    await page.keyboard.press('Meta+j')
    await expect(row('Command palette').getByRole('alert')).toHaveText(
      '⊞ keys stay the system’s. Press other keys, or Esc.',
    )
  }
  await page.keyboard.press('ControlOrMeta+j')
  await expect(row('Command palette')).toContainText('Changed')
  await page.keyboard.press('ControlOrMeta+j')
  const palette = page.getByRole('dialog').filter({ has: page.getByRole('combobox') })
  await expect(palette).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('button', { name: /^Refresh \((⌘⇧R|Ctrl\+Shift\+R)\)$/ }),
  ).toBeVisible()

  // Another browser, the same person: as they left it.
  const elsewhere = await browser.newContext()
  await as(elsewhere, 'alice@example.com', 'developers')
  const again = await elsewhere.newPage()
  await again.goto(`${served.url}cluster/demo/settings?section=shortcuts`)
  await expect(
    again.getByRole('main').getByRole('group', { name: 'Command palette', exact: true }),
  ).toContainText('Changed')
  await elsewhere.close()

  // What the server sets, and keys doing two things, refused in its words.
  const set = (patch: object) =>
    page.evaluate((patch) => window.lumovi!.app.setPreferences(patch as never), patch)
  expect(await set({ shortcuts: { refresh: ['Mod+R'] } })).toMatchObject({
    ok: false,
    error: { message: 'shortcuts.refresh: set by whoever runs this server.' },
  })
  expect(await set({ shortcuts: { back: ['Mod+]'] } })).toMatchObject({
    ok: false,
    error: { message: 'shortcuts: Mod+] can’t be both Back’s and Forward’s.' },
  })
  expect(await set({ shortcuts: { nowhere: ['Mod+J'] } })).toMatchObject({
    ok: false,
    error: { message: 'shortcuts can’t be {"nowhere":["Mod+J"]}.' },
  })
  // Reset all: what's theirs goes, what the server sets stays.
  await page.getByRole('button', { name: 'Reset all…' }).click()
  await page.getByRole('button', { name: 'Reset all', exact: true }).click()
  await expect(row('Command palette')).not.toContainText('Changed')
  await expect(row('Refresh').getByLabel('Set by your organization')).toBeVisible()
})

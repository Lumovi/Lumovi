/**
 * Settings (LMV-357): what a setting may be, checked one by one; the desktop's store and its
 * policy's `settings`; and a server's, per person, kept wherever they sign in from, with what
 * LUMOVI_SETTINGS sets locked for everyone.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures.ts'
import { as } from './fleet.ts'
import { checkedPreferences, PREFERENCE_DEFAULTS } from '../../src/shared/preferences.ts'
import { SettingsStore } from '../../src/main/settings.ts'
import { readPolicy } from '../../src/main/policy.ts'
import { lockedSettings, PeoplePreferences } from '../../src/server/preferences.ts'
import { ServerState } from '../../src/server/state.ts'

test('a setting is one of its values, or it’s left out and said why', () => {
  const { preferences, problems } = checkedPreferences({
    accent: 'violet',
    density: 'roomy',
    textSize: 110,
    timeZone: 'Europe/Budapest',
    clock: '13',
    terminalFontSize: 99,
    namespaces: { mode: 'named', namespace: 'Not A Name' },
    shell: '/bin/zsh',
    copyOnSelect: null,
    colour: 'red',
    theme: 'dark',
  })
  expect(preferences).toEqual({
    accent: 'violet',
    textSize: 110,
    timeZone: 'Europe/Budapest',
    shell: '/bin/zsh',
    copyOnSelect: null,
  })
  expect(problems).toEqual([
    'density can’t be "roomy".',
    'clock can’t be "13".',
    'terminalFontSize can’t be 99.',
    'namespaces can’t be {"mode":"named","namespace":"Not A Name"}.',
    'colour isn’t a setting.',
  ])
  expect(checkedPreferences({ timeZone: 'Mars/Olympus' }).problems).toEqual([
    'timeZone can’t be "Mars/Olympus".',
  ])
})

test('the desktop keeps a person’s own, and what its policy sets is what they are, locked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-settings-'))
  try {
    const policyFile = join(dir, 'policy.json')
    writeFileSync(policyFile, JSON.stringify({ settings: { theme: 'dark', shell: '/bin/sh' } }))
    const policy = readPolicy({ LUMOVI_POLICY: policyFile })
    const store = new SettingsStore(dir, {}, policy)
    const set = store.setPreferences({ accent: 'cyan', textSize: 100, clock: '24' })
    // (A default is kept as unset: it follows the default.)
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).preferences).toEqual({
      accent: 'cyan',
      clock: '24',
    })
    expect(set.preferences).toEqual({
      ...PREFERENCE_DEFAULTS,
      accent: 'cyan',
      clock: '24',
      shell: '/bin/sh',
    })
    expect(set.theme).toBe('dark')
    expect(set.locked).toEqual(['shell', 'theme'])
    expect(() => store.setPreferences({ shell: '/bin/zsh' })).toThrow(
      'shell: set by your organization.',
    )
    expect(() => store.setPreferences({ accent: 'pink' })).toThrow('accent can’t be "pink".')
    store.setPreferences({ accent: null })
    expect(new SettingsStore(dir, {}, policy).get().preferences?.accent).toBe('blue')

    // A policy whose settings aren't settings can't be used: it locks the most, and says why.
    writeFileSync(policyFile, JSON.stringify({ settings: { accent: 'pink' } }))
    expect(readPolicy({ LUMOVI_POLICY: policyFile }).managed?.problem).toMatch(
      /settings: accent can’t be "pink"/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a server keeps each person’s own; what LUMOVI_SETTINGS sets is everyone’s, locked', async () => {
  expect(() => lockedSettings('{"shell": "/bin/sh"}')).toThrow(
    'shell is the desktop app’s: a server starts no shells of its own.',
  )
  expect(() => lockedSettings('not json')).toThrow('LUMOVI_SETTINGS must be JSON')
  const state = await ServerState.open({ kind: 'memory' }, {}, randomBytes(32))
  const people = new PeoplePreferences(state, lockedSettings('{"clock": "24"}'))
  const alice = people.of({ name: 'alice@example.com', groups: [] })
  const bob = people.of({ name: 'bob@example.com', groups: [] })
  await alice.set({ accent: 'violet', theme: 'dark' })
  expect(alice.settings()).toMatchObject({
    preferences: { accent: 'violet', clock: '24' },
    theme: 'dark',
    locked: ['clock'],
  })
  expect(bob.settings().preferences?.accent).toBe('blue')
  await expect(alice.set({ clock: '12' })).rejects.toThrow(
    'clock: set by whoever runs this server.',
  )
  await expect(alice.set({ shell: '/bin/zsh' })).rejects.toThrow('shell is the desktop app’s.')
  state.close()
})

test('on a server, a person’s settings follow them to another browser, and what it sets is locked', async ({
  page,
  context,
  browser,
  serve,
}) => {
  const served = await serve({
    env: { LUMOVI_AUTH: 'proxy', LUMOVI_SETTINGS: JSON.stringify({ density: 'compact' }) },
  })
  await as(context, 'alice@example.com', 'developers')
  await page.goto(`${served.url}cluster/demo/settings`)
  await page.getByRole('radio', { name: 'Violet' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'violet')
  await page.getByRole('button', { name: 'Larger text size' }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe('1.1')
  const density = page.getByRole('group', { name: 'Density' })
  await expect(density).toContainText('Set by your organization')
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact')
  await expect(page.getByText('Kept for you on this server')).toBeVisible()

  // Another browser, the same person: as they left it. Another person: as it starts.
  const elsewhere = await browser.newContext()
  await as(elsewhere, 'alice@example.com', 'developers')
  const again = await elsewhere.newPage()
  await again.goto(`${served.url}cluster/demo`)
  await expect(again.locator('html')).toHaveAttribute('data-accent', 'violet')
  await as(elsewhere, 'bob@example.com', 'developers')
  await again.reload()
  await expect(again.locator('html')).not.toHaveAttribute('data-accent')
  await expect(again.locator('html')).toHaveAttribute('data-density', 'compact')
  await elsewhere.close()
})

test('on a phone, Settings is a list of sections, each a page whose Back is in the bar', async ({
  page,
  context,
  serve,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const served = await serve({ env: { LUMOVI_AUTH: 'proxy' } })
  await as(context, 'alice@example.com', 'developers')
  await page.goto(`${served.url}cluster/demo/settings`)
  const list = page.getByRole('navigation', { name: 'Settings' })
  await expect(list.getByRole('button')).toHaveText([
    /Appearance.*System · Blue/,
    /Time.*This phone’s · System/,
    /Terminal.*JetBrains Mono · 12 px/,
    /Namespaces.*Last picked/,
  ])
  await list.getByRole('button', { name: /Time/ }).click()
  await expect(page.getByRole('heading', { name: 'Time', level: 2 })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Settings')
  await expect(page.getByRole('button', { name: 'Menu' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to Settings' }).click()
  await expect(list).toBeVisible()
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible()
})

test('a server refuses what isn’t a setting, the desktop’s shell, and what it sets for everyone, in its words', async ({
  page,
  context,
  serve,
}) => {
  const served = await serve({
    env: { LUMOVI_AUTH: 'proxy', LUMOVI_SETTINGS: JSON.stringify({ theme: 'dark', clock: '24' }) },
  })
  await as(context, 'alice@example.com', 'developers')
  await page.goto(`${served.url}cluster/demo`)
  // What whoever runs it set: shown and kept by the browser too.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const set = (patch: object) =>
    page.evaluate((patch) => window.lumovi!.app.setPreferences(patch as never), patch)
  expect(await set({ theme: 'neon' })).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('theme must be system, light or dark.') },
  })
  expect(await set({ theme: 'light' })).toMatchObject({
    ok: false,
    error: { message: 'theme: set by whoever runs this server.' },
  })
  expect(await set({ shell: '/bin/sh' })).toMatchObject({
    ok: false,
    error: { message: 'shell is the desktop app’s.' },
  })
  expect(await set({ clock: '12' })).toMatchObject({
    ok: false,
    error: { message: 'clock: set by whoever runs this server.' },
  })
  // What's theirs: kept, and put back to its default with null.
  expect(await set({ accent: 'cyan', density: 'comfortable' })).toMatchObject({
    ok: true,
    data: { preferences: { accent: 'cyan' } },
  })
  expect(await set({ accent: null })).toMatchObject({
    ok: true,
    data: { preferences: { accent: 'blue' } },
  })
  // The theme the page asks for: refused here, so the browser keeps what's set.
  await page.evaluate(() => window.lumovi!.app.setTheme('light'))
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

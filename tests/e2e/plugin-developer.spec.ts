/**
 * Developer mode (the desktop app's): a plugin of the person's own with code, in a folder of its
 * own, runs only while it's on and once they've agreed to what it may do, through the store's
 * dialog. Its code changing asks again with one press, what it asks changing asks again with
 * what's new; the folder is watched, so a build is seen without reading again. The
 * organization's policy keeps it off, and lets go of what was agreed.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CONTEXTS, expect, openCluster, test } from './fixtures.ts'

const TOYS = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
  pages: [{ id: overview, title: Overview }]
`

/** Toys' code: its page draws a Table titled `title` (a region of that name: nothing to list). */
const code = (title: string) => `box.then(({ post, listen }) => {
  listen((text) => {
    if (!JSON.parse(text).open) return
    post(JSON.stringify({ commit: [
      ['make', 1, 'Table', { title: ${JSON.stringify(title)}, columns: [], headings: false, rows: [] }],
      ['put', 0, 1],
    ] }))
  })
})
`

/** A person's plugins folder, with Toys in a folder of its own. */
function folder(): string {
  const own = mkdtempSync(join(tmpdir(), 'lumovi-own-'))
  mkdirSync(join(own, 'toys'))
  writeFileSync(join(own, 'toys', 'plugin.yaml'), TOYS)
  writeFileSync(join(own, 'toys', 'plugin.js'), code('Widgets'))
  return own
}

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)
const PLUGINS = `#/cluster/${CONTEXTS.demo}/plugins?plugin=toys`
const PAGE = `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`
const body = (page: Page) => page.locator('[data-plugin-body="toys"]')
const dialog = (page: Page) => page.getByRole('dialog')
const events = (page: Page, q: object) =>
  page.evaluate((q) => window.lumovi!.audit.query(q), q).then((p) => p.events)

test('off as Lumovi starts: a folder’s plugin with code says its pages don’t run, and on, its code waits for the person', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_PLUGINS_DIR: folder() } })
  await openCluster(page)
  await go(page, PLUGINS)
  await expect(page.locator('[data-plugins-opening-yours]')).toHaveText(
    'and yours only while Developer mode is on',
  )
  const toys = page.locator('[data-plugin-code-off="toys"]').first()
  await expect(toys).toHaveText('Its pages don’t run: Developer mode is off.')
  const developer = page.getByRole('switch', { name: 'Developer mode' })
  await expect(developer).not.toBeChecked()
  await expect(page.locator('#plugins-developer-mode-line')).toHaveText(
    'Run code from plugins in your own folder. Only turn this on for plugins you wrote or trust as much as Lumovi.',
  )
  // Its page: nothing of its code was read, and it's a setting, not a failure, with the way to it.
  await go(page, PAGE)
  const ended = body(page).getByTestId('plugin-ended')
  await expect(ended.getByRole('heading')).toHaveText('Developer mode is off.')
  await expect(ended).toContainText('Turn it on in Plugins to run Toys’ code.')
  await expect(ended).not.toContainText('The rest of Lumovi')
  await ended.getByRole('link', { name: 'Open Plugins' }).click()
  await expect(page.getByRole('switch', { name: 'Developer mode' })).toBeFocused()
  // On: it waits, on its row and on its page, until the person has seen what it may do.
  await go(page, PLUGINS)
  await developer.click()
  await expect(developer).toBeChecked()
  await expect(page.locator('[data-plugins-opening-yours]')).toHaveText(
    'and yours, each once you’ve agreed to what it may do',
  )
  await expect(page.locator('[data-plugin-waiting="toys"]').first()).toHaveText(
    'Its code waits for you to agree to what it may do.',
  )
  // Its own "Run its code" switch doesn't say it runs: off and locked, with why under it.
  const runs = page.getByRole('switch', { name: 'Run its code' })
  await expect(runs).not.toBeChecked()
  await expect(runs).toBeDisabled()
  await expect(page.locator('#plugin-code-line-toys')).toContainText(
    'Its code waits for you to agree to what it may do.',
  )
  // (At the row's end, and under its switch: either opens it.)
  await expect(page.getByRole('button', { name: 'See what it may do…' })).toHaveCount(2)
  await page.getByRole('button', { name: 'See what it may do…' }).first().click()
  await expect(dialog(page).getByRole('heading', { name: 'Run Toys’ code?' })).toBeVisible()
  await expect(dialog(page)).toContainText('From your own folder,')
  // (As the folder writes it: with Windows' separator there.)
  await expect(dialog(page)).toContainText(/toys[\\/]plugin\.yaml/)
  await expect(dialog(page)).toContainText(
    'Draws its pages with its own code, which runs in Lumovi’s sealed box',
  )
  await expect(dialog(page)).toContainText('Its code doesn’t run until you press Run its code.')
  // Not now: nothing changes, and nothing is said.
  await dialog(page).getByRole('button', { name: 'Not now' }).click()
  await expect(dialog(page)).toHaveCount(0)
  await go(page, PAGE)
  const waiting = body(page).getByTestId('plugin-waiting')
  await expect(waiting).toContainText('Toys’ code waits for you')
  await expect(body(page).getByTestId('plugin-whose')).toContainText('your plugin Toys 1.2.0')
  await waiting.getByRole('button', { name: 'See what it may do…' }).click()
  await dialog(page).getByRole('button', { name: 'Run its code' }).click()
  // Agreed: its page draws, said to be the person's own; and the history says so.
  await expect(body(page).getByRole('region', { name: 'Widgets' })).toBeVisible({ timeout: 20_000 })
  // (As it reads, at this width: the strip holds a phone's words too, hidden.)
  await expect
    .poll(() => body(page).getByTestId('plugin-whose').innerText())
    .toContain('This page is from your plugin Toys 1.2.0, from your own folder.')
  const agreed = await events(page, { actions: ['plugin.code-agreed'] })
  expect(agreed).toHaveLength(1)
  expect(agreed[0]).toMatchObject({
    outcome: 'success',
    summary: expect.stringMatching(
      /^Agreed to run the code of the plugin Toys 1\.2\.0, from .*toys[\\/]plugin\.yaml$/,
    ),
  })
  // Off again: its page closes at once; on, what was agreed runs without asking.
  await go(page, PLUGINS)
  await developer.click()
  await expect(page.locator('[data-plugin-code-off="toys"]').first()).toBeVisible()
  await developer.click()
  await go(page, PAGE)
  await expect(body(page).getByRole('region', { name: 'Widgets' })).toBeVisible({ timeout: 20_000 })
})

test('its folder watched: new code asks again with one press, and what it asks with what’s new', async ({
  launch,
}) => {
  const own = folder()
  const { page } = await launch({ env: { LUMOVI_PLUGINS_DIR: own } })
  await openCluster(page)
  await page.evaluate(() => window.lumovi!.ownCode!.developerMode(true))
  const agree = async () => {
    const standing = await page.evaluate(() => window.lumovi!.ownCode!.standing('toys'))
    await page.evaluate(([asks, code]) => window.lumovi!.ownCode!.agree('toys', asks, code), [
      standing!.asks,
      standing!.code,
    ] as const)
  }
  await agree()
  await go(page, PAGE)
  await expect(body(page).getByRole('region', { name: 'Widgets' })).toBeVisible({ timeout: 20_000 })
  // A build writes new code: its page waits again, seen without reading again; one press runs it.
  writeFileSync(join(own, 'toys', 'plugin.js'), code('Gadgets'))
  const waiting = body(page).getByTestId('plugin-waiting')
  await expect(waiting).toBeVisible({ timeout: 10_000 })
  await waiting.getByRole('button', { name: 'See what it may do…' }).click()
  await expect(dialog(page).getByRole('heading', { name: 'Toys’ code changed' })).toBeVisible()
  await expect(dialog(page)).toContainText('It asks for nothing it doesn’t already have.')
  await dialog(page).getByRole('button', { name: 'Run its code' }).click()
  await expect(body(page).getByRole('region', { name: 'Gadgets' })).toBeVisible({ timeout: 20_000 })
  // Its file asks for more: asked again, what's new first.
  writeFileSync(
    join(own, 'toys', 'plugin.yaml'),
    `${TOYS}  reads: [{ group: '', kind: Pod, fields: [metadata.name] }]\n`,
  )
  await expect(waiting).toBeVisible({ timeout: 10_000 })
  await waiting.getByRole('button', { name: 'See what it may do…' }).click()
  await expect(dialog(page).getByRole('heading', { name: 'Run Toys’ code?' })).toBeVisible()
  await expect(dialog(page)).toContainText('New in 1.2.0')
  await expect(dialog(page)).toContainText('its code is handed only metadata.name')
  const changed = await events(page, { actions: ['plugin.code-agreed'] })
  expect(changed[0]!.details).toMatchObject({ changed: 'code' })
})

test('the organization’s policy keeps Developer mode off, and lets go of what was agreed', async ({
  launch,
}) => {
  const own = folder()
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const first = await launch({ env: { LUMOVI_PLUGINS_DIR: own }, userDataDir })
  await openCluster(first.page)
  await first.page.evaluate(() => window.lumovi!.ownCode!.developerMode(true))
  const standing = await first.page.evaluate(() => window.lumovi!.ownCode!.standing('toys'))
  await first.page.evaluate(([asks, code]) => window.lumovi!.ownCode!.agree('toys', asks, code), [
    standing!.asks,
    standing!.code,
  ] as const)
  await first.app.close()
  // Under the policy: locked off, said so, and what was agreed let go of, once.
  const policy = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(policy, JSON.stringify({ pluginDeveloperMode: 'off' }))
  const locked = await launch({
    env: { LUMOVI_PLUGINS_DIR: own, LUMOVI_POLICY: policy },
    userDataDir,
  })
  await openCluster(locked.page)
  await go(locked.page, PLUGINS)
  const developer = locked.page.getByRole('switch', { name: 'Developer mode' })
  await expect(developer).not.toBeChecked()
  await expect(developer).toBeDisabled()
  await expect(locked.page.locator('#plugins-developer-mode-line')).toHaveText(
    'Turned off by your organization’s policy.',
  )
  // Its row still says why its code doesn't run, folded or not.
  await expect(locked.page.locator('[data-plugin-code-off="toys"]').first()).toHaveText(
    'Its pages don’t run: Developer mode is off.',
  )
  await expect(locked.page.locator('[data-plugins-opening-yours]')).toHaveText(
    'but none of yours: your organization’s policy keeps Developer mode off',
  )
  await expect(
    locked.page.evaluate(() => window.lumovi!.ownCode!.developerMode(true)),
  ).rejects.toThrow('Your organization’s policy keeps Developer mode off.')
  // Its page: kept off by the policy, its mark the lock, and nothing to press.
  await go(locked.page, PAGE)
  const lockedPage = body(locked.page).getByTestId('plugin-ended')
  await expect(lockedPage.getByRole('heading')).toHaveText(
    'Your organization’s policy keeps Developer mode off.',
  )
  await expect(lockedPage.getByRole('link')).toHaveCount(0)
  const letGo = await events(locked.page, { actions: ['plugin.code-agreed'] })
  expect(letGo[0]).toMatchObject({
    outcome: 'cancelled',
    actor: { user: 'lumovi', via: 'server' },
    summary:
      'Let go of what you agreed to run of your own plugins’ code: your organization’s policy turns Developer mode off',
  })
  await locked.app.close()
  // Allowed again: it waits for the person from the start.
  const again = await launch({ env: { LUMOVI_PLUGINS_DIR: own }, userDataDir })
  await openCluster(again.page)
  await go(again.page, PAGE)
  await expect(body(again.page).getByTestId('plugin-waiting')).toBeVisible({ timeout: 20_000 })
  expect(await again.page.evaluate(() => window.lumovi!.ownCode!.standing('toys'))).toMatchObject({
    standing: 'first',
  })
})

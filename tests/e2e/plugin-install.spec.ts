/**
 * Installing a plugin from Lumovi-plugins, updating one, going back and removing one, on the
 * Plugins page (src/main/plugins-installed.ts): only on the person's press, after the store's
 * dialog, from a release checked again then; each file checked against what was agreed every
 * time it's read; each change audited. The release comes from the tests' stand-in for GitHub,
 * signed by their stand-in for Sigstore. Toys and Tinker are the tests' stand-ins, never
 * Lumovi-plugins' own.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { AuditEvent } from '../../src/shared/audit.ts'
import {
  builtWith,
  type StandInPlugin,
  type StandInRelease,
} from '../mock-downloads/plugin-store.ts'
import { CONTEXTS, expect, openCluster, test } from './fixtures.ts'

/** A stand-in's file: Toys shows Widgets; `more` is what a version adds to what it asks. */
const file = (name: string, label: string, kind: string, version: string, more = '') =>
  `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: ${name} }
spec:
  version: ${version}
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: ${label}
  kinds: [{ group: example.com, kind: ${kind} }]
${more}`
/** What Toys 1.3.0 adds: a link to Pods by name. */
const LINKS = `  views:
    - kinds: [{ group: example.com, kind: Widget }]
      links:
        - name: Its pod
          kind: Pod
          objectName: '{{ .metadata.name }}'
`
const plugin = (
  name: string,
  label: string,
  kind: string,
  version: string,
  more = '',
): StandInPlugin => ({
  name,
  version,
  lumovi: '1.0.0',
  text: file(name, label, kind, version, more),
})

/** Toys comes with this Lumovi (the tests' build takes it as its own), at 1.2.0. */
function included(): string {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), file('toys', 'Toys', 'Widget', '1.2.0'))
  return folder
}

/** A release after the one Lumovi was built with, `n` later, with these besides its own. */
function release(n: number, ...plugins: StandInPlugin[]): StandInRelease {
  const own = builtWith()
  return { version: `9.${n}.0`, serial: own.serial + n, plugins: [...own.plugins, ...plugins] }
}

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)
const pluginsPage = `#/cluster/${CONTEXTS.demo}/plugins`
const filter = (page: Page, name: string | RegExp) =>
  page.getByRole('group', { name: 'Which plugins' }).getByRole('button', { name })
const table = (page: Page) => page.getByRole('table', { name: 'Plugins' })
const row = (page: Page, name: string) =>
  table(page)
    .locator('tbody tr[data-state]')
    .filter({ hasText: new RegExp(`^${name}\\d`) })
const dialog = (page: Page) => page.getByRole('dialog')
const line = (page: Page) => page.locator('[data-plugin-store]')
const checkNow = (page: Page) => line(page).getByRole('button', { name: 'Check now' })
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
async function audited(page: Page): Promise<AuditEvent[]> {
  const { events } = await page.evaluate(() => window.lumovi!.audit.query({}))
  return events.filter((event) =>
    /^plugin\.(installed|updated|went-back|removed)$/.test(event.action),
  )
}

test('one this Lumovi doesn’t have is installed from Not here yet, only on Install, and removed again', async ({
  launch,
  downloads,
}) => {
  downloads.pluginStore = release(1, plugin('tinker', 'Tinker', 'Database', '1.0.0'))
  const { page, userDataDir } = await launch()
  await openCluster(page)
  await go(page, pluginsPage)
  await filter(page, 'Not here yet 1').click()
  await row(page, 'Tinker').getByRole('button', { name: 'Install…' }).click()

  // The dialog: what it may do in the page's own lines, and where it's from.
  await expect(dialog(page)).toContainText('Install Tinker 1.0.0?')
  await expect(dialog(page)).toContainText(
    'From Lumovi-plugins release 9.1.0, signed by its release workflow. What it reads and changes, it does as you.',
  )
  await expect(dialog(page).getByRole('region', { name: 'What it may do' })).toBeVisible()
  await expect(dialog(page)).toContainText('Nothing changes until you press Install.')
  // Cancel writes nothing.
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  const copy = join(userDataDir, 'plugins', 'installed', 'tinker', '1.0.0', 'plugin.yaml')
  expect(existsSync(copy)).toBe(false)

  await row(page, 'Tinker').getByRole('button', { name: 'Install…' }).click()
  await dialog(page).getByRole('button', { name: 'Install 1.0.0' }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.getByText('Installed Tinker 1.0.0.')).toBeVisible()
  // Written as the release has it, and recorded as agreed.
  expect(readFileSync(copy, 'utf8')).toBe(file('tinker', 'Tinker', 'Database', '1.0.0'))
  const settings = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8'))
  expect(settings.pluginsInstalled.tinker.current).toMatchObject({
    version: '1.0.0',
    release: '9.1.0',
    files: { 'plugin.yaml': sha256(copy) },
  })
  // In use now: in its sidebar place (its kind is on this cluster), and its row says where from.
  await expect(page.getByRole('navigation').getByRole('link', { name: 'Tinker' })).toBeVisible()
  await expect(row(page, 'Tinker')).toContainText('Installed from Lumovi-plugins release 9.1.0')
  // It's here now: in the page's own list, in its place by name, and no longer under Not here yet.
  await expect(filter(page, /^Not here yet/)).toHaveCount(0)
  await expect(filter(page, /^All /)).toHaveAttribute('aria-pressed', 'true')
  const names = await table(page).locator('[data-plugin-row]').allTextContents()
  expect(names.map((name) => name.replace(/\d.*$/, '').toLowerCase())).toEqual(
    names.map((name) => name.replace(/\d.*$/, '').toLowerCase()).sort(),
  )
  await expect(row(page, 'Tinker')).toContainText('On this cluster: in the sidebar')
  // The bar counts it by where it's from: one installed.
  await expect(page.locator('[data-plugins-count]')).toHaveText(
    /^\d+ come with Lumovi, 1 installed$/,
  )
  expect((await audited(page)).map(({ action, summary }) => [action, summary])).toEqual([
    ['plugin.installed', 'Installed the plugin Tinker 1.0.0'],
  ])

  // Removed: asked first, then gone, its files with it, and it's back under Not here yet.
  await row(page, 'Tinker').getByRole('button', { name: 'More for Tinker' }).click()
  await page.getByRole('menuitem', { name: /^Remove Tinker/ }).click()
  await expect(dialog(page)).toContainText('Remove Tinker?')
  await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused()
  await dialog(page).getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByText('Removed Tinker.')).toBeVisible()
  expect(existsSync(copy)).toBe(false)
  await filter(page, 'Not here yet 1').click()
  await expect(row(page, 'Tinker').getByRole('button', { name: 'Install…' })).toBeVisible()
  expect((await audited(page))[0]).toMatchObject({
    action: 'plugin.removed',
    summary: 'Removed the plugin Tinker 1.0.0',
  })
})

test('one of Lumovi’s own is updated, says what’s new, goes back to the one kept and to Lumovi’s own', async ({
  launch,
  downloads,
}) => {
  downloads.pluginStore = release(1, plugin('toys', 'Toys', 'Widget', '1.3.0', LINKS))
  const { page, userDataDir } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() },
  })
  await openCluster(page)
  await go(page, pluginsPage)
  // Where it is in the list: an update never moves it.
  const place = async () =>
    (await table(page).locator('[data-plugin-row]').allTextContents()).findIndex((name) =>
      name.startsWith('Toys'),
    )
  await expect(row(page, 'Toys').getByRole('button', { name: 'Update…' })).toBeVisible()
  const was = await place()
  expect(was).toBeGreaterThan(0)
  await row(page, 'Toys').getByRole('button', { name: 'Update…' }).click()

  // What's new first, by what it asks: here, a link to Pods.
  await expect(dialog(page)).toContainText('Update Toys to 1.3.0?')
  await expect(dialog(page)).toContainText('In use: 1.2.0, which comes with Lumovi.')
  const added = dialog(page).getByRole('region', { name: 'New in 1.3.0' })
  await expect(added.locator('[data-ask]')).toHaveCount(1)
  await expect(added).toContainText('It links to Pods by name.')
  await expect(dialog(page)).toContainText('Nothing changes until you press Update.')
  await dialog(page).getByRole('button', { name: 'Update to 1.3.0' }).click()
  await expect(page.getByText('Updated Toys to 1.3.0.')).toBeVisible()
  await expect(row(page, 'Toys')).toContainText('Installed from Lumovi-plugins release 9.1.0')
  expect(await place()).toBe(was)
  await expect(row(page, 'Toys')).toContainText('1.3.0')

  // A later one that asks for the same: said so, and the one in use is kept.
  downloads.pluginStore = release(2, plugin('toys', 'Toys', 'Widget', '1.4.0', LINKS))
  await checkNow(page).click()
  await expect(line(page)).toContainText('Lumovi-plugins release 9.2.0')
  await row(page, 'Toys').getByRole('button', { name: 'Update…' }).click()
  await expect(dialog(page)).toContainText('It asks for nothing it doesn’t already have.')
  await expect(dialog(page)).toContainText(
    'In use: 1.3.0, installed from Lumovi-plugins release 9.1.0.',
  )
  await dialog(page).getByRole('button', { name: 'Update to 1.4.0' }).click()
  await expect(page.getByText('Updated Toys to 1.4.0.')).toBeVisible()
  await expect(row(page, 'Toys')).toContainText(
    'Installed from Lumovi-plugins release 9.2.0 · 1.3.0 kept to go back to',
  )

  // Back to the one kept: it asks for nothing more, so at once.
  await row(page, 'Toys').getByRole('button', { name: 'More for Toys' }).click()
  await page.getByRole('menuitem', { name: /^Back to 1\.3\.0/ }).click()
  await expect(page.getByText('Went back to Toys 1.3.0.')).toBeVisible()
  await expect(row(page, 'Toys')).toContainText('Installed from Lumovi-plugins release 9.1.0')
  // And to the one that came with Lumovi: every copy goes.
  await row(page, 'Toys').getByRole('button', { name: 'More for Toys' }).click()
  await page.getByRole('menuitem', { name: /^Back to the one that came with Lumovi/ }).click()
  await expect(page.getByText('Went back to Lumovi’s own Toys.')).toBeVisible()
  await expect(row(page, 'Toys')).toContainText('Comes with Lumovi')
  expect(existsSync(join(userDataDir, 'plugins', 'installed', 'toys'))).toBe(false)
  expect((await audited(page)).map(({ summary }) => summary)).toEqual([
    'Went back to Lumovi’s own Toys',
    'Went back to the plugin Toys 1.3.0',
    'Updated the plugin Toys from 1.3.0 to 1.4.0',
    'Updated the plugin Toys from 1.2.0 to 1.3.0',
  ])
})

test('an update whose code reads the logs its pages only showed asks again: in red, first under New in', async ({
  launch,
  downloads,
}) => {
  const logs = (level: string) => `  reads: [{ group: '', kind: Pod, fields: [metadata.name] }]
  pages: [{ id: overview, title: Overview }]
  logs: ${level}
`
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), file('toys', 'Toys', 'Widget', '1.2.0', logs('shown')))
  writeFileSync(join(folder, 'toys.js'), 'box.then(() => {})\n')
  downloads.pluginStore = release(1, {
    ...plugin('toys', 'Toys', 'Widget', '1.3.0', logs('read')),
    code: 'box.then(() => {})\n',
  })
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  await go(page, pluginsPage)
  await row(page, 'Toys').getByRole('button', { name: 'Update…' }).click()
  const added = dialog(page).getByRole('region', { name: 'New in 1.3.0' })
  const asks = added.locator('[data-ask]')
  await expect(asks.first()).toHaveAttribute('data-ask', 'logs')
  await expect(asks.first()).toHaveAttribute('data-red', '')
  await expect(asks.first()).toHaveText(
    'Its code reads containers’ logs: what they print, which can hold tokens and personal data, reaches its code.' +
      'Of pods its page shows, one container at a time: at most its last 500 lines or hour, as you, within your access.',
  )
  await expect(asks.first()).toHaveClass(/text-critical-text/)
  // (Reading them is a step up from showing them: nothing of it is gone.)
  await expect(added.locator('[data-ask]')).toHaveCount(1)
  await expect(dialog(page).getByRole('region', { name: 'No longer' })).toHaveCount(0)
  await dialog(page).getByRole('button', { name: 'Update to 1.3.0' }).click()
  await expect(page.getByText('Updated Toys to 1.3.0.')).toBeVisible()
})

test('an update whose code asks its tool’s server asks again: in red, its paths listed, first under New in', async ({
  launch,
  downloads,
}) => {
  const pages = `  pages: [{ id: overview, title: Overview }]
`
  const server = `  server:
    service: { name: toys-api }
    in: { group: example.com, kind: Widget }
    port: http
    paths: ["/api/v1/widgets/{widget}/history"]
`
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), file('toys', 'Toys', 'Widget', '1.2.0', pages))
  writeFileSync(join(folder, 'toys.js'), 'box.then(() => {})\n')
  downloads.pluginStore = release(1, {
    ...plugin('toys', 'Toys', 'Widget', '1.3.0', pages + server),
    code: 'box.then(() => {})\n',
  })
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  await go(page, pluginsPage)
  await row(page, 'Toys').getByRole('button', { name: 'Update…' }).click()
  const asks = dialog(page).getByRole('region', { name: 'New in 1.3.0' }).locator('[data-ask]')
  await expect(asks).toHaveCount(1)
  await expect(asks.first()).toHaveAttribute('data-ask', 'server')
  await expect(asks.first()).toHaveAttribute('data-red', '')
  await expect(asks.first()).toHaveText(
    'Asks the server toys-api in this cluster, through Lumovi, and its code reads what it answers:' +
      'The Service toys-api, port http, in the namespace of the Widget its page shows.' +
      '/api/v1/widgets/{widget}/history',
  )
  await dialog(page).getByRole('button', { name: 'Update to 1.3.0' }).click()
  await expect(page.getByText('Updated Toys to 1.3.0.')).toBeVisible()
})

test('an installed copy whose files changed isn’t used: Lumovi’s own is, and the page says why', async ({
  launch,
  downloads,
}) => {
  downloads.pluginStore = release(1, plugin('toys', 'Toys', 'Widget', '1.3.0', LINKS))
  const { page, userDataDir } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() },
  })
  await openCluster(page)
  await go(page, pluginsPage)
  await row(page, 'Toys').getByRole('button', { name: 'Update…' }).click()
  await dialog(page).getByRole('button', { name: 'Update to 1.3.0' }).click()
  await expect(page.getByText('Updated Toys to 1.3.0.')).toBeVisible()
  const copy = join(userDataDir, 'plugins', 'installed', 'toys', '1.3.0', 'plugin.yaml')
  writeFileSync(copy, `${readFileSync(copy, 'utf8')}# changed\n`)
  await page.reload()
  await go(page, pluginsPage)
  await expect(row(page, 'Toys').locator('[data-plugin-not-used="files"]')).toHaveText(
    'Its installed files aren’t the ones you agreed to, so Lumovi uses its own Toys.',
  )
  await expect(row(page, 'Toys')).toContainText('1.2.0')
  await expect(row(page, 'Toys')).toContainText('Comes with Lumovi')
  // Its "…" clears the copy that isn't what was agreed: back to the one that came with Lumovi.
  await row(page, 'Toys').getByRole('button', { name: 'More for Toys' }).click()
  await expect(page.getByRole('menuitem')).toHaveCount(1)
  await page.getByRole('menuitem', { name: /^Back to the one that came with Lumovi/ }).click()
  await expect(page.getByText('Went back to Lumovi’s own Toys.')).toBeVisible()
  await expect(row(page, 'Toys').locator('[data-plugin-not-used]')).toHaveCount(0)
  expect(existsSync(join(userDataDir, 'plugins', 'installed', 'toys'))).toBe(false)
})

test('the organization’s policy refuses what it doesn’t allow, saying which key, with nothing to press', async ({
  launch,
  downloads,
}) => {
  const policy = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(policy, JSON.stringify({ pluginsAllowed: ['toys@1.2.0', 'tinker'] }))
  downloads.pluginStore = release(
    1,
    plugin('toys', 'Toys', 'Widget', '1.3.0', LINKS),
    plugin('tinker', 'Tinker', 'Database', '1.0.0'),
  )
  const { page } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(), LUMOVI_POLICY: policy },
  })
  await openCluster(page)
  await go(page, pluginsPage)
  // Its update still offers Update…, so the person learns why.
  await row(page, 'Toys').getByRole('button', { name: 'Update…' }).click()
  await expect(dialog(page).locator('[data-store-refused="pluginsAllowed"]')).toContainText(
    'Your organization’s policy doesn’t allow this version. (pluginsAllowed). 1.2.0 stays in use.',
  )
  await expect(dialog(page).getByRole('button', { name: /^Update to/ })).toHaveCount(0)
  await dialog(page).getByRole('button', { name: 'Close' }).click()
  // And the main process holds it too, whatever a page asks.
  await expect(
    page.evaluate(() => window.lumovi!.pluginStore!.install('toys', '1.3.0', '')),
  ).rejects.toThrow('What it asks isn’t what you were shown')
})

test('an update with code says its code changed, links the releases’ diff, and its code is what’s handed over', async ({
  launch,
  downloads,
}) => {
  const pages = `  reads: [{ group: '', kind: Node, fields: [metadata.name] }]
  pages: [{ id: overview, title: Overview }]
`
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), file('toys', 'Toys', 'Widget', '1.2.0', pages))
  writeFileSync(join(folder, 'toys.js'), 'box.then(() => {})\n')
  const code = 'box.then(({ post }) => post("{}"))\n'
  downloads.pluginStore = release(1, {
    ...plugin('toys', 'Toys', 'Widget', '1.3.0', pages),
    code,
  })
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  await go(page, pluginsPage)
  await row(page, 'Toys').getByRole('button', { name: 'Update…' }).click()
  // It asks for the same, and its code is new: the release it's in use from, to the one offered.
  await expect(dialog(page)).toContainText('It asks for nothing it doesn’t already have.')
  const changed = dialog(page).getByRole('link', { name: 'See what changed on GitHub ↗' })
  await expect(changed).toHaveAttribute(
    'href',
    `https://github.com/Lumovi/Lumovi-plugins/compare/v${builtWith().version}...v9.1.0`,
  )
  await expect(dialog(page)).toContainText(
    `Lumovi-plugins release ${builtWith().version} to 9.1.0, every plugin’s changes. This one’s are under plugins/toys and src/toys.`,
  )
  await dialog(page).getByRole('button', { name: 'Update to 1.3.0' }).click()
  await expect(page.getByText('Updated Toys to 1.3.0.')).toBeVisible()
  // What a page of it is handed: the installed code, checked against what was agreed.
  expect(await page.evaluate(() => window.lumovi!.kube.pluginCode('toys'))).toMatchObject({
    codeDigest: `sha256:${createHash('sha256').update(code).digest('hex')}`,
  })
})

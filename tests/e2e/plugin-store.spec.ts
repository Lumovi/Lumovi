/**
 * What's newer in Lumovi-plugins, on the Plugins page (src/main/plugin-store.ts): its latest
 * release, from the tests' stand-in for GitHub, signed by their stand-in for Sigstore with the
 * release workflow's real identity, and checked before anything of it is shown. Nothing installs.
 * Toys, Plain, Tinker and Gizmo are the tests' stand-ins, never Lumovi-plugins' own.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import {
  builtWith,
  type StandInPlugin,
  type StandInRelease,
} from '../mock-downloads/plugin-store.ts'
import type { MockDownloads } from '../mock-downloads/server.ts'
import { CONTEXTS, expect, openCluster, test } from './fixtures.ts'

/** A stand-in plugin's file, at a version, needing a Lumovi. */
const file = (name: string, label: string, kind: string, version: string, lumovi = '1.0.0') =>
  `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: ${name} }
spec:
  version: ${version}
  needs: { lumovi: ${lumovi} }
  groups: [example.com]
  label: ${label}
  kinds: [{ group: example.com, kind: ${kind} }]
`
const plugin = (
  name: string,
  label: string,
  kind: string,
  version: string,
  lumovi?: string,
): StandInPlugin => ({
  name,
  version,
  text: file(name, label, kind, version, lumovi),
  ...(lumovi ? { lumovi } : {}),
})

/** Toys and Plain come with this Lumovi (the tests' build takes them as its own). */
function included(): string {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), file('toys', 'Toys', 'Widget', '1.2.0'))
  writeFileSync(join(folder, 'plain.yaml'), file('plain', 'Plain', 'Gadget', '1.0.0'))
  return folder
}

function policyFile(policy: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(path, JSON.stringify(policy))
  return path
}

/**
 * A release after the one Lumovi was built with: Toys newer, Plain newer but for a Lumovi that
 * isn't out, and Tinker and Gizmo, which this Lumovi doesn't carry (Gizmo only a newer one can).
 */
function newer(): StandInRelease {
  const own = builtWith()
  return {
    version: '9.1.0',
    serial: own.serial + 1,
    plugins: [
      ...own.plugins,
      plugin('toys', 'Toys', 'Widget', '1.3.0'),
      plugin('plain', 'Plain', 'Gadget', '1.1.0', '99.0.0'),
      plugin('tinker', 'Tinker', 'Database', '1.0.0'),
      plugin('gizmo', 'Gizmo', 'Gizmo', '2.0.0', '99.0.0'),
    ],
  }
}

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)
const pluginsPage = `#/cluster/${CONTEXTS.demo}/plugins`
const filters = (page: Page) => page.getByRole('group', { name: 'Which plugins' })
const filter = (page: Page, name: string | RegExp) => filters(page).getByRole('button', { name })
const table = (page: Page) => page.getByRole('table', { name: 'Plugins' })
const row = (page: Page, name: string) =>
  table(page)
    .locator('tbody tr[data-state]')
    .filter({ hasText: new RegExp(`^${name}\\d`) })
const line = (page: Page) => page.locator('[data-plugin-store]')
const checkNow = (page: Page) => line(page).getByRole('button', { name: 'Check now' })
const foot = (page: Page) => page.locator('footer').filter({ hasText: ' shown.' })
const columns = (page: Page) => table(page).getByRole('columnheader')
/** What was asked of GitHub's stand-in for Lumovi-plugins. */
const asked = (requests: string[]) =>
  requests.filter(
    (path) => path.startsWith('/Lumovi/Lumovi-plugins') || path.startsWith('/release-assets/'),
  )

test('the Plugins page says what’s newer in Lumovi-plugins’ latest release, once it’s checked, and asks again only on Check now', async ({
  launch,
  downloads,
}) => {
  downloads.pluginStore = newer()
  const { page, userDataDir } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() },
  })
  await openCluster(page)
  expect(asked(downloads.requests)).toEqual([])
  await go(page, pluginsPage)
  await expect(line(page)).toHaveText(
    /^Lumovi-plugins release 9\.1\.0 · checked just nowCheck now$/,
  )
  // Its redirect to the latest tag, git's list of refs, and the release's five files, each from
  // where GitHub keeps them.
  const files = [
    'plugins-9.1.0.json',
    'plugins-9.1.0.index.json',
    'plugins-9.1.0.json.sigstore.json',
    'plugins-9.1.0.index.json.sigstore.json',
    'plugins-9.1.0.attestation.json',
  ]
  expect(asked(downloads.requests)).toEqual([
    '/Lumovi/Lumovi-plugins/releases/latest',
    '/Lumovi/Lumovi-plugins.git/info/refs',
    ...files.flatMap((name) => [
      `/Lumovi/Lumovi-plugins/releases/download/v9.1.0/${name}`,
      `/release-assets/${name}`,
    ]),
  ])
  // Taken: none older than it is taken after.
  expect(JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8'))).toMatchObject({
    pluginStoreSerial: newer().serial,
  })

  // Toys has an update; Plain's newer one needs a newer Lumovi, and says so at its end.
  await expect(row(page, 'Toys').locator('[data-plugin-update]')).toHaveText('Update: 1.3.0')
  await expect(row(page, 'Plain').locator('[data-plugin-update]')).toHaveCount(0)
  await expect(row(page, 'Plain').locator('[data-plugin-needs]')).toHaveText(
    '1.1.0 needs Lumovi 99.0.0',
  )
  // (Said at the rows' end: a column there only while a row has something for it.)
  await expect(columns(page)).toHaveCount(4)
  // Lumovi's own say so.
  await expect(row(page, 'Toys')).toContainText('Comes with Lumovi')
  // The two filters of what it found, beside the page's own; All is still this Lumovi's.
  await expect(filter(page, 'Updates 1')).toBeVisible()
  await expect(filter(page, 'Not here yet 2')).toBeVisible()
  await expect(row(page, 'Tinker')).toHaveCount(0)
  await filter(page, 'Updates 1').click()
  await expect(table(page).locator('tbody tr[data-state]')).toHaveCount(1)
  await expect(row(page, 'Toys')).toBeVisible()

  // Not here yet: each with where it's from, whether its kinds are here, and what it asks.
  await filter(page, 'Not here yet 2').click()
  await expect(table(page).locator('tbody tr[data-state]')).toHaveCount(2)
  // Counted from what the filter draws on: what this Lumovi lacks, apart from its own.
  await expect(foot(page)).toContainText(/^2 of 2 shown\./)
  await expect(row(page, 'Tinker')).toContainText('Its kinds are on this cluster')
  await expect(row(page, 'Tinker')).toContainText('From Lumovi-plugins release 9.1.0')
  await expect(row(page, 'Gizmo')).toContainText('Not on this cluster')
  await expect(row(page, 'Gizmo').locator('[data-plugin-needs]')).toHaveText(
    '2.0.0 needs Lumovi 99.0.0',
  )
  await row(page, 'Tinker')
    .getByRole('button', { name: /^Tinker/ })
    .click()
  await expect(page.getByRole('region', { name: 'May change and create' })).toBeVisible()

  // Opened again within ten minutes: what was found, and nothing asked.
  const before = asked(downloads.requests).length
  await go(page, `#/cluster/${CONTEXTS.demo}/overview`)
  await go(page, pluginsPage)
  await expect(line(page)).toContainText('Lumovi-plugins release 9.1.0')
  expect(asked(downloads.requests)).toHaveLength(before)

  // Check now asks again. Where the latest has nothing newer than this Lumovi's own, there are
  // no Updates and no Not here yet, and a filter that was on gives way to All.
  await filter(page, 'Updates 1').click()
  const own = builtWith()
  downloads.pluginStore = { ...own, version: '9.3.0', serial: own.serial + 2 }
  // While it checks, it says so, and Check now waits.
  downloads.pluginStoreDelayMs = 1_000
  await checkNow(page).click()
  await expect(line(page)).toHaveAttribute('data-plugin-store', 'checking')
  await expect(line(page)).toContainText('Checking for newer plugins…')
  await expect(checkNow(page)).toBeDisabled()
  await expect(line(page)).toContainText('Lumovi-plugins release 9.3.0')
  expect(asked(downloads.requests).length).toBeGreaterThan(before)
  await expect(filter(page, /^Updates/)).toHaveCount(0)
  await expect(filter(page, /^Not here yet/)).toHaveCount(0)
  await expect(filter(page, /^All /)).toHaveAttribute('aria-pressed', 'true')
  await expect(row(page, 'Toys').locator('[data-plugin-update]')).toHaveCount(0)
  await expect(columns(page)).toHaveCount(3)
  const all = await filter(page, /^All /).textContent()
  await expect(foot(page)).toContainText(`${all!.slice(4)} of ${all!.slice(4)} shown.`)
})

test('at the narrowest, beside what’s newer, where a plugin came from breaks between words, never inside one', async ({
  launch,
  downloads,
}) => {
  downloads.pluginStore = newer()
  const { page } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(), LUMOVI_E2E_WINDOW: '1024x700' },
    fullLayout: false,
  })
  await openCluster(page)
  await go(page, pluginsPage)
  await expect(columns(page)).toHaveCount(4)
  expect(await page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(1024)
  await expect(row(page, 'Toys')).toContainText('Comes with Lumovi')
  const lines = table(page).getByText('Comes with Lumovi')
  // A word cut in two takes two lines.
  const cut = await lines.evaluateAll((each) =>
    each.flatMap((line) => {
      const text = line.firstChild!
      return [...text.textContent!.matchAll(/\S+/g)]
        .filter((word) => {
          const range = document.createRange()
          range.setStart(text, word.index)
          range.setEnd(text, word.index + word[0].length)
          return range.getClientRects().length > 1
        })
        .map((word) => word[0])
    }),
  )
  expect(cut).toEqual([])
})

test('a release that fails a check is refused, saying which, and the page goes on with the last one that passed', async ({
  launch,
  downloads,
}) => {
  downloads.pluginStore = newer()
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  await go(page, pluginsPage)
  await expect(line(page)).toContainText('Lumovi-plugins release 9.1.0')
  const refused = async (release: MockDownloads['pluginStore'], said: string) => {
    downloads.pluginStore = release
    await checkNow(page).click()
    await expect(line(page)).toHaveAttribute('data-plugin-store', 'failed')
    await expect(line(page)).toContainText(said)
  }
  const later = (change: Partial<StandInRelease>): StandInRelease => ({
    ...newer(),
    version: '9.2.0',
    ...change,
  })
  await refused(
    later({ fault: 'signer' }),
    'Couldn’t check for newer plugins: the release isn’t signed by Lumovi-plugins’ release workflow, so Lumovi took nothing from it.',
  )
  // What the last good check found stays, and its filters say so.
  await expect(row(page, 'Toys').locator('[data-plugin-update]')).toHaveText('Update: 1.3.0')
  await filter(page, 'Updates 1').hover()
  await expect(page.getByRole('tooltip')).toContainText(/^From the check at /)
  await refused(
    later({ fault: 'commit' }),
    'Couldn’t check for newer plugins: the release doesn’t show it was built from its tag’s commit, so Lumovi took nothing from it.',
  )
  await refused(
    later({ fault: 'tampered' }),
    'Couldn’t check for newer plugins: a file isn’t the one the release names, so Lumovi took nothing from it.',
  )
  await refused(
    later({ expires: '2025-10-01T12:00:00.000Z' }),
    'Couldn’t check for newer plugins: this release expired on Oct 1, 2025, and Lumovi takes none past that.',
  )
  // Older than the one it took: never taken, though it's signed, whole and its tag's.
  await refused(
    later({ serial: newer().serial - 1 }),
    'Couldn’t check for newer plugins: this release is older than one Lumovi has already taken, so Lumovi took nothing from it.',
  )
  await refused(503, 'Couldn’t check for newer plugins: GitHub answered 503.')
  // And Lumovi-plugins with no release at all.
  await refused('none', 'Couldn’t check for newer plugins: GitHub answered 404.')
  await expect(row(page, 'Toys').locator('[data-plugin-update]')).toHaveText('Update: 1.3.0')
})

test('the organization’s policy turns it off, or allows only Lumovi’s own: nothing is asked of GitHub', async ({
  launch,
  downloads,
}) => {
  for (const policy of [{ pluginStore: 'off' }, { plugins: 'bundled' }]) {
    const { page, app } = await launch({ env: { LUMOVI_POLICY: policyFile(policy) } })
    await openCluster(page)
    await go(page, pluginsPage)
    await expect(table(page)).toBeVisible()
    await expect(line(page)).toHaveText(
      'Your organization’s policy turns off checking for newer plugins.',
    )
    await expect(checkNow(page)).toHaveCount(0)
    await expect(filter(page, /^Updates/)).toHaveCount(0)
    expect(asked(downloads.requests)).toEqual([])
    await app.close()
  }
})

/**
 * A hostile copy of a plugin installed from Lumovi-plugins (src/main/plugins-installed.ts): one
 * whose files were changed after it was agreed to is never run, Lumovi's own in its place; and no
 * copy is installed asking for anything but what the person was shown, whatever the page that
 * asks says was agreed. Each is asked of the main process straight, as a page that skipped the
 * store's dialog would ask, and judged by what came of it: what was handed, what was read for it,
 * what was written, what was drawn.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { asksOf } from '../../src/shared/plugin-store.ts'
import { parsePlugin } from '../../src/shared/plugins.ts'
import { holds } from '../holds.ts'
import { builtWith, type StandInRelease } from '../mock-downloads/plugin-store.ts'
import { CONTEXTS, expect, openCluster, test } from './fixtures.ts'

/** Toys' file at a version, reading these fields of a pod: its page is drawn by its code. */
const file = (version: string, fields: string) => `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: ${version}
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
  pages: [{ id: overview, title: Overview }]
  reads: [{ group: '', kind: Pod, fields: [${fields}] }]
`
const NAME = 'metadata.name'
const MORE = 'metadata.name, metadata.namespace'
const MOST = 'metadata.name, metadata.namespace, metadata.labels'

/** Its code: wherever it runs, its page says so (a Table titled "Ran <mark>"). */
const code = (mark: string) => `box.then(({ post, listen }) => {
  listen((text) => {
    if (!JSON.parse(text).open) return
    post(JSON.stringify({ commit: [
      ['make', 1, 'Table', { title: ${JSON.stringify(`Ran ${mark}`)}, columns: [], headings: false, rows: [] }],
      ['put', 0, 1],
    ] }))
  })
})
`
const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`
/** What a file asks, as the store's dialog shows it and an install is agreed to. */
const asks = (text: string) =>
  asksOf(parsePlugin(text, 'toys.yaml', { carriesCode: true }).plugin!, true)

/** Toys 1.2.0 comes with this Lumovi (the tests' build takes it as its own), with its code. */
function included(): string {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), file('1.2.0', NAME))
  writeFileSync(join(folder, 'toys.js'), code('own'))
  return folder
}
/** A release after the one Lumovi was built with, `n` later, with Toys at a version in it. */
function release(n: number, version: string, fields: string, mark: string): StandInRelease {
  const own = builtWith()
  return {
    version: `9.${n}.0`,
    serial: own.serial + n,
    plugins: [
      ...own.plugins,
      { name: 'toys', version, lumovi: '1.0.0', text: file(version, fields), code: code(mark) },
    ],
  }
}

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)
const PAGE = `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`
const ran = (page: Page, mark: string) => page.getByRole('region', { name: `Ran ${mark}` })
/** What the main process hands a page that asks for Toys' code. */
const handed = (page: Page) => page.evaluate(() => window.lumovi!.kube.pluginCode('toys'))
/** A read asked straight for Toys as `text` and `js` are: what the main process answers. */
const read = (page: Page, text: string, js: string) =>
  page.evaluate((q) => window.lumovi!.kube.pluginRead(q), {
    context: CONTEXTS.demo,
    plugin: 'toys',
    digest: sha(text),
    codeDigest: sha(js),
    kind: '/Pod',
  })
/** Asks the main process to install Toys at a version, said to be agreed to `agreed`. */
const install = (page: Page, version: string, agreed: string, name = 'toys') =>
  page.evaluate(
    ([name, version, agreed]) => window.lumovi!.pluginStore!.install(name, version, agreed),
    [name, version, agreed] as const,
  )
const OWN = {
  ok: true,
  code: code('own'),
  digest: sha(file('1.2.0', NAME)),
  codeDigest: sha(code('own')),
}

test('an installed copy whose code or file was changed is never run: Lumovi’s own is handed in its place, and only the very bytes agreed to bring it back', async ({
  launch,
  downloads,
}) => {
  downloads.pluginStore = release(1, '1.3.0', NAME, 'installed')
  const { page, userDataDir } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() },
  })
  await openCluster(page)
  await page.evaluate(() => window.lumovi!.pluginStore!.check(true))
  await install(page, '1.3.0', asks(file('1.3.0', NAME)))
  const installed = {
    ok: true,
    code: code('installed'),
    digest: sha(file('1.3.0', NAME)),
    codeDigest: sha(code('installed')),
  }
  expect(await handed(page)).toEqual(installed)
  await go(page, PAGE)
  await expect(ran(page, 'installed')).toBeVisible({ timeout: 20_000 })

  // Its code is written over, where it's installed. What's handed is Lumovi's own Toys, never
  // the changed code; a read by the changed code's digests is for no code Lumovi has.
  const at = join(userDataDir, 'plugins', 'installed', 'toys', '1.3.0')
  writeFileSync(join(at, 'plugin.js'), code('hostile'))
  await expect.poll(() => handed(page)).toEqual(OWN)
  expect(await read(page, file('1.3.0', NAME), code('hostile'))).toMatchObject({
    ok: false,
    refused: 'changed',
  })
  // Its page, opened again, is drawn by Lumovi's own; the changed code draws nothing, ever.
  await page.reload()
  await go(page, PAGE)
  await expect(ran(page, 'own')).toBeVisible({ timeout: 20_000 })
  await holds(
    async () => (await ran(page, 'hostile').count()) === 0,
    1500,
    'never the changed code',
  )

  // Its code as it was, and its file changed to ask for more: not what was agreed, so not used.
  writeFileSync(join(at, 'plugin.js'), code('installed'))
  writeFileSync(join(at, 'plugin.yaml'), file('1.3.0', MORE))
  await expect.poll(() => handed(page)).toEqual(OWN)
  expect(await read(page, file('1.3.0', MORE), code('installed'))).toMatchObject({
    ok: false,
    refused: 'changed',
  })
  // The very bytes that were agreed to, back in their place: it's the installed copy again.
  writeFileSync(join(at, 'plugin.yaml'), file('1.3.0', NAME))
  await expect.poll(() => handed(page)).toEqual(installed)
  // Only what was agreed to, and Lumovi's own, were ever handed.
  const { events } = await page.evaluate(() =>
    window.lumovi!.audit.query({ actions: ['plugin.code'] }),
  )
  const digests = events
    .filter((event) => event.target?.name === 'toys')
    .map((event) => event.details?.codeDigest)
  expect(new Set(digests)).toEqual(new Set([sha(code('installed')), sha(code('own'))]))
})

test('nothing is installed that asks for other than the person was shown: an install said to be agreed to other asks is refused, and writes nothing', async ({
  launch,
  downloads,
}) => {
  // Toys 1.3.0 asks for more than the one that comes with Lumovi: a pod's namespace too.
  downloads.pluginStore = release(1, '1.3.0', MORE, 'installed')
  const { page, userDataDir } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() },
  })
  await openCluster(page)
  await page.evaluate(() => window.lumovi!.pluginStore!.check(true))
  const nothingWritten = async (what: string) => {
    expect(existsSync(join(userDataDir, 'plugins', 'installed', 'toys')), what).toBe(false)
    const settings = join(userDataDir, 'settings.json')
    const kept = existsSync(settings)
      ? (JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>)
      : {}
    expect(JSON.stringify(kept), what).not.toContain('"toys"')
    expect(await handed(page), what).toEqual(OWN)
  }
  // Said to be agreed to what it has today, to nothing, or to something that isn't asks at all:
  // what the release asks isn't that, so it's refused.
  for (const agreed of [asks(file('1.2.0', NAME)), asks(file('1.3.0', NAME)), '', '{}']) {
    await expect(install(page, '1.3.0', agreed), agreed.slice(0, 40)).rejects.toThrow(
      'What it asks isn’t what you were shown',
    )
    await nothingWritten('after an install agreed to other asks')
  }
  // A version the release doesn't have, and a name that isn't a plugin's: refused as plainly.
  await expect(install(page, '9.9.9', asks(file('1.3.0', MORE)))).rejects.toThrow(
    'doesn’t have toys 9.9.9',
  )
  for (const name of ['../toys', 'toys/1.3.0', 'Toys']) {
    await expect(install(page, '1.3.0', asks(file('1.3.0', MORE)), name), name).rejects.toThrow(
      `${name} 1.3.0 isn’t a plugin’s name and version`,
    )
  }
  await nothingWritten('after installs that name no plugin of the release')
  const updated = () =>
    page
      .evaluate(() =>
        window.lumovi!.audit.query({ actions: ['plugin.installed', 'plugin.updated'] }),
      )
      .then(({ events }) => events.length)
  expect(await updated()).toBe(0)

  // Agreed to what it asks, it's installed, and that's what's handed.
  await install(page, '1.3.0', asks(file('1.3.0', MORE)))
  const installed = {
    ok: true,
    code: code('installed'),
    digest: sha(file('1.3.0', MORE)),
    codeDigest: sha(code('installed')),
  }
  expect(await handed(page)).toEqual(installed)
  expect(await updated()).toBe(1)

  // A newer release, whose Toys asks for more again: the agreement to 1.3.0 isn't one to it.
  downloads.pluginStore = release(2, '1.4.0', MOST, 'newer')
  await page.evaluate(() => window.lumovi!.pluginStore!.check(true))
  await expect(install(page, '1.4.0', asks(file('1.3.0', MORE)))).rejects.toThrow(
    'What it asks isn’t what you were shown',
  )
  // (And the version it was agreed to is no longer the release's to give.)
  await expect(install(page, '1.3.0', asks(file('1.3.0', MORE)))).rejects.toThrow(
    'doesn’t have toys 1.3.0',
  )
  expect(existsSync(join(userDataDir, 'plugins', 'installed', 'toys', '1.4.0'))).toBe(false)
  expect(await handed(page)).toEqual(installed)
  expect(await updated()).toBe(1)
})

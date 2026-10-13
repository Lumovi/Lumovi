/**
 * A hostile plugin of the person's own, in a folder of its own with code, against Developer mode
 * (src/main/plugins-agreed.ts): its code runs nowhere without an agreement, an agreement is to the
 * very code and asks that were read and to nothing put in their place since, and under the
 * organization's policy none of it runs whatever the person's settings say. Each is asked of the
 * main process straight, as a page that skipped Lumovi's own questions would ask, and judged by
 * what came of it: what was handed, what was read for it, what was drawn.
 */
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { AuditEvent } from '../../src/shared/audit.ts'
import { holds } from '../holds.ts'
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
  reads: [{ group: '', kind: Pod, fields: [metadata.name] }]
`
/** What it asks for once it's edited: a pod's namespace too. */
const TOYS_ASKS_MORE = TOYS.replace(
  'fields: [metadata.name]',
  'fields: [metadata.name, metadata.namespace]',
)

/**
 * Its code: wherever it runs, its page says so (a Table titled "Ran <mark>"), and it reads the
 * cluster's pods.
 */
const code = (mark: string) => `box.then(({ post, listen }) => {
  listen((text) => {
    if (!JSON.parse(text).open) return
    post(JSON.stringify({ read: 1, what: 'list', kind: '/Pod' }))
    post(JSON.stringify({ commit: [
      ['make', 1, 'Table', { title: ${JSON.stringify(`Ran ${mark}`)}, columns: [], headings: false, rows: [] }],
      ['put', 0, 1],
    ] }))
  })
})
`
const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`

/** A person's plugins folder, with Toys in a folder of its own. */
function folder(): string {
  const own = mkdtempSync(join(tmpdir(), 'lumovi-own-'))
  mkdirSync(join(own, 'toys'))
  writeFileSync(join(own, 'toys', 'plugin.yaml'), TOYS)
  writeFileSync(join(own, 'toys', 'plugin.js'), code('first'))
  return own
}

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)
const PAGE = `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`
const body = (page: Page) => page.locator('[data-plugin-body="toys"]')
/** Anything its code drew, whichever code it was. */
const ran = (page: Page) => page.getByRole('region', { name: /^Ran / })

/** What the main process hands a page that asks for Toys' code. */
const handed = (page: Page) => page.evaluate(() => window.lumovi!.kube.pluginCode('toys'))
/** A read asked straight for Toys' code as `file` and `js` are: what the main process answers. */
const read = (page: Page, file: string, js: string) =>
  page.evaluate((q) => window.lumovi!.kube.pluginRead(q), {
    context: CONTEXTS.demo,
    plugin: 'toys',
    digest: sha(file),
    codeDigest: sha(js),
    kind: '/Pod',
  })
/** Agrees as the store's dialog would, to what the main process reads now. */
async function agree(page: Page) {
  const standing = await page.evaluate(() => window.lumovi!.ownCode!.standing('toys'))
  await page.evaluate(([asks, js]) => window.lumovi!.ownCode!.agree('toys', asks, js), [
    standing!.asks,
    standing!.code,
  ] as const)
  return standing!
}
const events = (page: Page, action: AuditEvent['action']) =>
  page
    .evaluate((actions) => window.lumovi!.audit.query({ actions }), [action])
    .then(({ events }) => events)

test('without an agreement a folder plugin’s code runs nowhere: it isn’t handed, nothing is read for it, and an agreement to anything but what Lumovi read is refused', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_PLUGINS_DIR: folder() } })
  await openCluster(page)
  // Developer mode off, as Lumovi starts: asked straight, its code isn't handed, and a read asked
  // in its name, with the digests its code would have, is no plugin's.
  expect(await handed(page)).toEqual({ ok: false, refused: 'developer-mode-off' })
  expect(await page.evaluate(() => window.lumovi!.kube.pluginHandOver('toys'))).toBe(
    'developer-mode-off',
  )
  expect(await read(page, TOYS, code('first'))).toMatchObject({ ok: false, refused: 'not-in-use' })
  // Nor can it be agreed to there, whatever is said to be agreed.
  await expect(
    page.evaluate(([file, js]) => window.lumovi!.ownCode!.agree('toys', file, js), [
      TOYS,
      sha(code('first')),
    ] as const),
  ).rejects.toThrow('Lumovi runs no code of this plugin')

  // On, and not agreed: still not handed, and nothing read for it.
  await page.evaluate(() => window.lumovi!.ownCode!.developerMode(true))
  expect(await handed(page)).toEqual({ ok: false, refused: 'waiting-first' })
  expect(await read(page, TOYS, code('first'))).toMatchObject({ ok: false, refused: 'not-in-use' })
  // An agreement is to what Lumovi read, said back to it: to other asks, or other code, it's
  // refused; and so is one for a plugin that isn't one of the person's own with code.
  const standing = await page.evaluate(() => window.lumovi!.ownCode!.standing('toys'))
  expect(standing).toMatchObject({ standing: 'first', code: sha(code('first')) })
  for (const [asks, js] of [
    [standing!.asks, sha(code('second'))],
    ['{}', standing!.code],
    ['', ''],
  ] as const) {
    await expect(
      page.evaluate(([asks, js]) => window.lumovi!.ownCode!.agree('toys', asks, js), [
        asks,
        js,
      ] as const),
    ).rejects.toThrow('It changed while its dialog was open.')
  }
  for (const name of ['nope', 'argo-cd', '../toys', 'toys/plugin']) {
    await expect(
      page.evaluate(([name, asks, js]) => window.lumovi!.ownCode!.agree(name, asks, js), [
        name,
        standing!.asks,
        standing!.code,
      ] as const),
      name,
    ).rejects.toThrow('Lumovi runs no code of this plugin')
  }
  expect(await handed(page)).toEqual({ ok: false, refused: 'waiting-first' })
  // Its page waits, and nothing of its code is drawn however long it's left.
  await go(page, PAGE)
  await expect(body(page).getByTestId('plugin-waiting')).toBeVisible({ timeout: 20_000 })
  await holds(async () => (await ran(page).count()) === 0, 1500, 'nothing of its code is drawn')
  // Nothing was handed, and nothing agreed: the history has neither.
  const handedOver = (await events(page, 'plugin.code')).filter(
    (event) => event.target?.name === 'toys',
  )
  expect(handedOver).toEqual([])
  expect(await events(page, 'plugin.code-agreed')).toEqual([])
})

test('code put in its place after the agreement isn’t handed, nor read for: what was agreed is what runs, and the old agreement can’t be said again for the new', async ({
  launch,
}) => {
  const own = folder()
  const js = join(own, 'toys', 'plugin.js')
  const { page } = await launch({ env: { LUMOVI_PLUGINS_DIR: own } })
  await openCluster(page)
  await page.evaluate(() => window.lumovi!.ownCode!.developerMode(true))
  const agreed = await agree(page)
  // Agreed: what's handed is the code that was read and agreed to, byte for byte.
  expect(await handed(page)).toEqual({
    ok: true,
    code: code('first'),
    digest: sha(TOYS),
    codeDigest: sha(code('first')),
  })
  await go(page, PAGE)
  await expect(page.getByRole('region', { name: 'Ran first' })).toBeVisible({ timeout: 20_000 })

  // Other code is written over it. It isn't handed; a read for it, by its own digests or by the
  // agreed ones, is refused; and its page, which was running the first, is closed.
  writeFileSync(js, code('second'))
  await expect.poll(() => handed(page)).toEqual({ ok: false, refused: 'waiting-code' })
  expect(await read(page, TOYS, code('second'))).toMatchObject({ ok: false, refused: 'not-in-use' })
  expect(await read(page, TOYS, code('first'))).toMatchObject({ ok: false, refused: 'not-in-use' })
  await expect(body(page).getByTestId('plugin-waiting')).toBeVisible({ timeout: 10_000 })
  await holds(async () => (await ran(page).count()) === 0, 1500, 'the new code draws nothing')
  // The agreement made for the first can't be said again for the second.
  await expect(
    page.evaluate(([asks, js]) => window.lumovi!.ownCode!.agree('toys', asks, js), [
      agreed.asks,
      agreed.code,
    ] as const),
  ).rejects.toThrow('It changed while its dialog was open.')
  expect(await handed(page)).toEqual({ ok: false, refused: 'waiting-code' })

  // A link in its place counts as what it points at: other code behind it waits; the agreed
  // code behind it is the agreed code. (Windows makes no link without a privilege.)
  if (process.platform !== 'win32') {
    const [other, same] = [join(own, 'other.js'), join(own, 'same.js')]
    writeFileSync(other, code('third'))
    writeFileSync(same, code('first'))
    unlinkSync(js)
    symlinkSync(other, js)
    await expect.poll(() => handed(page)).toEqual({ ok: false, refused: 'waiting-code' })
    unlinkSync(js)
    symlinkSync(same, js)
    await expect
      .poll(() => handed(page))
      .toMatchObject({ ok: true, codeDigest: sha(code('first')) })
    unlinkSync(js)
  }

  // The agreed code back, and its file asking for more: it waits for what's new, the code isn't
  // handed, and a read by the new file's digest is refused.
  writeFileSync(js, code('first'))
  await expect.poll(() => handed(page)).toMatchObject({ ok: true })
  writeFileSync(join(own, 'toys', 'plugin.yaml'), TOYS_ASKS_MORE)
  await expect.poll(() => handed(page)).toEqual({ ok: false, refused: 'waiting-asks' })
  expect(await read(page, TOYS_ASKS_MORE, code('first'))).toMatchObject({
    ok: false,
    refused: 'not-in-use',
  })
  await expect(
    page.evaluate(([asks, js]) => window.lumovi!.ownCode!.agree('toys', asks, js), [
      agreed.asks,
      agreed.code,
    ] as const),
  ).rejects.toThrow('It changed while its dialog was open.')
  // Only the first was ever handed. (The history says a hand-over once for each code, by its
  // digests, however often a window asks for it: so one entry, the first's.)
  const handedOver = (await events(page, 'plugin.code')).filter(
    (event) => event.target?.name === 'toys',
  )
  expect(handedOver.map((event) => event.details?.codeDigest)).toEqual([sha(code('first'))])
})

/** What its page says under a policy that keeps Developer mode off; and where it isn't in use. */
const LOCKED = 'Your organization’s policy keeps Developer mode off.'
const NOT_HERE = 'This cluster doesn’t have it'

// Each policy, how the main process refuses its code under it, and what its page then says.
for (const [policy, why, refused, said] of [
  [{ pluginDeveloperMode: 'off' }, 'Developer mode off', 'developer-mode-locked', LOCKED],
  [{ plugins: 'no-code' }, 'no plugin’s code', 'developer-mode-locked', LOCKED],
  // (None of the person's own plugins is in use at all there.)
  [{ plugins: 'bundled' }, 'only the plugins Lumovi comes with', 'not-in-use', NOT_HERE],
] as const) {
  test(`under a policy of ${why}, an agreed folder plugin’s code isn’t handed, whatever the person’s settings say`, async ({
    launch,
  }) => {
    const own = folder()
    const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
    const first = await launch({ env: { LUMOVI_PLUGINS_DIR: own }, userDataDir })
    await openCluster(first.page)
    await first.page.evaluate(() => window.lumovi!.ownCode!.developerMode(true))
    const agreed = await agree(first.page)
    expect(await handed(first.page)).toMatchObject({ ok: true })
    await first.app.close()
    // The person's settings as they were left: Developer mode on, and Toys agreed to.
    const settings = join(userDataDir, 'settings.json')
    const kept = readFileSync(settings, 'utf8')
    expect(JSON.parse(kept)).toMatchObject({
      pluginDeveloperMode: true,
      pluginsAgreed: { toys: { code: sha(code('first')) } },
    })

    const file = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
    writeFileSync(file, JSON.stringify(policy))
    const locked = await launch({
      env: { LUMOVI_PLUGINS_DIR: own, LUMOVI_POLICY: file },
      userDataDir,
    })
    await openCluster(locked.page)
    // Not handed, asked straight; and nothing read for it.
    expect(await handed(locked.page)).toEqual({ ok: false, refused })
    expect(await read(locked.page, TOYS, code('first'))).toMatchObject({
      ok: false,
      refused: 'not-in-use',
    })
    // Developer mode can't be turned on, and nothing can be agreed to.
    await expect(
      locked.page.evaluate(() => window.lumovi!.ownCode!.developerMode(true)),
    ).rejects.toThrow('Your organization’s policy keeps Developer mode off.')
    await expect(
      locked.page.evaluate(([asks, js]) => window.lumovi!.ownCode!.agree('toys', asks, js), [
        agreed.asks,
        agreed.code,
      ] as const),
    ).rejects.toThrow('Lumovi runs no code of this plugin')
    // Its page says why, and once it has, nothing of its code is drawn however long it's left.
    await go(locked.page, PAGE)
    await expect(locked.page.locator('main')).toContainText(said, { timeout: 20_000 })
    await holds(async () => (await ran(locked.page).count()) === 0, 1500, 'nothing is drawn')
    // What was agreed was let go of, by Lumovi and said once.
    expect(JSON.parse(readFileSync(settings, 'utf8')).pluginsAgreed ?? {}).toEqual({})
    expect((await events(locked.page, 'plugin.code-agreed'))[0]).toMatchObject({
      outcome: 'cancelled',
      actor: { user: 'lumovi', via: 'server' },
    })
    await locked.app.close()

    // The settings written back as they were, agreement and all, under the same policy: the
    // policy is read before them, and it's let go of again.
    writeFileSync(settings, kept)
    const again = await launch({
      env: { LUMOVI_PLUGINS_DIR: own, LUMOVI_POLICY: file },
      userDataDir,
    })
    await openCluster(again.page)
    expect(await handed(again.page)).toEqual({ ok: false, refused })
    expect(await read(again.page, TOYS, code('first'))).toMatchObject({
      ok: false,
      refused: 'not-in-use',
    })
    expect(JSON.parse(readFileSync(settings, 'utf8')).pluginsAgreed ?? {}).toEqual({})
  })
}

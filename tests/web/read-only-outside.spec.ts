/**
 * A server's settings, changed where it keeps them, outside Lumovi: by whoever can write there
 * (its state's Secret, or file), who can't make an entry, but can delete one, or put an older one
 * back. Each is recorded, the stricter is kept (read-only if either was; the rest as Lumovi last
 * set it), and it's shown to the server's admins, on every replica, until one of them settles it.
 */
import { createHmac, hkdfSync } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { audited, expect, test, type Served } from './fixtures.ts'
import { as } from './fleet.ts'

/** What a server keeps in its folder, by entry name. */
const entries = (dir: string): Record<string, string> =>
  (JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { entries: Record<string, string> })
    .entries
const keep = (dir: string, kept: Record<string, string>) =>
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ entries: kept }))

/** The name demo's settings are filed under: an HMAC of what they are, with the state's key. */
function demoName(dir: string): string {
  const key = Buffer.from(readFileSync(join(dir, 'state.key'), 'utf8').trim())
  return createHmac('sha256', Buffer.from(hkdfSync('sha256', key, 'lumovi', 'state names', 32)))
    .update('clusters\0demo')
    .digest('base64url')
}

/**
 * A server keeping its state in `dir`, with an admin. Its audit history in a folder of its own:
 * replicas share their state, never their history (one chain is one replica's).
 */
const env = (dir: string) => ({
  LUMOVI_AUTH: 'proxy',
  LUMOVI_DATA_DIR: dir,
  LUMOVI_AUDIT_DIR: mkdtempSync(join(tmpdir(), 'lumovi-audit-')),
  LUMOVI_ADMINS: 'user:admin@example.com',
})

/** What's set for demo, on a page. */
const settings = (page: Page) => page.evaluate(() => window.lumovi!.app.settings())
const setReadOnly = (page: Page, readOnly: boolean) =>
  page.evaluate((r) => window.lumovi!.app.setReadOnly('demo', r), readOnly)

/** What a server recorded as changed outside Lumovi. */
const outside = (served: Served, action = 'read-only.changed') =>
  audited(served, action).filter((event) => event.details?.outside === true)

/** Once what's kept for demo isn't `than`: it's written a little after a change. */
const written = (dir: string, than?: string) =>
  expect.poll(() => entries(dir)[demoName(dir)]).not.toBe(than)

const banner = (page: Page) => page.getByRole('region', { name: 'Changed outside Lumovi' })

test('read-only taken off where the server keeps it is put back, recorded, and shown on every replica', async ({
  page,
  context,
  serve,
}) => {
  // A server reads what's kept again every 10 seconds.
  test.slow()
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const served = await serve({ env: env(dir) })
  await as(context, 'admin@example.com')
  await page.goto(`${served.url}cluster/demo`)
  await setReadOnly(page, true)
  await written(dir)

  // Its entry deleted: read-only stays (it fails closed), and it's recorded.
  const name = demoName(dir)
  const { [name]: _deleted, ...others } = entries(dir)
  keep(dir, others)
  await expect
    .poll(() => outside(served), { timeout: 30_000 })
    .toEqual([
      expect.objectContaining({
        outcome: 'success',
        actor: { user: 'lumovi', via: 'server' },
        cluster: 'demo',
        summary:
          'Changed outside Lumovi: demo’s read-only was turned off, as its setting was deleted where Lumovi keeps it, and Lumovi made it read-only again',
        details: { outside: true, how: 'deleted', readOnly: true },
      }),
    ])
  expect(served.log()).toContain(
    'What’s set for demo was changed outside Lumovi: its setting was deleted where Lumovi keeps it. Lumovi kept the stricter (read-only again), and it’s recorded in the audit log.',
  )
  expect(await settings(page)).toMatchObject({
    readOnly: ['demo'],
    changedOutside: { demo: { how: 'deleted', readOnly: 'restored', restored: [] } },
  })
  await expect(banner(page)).toContainText(
    'demo’s read-only was turned off outside Lumovi, and Lumovi made it read-only again. On ',
  )
  await expect(banner(page)).toContainText(
    'its setting was deleted where Lumovi keeps it, by whoever can write there. It’s in the audit log.',
  )

  // Kept in the entry: another replica shows it too.
  const other = await serve({ env: env(dir) })
  const second = await context.newPage()
  await second.goto(`${other.url}cluster/demo`)
  await expect(banner(second)).toContainText('Lumovi made it read-only again')

  // Someone who isn't an admin isn't shown it, nor offered to set read-only, which they can't.
  const bob = await context.browser()!.newContext()
  await as(bob, 'bob@example.com')
  const bobs = await bob.newPage()
  await bobs.goto(`${served.url}cluster/demo`)
  await expect(bobs.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(banner(bobs)).toHaveCount(0)
  expect(await settings(bobs).then((s) => s.changedOutside)).toBeUndefined()
  await bobs.keyboard.press('ControlOrMeta+K')
  const palette = bobs.getByRole('dialog').filter({ has: bobs.getByRole('combobox') })
  await palette.getByRole('combobox').fill('read-only')
  await expect(palette.getByRole('option', { name: 'Allow changes to demo' })).toHaveCount(0)
  await bob.close()

  // Recorded once: kept counting above it, it's Lumovi's own to both replicas now.
  await page.waitForTimeout(12_000)
  expect(outside(served)).toHaveLength(1)
  expect(outside(other)).toHaveLength(0)

  // Settled on one replica, by the admin who confirms it: gone on both, and theirs.
  await banner(second).getByRole('button', { name: 'Keep it read-only' }).click()
  await expect(banner(second)).toHaveCount(0)
  await expect(banner(page)).toHaveCount(0, { timeout: 20_000 })
  expect((await settings(page)).readOnlyBy?.demo?.by).toBe('admin@example.com')
  await expect
    .poll(() => audited(other, 'read-only.changed').at(-1))
    .toMatchObject({ actor: expect.objectContaining({ user: 'admin@example.com' }) })
  await other.stop()
})

test('an older copy put back can’t take read-only off, nor bring back what Lumovi replaced', async ({
  page,
  context,
  serve,
}) => {
  test.slow()
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const served = await serve({ env: env(dir) })
  await as(context, 'admin@example.com')
  await page.goto(`${served.url}cluster/demo`)
  const nodeShell = (image: string) =>
    page.evaluate(
      (i) => window.lumovi!.app.setNodeShell('demo', { namespace: 'ops', image: i }),
      image,
    )
  const name = demoName(dir)
  // Changeable, its node shells in one image: the copy kept.
  await nodeShell('busybox:1.36')
  await written(dir)
  const changeable = entries(dir)[name]!
  // Then read-only, in another.
  await nodeShell('busybox:1.37')
  await setReadOnly(page, true)
  await written(dir, changeable)
  await expect.poll(() => settings(page).then((s) => s.readOnly)).toEqual(['demo'])
  const readOnly = entries(dir)[name]!

  // The changeable copy put back: read-only stays, and so does the newer image.
  keep(dir, { ...entries(dir), [name]: changeable })
  await expect.poll(() => outside(served).length, { timeout: 30_000 }).toBe(1)
  expect(outside(served)[0]).toMatchObject({
    summary:
      'Changed outside Lumovi: demo’s read-only was turned off, as an older copy of its setting was put back where Lumovi keeps it, and Lumovi made it read-only again',
    details: { outside: true, how: 'replaced', readOnly: true },
  })
  expect(outside(served, 'node-shell.changed')).toEqual([
    expect.objectContaining({
      summary:
        'Changed outside Lumovi: demo’s node shells were changed, as an older copy of its setting was put back where Lumovi keeps it, and Lumovi put back what it last set',
    }),
  ])
  await expect
    .poll(() => settings(page))
    .toMatchObject({
      readOnly: ['demo'],
      nodeShell: { demo: { namespace: 'ops', image: 'busybox:1.37' } },
      changedOutside: { demo: { how: 'replaced', readOnly: 'restored', restored: ['nodeShell'] } },
    })
  await expect(banner(page)).toContainText('Lumovi put back its node shells as it last set them.')

  // Allowed changes; then a copy put back from when it was read-only: kept so, as made outside.
  await banner(page).getByRole('button', { name: 'Allow changes' }).click()
  await expect(banner(page)).toHaveCount(0)
  await expect.poll(() => settings(page).then((s) => s.readOnly)).toEqual([])
  await written(dir, readOnly)
  keep(dir, { ...entries(dir), [name]: readOnly })
  await expect.poll(() => outside(served).length, { timeout: 30_000 }).toBe(2)
  expect(outside(served)[1]).toMatchObject({
    summary:
      'Changed outside Lumovi: demo was made read-only for everyone, as an older copy of its setting was put back where Lumovi keeps it',
    details: { outside: true, how: 'replaced', readOnly: true },
  })
  await expect(banner(page)).toContainText('demo was made read-only outside Lumovi.')
  // A change refused says so: the copy's person didn't make it read-only now.
  expect(
    await page.evaluate(async () => {
      const result = await window.lumovi!.kube.change({
        context: 'demo',
        kind: 'Deployment',
        namespace: 'shop',
        name: 'cart',
        change: { action: 'patch', patchType: 'merge', patch: { spec: { replicas: 3 } } },
      })
      return result.ok ? 'changed' : result.error.message
    }),
  ).toBe('demo is read-only for everyone on this server: it was made so outside Lumovi.')
  // Its buttons say what it is now.
  await expect(banner(page).getByRole('button', { name: 'Keep it read-only' })).toBeVisible()
  await banner(page).getByRole('button', { name: 'Allow changes' }).click()
  await expect(banner(page)).toHaveCount(0)
  await expect.poll(() => settings(page).then((s) => s.readOnly)).toEqual([])
})

test('an entry made again, after one was deleted while no server ran, counts above any older copy', async ({
  page,
  context,
  serve,
}) => {
  test.slow()
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const first = await serve({ env: env(dir) })
  await as(context, 'admin@example.com')
  await page.goto(`${first.url}cluster/demo`)
  await setReadOnly(page, true)
  await written(dir)
  const readOnly = entries(dir)[demoName(dir)]
  await setReadOnly(page, false)
  await written(dir, readOnly)
  const changeable = entries(dir)[demoName(dir)]!
  await first.stop()
  // Deleted while no server runs: the next takes it as it finds it, knowing nothing older.
  const { [demoName(dir)]: _deleted, ...others } = entries(dir)
  keep(dir, others)

  const again = await serve({ env: env(dir), port: first.port })
  await page.goto(`${again.url}cluster/demo`)
  await setReadOnly(page, true)
  await written(dir)
  // The changeable copy from before, put back: it doesn't count above the entry made again.
  keep(dir, { ...entries(dir), [demoName(dir)]: changeable })
  await expect.poll(() => outside(again).length, { timeout: 30_000 }).toBe(1)
  expect(outside(again)[0]).toMatchObject({ details: { how: 'replaced', readOnly: true } })
  expect(await settings(page)).toMatchObject({ readOnly: ['demo'] })
})

test('a server keeping its state in memory says to run one replica', async ({ serve }) => {
  const served = await serve({ env: { LUMOVI_AUTH: 'proxy' } })
  expect(served.log()).toContain(
    'Run a single replica so: each would keep its own, and what’s set for everyone (the clusters made read-only, say) would differ between them.',
  )
})

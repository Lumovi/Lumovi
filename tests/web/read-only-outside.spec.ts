/**
 * A server's read-only, changed where it keeps it, outside Lumovi: by whoever can write there (its
 * state's Secret, or file), who can't make an entry, but can delete one, or put an older one back.
 * Each is recorded, and shown to the server's admins, until one of them sets it again.
 */
import { createHmac, hkdfSync } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { audited, expect, test } from './fixtures.ts'
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

test('read-only taken off where the server keeps it is recorded, and shown to its admins', async ({
  page,
  context,
  serve,
}) => {
  // The server reads what's kept again every 10 seconds.
  test.slow()
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const served = await serve({
    env: { LUMOVI_AUTH: 'proxy', LUMOVI_DATA_DIR: dir, LUMOVI_ADMINS: 'user:admin@example.com' },
  })
  await as(context, 'admin@example.com')
  await page.goto(`${served.url}cluster/demo`)
  const setReadOnly = (readOnly: boolean) =>
    page.evaluate((r) => window.lumovi!.app.setReadOnly('demo', r), readOnly)
  const name = demoName(dir)
  const demo = () => entries(dir)[name]
  const outside = () =>
    audited(served, 'read-only.changed').filter((event) => event.details?.outside === true)
  const banner = page.getByRole('region', { name: 'Changed outside Lumovi' })

  // Its entry deleted: read-only off.
  await setReadOnly(true)
  await expect.poll(demo).toBeDefined()
  const { [name]: _deleted, ...others } = entries(dir)
  keep(dir, others)
  await expect.poll(outside, { timeout: 30_000 }).toEqual([
    expect.objectContaining({
      outcome: 'success',
      actor: { user: 'lumovi', via: 'server' },
      cluster: 'demo',
      summary:
        'Changed outside Lumovi: demo is no longer read-only for everyone on this server, as its setting was deleted where Lumovi keeps it',
      details: expect.objectContaining({ outside: true, how: 'deleted', readOnly: false }),
    }),
  ])
  expect(served.log()).toContain(
    'demo’s read-only was turned off outside Lumovi: its setting was deleted where Lumovi keeps it. It’s recorded in the audit log.',
  )
  // Shown to its admin.
  await expect(banner).toContainText(
    'demo is no longer read-only: it was changed outside Lumovi. On ',
  )
  await expect(banner).toContainText(
    'its setting was deleted where Lumovi keeps it, by whoever can write there. It’s in the audit log.',
  )
  expect(await page.evaluate(() => window.lumovi!.app.settings())).toMatchObject({
    readOnlyChangedOutside: { demo: { how: 'deleted', readOnly: false } },
  })

  // Someone who isn't an admin isn't shown it, nor offered to set read-only, which they can't.
  const bob = await context.browser()!.newContext()
  await as(bob, 'bob@example.com')
  const bobs = await bob.newPage()
  await bobs.goto(`${served.url}cluster/demo`)
  await expect(bobs.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(bobs.getByRole('region', { name: 'Changed outside Lumovi' })).toHaveCount(0)
  expect(
    await bobs.evaluate(() => window.lumovi!.app.settings().then((s) => s.readOnlyChangedOutside)),
  ).toBeUndefined()
  await bobs.keyboard.press('ControlOrMeta+K')
  const palette = bobs.getByRole('dialog').filter({ has: bobs.getByRole('combobox') })
  await palette.getByRole('combobox').fill('read-only')
  await expect(palette.getByRole('option', { name: 'Make demo read-only' })).toHaveCount(0)
  await bob.close()

  // Recorded once, by the server that found it, which keeps it as it now is, counting on: not
  // again as it reads it again.
  await page.waitForTimeout(12_000)
  expect(outside()).toHaveLength(1)

  // The admin settles it: read-only again, as theirs.
  await banner.getByRole('button', { name: 'Make it read-only again' }).click()
  await expect(banner).toHaveCount(0)
  expect(await page.evaluate(() => window.lumovi!.app.settings())).toMatchObject({
    readOnly: ['demo'],
  })
  await expect
    .poll(() => audited(served, 'read-only.changed').at(-1))
    .toMatchObject({ actor: expect.objectContaining({ user: 'admin@example.com' }) })

  // An older copy put back, from when it was off: read-only off again, and said so.
  await setReadOnly(false)
  await expect.poll(demo).toBeDefined()
  const off = demo()!
  await setReadOnly(true)
  await expect.poll(demo).not.toBe(off)
  keep(dir, { ...entries(dir), [name]: off })
  await expect.poll(() => outside().length, { timeout: 30_000 }).toBe(2)
  expect(outside()[1]).toMatchObject({
    summary:
      'Changed outside Lumovi: demo is no longer read-only for everyone on this server, as an older copy of its setting was put back where Lumovi keeps it',
    details: { outside: true, how: 'replaced', readOnly: false },
  })
  await expect(banner).toContainText('an older copy of its setting was put back')
  // Kept changeable, the admin's choice: settled too.
  await banner.getByRole('button', { name: 'Keep it changeable' }).click()
  await expect(banner).toHaveCount(0)
  expect(await page.evaluate(() => window.lumovi!.app.settings())).toMatchObject({ readOnly: [] })
})

test('a server keeping its state in memory says to run one replica', async ({ serve }) => {
  const served = await serve({ env: { LUMOVI_AUTH: 'proxy' } })
  expect(served.log()).toContain(
    'Run a single replica so: each would keep its own, and what’s set for everyone (the clusters made read-only, say) would differ between them.',
  )
})

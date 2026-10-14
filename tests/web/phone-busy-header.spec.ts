/**
 * A plugin's header on a phone, while one of its buttons that change is busy: Lumovi's line for
 * what a phone doesn't start leaves the busy one out (nothing could be started with it on a
 * larger screen either), and says nothing where only busy ones would be in it.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEMO_TOKEN, expect, freePort, test } from './fixtures.ts'
import { PHONE, signInNarrow } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

const FILE = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: busy }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Busy
  kinds: [{ group: example.com, kind: Widget }]
  pages: [{ id: overview, title: Overview }]
`

/** Its code: two headers, one with a busy Sync beside a Refresh, one with only the busy Sync. */
const CODE = `box.then(({ post, listen }) => {
  const sync = { key: 'sync', name: 'Sync', changes: true, asks: true, busy: { word: 'Syncing' } }
  const refresh = { key: 'refresh', name: 'Refresh', changes: true, asks: true }
  listen((text) => {
    if (!JSON.parse(text).open) return
    post(JSON.stringify({ commit: [
      ['make', 1, 'Stack', {}],
      ['make', 2, 'Header', { name: 'storefront', status: { level: 'healthy', word: 'Healthy' }, buttons: [refresh, sync], onPress: 'press' }],
      ['make', 3, 'Header', { name: 'checkout', status: { level: 'healthy', word: 'Healthy' }, buttons: [sync], onPress: 'press' }],
      ['put', 0, 1], ['put', 1, 2], ['put', 1, 3],
    ] }))
  })
})
`

test('on a phone, a busy button is in no line of what a larger screen starts', async ({
  serve,
  page,
}) => {
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'busy.yaml'), FILE)
  writeFileSync(join(included, 'busy.js'), CODE)
  const port = await freePort()
  const server = await serve({
    port,
    env: { LUMOVI_URL: `http://127.0.0.1:${port}`, LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included },
  })
  await signInNarrow(page, `${server.url}cluster/demo/plugins/busy/overview`, DEMO_TOKEN)
  const body = page.locator('[data-plugin-body]')
  const storefront = body.getByRole('group', { name: 'storefront' })
  await expect(storefront.getByRole('paragraph').filter({ hasText: 'larger screen' })).toHaveText(
    'Open Lumovi on a larger screen to use Refresh.',
  )
  const checkout = body.getByRole('group', { name: 'checkout' })
  await expect(checkout).toContainText('Healthy')
  await expect(checkout.getByRole('paragraph').filter({ hasText: 'larger screen' })).toHaveCount(0)
  // (Nor is the busy one drawn: what's happening is the header's to say.)
  await expect(body.getByRole('button', { name: /^Sync/ })).toHaveCount(0)
})

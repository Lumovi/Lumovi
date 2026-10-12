/**
 * The hand-over on a server: no browser has passed Lumovi's check that it keeps a plugin's code
 * apart (there's no check yet), so a server hands a plugin's code to no one, and says why where
 * its page would be and on the Plugins page. Without the second wall, it says that instead.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { NotHanded, PluginCode } from '../../src/shared/plugin-hand-over.ts'
import {
  audited,
  DEMO_TOKEN,
  expect,
  freePort,
  signIn,
  test,
  type ServeOptions,
  type Served,
} from './fixtures.ts'

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
const CODE = 'box.then(() => {})\n'

type Kube = {
  pluginCode(name: string): Promise<PluginCode>
  pluginHandOver(name: string): Promise<true | NotHanded>
}
const kube = (page: Page) =>
  page.evaluate(async () => {
    const api = (window as unknown as { lumovi: { kube: Kube } }).lumovi.kube
    return { code: await api.pluginCode('toys'), whether: await api.pluginHandOver('toys') }
  })

async function served(serve: (options?: ServeOptions) => Promise<Served>, env = {}) {
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'toys.yaml'), TOYS)
  writeFileSync(join(included, 'toys.js'), CODE)
  // (A server with plugins knows its own address: the box is served at it.)
  const port = await freePort()
  return serve({
    port,
    env: {
      LUMOVI_URL: `http://127.0.0.1:${port}`,
      LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included,
      ...env,
    },
  })
}

test('a server hands no browser a plugin’s code before its check, and says why', async ({
  page,
  serve,
}) => {
  const server = await served(serve)
  await signIn(page, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
  // Held to Lumovi's own page, but not checked: not handed, and nothing of the code crosses.
  expect(await kube(page)).toEqual({
    code: { ok: false, refused: 'not-checked' },
    whether: 'not-checked',
  })
  // Where its page would be.
  await page.waitForFunction(() => '__lumoviDoor' in window)
  await page.evaluate(() =>
    (window as unknown as { __lumoviDoor: { show(shown: object): void } }).__lumoviDoor.show({
      plugin: 'toys',
      name: 'Toys',
      version: '1.2.0',
      context: 'demo',
    }),
  )
  const ended = page.getByTestId('plugin-ended')
  await expect(ended).toHaveAttribute('data-why', 'not-handed')
  await expect(ended.getByRole('heading')).toHaveText('Toys’ page couldn’t start.')
  await expect(ended).toContainText(
    'Lumovi hasn’t checked that this browser keeps a plugin’s code apart from Lumovi’s own page, so it doesn’t run it here.',
  )
  await expect(ended.getByRole('button', { name: 'Open it again' })).toHaveCount(0)
  // And on the Plugins page, in its entry.
  await page.evaluate(() =>
    (window as unknown as { __lumoviDoor: { hide(): void } }).__lumoviDoor.hide(),
  )
  await page.goto(`${server.url}cluster/demo/plugins?plugin=toys`)
  await expect(page.getByTestId('plugin-not-handed')).toHaveText(
    'Its pages don’t run here: Lumovi hasn’t checked that this browser keeps a plugin’s code apart from Lumovi’s own page, so it doesn’t run it here.',
  )
  // Nothing was handed, so nothing of it is in the history.
  expect(audited(server, 'plugin.code')).toEqual([])
})

test('where the second wall doesn’t hold, a server says so: it doesn’t offer plugins that run code', async ({
  page,
  serve,
}) => {
  const server = await served(serve, { LUMOVI_SEC_FETCH_SITE: 'off' })
  await signIn(page, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
  expect(await kube(page)).toEqual({
    code: { ok: false, refused: 'not-held' },
    whether: 'not-held',
  })
  await page.goto(`${server.url}cluster/demo/plugins?plugin=toys`)
  await expect(page.getByTestId('plugin-not-handed')).toHaveText(
    'Its pages don’t run here: this server doesn’t offer plugins that run code to this browser.',
  )
})

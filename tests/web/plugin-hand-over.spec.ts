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

test('a server hands a browser a plugin’s code only once its check has passed, and says why until then', async ({
  page,
  serve,
}) => {
  const server = await served(serve)
  await signIn(page, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
  // Held to Lumovi's own page, but not checked yet: not handed, and nothing of the code crosses.
  expect(await kube(page)).toEqual({
    code: { ok: false, refused: 'not-checked' },
    whether: 'not-checked',
  })
  // The Plugins page says so, in its entry (and checks nothing itself).
  await page.goto(`${server.url}cluster/demo/plugins?plugin=toys`)
  await expect(page.getByTestId('plugin-not-handed')).toHaveText(
    'Its pages don’t run here: Lumovi hasn’t checked that this browser keeps a plugin’s code apart from Lumovi’s own page, so it doesn’t run it here.',
  )
  expect(audited(server, 'plugin.box-check')).toEqual([])
  // Its page: this browser's box is checked first, it passes, and the code is handed over.
  await page.waitForFunction(() => '__lumoviDoor' in window)
  await page.evaluate(() =>
    (window as unknown as { __lumoviDoor: { show(shown: object): void } }).__lumoviDoor.show({
      plugin: 'toys',
      name: 'Toys',
      version: '1.2.0',
      context: 'demo',
    }),
  )
  await expect
    .poll(() => audited(server, 'plugin.code').map((event) => event.summary))
    .toEqual(['Handed the plugin toys’ code to this browser'])
  await expect(page.getByTestId('plugin-ended')).toHaveCount(0)
  expect(
    audited(server, 'plugin.box-check').map((event) => [event.summary, event.outcome]),
  ).toEqual([['Lumovi checked this browser: a plugin’s code stays in its box', 'success']])
  expect(await kube(page)).toMatchObject({ code: { ok: true }, whether: true })
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

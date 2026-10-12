/**
 * A plugin's page on a server, reading through the door: its code handed over once Lumovi's check
 * of this browser's box has passed; its asks go to the server, which reads what the plugin's file
 * grants; what comes back is handed to its code with a token for each object. (Every way a read
 * goes is tried on the desktop, in tests/e2e/plugin-page-reads.)
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { READ_REFUSED } from '../../src/shared/plugin-reads.ts'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { audited, DEMO_TOKEN, expect, freePort, signIn, test } from './fixtures.ts'

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

/** It asks for every Widget and for Nodes, and shows what each read comes to in a Field. */
const CODE = `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  commit([['make', 1, 'Stack', {}], ['put', 0, 1]])
  const fields = new Map()
  let next = 10
  listen((text) => {
    const said = JSON.parse(text)
    const value = said.objects
      ? said.objects.map((o) => o.object.metadata.name + '=' + o.token).join(' ')
      : 'ended ' + said.ended + ': ' + said.said
    const props = { name: 'read ' + said.read, value }
    if (fields.has(said.read)) return commit([['change', fields.get(said.read), props]])
    fields.set(said.read, next)
    commit([['make', next, 'Field', props], ['put', 1, next++]])
  })
  post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Widget' }))
  post(JSON.stringify({ read: 2, what: 'list', kind: '/Node' }))
})`

test('a plugin’s page on a server reads what its file grants, each object handed with a token', async ({
  page,
  serve,
}) => {
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'toys.yaml'), TOYS)
  // Its code beside its file, as Lumovi's own carry theirs: handed over only as Lumovi says.
  writeFileSync(join(included, 'toys.js'), CODE)
  // (A server with plugins knows its own address: the box is served at it.)
  const port = await freePort()
  const served = await serve({
    port,
    env: { LUMOVI_URL: `http://127.0.0.1:${port}`, LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included },
  })
  await signIn(page, `${served.url}cluster/demo/pods`, DEMO_TOKEN)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  await page.evaluate(() =>
    (window as unknown as { __lumoviDoor: { show(shown: object): void } }).__lumoviDoor.show({
      plugin: 'toys',
      name: 'Toys',
      version: '1.2.0',
      context: 'demo',
    }),
  )
  const field = (read: number) =>
    page.locator('[data-part="Field"]').filter({ hasText: `read ${read}` })
  await expect(field(1)).toContainText(new RegExp(`${CUSTOM.widget}=[A-Za-z0-9_-]{24}`))
  await expect(field(2)).toContainText(`ended not-granted: ${READ_REFUSED['not-granted']}`)
  await expect(page.getByTestId('plugin-ended')).toHaveCount(0)
  // Each read in the history, as the server made it for the plugin. (The two were asked at once:
  // in whichever order they were made.)
  await expect
    .poll(() =>
      audited(served, 'plugin.read')
        .map((event) => `${event.summary}: ${event.outcome}`)
        .sort(),
    )
    .toEqual([
      'Read Nodes for the plugin toys: refused',
      'Read Widgets for the plugin toys: success',
    ])
  // What they rest on: the check of this browser's box passed, and then its code was handed over.
  expect(
    audited(served, 'plugin.box-check').map((event) => [event.summary, event.outcome]),
  ).toEqual([['Lumovi checked this browser: a plugin’s code stays in its box', 'success']])
  expect(audited(served, 'plugin.code').map((event) => event.summary)).toEqual([
    'Handed the plugin toys’ code to this browser',
  ])
})

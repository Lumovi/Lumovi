/**
 * What the desktop app's main process reads for a plugin's page: what the plugin's file grants
 * and nothing more, picked there; a refusal as a code. (The server's, and the audit history,
 * in tests/web/plugin-read.spec.ts: the handler is one.)
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { PluginRead, PluginReadQuery } from '../../src/shared/plugin-reads.ts'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { expect, test } from './fixtures.ts'

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

const read = (page: Page, query: Omit<PluginReadQuery, 'context'>) =>
  page.evaluate(
    (q) =>
      (
        window as unknown as {
          lumovi: { kube: { pluginRead(q: PluginReadQuery): Promise<PluginRead> } }
        }
      ).lumovi.kube.pluginRead({ context: 'demo', ...q }),
    query,
  )

test('the main process reads for a plugin’s page what its file grants, and nothing it doesn’t', async ({
  launch,
}) => {
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'toys.yaml'), TOYS)
  const { page, userDataDir } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included },
  })
  const one = await read(page, {
    plugin: 'toys',
    kind: 'example.com/Widget',
    namespace: 'default',
    name: CUSTOM.widget,
  })
  expect(one).toMatchObject({
    ok: true,
    answer: {
      kind: 'Widget.example.com',
      objects: [{ namespace: 'default', name: CUSTOM.widget }],
    },
  })
  expect(JSON.stringify(one)).not.toContain('managedFields')
  expect(await read(page, { plugin: 'toys', kind: '/Node' })).toEqual({
    ok: false,
    refused: 'not-granted',
  })
  // One of the person's own files can't carry code: it reads nothing, whatever it claims.
  const own = join(userDataDir, 'plugins')
  mkdirSync(own, { recursive: true })
  writeFileSync(join(own, 'board.yaml'), TOYS.replace('name: toys', 'name: board'))
  expect(await read(page, { plugin: 'board', kind: 'example.com/Widget' })).toEqual({
    ok: false,
    refused: 'not-in-use',
  })
  // Nor by the name of one of Lumovi's own: in its place, it's the person's file that's in use.
  writeFileSync(join(own, 'toys.yaml'), TOYS.replace(/^ {2}pages:.*\n/m, ''))
  expect(await read(page, { plugin: 'toys', kind: 'example.com/Widget' })).toEqual({
    ok: false,
    refused: 'not-in-use',
  })
})

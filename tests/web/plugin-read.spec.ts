/**
 * What a server reads for a plugin's page: what the plugin's file grants and nothing more,
 * picked on the server; a refusal as a code; each read in the audit history with the plugin's
 * name, version and digest.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { PluginRead, PluginReadQuery } from '../../src/shared/plugin-reads.ts'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { audited, DEMO_TOKEN, expect, signIn, test } from './fixtures.ts'

/** A stand-in for one of Lumovi's own: its code may read Widgets, its own kind. */
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

test('a server reads for a plugin’s page what its file grants, and nothing it doesn’t', async ({
  page,
  serve,
}) => {
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'toys.yaml'), TOYS)
  // A file of the server's folder can't carry code: it reads nothing, whatever it claims.
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-plugins-'))
  writeFileSync(join(folder, 'board.yaml'), TOYS.replace('name: toys', 'name: board'))
  const served = await serve({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included, LUMOVI_PLUGINS_DIR: folder },
  })
  await signIn(page, served.url, DEMO_TOKEN)

  // Its own kind, whole: every Widget it may see, and one of them.
  const all = await read(page, { plugin: 'toys', kind: 'example.com/Widget' })
  expect(all.ok && all.answer.kind).toBe('Widget.example.com')
  const widgets = all.ok ? all.answer.objects : []
  expect(widgets.map(({ namespace, name }) => `${namespace}/${name}`)).toContain(
    `default/${CUSTOM.widget}`,
  )
  const one = await read(page, {
    plugin: 'toys',
    kind: 'example.com/Widget',
    namespace: 'default',
    name: CUSTOM.widget,
  })
  expect(one).toMatchObject({
    ok: true,
    answer: { objects: [{ namespace: 'default', name: CUSTOM.widget }] },
  })
  // Who manages which field never comes with it.
  expect(JSON.stringify(one)).not.toContain('managedFields')

  // What isn't granted; what isn't there; what isn't a plugin whose code runs.
  for (const [query, refused] of [
    [{ plugin: 'toys', kind: '/Node' }, 'not-granted'],
    [{ plugin: 'toys', kind: '/Secret', namespace: 'default' }, 'not-granted'],
    [{ plugin: 'toys', kind: 'core/Secret' }, 'no-such-kind'],
    [{ plugin: 'toys', kind: 'example.com/Widget', name: CUSTOM.widget }, 'needs-namespace'],
    [
      { plugin: 'toys', kind: 'example.com/Widget', namespace: 'default', name: 'nowhere' },
      'not-found',
    ],
    [{ plugin: 'board', kind: 'example.com/Widget' }, 'not-in-use'],
    [{ plugin: 'nobody', kind: 'example.com/Widget' }, 'not-in-use'],
    // A name no plugin could have: no read at all, and nothing of it in the history.
    [{ plugin: 'toys\u202Eevil', kind: 'example.com/Widget' }, 'failed'],
  ] as const) {
    expect(await read(page, query), JSON.stringify(query)).toEqual({ ok: false, refused })
  }

  // In the history: who read, as what plugin (as the server read its file, never as the page
  // said), and what came of it.
  const digest = `sha256:${createHash('sha256').update(TOYS).digest('hex')}`
  await expect
    .poll(() =>
      audited(served, 'plugin.read').map((event) => [
        event.summary,
        event.outcome,
        event.details?.pluginDigest ?? null,
      ]),
    )
    .toEqual([
      ['Read Widgets for the plugin toys', 'success', digest],
      [`Read Widget ${CUSTOM.widget} for the plugin toys`, 'success', digest],
      ['Read Nodes for the plugin toys', 'refused', digest],
      ['Read Secrets for the plugin toys', 'refused', digest],
      ['Read Secret.core for the plugin toys', 'failure', digest],
      [`Read Widget ${CUSTOM.widget} for the plugin toys`, 'failure', digest],
      ['Read Widget nowhere for the plugin toys', 'failure', digest],
      // (Plugins not in use: one entry a while, whatever they're called.)
      ['Read Widget.example.com for the plugin board', 'refused', null],
    ])
  expect(audited(served, 'plugin.read')[0]?.details?.pluginVersion).toBe('1.2.0')
})

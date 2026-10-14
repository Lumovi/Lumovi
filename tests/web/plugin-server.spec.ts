/**
 * A plugin's tool's own server asked on a server's page: as the person, with their access to
 * `services/proxy`, and in the audit log with the plugin's name and the path as listed.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { PluginServerAnswer, PluginServerQuery } from '../../src/shared/plugin-server.ts'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { STAND_IN } from '../mock-cluster/server.ts'
import { audited, DEMO_TOKEN, expect, signIn, test } from './fixtures.ts'

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
  server:
    service: { labels: { app.kubernetes.io/name: toys-api } }
    in: { group: example.com, kind: Widget }
    port: 8080
    paths: [/api/v1/status]
`
const CODE = 'box.then(() => {})\n'
const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`

const ask = (page: Page) =>
  page.evaluate(
    (q) =>
      (
        window as unknown as {
          lumovi: { kube: { pluginServer(q: PluginServerQuery): Promise<PluginServerAnswer> } }
        }
      ).lumovi.kube.pluginServer(q),
    {
      context: 'demo',
      plugin: 'toys',
      digest: sha(TOYS),
      codeDigest: sha(CODE),
      in: { kind: 'Widget.example.com', namespace: 'default', name: CUSTOM.widget },
      path: '/api/v1/status',
    } satisfies PluginServerQuery,
  )

test('a server asks a plugin’s tool’s server as the person, and only where they may reach it', async ({
  page,
  serve,
  clusters,
}) => {
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: 'toys-api',
      namespace: 'default',
      creationTimestamp: new Date().toISOString(),
      labels: { 'app.kubernetes.io/name': 'toys-api', [STAND_IN]: 'toys-api' },
    },
    spec: { ports: [{ name: 'http', port: 8080 }] },
  })
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'toys.yaml'), TOYS)
  writeFileSync(join(included, 'toys.js'), CODE)
  const served = await serve({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included } })
  await signIn(page, served.url, DEMO_TOKEN)

  // Found by its labels, asked by its port's number.
  expect(await ask(page)).toEqual({ ok: true, json: { healthy: true, widgets: 1 } })
  // Their RBAC doesn't give them services/proxy there: Lumovi says what it takes.
  clusters.demo.deny({ verb: 'get', resource: 'services', subresource: 'proxy' })
  expect(await ask(page)).toEqual({
    ok: false,
    refused: 'not-allowed',
    said: 'You may not reach toys-api in default: it takes get on services/proxy.',
  })
  await expect
    .poll(() =>
      audited(served, 'plugin.server').map((event) => [
        event.summary,
        event.outcome,
        event.details?.plugin,
      ]),
    )
    // (One entry: the ask that was made. The same ask again, refused, wasn't a read, and an ask
    // that was made is in the history as made.)
    .toEqual([
      [
        'Asked the Service toys-api in default for /api/v1/status, for the plugin Toys’ page',
        'success',
        'toys',
      ],
    ])
})

/**
 * A pod's logs a server reads for a plugin's code (`spec.logs: read`): only for a plugin whose
 * file says so and reads Pods, as the person, once; in the audit history with the plugin's name.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { PluginLogs, PluginLogsQuery } from '../../src/shared/plugin-reads.ts'
import { as } from './fleet.ts'
import { audited, DEMO, DEMO_TOKEN, expect, signIn, test } from './fixtures.ts'

/** A plugin of a group of its own (two plugins never claim one kind). */
const toys = (name: string, logs: string) => `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: ${name} }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [${name}.example.com]
  label: Toys
  kinds: [{ group: ${name}.example.com, kind: Widget }]
  reads: [{ group: '', kind: Pod, fields: [metadata.name] }]
  pages: [{ id: overview, title: Overview }]
  logs: ${logs}
`
const CODE = 'box.then(() => {})\n'
const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`
const POD = DEMO.pods.storefront[0]!

const logs = (page: Page, query: PluginLogsQuery) =>
  page.evaluate(
    (q) =>
      (
        window as unknown as {
          lumovi: { kube: { pluginLogs(q: PluginLogsQuery): Promise<PluginLogs> } }
        }
      ).lumovi.kube.pluginLogs(q),
    query,
  )

test('a server reads a pod’s logs for a plugin’s code only where its file says so, and records it', async ({
  page,
  serve,
}) => {
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'toys.yaml'), toys('toys', 'read'))
  writeFileSync(join(included, 'toys.js'), CODE)
  writeFileSync(join(included, 'shows.yaml'), toys('shows', 'shown'))
  writeFileSync(join(included, 'shows.js'), CODE)
  const served = await serve({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included } })
  await signIn(page, served.url, DEMO_TOKEN)
  const ask = {
    context: 'demo',
    namespace: 'shop',
    pod: POD,
    container: 'envoy',
    tail: 3,
    codeDigest: sha(CODE),
  }

  const read = await logs(page, { ...ask, plugin: 'toys', digest: sha(toys('toys', 'read')) })
  expect(read.ok && read.lines.length).toBe(3)
  expect(read.ok && read.lines.every(({ time }) => time !== undefined)).toBe(true)
  // A plugin whose pages show logs: its code reads none.
  expect(
    await logs(page, { ...ask, plugin: 'shows', digest: sha(toys('shows', 'shown')) }),
  ).toEqual({ ok: false, refused: 'not-granted' })

  await expect
    .poll(() => audited(served, 'logs.read').map((event) => [event.summary, event.outcome]))
    .toEqual([
      [`Read the logs of Pod ${POD} (envoy), for the plugin Toys’ code`, 'success'],
      [`Read the logs of Pod ${POD} (envoy), for the plugin Toys’ code`, 'refused'],
    ])
  expect(audited(served, 'logs.read')[1]?.details).toMatchObject({
    plugin: 'shows',
    refused: 'not-granted',
  })
})

/** Everyone reads logs, but none of shop's: a limit holds them back. */
const ACCESS = `
everyone: { changes: read, shells: off, nodeShells: off, logs: on, secrets: keys, helm: off, assistants: off, audit: own }
limits:
  - { id: shop, name: Shop’s logs stay put, namespaces: [shop], caps: { logs: off } }
`

test('a person whose access doesn’t let them read a pod’s logs reads none of them for a plugin’s code either', async ({
  page,
  context,
  serve,
}) => {
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'toys.yaml'), toys('toys', 'read'))
  writeFileSync(join(included, 'toys.js'), CODE)
  const served = await serve({
    env: {
      LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included,
      LUMOVI_AUTH: 'proxy',
      LUMOVI_ACCESS: ACCESS,
    },
  })
  await as(context, 'dave@example.com')
  await page.goto(served.url)
  const ask = {
    context: 'demo',
    plugin: 'toys',
    digest: sha(toys('toys', 'read')),
    codeDigest: sha(CODE),
    container: 'envoy',
  }
  // Shop's are held back; another namespace's are theirs.
  expect(await logs(page, { ...ask, namespace: 'shop', pod: POD })).toEqual({
    ok: false,
    refused: 'not-allowed',
  })
  const coredns = await logs(page, {
    ...ask,
    namespace: 'kube-system',
    pod: DEMO.pods.coredns[0]!,
    container: 'coredns',
  })
  expect(coredns.ok).toBe(true)
  await expect
    .poll(() =>
      audited(served, 'logs.read').map((event) => [event.target?.namespace, event.outcome]),
    )
    .toEqual([
      ['shop', 'refused'],
      ['kube-system', 'success'],
    ])
})

/**
 * A Secret's value pressed on a plugin's page, as a server reads it: the person's read, for that
 * plugin as the server knows it, of keys its file says its pages show and no other; in the
 * history with the plugin, counted apart from a read on the Secret's own page. (Whether a value
 * crossed is said yes or no: never the value.)
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { Result, SecretValues, SecretValuesQuery } from '../../src/shared/api.ts'
import { SECRET_KEYS_UNDECLARED } from '../../src/backend/plugin-reads.ts'
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
  showsSecrets:
    - { group: example.com, kind: Widget, path: spec.secretName, keys: [tls.crt] }
`

/** Reads some of a Secret's values, and says only whether any crossed. */
const read = (page: Page, query: Omit<SecretValuesQuery, 'context'>) =>
  page.evaluate(async (q) => {
    const result = await (
      window as unknown as {
        lumovi: { kube: { secretValues(q: SecretValuesQuery): Promise<Result<SecretValues>> } }
      }
    ).lumovi.kube.secretValues({ context: 'demo', ...q })
    return result.ok
      ? { ok: true, keys: result.data.values.map(([key, value]) => [key, value !== '']) }
      : { ok: false, code: result.error.code, message: result.error.message }
  }, query)

test('a Secret pressed on a plugin’s page is read for that plugin, of the keys its file declares alone', async ({
  page,
  serve,
  clusters,
}) => {
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'toys.yaml'), TOYS)
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'shop-tls', namespace: 'default', uid: 'shop-tls-uid' },
    type: 'kubernetes.io/tls',
    data: {
      'tls.crt': Buffer.from('a').toString('base64'),
      'tls.key': Buffer.from('b').toString('base64'),
    },
  })
  const served = await serve({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included } })
  await signIn(page, `${served.url}cluster/demo`, DEMO_TOKEN)
  const secret = { namespace: 'default', name: 'shop-tls' }

  // A key its file says its pages show: read, as the person.
  expect(await read(page, { ...secret, keys: ['tls.crt'], forPlugin: 'toys' })).toEqual({
    ok: true,
    keys: [['tls.crt', true]],
  })
  // Any other: refused, and nothing of it read.
  expect(await read(page, { ...secret, keys: ['tls.key'], forPlugin: 'toys' })).toEqual({
    ok: false,
    code: 'not-allowed',
    message: SECRET_KEYS_UNDECLARED,
  })
  expect(
    await read(page, { ...secret, keys: ['tls.crt', 'tls.key'], forPlugin: 'toys' }),
  ).toMatchObject({
    ok: false,
    code: 'not-allowed',
  })
  // A plugin not in use, and a name no plugin could have: no read of anyone's, and none recorded.
  expect(await read(page, { ...secret, keys: ['tls.crt'], forPlugin: 'nobody' })).toMatchObject({
    ok: false,
    code: 'not-allowed',
  })
  expect(
    await read(page, { ...secret, keys: ['tls.crt'], forPlugin: 'toys\nforged' }),
  ).toMatchObject({
    ok: false,
    code: 'invalid',
  })
  // The person's own read on the Secret's own page: counted by itself.
  expect(await read(page, { ...secret, keys: ['tls.crt'] })).toMatchObject({ ok: true })

  await expect
    .poll(() =>
      audited(served, 'secret.read').map((event) => [
        event.summary,
        event.outcome,
        event.details?.plugin ?? null,
        event.details?.keys ?? null,
      ]),
    )
    .toEqual([
      ['Read 1 key of Secret shop-tls for the plugin toys', 'success', 'toys', ['tls.crt']],
      ['Read 0 keys of Secret shop-tls for the plugin toys', 'refused', 'toys', null],
      ['Read 1 key of Secret shop-tls', 'success', null, ['tls.crt']],
    ])
  const [first] = audited(served, 'secret.read')
  expect(first?.details?.pluginVersion).toBe('1.2.0')
  expect(String(first?.details?.pluginDigest)).toMatch(/^sha256:[0-9a-f]{64}$/)
})

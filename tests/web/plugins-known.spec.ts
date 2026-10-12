/**
 * Lumovi's own plugins as a built server knows them: every one of the release its lock pins, by
 * the digests that release's index has for its files. Asked as a page of each would ask, with a
 * Secret read made for it: one the server doesn't know is refused as not in use, and nothing is
 * recorded; one it knows is weighed against the plugin as it knows it, and the history names
 * that plugin, its version and its digest. (No Secret is read: none is named.)
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Result, SecretValues, SecretValuesQuery } from '../../src/shared/api.ts'
import { SECRET_KEYS_UNDECLARED } from '../../src/backend/plugin-reads.ts'
import { READ_REFUSED } from '../../src/shared/plugin-reads.ts'
import {
  cacheEntry,
  readLock,
  releaseFiles,
  takePlugins,
  trust,
} from '../../scripts/plugins-bundle.ts'
import { audited, DEMO_TOKEN, expect, signIn, test } from './fixtures.ts'

interface Index {
  plugins: { name: string; version: string; files: { path: string; sha256: string }[] }[]
}

test('a built server knows every plugin of the release Lumovi is built with, by its index’s digests', async ({
  page,
  serve,
}) => {
  // (The build's own copy, from the cache it kept, checked again: a checkout that hasn't built
  // yet downloads the release once and checks it as the build does.)
  test.setTimeout(120_000)
  const lock = readLock()
  await takePlugins(lock, trust())
  const index = JSON.parse(
    readFileSync(join(cacheEntry(lock), releaseFiles(lock.version).index), 'utf8'),
  ) as Index
  const digests = (plugin: Index['plugins'][number]) => {
    const of = (path: string) => plugin.files.find((file) => file.path === path)?.sha256
    return {
      digest: `sha256:${of('plugin.yaml')}`,
      codeDigest: of('plugin.js') && `sha256:${of('plugin.js')}`,
    }
  }
  expect(index.plugins.length).toBeGreaterThan(0)

  const served = await serve()
  await signIn(page, `${served.url}cluster/demo`, DEMO_TOKEN)
  for (const plugin of index.plugins) {
    const asked: Omit<SecretValuesQuery, 'context'> = {
      namespace: 'default',
      name: 'nothing-named',
      keys: ['key'],
      forPlugin: plugin.name,
      namedBy: { kind: 'Secret', name: 'nothing-named', path: 'metadata.name' },
      ...digests(plugin),
    }
    const answer = await page.evaluate(async (q) => {
      const result = await (
        window as unknown as {
          lumovi: { kube: { secretValues(q: SecretValuesQuery): Promise<Result<SecretValues>> } }
        }
      ).lumovi.kube.secretValues({ context: 'demo', ...q })
      return result.ok ? 'read' : result.error.message
    }, asked)
    // Known, so weighed: against the code its page was handed, where it has code (and then
    // against what its file says its pages show); and with none, as a page handed none.
    expect(answer, plugin.name).toBe(
      digests(plugin).codeDigest ? SECRET_KEYS_UNDECLARED : READ_REFUSED.changed,
    )
  }
  // Each one, as the server knows it: of Lumovi's own, from that release.
  await expect
    .poll(() =>
      audited(served, 'secret.read')
        .map((event) => [
          event.details?.plugin,
          event.details?.pluginVersion,
          event.details?.pluginDigest,
        ])
        .sort(),
    )
    .toEqual(
      index.plugins.map((plugin) => [plugin.name, plugin.version, digests(plugin).digest]).sort(),
    )
})

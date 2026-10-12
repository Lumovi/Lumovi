/**
 * The plugins Lumovi has, as its backend knows them: read as the page reads them, each with its
 * origin and the digest of its file. Plain functions on the real plugins folder: nothing is
 * built or launched.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { mayCarryCode, type PluginFile } from '../../src/shared/plugin-loading.ts'
import { knownPlugins, readIncluded } from '../../src/shared/plugins-known.ts'
import {
  includedPlugins,
  loadShippedPlugins,
  lumovisOwnKinds,
} from '../../src/renderer/src/lib/plugins.ts'

const PLUGINS = 'plugins'
const OWN = 'src/renderer/src/views'
const yamlOf = (folder: string) =>
  readdirSync(folder)
    .filter((name) => name.endsWith('.yaml'))
    .sort()
const texts = (folder: string) =>
  Object.fromEntries(
    yamlOf(folder).map((name) => [`${folder}/${name}`, readFileSync(join(folder, name), 'utf8')]),
  )
const sha = (bytes: Uint8Array | string) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const LUMOVI = '99.0.0'

test('Lumovi’s own plugins read for the backend are exactly the ones the page reads', () => {
  const included = readIncluded(texts(PLUGINS), texts(OWN))
  const pages = loadShippedPlugins(texts(PLUGINS), texts(OWN))
  expect(included.problems).toEqual(pages)
  expect(included.problems).toEqual([])
  expect(included.ownKinds).toEqual([...lumovisOwnKinds()])
  const told = (plugin: { name: string; version: string; views: { kinds: string[] }[] }) => ({
    name: plugin.name,
    version: plugin.version,
    kinds: plugin.views.flatMap((view) => view.kinds),
  })
  expect(included.plugins.map(({ plugin }) => told(plugin))).toEqual(includedPlugins().map(told))
  expect(included.plugins).toHaveLength(yamlOf(PLUGINS).length)
})

test('a digest is what `shasum -a 256` gives for the file: of its bytes', () => {
  // Lumovi's own are built in as text: each one's bytes are its text as UTF-8, with nothing a
  // build would change (no mark at its start, no line end but a plain one), so what a build
  // carries for it is the digest of the file in the repository.
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  for (const name of yamlOf(PLUGINS)) {
    const bytes = readFileSync(join(PLUGINS, name))
    const text = utf8.decode(bytes)
    expect(Buffer.from(text, 'utf8').equals(bytes), name).toBe(true)
    expect(text.startsWith('﻿') || text.includes('\r'), name).toBe(false)
  }
  const included = readIncluded(texts(PLUGINS), texts(OWN))
  const known = knownPlugins(included, [], 'yours', LUMOVI, (text) => sha(text))
  expect(known).toHaveLength(yamlOf(PLUGINS).length)
  for (const plugin of known) {
    expect(plugin.origin).toBe('lumovi')
    expect(plugin.digest).toBe(sha(readFileSync(join(PLUGINS, plugin.file))))
    expect(plugin.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  }
  // One a name, in the order of their names.
  const names = known.map(({ name }) => name)
  expect(names).toEqual([...new Set(names)].sort())
})

test('a folder’s file in the place of one of Lumovi’s is that plugin: by its own origin and digest', () => {
  const included = readIncluded(texts(PLUGINS), texts(OWN))
  const theirs = readFileSync(join(PLUGINS, 'cert-manager.yaml'), 'utf8').replace(
    /^(\s*version:\s*)\S+/m,
    '$17.7.7',
  )
  const file = (name: string, text: string): PluginFile & { digest: string } => ({
    name,
    text,
    digest: sha(text),
  })
  for (const origin of ['yours', 'server'] as const) {
    const known = knownPlugins(included, [file('mine.yaml', theirs)], origin, LUMOVI, sha)
    const named = known.filter(({ name }) => name === 'cert-manager')
    // Lumovi's own of that name isn't in the list at all: it isn't in use.
    expect(named).toEqual([
      { name: 'cert-manager', version: '7.7.7', origin, file: 'mine.yaml', digest: sha(theirs) },
    ])
    expect(mayCarryCode(named[0]!.origin)).toBe(false)
    expect(known).toHaveLength(yamlOf(PLUGINS).length)
  }
})

test('only a plugin in use is one Lumovi has: not a file refused, nor the second of a name', () => {
  const included = readIncluded(texts(PLUGINS), texts(OWN))
  const own = (name: string, group: string) => `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata:
  name: ${name}
spec:
  version: 1.0.0
  needs:
    lumovi: 1.0.0
  groups:
    - ${group}
  label: ${name}
  kinds:
    - { group: ${group}, kind: Widget }
  views:
    - name: ${name}-widgets
      kinds:
        - { group: ${group}, kind: Widget }
      columns:
        - { name: Size, path: .spec.size }
`
  const file = (name: string, text: string, error?: string) => ({
    name,
    text,
    ...(error ? { error } : { digest: sha(text) }),
  })
  const files = [
    file('a-widgets.yaml', own('widgets', 'widgets.example.io')),
    file('b-widgets-again.yaml', own('widgets', 'widgets.example.io')),
    file('c-broken.yaml', 'not: [a plugin'),
    file('d-unread.yaml', '', 'It isn’t UTF-8 text.'),
    file(
      'e-too-new.yaml',
      own('newer', 'newer.example.io').replace('lumovi: 1.0.0', 'lumovi: 100.0.0'),
    ),
  ]
  const known = knownPlugins(included, files, 'yours', LUMOVI, sha)
  const theirs = known.filter(({ origin }) => origin !== 'lumovi')
  expect(theirs.map(({ name, file }) => [name, file])).toEqual([['widgets', 'a-widgets.yaml']])
  expect(theirs[0]!.digest).toBe(sha(files[0]!.text))
  // Whatever order the files are handed in.
  expect(knownPlugins(included, [...files].reverse(), 'yours', LUMOVI, sha)).toEqual(known)
  // And every one of Lumovi's own is still there.
  expect(known.filter(({ origin }) => origin === 'lumovi')).toHaveLength(yamlOf(PLUGINS).length)
})

test('a folder’s file is read once: its text and its digest are of the same bytes, and what isn’t UTF-8 is refused', async () => {
  // (The build says whether it's the tests' own; here it's said by hand: not.)
  ;(globalThis as { LUMOVI_TEST_BUILD?: boolean }).LUMOVI_TEST_BUILD = false
  const { readFiles, readPlugins } = await import('../../src/backend/plugins.ts')
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-known-'))
  const good = Buffer.from('name: é\n# ﻿ kept as it is\r\n', 'utf8')
  writeFileSync(join(folder, 'a.yaml'), good)
  writeFileSync(join(folder, 'b.yaml'), Buffer.from([0x6e, 0x3a, 0x20, 0xff, 0xfe, 0x0a]))
  writeFileSync(
    join(folder, 'c.yaml'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('n: 1\n')]),
  )
  writeFileSync(join(folder, 'not-a-plugin.txt'), 'x')
  const read = await readFiles({ path: folder })
  expect(read.files).toEqual([
    { name: 'a.yaml', text: good.toString('utf8'), digest: sha(good) },
    { name: 'b.yaml', text: '', error: 'It isn’t UTF-8 text.' },
    // A mark at a file's start is part of its bytes, and so of its text and its digest.
    { name: 'c.yaml', text: '﻿n: 1\n', digest: sha(readFileSync(join(folder, 'c.yaml'))) },
  ])
  // The page gets what it always has: no digest goes to it.
  const page = await readPlugins({ path: folder, shown: '~/plugins' })
  expect(page).toEqual({
    directory: '~/plugins',
    files: read.files.map(({ name, text, error }) => ({ name, text, ...(error ? { error } : {}) })),
  })
  rmSync(folder, { recursive: true, force: true })
})

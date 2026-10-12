/**
 * The plugins Lumovi has, as its backend knows them: read as the page reads them, each with its
 * origin and the digest of its file. Plain functions on the real plugins folder: nothing is
 * built or launched.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { mayCarryCode, type PluginFile } from '../../src/shared/plugin-loading.ts'
import { knownPlugins, readIncluded, type KnownPlugin } from '../../src/shared/plugins-known.ts'
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
      {
        name: 'cert-manager',
        version: '7.7.7',
        origin,
        file: 'mine.yaml',
        digest: sha(theirs),
        // What its code may read: its own kinds, whole. (Of Kubernetes' own, nothing yet.)
        grant: {
          groups: ['cert-manager.io', 'acme.cert-manager.io'],
          own: [
            'cert-manager.io/Certificate',
            'cert-manager.io/CertificateRequest',
            'cert-manager.io/Issuer',
            'cert-manager.io/ClusterIssuer',
            'acme.cert-manager.io/Order',
            'acme.cert-manager.io/Challenge',
          ],
          reads: {},
        },
      },
    ])
    expect(mayCarryCode(named[0]!.origin)).toBe(false)
    expect(known).toHaveLength(yamlOf(PLUGINS).length)
  }
})

test('an answer can’t be changed by whoever asked: the next asker is told the same', () => {
  const included = readIncluded(texts(PLUGINS), texts(OWN))
  const theirs = readFileSync(join(PLUGINS, 'cert-manager.yaml'), 'utf8')
  const known = knownPlugins(
    included,
    [{ name: 'mine.yaml', text: theirs, digest: sha(theirs) }],
    'yours',
    LUMOVI,
    sha,
  )
  const mine = known.find(({ name }) => name === 'cert-manager')!
  expect(Object.isFrozen(known) && known.every((plugin) => Object.isFrozen(plugin))).toBe(true)
  // The origin is what `mayCarryCode` is asked with.
  expect(() => ((mine as { origin: string }).origin = 'lumovi')).toThrow()
  expect(() => (known as KnownPlugin[]).sort(() => -1)).toThrow()
  expect(() => ((known as KnownPlugin[]).length = 0)).toThrow()
  // Nor what its code may read.
  expect(() => (mine.grant.own as string[]).push('apps/Deployment')).toThrow()
  expect(() => ((mine.grant as { reads: object }).reads = { '/Pod': {} })).toThrow()
  expect(mine.origin).toBe('yours')
  // A file in use handed over without its digest isn't left out quietly.
  expect(() =>
    knownPlugins(included, [{ name: 'mine.yaml', text: theirs }], 'yours', LUMOVI, sha),
  ).toThrow('mine.yaml is in use and was handed over without its digest')
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
  // A name in the folder can be a link to anything. What isn't a plain file is refused before a
  // byte is read: a device that never ends, a folder, a pipe (and the open doesn't wait for a
  // pipe's other end: this returns).
  if (process.platform !== 'win32') {
    symlinkSync('/dev/zero', join(folder, 'd-endless.yaml'))
    symlinkSync(folder, join(folder, 'e-folder.yaml'))
    // (A pipe by its own name isn't taken for a file of the folder at all; a link to one is.)
    execFileSync('mkfifo', [join(folder, 'pipe.yaml')])
    execFileSync('mkfifo', [join(folder, 'a-pipe')])
    symlinkSync(join(folder, 'a-pipe'), join(folder, 'f-pipe.yaml'))
    symlinkSync(join(folder, 'nothing-there'), join(folder, 'g-nowhere.yaml'))
    const started = Date.now()
    const odd = (await readFiles({ path: folder })).files.filter(({ name }) => /^[d-g]-/.test(name))
    expect(Date.now() - started).toBeLessThan(4000)
    expect(odd.map(({ name, error, digest }) => [name, error?.replace(/:.*/, ''), digest])).toEqual(
      [
        ['d-endless.yaml', 'It isn’t a file.', undefined],
        ['e-folder.yaml', 'It isn’t a file.', undefined],
        ['f-pipe.yaml', 'It isn’t a file.', undefined],
        ['g-nowhere.yaml', 'It isn’t there', undefined],
      ],
    )
  }
  // A file that can't be opened: said by its name alone and in Lumovi's words, never the
  // system's (which carry the folder's whole path: they go to the log).
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    writeFileSync(join(folder, 'j-locked.yaml'), 'n: 1\n')
    chmodSync(join(folder, 'j-locked.yaml'), 0o000)
    const warned: string[] = []
    const warn = console.warn
    console.warn = (line: string) => warned.push(line)
    const closed = (await readFiles({ path: folder })).files.filter(({ name }) =>
      /^[gj]-/.test(name),
    )
    console.warn = warn
    expect(closed).toEqual([
      { name: 'g-nowhere.yaml', text: '', error: 'It isn’t there: a link to a file that’s gone.' },
      { name: 'j-locked.yaml', text: '', error: 'Lumovi isn’t allowed to read it.' },
    ])
    expect(JSON.stringify(closed)).not.toContain(folder)
    expect(warned.join('\n')).toContain(folder)
    chmodSync(join(folder, 'j-locked.yaml'), 0o600)
  }
  // A file over the limit is refused by its size; one of exactly the limit is read whole.
  writeFileSync(join(folder, 'h-large.yaml'), Buffer.alloc(256 * 1024 + 1, 0x61))
  writeFileSync(join(folder, 'i-full.yaml'), Buffer.alloc(256 * 1024, 0x61))
  const sized = (await readFiles({ path: folder })).files.filter(({ name }) => /^[hi]-/.test(name))
  expect(sized[0]).toEqual({ name: 'h-large.yaml', text: '', error: 'It’s larger than 256 KB.' })
  expect(sized[1]!.text).toHaveLength(256 * 1024)
  expect(sized[1]!.digest).toBe(sha(Buffer.alloc(256 * 1024, 0x61)))
  rmSync(folder, { recursive: true, force: true })
  delete (globalThis as { LUMOVI_TEST_BUILD?: boolean }).LUMOVI_TEST_BUILD
})

test('one of Lumovi’s own that adds pages is in use for the backend as for the page: it may carry code', () => {
  const toys = `apiVersion: lumovi.dev/v1beta1
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
  const included = readIncluded({ 'plugins/toys.yaml': toys }, texts(OWN))
  expect(included.problems).toEqual([])
  expect(included.plugins.map(({ plugin }) => plugin.added.pages)).toEqual([
    [{ id: 'overview', title: 'Overview' }],
  ])
  const [known] = knownPlugins(included, [], 'yours', LUMOVI, sha)
  expect(known).toMatchObject({ name: 'toys', origin: 'lumovi' })
  // A folder's file of its name is in its place: data, whatever it came to be. (One with pages
  // isn't a plugin at all there, and leaves Lumovi's own in use.)
  const data = toys.replace(/^ {2}pages:.*\n/m, '')
  for (const [text, origin] of [
    [data, 'yours'],
    [toys, 'lumovi'],
  ] as const) {
    const theirs = knownPlugins(
      included,
      [{ name: 'toys.yaml', text, digest: sha(text) }],
      'yours',
      LUMOVI,
      sha,
    )
    expect(theirs.find(({ name }) => name === 'toys')?.origin).toBe(origin)
  }
})

test('the folders’ files are marked without being read: a change of any of them changes the mark', async () => {
  ;(globalThis as { LUMOVI_TEST_BUILD?: boolean }).LUMOVI_TEST_BUILD = true
  const { filesMark } = await import('../../src/backend/plugins.ts')
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-mark-'))
  const included = mkdtempSync(join(tmpdir(), 'lumovi-mark-included-'))
  const env = { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included }
  writeFileSync(join(folder, 'a.yaml'), 'name: a\n')
  writeFileSync(join(included, 'toys.yaml'), 'name: toys\n')
  const marks = [await filesMark({ path: folder }, env)]
  // Looked at again with nothing changed: the same.
  expect(await filesMark({ path: folder }, env)).toBe(marks[0])
  const changes: (() => void)[] = [
    // The same size, other bytes.
    () => writeFileSync(join(folder, 'a.yaml'), 'name: b\n'),
    () => writeFileSync(join(folder, 'b.yml'), 'name: b\n'),
    () => rmSync(join(folder, 'b.yml')),
    // A link where a file was: what it leads to is what's marked.
    () => {
      writeFileSync(join(folder, 'target.txt'), 'name: c\n')
      rmSync(join(folder, 'a.yaml'))
      symlinkSync(join(folder, 'target.txt'), join(folder, 'a.yaml'))
    },
    () => writeFileSync(join(folder, 'target.txt'), 'name: d\n'),
    // The tests' stand-ins for Lumovi's own count too.
    () => writeFileSync(join(included, 'toys.yaml'), 'name: tots\n'),
  ]
  for (const change of changes) {
    change()
    const mark = await filesMark({ path: folder }, env)
    expect(mark, String(change)).not.toBe(marks.at(-1))
    marks.push(mark)
  }
  // (Taken away again, a file leaves the folder as it was before it came: so does its mark.)
  expect(marks[3]).toBe(marks[1])
  // What isn't a plugin's file isn't looked at.
  writeFileSync(join(folder, 'notes.txt'), 'x')
  expect(await filesMark({ path: folder }, env)).toBe(marks.at(-1))
  // And no folder at all is a mark too.
  expect(await filesMark({ path: join(folder, 'nowhere') })).toBe('[[]]')
  delete (globalThis as { LUMOVI_TEST_BUILD?: boolean }).LUMOVI_TEST_BUILD
})

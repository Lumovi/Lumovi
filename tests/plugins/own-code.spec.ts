/**
 * A person's own plugins with code (Developer mode, the desktop app's): each in a folder of its
 * own, named as it is; its code read only in Developer mode, and handed over only as what was
 * agreed to (src/main/plugins-agreed.ts). Plain functions: nothing is built or launched.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Recorded } from '../../src/backend/audit/recorder.ts'
import { mayHandOver, runsCode, type HandOverTo } from '../../src/backend/plugin-code.ts'
import { AgreedPlugins } from '../../src/main/plugins-agreed.ts'
import type { AgreedRecord, ManagedSettings } from '../../src/shared/api.ts'
import { offersPages, setOwnPlugins } from '../../src/renderer/src/lib/code-pages.ts'
import { folderOf, ownRefusal, settle } from '../../src/shared/plugin-loading.ts'
import { parsePlugin, type Plugin } from '../../src/shared/plugins.ts'
import { knownPlugins, readIncluded, type KnownPlugin } from '../../src/shared/plugins-known.ts'

const sha = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`
const TOYS = (more = '') => `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
  pages: [{ id: overview, title: Overview }]
${more}`
const CODE = 'box.then(() => {})\n'

test('a plugin of one’s own with code is in a folder of its own, named as it is: a file of the folder is data', () => {
  expect(folderOf('toys/plugin.yaml')).toBe('toys')
  for (const file of ['toys.yaml', 'toys/plugin.yml', 'a/toys/plugin.yaml', 'Toys/plugin.yaml']) {
    expect(folderOf(file), file).toBeUndefined()
  }
  const [inFolder] = settle([], [{ name: 'toys/plugin.yaml', text: TOYS() }], 'yours').files
  expect(inFolder).toMatchObject({ state: 'in-use', origin: 'yours' })
  expect(inFolder!.plugin!.added.pages).toEqual([{ id: 'overview', title: 'Overview' }])
  // A file of the folder itself: its pages are refused, as ever.
  expect(settle([], [{ name: 'toys.yaml', text: TOYS() }], 'yours').files[0]!.state).toBe(
    'not-in-use',
  )
  // A folder not named as its plugin.
  const misnamed = settle([], [{ name: 'games/plugin.yaml', text: TOYS() }], 'yours').files[0]!
  expect(misnamed.state).toBe('not-in-use')
  expect(misnamed.problems).toEqual([
    'games/plugin.yaml: the plugin is named toys, so its folder should be too',
  ])
  // A server's folder is its administrator's: data, whatever its folders hold.
  expect(settle([], [{ name: 'toys/plugin.yaml', text: TOYS() }], 'server').files[0]!.state).toBe(
    'not-in-use',
  )
})

test('only in Developer mode is a folder’s code read, and nothing else in it', async () => {
  ;(globalThis as { LUMOVI_TEST_BUILD?: boolean }).LUMOVI_TEST_BUILD = false
  const { filesMark, readFiles } = await import('../../src/backend/plugins.ts')
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-own-'))
  mkdirSync(join(folder, 'toys'))
  writeFileSync(join(folder, 'toys', 'plugin.yaml'), TOYS())
  writeFileSync(join(folder, 'toys', 'plugin.js'), CODE)
  writeFileSync(join(folder, 'toys', 'notes.txt'), 'not read')
  mkdirSync(join(folder, 'empty'))
  writeFileSync(join(folder, 'flat.yaml'), 'kind: Plugin\n')
  const names = (files: { name: string }[] | undefined) => files?.map(({ name }) => name)
  // A server's reading: the folder's files alone.
  expect(names((await readFiles({ path: folder })).files)).toEqual(['flat.yaml'])
  // The desktop's: each plugin's own folder too, and its code only in Developer mode.
  const off = await readFiles({ path: folder }, {}, { folders: true })
  expect(names(off.files)).toEqual(['flat.yaml', 'toys/plugin.yaml'])
  expect(off.code).toBeUndefined()
  const on = await readFiles({ path: folder }, {}, { folders: true, code: true })
  expect(on.code).toEqual([{ name: 'toys/plugin.js', text: CODE, digest: sha(CODE) }])
  // Its code changing changes the mark only where it's read.
  const mark = (code: boolean) => filesMark({ path: folder }, {}, { folders: true, code })
  const [before, beforeOff] = [await mark(true), await mark(false)]
  writeFileSync(join(folder, 'toys', 'plugin.js'), `${CODE}// changed\n`)
  expect(await mark(true)).not.toBe(before)
  expect(await mark(false)).toBe(beforeOff)
  delete (globalThis as { LUMOVI_TEST_BUILD?: boolean }).LUMOVI_TEST_BUILD
})

test('one of a person’s own carries its code where it was read: its digest, and what it asks', () => {
  const known = (codes: Record<string, string>) =>
    knownPlugins(
      readIncluded({}),
      [{ name: 'toys/plugin.yaml', text: TOYS(), digest: sha(TOYS()) }],
      'yours',
      '1.0.0',
      sha,
      codes,
    )[0]!
  const withCode = known({ 'toys/plugin.js': CODE })
  expect(withCode).toMatchObject({
    name: 'toys',
    origin: 'yours',
    code: CODE,
    codeDigest: sha(CODE),
  })
  expect(JSON.parse(withCode.asks!)).toMatchObject({ code: true })
  // Not in Developer mode: no code was read, and none is carried.
  const without = known({})
  expect(without.code).toBeUndefined()
  expect(without.asks).toBeUndefined()
})

const own = (also: Partial<KnownPlugin> = {}): KnownPlugin => ({
  name: 'toys',
  version: '1.0.0',
  origin: 'yours',
  file: 'toys/plugin.yaml',
  digest: sha(TOYS()),
  grant: { groups: [], own: [], reads: {} },
  code: CODE,
  codeDigest: sha(CODE),
  asks: '{"asks":1}',
  label: 'Toys',
  ...also,
})

function agreements(plugin: () => KnownPlugin) {
  let records: Record<string, AgreedRecord> = {}
  const recorded: Recorded[] = []
  const byLumovi: Recorded[] = []
  const agreed = new AgreedPlugins({
    records: () => records,
    keep: (next) => (records = next),
    known: async () => [plugin()],
    shown: (file) => `~/.lumovi/plugins/${file}`,
    audit: { record: (input) => void recorded.push(input) },
    byLumovi: (input) => void byLumovi.push(input),
    now: () => new Date('2026-10-13T12:00:00Z'),
  })
  return { agreed, recorded, byLumovi, records: () => records }
}

test('what was agreed is what runs: its code changed, or what it asks, and it waits again', async () => {
  let now = own()
  const { agreed, recorded, records } = agreements(() => now)
  expect(agreed.standing(now)).toBe('first')
  expect(await agreed.ownCode('toys')).toEqual({
    standing: 'first',
    asks: now.asks,
    code: now.codeDigest,
  })
  await agreed.agree('toys', now.asks, now.codeDigest)
  expect(agreed.standing(now)).toBe('agreed')
  expect(records().toys).toEqual({
    asks: now.asks,
    code: now.codeDigest,
    file: 'toys/plugin.yaml',
    at: '2026-10-13T12:00:00.000Z',
  })
  expect(recorded.at(-1)).toMatchObject({
    action: 'plugin.code-agreed',
    outcome: 'success',
    summary:
      'Agreed to run the code of the plugin Toys 1.0.0, from ~/.lumovi/plugins/toys/plugin.yaml',
    details: { plugin: 'toys', pluginVersion: '1.0.0', codeDigest: sha(CODE) },
  })
  expect(recorded.at(-1)!.details).not.toHaveProperty('changed')
  // Its code changed: one press. What it asks changed: asked again, against what was agreed.
  now = own({ code: `${CODE}//`, codeDigest: sha(`${CODE}//`) })
  expect(agreed.standing(now)).toBe('code')
  now = own({ asks: '{"asks":2}' })
  expect(agreed.standing(now)).toBe('asks')
  expect((await agreed.ownCode('toys'))!.agreed).toBe('{"asks":1}')
  // Agreed again: said what changed.
  await agreed.agree('toys', now.asks, now.codeDigest)
  expect(recorded.at(-1)!.details).toMatchObject({ changed: 'asks' })
  // Only what the person was shown, as Lumovi reads it now.
  await expect(agreed.agree('toys', '{"asks":1}', now.codeDigest)).rejects.toThrow(
    'It changed while its dialog was open. Open it again to see what it asks now.',
  )
  // Moved to another file: agreed to as a new one.
  expect(agreed.standing(own({ file: 'other/plugin.yaml' }))).toBe('first')
  // Not one of theirs with code: nothing to agree to.
  for (const name of ['nope', '__proto__', 7]) {
    await expect(agreed.agree(name, now.asks, now.codeDigest)).rejects.toThrow(
      'Lumovi runs no code of this plugin: it isn’t one of yours with code, or Developer mode is off.',
    )
  }
  expect(await agreed.ownCode('toys')).toMatchObject({ standing: 'agreed' })
})

test('a policy that keeps Developer mode off lets go of every agreement, and says so once', async () => {
  const { agreed, recorded, byLumovi, records } = agreements(() => own())
  await agreed.agree('toys', own().asks, own().codeDigest)
  const policy = (said: Partial<ManagedSettings>): ManagedSettings => ({
    source: 'p.json',
    ...said,
  })
  // Not by a policy that allows it, or by none.
  agreed.clearUnder(undefined)
  agreed.clearUnder(policy({ pluginProposalsOff: true }))
  expect(Object.keys(records())).toEqual(['toys'])
  agreed.clearUnder(policy({ pluginDeveloperModeOff: true }))
  expect(records()).toEqual({})
  // Said by Lumovi itself, not as the person.
  expect(recorded.map(({ outcome }) => outcome)).not.toContain('cancelled')
  expect(byLumovi.at(-1)).toMatchObject({
    action: 'plugin.code-agreed',
    outcome: 'cancelled',
    summary:
      'Let go of what you agreed to run of your own plugins’ code: your organization’s policy turns Developer mode off',
  })
  // Nothing more to let go of: nothing said.
  const said = byLumovi.length
  agreed.clearUnder(policy({ pluginCodeOff: true }))
  expect(byLumovi).toHaveLength(said)
  // Every way a policy keeps it off.
  for (const locks of [
    { pluginsOff: true },
    { pluginsBundledOnly: true },
    { pluginCodeOff: true },
  ] as const) {
    await agreed.agree('toys', own().asks, own().codeDigest)
    agreed.clearUnder(policy(locks))
    expect(records(), JSON.stringify(locks)).toEqual({})
  }
})

test('a person’s own plugin’s code is handed only on the desktop, as Developer mode and what they agreed to say', () => {
  const desktop = (answer?: true | 'developer-mode-off' | 'waiting-first'): HandOverTo => ({
    host: 'desktop',
    ...(answer === undefined ? {} : { own: () => answer }),
  })
  expect(mayHandOver(own(), desktop())).toBe('not-in-use')
  expect(mayHandOver(own(), desktop('developer-mode-off'))).toBe('developer-mode-off')
  expect(mayHandOver(own(), desktop('waiting-first'))).toBe('waiting-first')
  expect(mayHandOver(own(), desktop(true))).toBe(true)
  expect(mayHandOver(own(), { host: 'server', held: true, check: 'passed' })).toBe('not-in-use')
  // The person's own switch holds it as any.
  expect(mayHandOver(own(), { ...desktop(true), switches: { chosen: { toys: false } } })).toBe(
    'turned-off',
  )
  // What its code reads is held to the same.
  expect(runsCode(own(), desktop(true))).toBe(true)
  expect(runsCode(own(), desktop('waiting-first'))).toBe(false)
  expect(runsCode(own(), { host: 'server', held: true })).toBe(false)
  expect(runsCode(own({ origin: 'lumovi' }), desktop())).toBe(true)
})

test('one of a person’s own with a field this Lumovi can’t say what it asks is refused: no agreement could cover it', () => {
  const toys = parsePlugin(TOYS(), 'toys/plugin.yaml', { carriesCode: true }).plugin!
  expect(ownRefusal(toys)).toBeUndefined()
  expect(ownRefusal({ ...toys, canvas: { width: 100 } } as Plugin)).toBe(
    'this Lumovi can’t say all that it asks for (canvas), so it isn’t used',
  )
})

test('a release offers the pages of a person’s own plugins with code, as of Lumovi’s own: they open, to run once agreed', () => {
  // (Here, as in a release: not the tests' build, which offers every one.)
  setOwnPlugins([])
  expect(offersPages('toys')).toBe(false)
  setOwnPlugins(['toys'])
  expect(offersPages('toys')).toBe(true)
  expect(offersPages('gadgets')).toBe(false)
  setOwnPlugins([])
})

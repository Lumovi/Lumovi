/**
 * The hand-over: the one answer to whether a page may be handed a plugin's code, and the one call
 * that hands it. Plain functions: nothing is built or launched.
 */
import { expect, test } from '@playwright/test'
import type { Recorded } from '../../src/backend/audit/recorder.ts'
import { mayHandOver, pluginCodes, type HandOverTo } from '../../src/backend/plugin-code.ts'
import { notHandedLine, notHandedWhy } from '../../src/shared/plugin-hand-over.ts'
import type { KnownPlugin } from '../../src/shared/plugins-known.ts'

const FILE = `sha256:${'a'.repeat(64)}`
const CODE = `sha256:${'c'.repeat(64)}`
const plugin = (also: Partial<KnownPlugin> = {}): KnownPlugin => ({
  name: 'karpenter',
  version: '1.0.0',
  origin: 'lumovi',
  file: 'karpenter.yaml',
  digest: FILE,
  grant: { groups: [], own: [], reads: {} },
  code: 'box.then(() => {})',
  codeDigest: CODE,
  ...also,
})
const DESKTOP: HandOverTo = { host: 'desktop' }
const server = (held: boolean, check?: 'passed' | 'failed' | 'unfinished'): HandOverTo => ({
  host: 'server',
  held,
  ...(check ? { check } : {}),
})

test('code is handed only where every wall holds, and the first that doesn’t says why', () => {
  // The desktop: one of Lumovi's own, in use, with code.
  expect(mayHandOver(plugin(), DESKTOP)).toBe(true)
  // Not one Lumovi has, or one whose code it doesn't run (a folder's file is data).
  for (const origin of ['yours', 'server', 'installed'] as const) {
    expect(mayHandOver(plugin({ origin }), DESKTOP), origin).toBe('not-in-use')
  }
  expect(mayHandOver(undefined, DESKTOP)).toBe('not-in-use')
  // One with no code.
  expect(mayHandOver(plugin({ code: undefined, codeDigest: undefined }), DESKTOP)).toBe('no-code')
  // A server: the second wall, then the browser's check. Until there's a check, no browser has
  // passed it, so a server hands code to no one.
  expect(mayHandOver(plugin(), server(false))).toBe('not-held')
  expect(mayHandOver(plugin(), server(false, 'passed'))).toBe('not-held')
  expect(mayHandOver(plugin(), server(true))).toBe('not-checked')
  expect(mayHandOver(plugin(), server(true, 'failed'))).toBe('check-failed')
  expect(mayHandOver(plugin(), server(true, 'unfinished'))).toBe('check-unfinished')
  // (Unfinished because a look couldn't be made: no use checking again in this browser.)
  const unlooked = (check: 'unfinished' | 'failed'): HandOverTo => ({
    host: 'server',
    held: true,
    check,
    unlooked: true,
  })
  expect(mayHandOver(plugin(), unlooked('unfinished'))).toBe('check-unlooked')
  expect(mayHandOver(plugin(), unlooked('failed'))).toBe('check-failed')
  expect(mayHandOver(plugin(), server(true, 'passed'))).toBe(true)
  // Only those words, as a yes: anything else, or a place it doesn't know, is no.
  for (const to of [
    { host: 'server', held: 'yes', check: 'passed' },
    { host: 'server', held: true, check: true },
    { host: 'server', held: true, checked: true },
    { host: 'other' },
    { host: 'server' },
    {},
  ]) {
    expect(mayHandOver(plugin(), to as unknown as HandOverTo), JSON.stringify(to)).not.toBe(true)
  }
  // (What a plugin is comes before where it's asked for: a server says not-in-use first too.)
  expect(mayHandOver(plugin({ origin: 'server' }), server(false))).toBe('not-in-use')
})

test('the one call that hands code over: the code and its digests, recorded once; or why not', async () => {
  const records: Recorded[] = []
  let to: HandOverTo = DESKTOP
  const codes = pluginCodes({
    known: async () => [
      plugin(),
      plugin({ name: 'plain', code: undefined, codeDigest: undefined }),
    ],
    to: () => to,
    audit: { user: 'me', record: (input) => void records.push(input), read: () => undefined },
  })
  expect(await codes.code('karpenter')).toEqual({
    ok: true,
    code: 'box.then(() => {})',
    digest: FILE,
    codeDigest: CODE,
  })
  await codes.code('karpenter')
  // Once for this window, by the plugin and its digests.
  expect(records).toEqual([
    {
      action: 'plugin.code',
      outcome: 'success',
      target: { kind: 'Plugin', name: 'karpenter' },
      summary: 'Handed the plugin karpenter’s code to this window',
      details: {
        plugin: 'karpenter',
        pluginVersion: '1.0.0',
        pluginDigest: FILE,
        codeDigest: CODE,
      },
    },
  ])
  expect(await codes.whether('karpenter')).toBe(true)
  expect(await codes.code('plain')).toEqual({ ok: false, refused: 'no-code' })
  // What isn't a plugin's name names no plugin in use; nothing is recorded for a refusal.
  for (const name of ['nobody', 'Karpenter', 'a‮b', 7, undefined]) {
    expect(await codes.code(name), String(name)).toEqual({ ok: false, refused: 'not-in-use' })
  }
  // A server's browser that isn't checked: not handed, and the same said without the code.
  to = server(true)
  expect(await codes.code('karpenter')).toEqual({ ok: false, refused: 'not-checked' })
  expect(await codes.whether('karpenter')).toBe('not-checked')
  expect(records).toHaveLength(1)
  // A server's browser that is (once there's a check): handed, and said as a browser's.
  const browser = pluginCodes({
    known: async () => [plugin()],
    to: () => server(true, 'passed'),
    audit: { user: 'me', record: (input) => void records.push(input), read: () => undefined },
  })
  expect(await browser.code('karpenter')).toMatchObject({ ok: true })
  expect(records.at(-1)?.summary).toBe('Handed the plugin karpenter’s code to this browser')
})

test('what a person is told where code isn’t handed', () => {
  expect(notHandedWhy('not-held')).toBe(
    'This server doesn’t offer plugins that run code to this browser.',
  )
  expect(notHandedLine('not-held')).toBe(
    'Its pages don’t run here: this server doesn’t offer plugins that run code to this browser.',
  )
  expect(notHandedLine('not-checked')).toBe(
    'Its pages don’t run here: Lumovi hasn’t checked that this browser keeps a plugin’s code apart from Lumovi’s own page, so it doesn’t run it here.',
  )
  expect(notHandedLine('no-code')).toBe(
    'Its pages don’t run here: its code isn’t part of this Lumovi.',
  )
  expect(notHandedLine('check-failed')).toBe(
    'Its pages don’t run here: Lumovi’s check of this browser didn’t pass.',
  )
  expect(notHandedLine('check-unfinished')).toBe(
    'Its pages don’t run here yet: Lumovi’s check of this browser didn’t finish in time.',
  )
  expect(notHandedLine('check-unlooked')).toBe(
    'Its pages don’t run here: Lumovi couldn’t check this browser.',
  )
})

test('a switch that turns code off is asked before any browser: the organization’s, the server’s, then the person’s', () => {
  const on: HandOverTo = { host: 'desktop', switches: { chosen: {} } }
  expect(mayHandOver(plugin(), on)).toBe(true)
  // The person's own: off for this plugin, and only this one.
  const theirs = (chosen: Record<string, boolean>): HandOverTo => ({
    host: 'desktop',
    switches: { chosen },
  })
  expect(mayHandOver(plugin(), theirs({ karpenter: false }))).toBe('turned-off')
  expect(mayHandOver(plugin(), theirs({ 'argo-cd': false }))).toBe(true)
  expect(mayHandOver(plugin(), theirs({ karpenter: true }))).toBe(true)
  // A server's: none, or only those it names; ahead of the person's, and of the browser's check.
  const served = (only: string[], chosen = {}): HandOverTo => ({
    host: 'server',
    held: true,
    check: 'passed',
    switches: { serverOnly: only, chosen },
  })
  expect(mayHandOver(plugin(), served([]))).toBe('off-on-server')
  expect(mayHandOver(plugin(), served(['argo-cd']))).toBe('off-on-server-for-it')
  expect(mayHandOver(plugin(), served(['karpenter']))).toBe(true)
  expect(mayHandOver(plugin(), served(['karpenter'], { karpenter: false }))).toBe('turned-off')
  expect(mayHandOver(plugin(), served([], { karpenter: true }))).toBe('off-on-server')
  // Off by a switch, a browser that hasn't been checked is never asked about.
  expect(
    mayHandOver(plugin(), { host: 'server', held: true, switches: { serverOnly: [], chosen: {} } }),
  ).toBe('off-on-server')
  // The organization's policy: before all, whatever the person chose.
  expect(
    mayHandOver(plugin(), {
      host: 'desktop',
      switches: { policyOff: true, chosen: { karpenter: true } },
    }),
  ).toBe('off-by-policy')
  // (What the plugin is still comes first: none, or none with code, says so whatever's switched.)
  expect(mayHandOver(plugin({ code: undefined }), theirs({ karpenter: false }))).toBe('no-code')
  expect(mayHandOver(undefined, theirs({ karpenter: false }))).toBe('not-in-use')
})

test('what a person is told where a switch turned its code off', () => {
  expect(notHandedWhy('turned-off')).toBe('You turned off its code.')
  expect(notHandedLine('turned-off')).toBe('Its pages don’t run: you turned off its code.')
  expect(notHandedLine('off-on-server')).toBe(
    'Its pages don’t run here: this server doesn’t run plugins’ code.',
  )
  expect(notHandedLine('off-on-server-for-it')).toBe(
    'Its pages don’t run here: this server doesn’t run this plugin’s code.',
  )
  expect(notHandedLine('off-by-policy')).toBe(
    'Its pages don’t run: your organization’s policy doesn’t let plugins run code.',
  )
})

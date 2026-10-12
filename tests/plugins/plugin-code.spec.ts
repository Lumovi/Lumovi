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
const server = (held: boolean, checked: boolean): HandOverTo => ({ host: 'server', held, checked })

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
  expect(mayHandOver(plugin(), server(false, false))).toBe('not-held')
  expect(mayHandOver(plugin(), server(false, true))).toBe('not-held')
  expect(mayHandOver(plugin(), server(true, false))).toBe('not-checked')
  expect(mayHandOver(plugin(), server(true, true))).toBe(true)
  // (What a plugin is comes before where it's asked for: a server says not-in-use first too.)
  expect(mayHandOver(plugin({ origin: 'server' }), server(false, false))).toBe('not-in-use')
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
  to = server(true, false)
  expect(await codes.code('karpenter')).toEqual({ ok: false, refused: 'not-checked' })
  expect(await codes.whether('karpenter')).toBe('not-checked')
  expect(records).toHaveLength(1)
  // A server's browser that is (once there's a check): handed, and said as a browser's.
  const browser = pluginCodes({
    known: async () => [plugin()],
    to: () => server(true, true),
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
})

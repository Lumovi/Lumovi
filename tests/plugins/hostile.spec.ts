/**
 * A hostile plugin against the door, line by line of what may never get past it: what it may
 * never ask for, a part Lumovi doesn't have, more rows than a table takes, a flood of refreshes,
 * and tokens that were never its own page's. Plain functions: nothing is built or launched. (The
 * box's ways out, and what reaches Lumovi's backend, are tried in the e2e and web specs.)
 */
import { expect, test } from '@playwright/test'
import { DOOR_LIMITS, DoorPage } from '../../src/shared/plugin-door.ts'
import { DECLARED } from '../../src/shared/kit/parts.ts'
import { TABLE_LIMITS } from '../../src/shared/kit/table.ts'
import { Tokens } from '../../src/shared/plugin-presses.ts'
import { PageReads, READ_LIMITS, readAsk } from '../../src/shared/plugin-reads.ts'

const commit = (...steps: unknown[][]) => JSON.stringify({ commit: steps })

test('what a plugin may never have isn’t a word of the door’s: each ask for it stops the plugin', () => {
  // Lumovi's credentials, its history, its settings and access rules, the computer's files, the
  // terminal, other plugins: no ask names them, however it's spelled.
  for (const what of [
    'kubeconfig',
    'token',
    'credentials',
    'audit',
    'history',
    'settings',
    'access',
    'policy',
    'readOnly',
    'file',
    'files',
    'terminal',
    'exec',
    'install',
    'plugins',
    'store',
    'assistant',
    'raw',
    'proxy',
  ]) {
    expect(readAsk({ read: 1, what }), what).toMatchObject({ why: 'not-allowed' })
  }
  // Nor by a path of the API server's own, as a kind or a name.
  for (const ask of [
    { read: 1, what: 'list', kind: '/api/v1/secrets' },
    { read: 1, what: 'object', kind: '/Secret', name: '../../kube-system/secrets/x' },
    { read: 1, what: 'list', kind: 'apiextensions.k8s.io/../../v1/secrets' },
  ]) {
    expect(readAsk(ask), JSON.stringify(ask)).toMatchObject({ why: 'not-allowed' })
  }
})

test('a part Lumovi doesn’t have is no part, whatever it’s called: a canvas of its own among them', () => {
  for (const name of [
    'Custom',
    'Canvas',
    'Frame',
    'Html',
    'Script',
    'Iframe',
    'constructor',
    '__proto__',
  ]) {
    const page = new DoorPage(DECLARED, () => 0)
    expect(page.take(commit(['make', 1, name, {}])), name).toMatchObject({
      why: 'not-allowed',
      what: `step 1: names a part Lumovi doesn’t have: ${JSON.stringify(name)}`,
    })
  }
})

test('a table of more rows than a table takes stops the page: none is left out without a word', () => {
  const rows = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      key: `r${i}`,
      lead: { name: `row ${i}` },
      cells: [],
    }))
  const table = (count: number) => ({
    title: 'Rows',
    headings: false,
    columns: [],
    rows: rows(count),
  })
  // As many as it takes: drawn.
  const fits = new DoorPage(DECLARED, () => 0)
  expect(
    fits.take(commit(['make', 1, 'Table', table(TABLE_LIMITS.rows)], ['put', 0, 1])),
  ).not.toHaveProperty('why')
  // One more: the page stops.
  const over = new DoorPage(DECLARED, () => 0)
  expect(
    over.take(commit(['make', 1, 'Table', table(TABLE_LIMITS.rows + 1)], ['put', 0, 1])),
  ).toHaveProperty('why')
  // (And a message past the door's size is stopped before it's read at all.)
  const huge = new DoorPage(DECLARED, () => 0)
  expect(huge.take(`{"commit":[${'0,'.repeat(DOOR_LIMITS.message / 2)}0]}`)).toMatchObject({
    why: 'too-much',
  })
})

test('a flood of refreshes is ended at the asks a second takes; one too soon is only not made', () => {
  const clock = { now: 0 }
  const page = new PageReads({ lists: 0, kept: 0 }, () => clock.now)
  // The first is made; the next, too soon, isn't, and doesn't stop the plugin…
  expect(page.take({ refresh: true })).toBeUndefined()
  expect(page.take({ refresh: true })).toBe('too-soon')
  // …but every one counts among its second's asks: a flood ends there.
  let stopped: unknown
  for (let i = 0; i < READ_LIMITS.asksASecond + 5 && !stopped; i++) {
    const took = page.take({ refresh: true })
    if (typeof took === 'object') stopped = took
  }
  expect(stopped).toMatchObject({ why: 'too-much' })
})

test('a token is good on the page it was handed to: another page’s, another plugin’s, or one made up, is nothing', () => {
  const plugin = { objects: 0 }
  let made = 0
  const toys = new Tokens(plugin, () => `toys-${++made}`)
  const [pod] = toys.hand(1, [{ kind: 'Pod', namespace: 'shop', name: 'cart-1' }]) as string[]
  expect(toys.podOf(pod!)).toMatchObject({ name: 'cart-1' })
  // Another page of the same plugin, and another plugin's page, hold none of it.
  const sameplugin = new Tokens(plugin, () => `toys-${++made}`)
  const other = new Tokens({ objects: 0 }, () => `other-${++made}`)
  for (const page of [sameplugin, other]) {
    expect(page.podOf(pod!)).toBeUndefined()
    expect(page.heldOf(pod!)).toBeUndefined()
    expect(page.objectOf(pod!)).toBeUndefined()
  }
  // One made up, or spelled as an object, is nothing either.
  for (const token of ['toys-1x', 'cart-1', 'shop/cart-1', '', 'constructor', '__proto__']) {
    expect(toys.heldOf(token), token).toBeUndefined()
  }
  // Once its read has ended, its own page holds it no more.
  toys.ended(1)
  expect(toys.podOf(pod!)).toBeUndefined()
})

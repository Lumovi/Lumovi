/**
 * A kept tab's window opened again as Lumovi did: whether it waits to be asked for before it's
 * read, which for a cluster that signs in through a program runs that program.
 */
import { expect, test } from '@playwright/test'
import type { MovedTab } from '../../src/shared/api.ts'
import { waitsToBeRead } from '../../src/shared/moved-tab.ts'

const kept: MovedTab = {
  kind: 'kept',
  context: 'plugged',
  object: { kind: 'Pod', name: 'web-0', namespace: 'shop' },
  tab: 'logs',
}
const terminal: MovedTab = { kind: 'terminal', context: 'plugged' }
const plugged = { name: 'plugged', signsInWith: 'credential.mjs' }
const plain = { name: 'plugged' }

test('a kept tab opened again waits unless its cluster is known not to sign in through a program', () => {
  // Its cluster signs in through a program: it waits.
  expect(waitsToBeRead(kept, true, [plain, plugged].slice(1))).toBe(true)
  // Known not to: read as it opens.
  expect(waitsToBeRead(kept, true, [plain])).toBe(false)
  // The contexts couldn't be read: nothing says it doesn't, so it waits.
  expect(waitsToBeRead(kept, true, undefined)).toBe(true)
  // Its context gone from the kubeconfig: there's no program to run, and reading it says so.
  expect(waitsToBeRead(kept, true, [{ name: 'other', signsInWith: 'x' }])).toBe(false)
})

test('only a kept object opened again waits: not one moved just now, nor a terminal', () => {
  // Moved by the person just now: they're using that cluster.
  expect(waitsToBeRead(kept, false, [plugged])).toBe(false)
  expect(waitsToBeRead(kept, false, undefined)).toBe(false)
  // A terminal opened again is ended, and starts its shell only when asked.
  expect(waitsToBeRead(terminal, true, [plugged])).toBe(false)
  expect(waitsToBeRead(terminal, true, undefined)).toBe(false)
})

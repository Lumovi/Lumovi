/**
 * Which Logs parts stream at once: a page's first four, and a plugin's first eight on all its
 * pages and tabs; the rest wait, the first drawn first. Plain functions: nothing is drawn.
 */
import { expect, test } from '@playwright/test'
import { slotOf } from '../../src/renderer/src/plugins/log-slots.ts'
import { DOOR_LIMITS } from '../../src/shared/plugin-door.ts'

const drawn = (plugin: string, page: string, count: number) =>
  Array.from({ length: count }, () => ({ plugin, page }))

test('a page shows four logs at once, and the fifth waits for a place on it', () => {
  expect(DOOR_LIMITS.logStreamsPage).toBe(4)
  const page = drawn('toys', 'a', 5)
  expect(page.map((one) => slotOf(one, page))).toEqual(['open', 'open', 'open', 'open', 'page'])
  // One closes: the one that waited is the first to stream.
  const left = page.slice(1)
  expect(left.map((one) => slotOf(one, left))).toEqual(['open', 'open', 'open', 'open'])
})

test('a plugin shows eight logs at once across its pages, and the ninth waits though its page has room', () => {
  expect(DOOR_LIMITS.logStreamsPlugin).toBe(8)
  const all = [...drawn('toys', 'a', 3), ...drawn('toys', 'b', 3), ...drawn('toys', 'c', 3)]
  expect(all.map((one) => slotOf(one, all))).toEqual([
    ...Array(8).fill('open'),
    // (Its page shows two: what's full is the plugin's.)
    'plugin',
  ])
  // Another plugin's are its own.
  const theirs = [...all, ...drawn('cogs', 'd', 2)]
  expect(theirs.slice(-2).map((one) => slotOf(one, theirs))).toEqual(['open', 'open'])
  // Where both are full, the page's is what's said.
  const both = [...drawn('toys', 'a', 4), ...drawn('toys', 'b', 4), ...drawn('toys', 'a', 1)]
  expect(slotOf(both.at(-1)!, both)).toBe('page')
})

/**
 * Who gets the height in Lumovi's dialog for a plugin's change (proposal-heights.ts), as plain
 * numbers: the options first, the change never under its floor, the command from its floor, folded
 * where the options would have too little; and nothing laid out where it can't be by the rule.
 */
import { expect, test } from '@playwright/test'
import {
  COMMAND_MOST,
  OPTIONS_ENOUGH,
  share,
  type Heights,
} from '../../src/renderer/src/plugins/proposal-heights.ts'

/** Five fields, a long change with its three-row floor, a long command with its two lines. */
const LONG: Heights = {
  room: 600,
  options: 400,
  change: 500,
  changeFloor: 94,
  command: 200,
  commandFloor: 39,
  opened: false,
}

test('with room for all of it, each box has its whole height, the command its most', () => {
  expect(share({ ...LONG, room: 2000 })).toEqual({
    options: 400,
    change: 500,
    command: COMMAND_MOST,
    tight: false,
    folded: false,
  })
})

test('the options get the height first, then the change, then the command from its floor', () => {
  // All the options; the change what's left over its floor; the command its two lines.
  expect(share(LONG)).toEqual({
    options: 400,
    change: 161,
    command: 39,
    tight: false,
    folded: false,
  })
  // Less room: the options give way before the floors do, and are still enough to fill in.
  expect(share({ ...LONG, room: 400 })).toEqual({
    options: 267,
    change: 94,
    command: 39,
    tight: false,
    folded: false,
  })
  // No options: the change takes what the command's floor leaves.
  expect(share({ ...LONG, options: 0, room: 265 })).toEqual({
    options: 0,
    change: 226,
    command: 39,
    tight: false,
    folded: false,
  })
})

test('where the options would have less than two fields’ height, the command folds; opened by hand, it takes its floor from them', () => {
  // The smallest window: 132 px of options beside both floors is too little.
  const tight = share({ ...LONG, room: 265 })
  expect(tight).toEqual({ options: 171, change: 94, command: 0, tight: true, folded: true })
  expect(tight!.options).toBeLessThan(OPTIONS_ENOUGH)
  expect(share({ ...LONG, room: 265, opened: true })).toEqual({
    options: 132,
    change: 94,
    command: 39,
    tight: true,
    folded: false,
  })
  // Options that are short themselves are never the reason: they show whole.
  expect(share({ ...LONG, options: 100, room: 265 })).toMatchObject({
    options: 100,
    tight: false,
    folded: false,
  })
  // With no options at all, the command folds only where its floor doesn't fit beside the change's.
  expect(share({ ...LONG, options: 0, room: 120 })).toEqual({
    options: 0,
    change: 120,
    command: 0,
    tight: true,
    folded: true,
  })
  // (Opened there: what's left beside the change's floor.)
  expect(share({ ...LONG, options: 0, room: 120, opened: true })).toEqual({
    options: 0,
    change: 94,
    command: 26,
    tight: true,
    folded: false,
  })
})

test('the change never has less than its floor, and a change shorter than its floor shows whole', () => {
  for (let room = 94; room <= 1200; room += 7) {
    for (const opened of [false, true]) {
      const shared = share({ ...LONG, room, opened })!
      expect(shared.change, `${room}`).toBeGreaterThanOrEqual(94)
      expect(shared.options + shared.change + shared.command, `${room}`).toBeLessThanOrEqual(room)
      expect(shared.folded ? shared.command : 1, `${room}`).not.toBe(shared.folded ? 1 : 0)
    }
  }
  expect(share({ ...LONG, change: 40, room: 300 })).toMatchObject({ change: 40 })
  // No command (a change the cluster hasn't answered yet): nothing to fold.
  expect(share({ ...LONG, command: 0, room: 200 })).toEqual({
    options: 106,
    change: 94,
    command: 0,
    tight: false,
    folded: false,
  })
})

test('what can’t be laid out by the rule is left as it is: a height that isn’t one, or less room than the change’s floor', () => {
  expect(share({ ...LONG, room: 93 })).toBeUndefined()
  expect(share({ ...LONG, room: Number.NaN })).toBeUndefined()
  expect(share({ ...LONG, change: Number.POSITIVE_INFINITY })).toBeUndefined()
  expect(share({ ...LONG, options: -1 })).toBeUndefined()
  expect(share({ ...LONG, room: -200 })).toBeUndefined()
})

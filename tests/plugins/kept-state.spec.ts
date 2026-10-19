/**
 * What becomes of an object kept open below (src/renderer/src/features/terminal/kept-state.ts):
 * deleted, or its cluster away, each from when it was first found so, and neither once it's read
 * again. Plain data: nothing is drawn.
 */
import { expect, test } from '../temp-folders.ts'
import { keptState } from '../../src/renderer/src/features/terminal/kept-state.ts'

test('a kept object’s cluster away: from when it was first found so, its last view kept; back, as before', () => {
  const read = true
  // Its cluster doesn't answer: away from now, and still from then at the next read.
  const away = keptState({}, { read, code: 'unreachable' }, 1_000)
  expect(away).toEqual({ deletedAt: undefined, unreachableSince: 1_000 })
  expect(keptState(away, { read, code: 'timeout' }, 5_000)).toEqual({
    deletedAt: undefined,
    unreachableSince: 1_000,
  })
  // It answers again: neither.
  expect(keptState(away, { read }, 9_000)).toEqual({
    deletedAt: undefined,
    unreachableSince: undefined,
  })
})

test('a kept object deleted: from when it was first found gone; never read at all, neither', () => {
  const gone = keptState({}, { read: true, code: 'not-found' }, 2_000)
  expect(gone.deletedAt).toBe(2_000)
  expect(keptState(gone, { read: true, code: 'not-found' }, 7_000).deletedAt).toBe(2_000)
  // Made again by that name: as before.
  expect(keptState(gone, { read: true }, 8_000).deletedAt).toBeUndefined()
  // Never read (kept, and gone before it was read): it says why where it's shown, not this.
  expect(keptState({}, { read: false, code: 'not-found' }, 3_000)).toEqual({
    deletedAt: undefined,
    unreachableSince: undefined,
  })
  // Any other refusal is neither.
  expect(keptState({}, { read: true, code: 'forbidden' }, 3_000)).toEqual({
    deletedAt: undefined,
    unreachableSince: undefined,
  })
})

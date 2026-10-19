/**
 * The server's budget for people's pins and saved views, as its own code keeps them (marks.ts over
 * state.ts, in a file): one person's in one cluster, in all the clusters it shows, and everyone's
 * together; a cluster it doesn't show now counts toward no one's own, and is let go first when
 * everyone's would be passed, the longest unread first; and what's gone unread 180 days is let go
 * as the state is written, on a clock the test sets back.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '../temp-folders.ts'
import type { Marks } from '../../src/shared/marks.ts'
import {
  KEPT_UNUSED_MS,
  MOST_ALL,
  MOST_EACH,
  MOST_PERSON,
  OVER_ALL,
  OVER_OWN,
  OVER_YOURS,
  PeopleMarks,
  sealedSize,
} from '../../src/server/marks.ts'
import { ServerState } from '../../src/server/state.ts'

const DAY = 24 * 60 * 60 * 1000
const person = (name: string) => ({ name, groups: [] })
/** An entry's key, as marks.ts writes it. */
const key = (name: string, context: string) => JSON.stringify([name, context])
const anywhere = () => undefined

/** `count` views of pods, each with a filter and a selector a kilobyte long. */
const views = (count: number): Marks => ({
  pins: [],
  views: Array.from({ length: count }, (_, i) => ({
    name: `View ${i}`,
    kind: 'Pod',
    q: 'q'.repeat(1000),
    labels: 'l'.repeat(1000),
  })),
})
/** About 27 kB sealed: under one person's in one cluster. */
const NEARLY_FULL = views(10)

async function opened(shows: (context: string) => boolean, now?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-marks-'))
  const sealedWith = randomBytes(32)
  const open = () =>
    ServerState.open({ kind: 'file', path: join(dir, 'state.json') }, {}, sealedWith, {
      writeAfterMs: 3_600_000,
      retryMs: 3_600_000,
    })
  const state = await open()
  return {
    state,
    /** What's written, as a server started now reads it. */
    written: async () => {
      const again = await open()
      const keys = again.entries('marks').map(([each]) => each)
      again.close()
      return keys
    },
    marks: new PeopleMarks(state, shows, now),
    done: () => {
      state.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('one person’s in a cluster, and in all the clusters shown, each has its ceiling', async () => {
  // (Three such fit one person's 96 kB; a fourth doesn't.)
  const size = sealedSize({ marks: NEARLY_FULL, expires: Date.now() })
  expect(size).toBeLessThanOrEqual(MOST_EACH)
  expect(3 * size).toBeLessThanOrEqual(MOST_PERSON)
  expect(4 * size).toBeGreaterThan(MOST_PERSON)
  const { marks, done } = await opened(() => true)
  const alice = marks.of(person('alice'), anywhere)
  expect(alice.set('a', views(12))).toBe(OVER_OWN)
  expect(alice.set('a', NEARLY_FULL)).toBeUndefined()
  expect(alice.set('b', NEARLY_FULL)).toBeUndefined()
  expect(alice.set('c', NEARLY_FULL)).toBeUndefined()
  // A fourth cluster's would pass her 96 kB; another person's is their own.
  expect(alice.set('d', NEARLY_FULL)).toBe(OVER_YOURS)
  expect(marks.of(person('bob'), anywhere).set('d', NEARLY_FULL)).toBeUndefined()
  // Less in one leaves room for another.
  expect(alice.set('c', { pins: [], views: [] })).toBeUndefined()
  expect(alice.set('d', NEARLY_FULL)).toBeUndefined()
  done()
})

test('a user name with a NUL in it, as an OIDC claim can have, is one person with their own ceiling', async () => {
  const { marks, done } = await opened(() => true)
  const odd = marks.of(person('alice\u0000prod'), anywhere)
  expect(odd.set('a', NEARLY_FULL)).toBeUndefined()
  expect(odd.set('b', NEARLY_FULL)).toBeUndefined()
  expect(odd.set('c', NEARLY_FULL)).toBeUndefined()
  expect(odd.set('d', NEARLY_FULL)).toBe(OVER_YOURS)
  // Alice is someone else: none of it is hers, and hers none of theirs.
  const alice = marks.of(person('alice'), anywhere)
  expect(alice.get('a')).toEqual({ pins: [], views: [] })
  expect(alice.set('d', NEARLY_FULL)).toBeUndefined()
  expect(odd.get('d')).toEqual({ pins: [], views: [] })
  done()
})

test('a cluster not shown counts toward no one’s own, and is let go first, longest unread first, where everyone’s would be passed', async () => {
  const shown = new Set(['demo', 'gone-a', 'gone-b'])
  let clock = Date.now()
  const { state, marks, done } = await opened(
    (context) => shown.has(context),
    () => clock,
  )
  // Alice's in two clusters, which then go: the older read first.
  const alice = marks.of(person('alice'), anywhere)
  expect(alice.set('gone-a', NEARLY_FULL)).toBeUndefined()
  clock += DAY
  expect(alice.set('gone-b', NEARLY_FULL)).toBeUndefined()
  expect(alice.set('demo', NEARLY_FULL)).toBeUndefined()
  shown.delete('gone-a')
  shown.delete('gone-b')
  // Not shown, they're none of hers: two more clusters fit her 96 kB.
  shown.add('more-1')
  shown.add('more-2')
  expect(alice.set('more-1', NEARLY_FULL)).toBeUndefined()
  expect(alice.set('more-2', NEARLY_FULL)).toBeUndefined()

  // Others fill everyone's until one more would pass the 400 kB.
  let n = 0
  const kept = () =>
    state
      .entries<{ marks: Marks; expires: number }>('marks')
      .reduce((sum, [, entry]) => sum + sealedSize(entry), 0)
  const size = sealedSize({ marks: NEARLY_FULL, expires: clock })
  while (kept() + size <= MOST_ALL) {
    expect(marks.of(person(`p${n++}`), anywhere).set('demo', NEARLY_FULL)).toBeUndefined()
  }
  const keys = () => state.entries('marks').map(([key]) => key)
  expect(keys()).toContain(key('alice', 'gone-a'))

  // One more passes it: the longest unread of a cluster not shown makes room, and only it.
  expect(marks.of(person('zoe'), anywhere).set('demo', NEARLY_FULL)).toBeUndefined()
  expect(keys()).not.toContain(key('alice', 'gone-a'))
  expect(keys()).toContain(key('alice', 'gone-b'))
  expect(keys()).toContain(key('zoe', 'demo'))
  // Then the other; and with none left, a save is refused, nothing let go.
  expect(marks.of(person('yan'), anywhere).set('demo', NEARLY_FULL)).toBeUndefined()
  expect(keys()).not.toContain(key('alice', 'gone-b'))
  const before = keys().length
  expect(marks.of(person('xi'), anywhere).set('demo', NEARLY_FULL)).toBe(OVER_ALL)
  expect(keys()).toHaveLength(before)
  done()
})

test('what goes unread 180 days is let go as the state is written; a read keeps it another 180', async () => {
  // Set back: what was saved then has been unread for 181 days now.
  let clock = Date.now() - KEPT_UNUSED_MS - DAY
  const { state, written, marks, done } = await opened(
    () => true,
    () => clock,
  )
  const alice = marks.of(person('alice'), anywhere)
  const bob = marks.of(person('bob'), anywhere)
  expect(alice.set('demo', views(1))).toBeUndefined()
  expect(bob.set('demo', views(1))).toBeUndefined()
  // Bob's is read 100 days ago, which keeps it another 180; Alice's never is.
  clock = Date.now() - 100 * DAY
  expect(bob.get('demo').views).toHaveLength(1)
  clock = Date.now()
  expect(bob.get('demo').views).toHaveLength(1)
  // Run out, it's none, read or counted; and as the state's written, it's let go.
  expect(alice.get('demo')).toEqual({ pins: [], views: [] })
  await state.flush({ strict: true })
  expect(await written()).toEqual([key('bob', 'demo')])
  expect(bob.get('demo').views).toHaveLength(1)
  // Read again the same day, it's not written again.
  const entry = () => state.get<{ expires: number }>('marks', key('bob', 'demo'))!
  const expires = entry().expires
  clock += 60_000
  bob.get('demo')
  expect(entry().expires).toBe(expires)
  done()
})

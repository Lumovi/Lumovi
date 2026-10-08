/**
 * Replicas over one kept state, as the server's own code has them (state.ts and
 * cluster-settings.ts over one file), each reading and writing only when the test says, on a
 * clock the test turns: the orders a change made outside Lumovi, a key rotation, or a failed write
 * can meet them in, which a running server leaves to its timers. The invariants at the top of
 * cluster-settings.ts, step by step, and in seeded random runs.
 */
import { createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { expect, test } from '@playwright/test'
import type { AuditLog } from '../../src/backend/audit/log.ts'
import type { ServerAccess } from '../../src/server/access.ts'
import {
  ClusterSettings,
  readOnlyWhy,
  type ClusterEntry,
} from '../../src/server/cluster-settings.ts'
import { ServerState } from '../../src/server/state.ts'

const ADMIN = { name: 'admin@example.com', groups: [] }
const AUTO = { mode: 'auto' } as const
const OFF = { mode: 'off' } as const
const GRACE = 60_000

type Recorded = Parameters<AuditLog['record']>[0]

/** A clock the test turns, shared by replicas: a millisecond on each time it's read. */
const clock = () => {
  let now = Date.now()
  return { now: () => (now += 1), turn: (ms: number) => void (now += ms) }
}
type Clock = ReturnType<typeof clock>

/**
 * A replica: its own view of the state kept in `dir`, sealed with `key`, which writes only when
 * the test says (`written`), on `time` (its own clock `skew` ms off).
 */
async function replica(dir: string, key: Buffer, time: Clock, skew = 0) {
  const now = () => time.now() + skew
  const recorded: Recorded[] = []
  /** Each fix recorded (its records are made at once, together), naming the copy it found. */
  const fixes: { found: unknown }[] = []
  let recording = false
  const record = (event: Recorded) => {
    recorded.push(event)
    if (event.details?.outside !== true || recording) return
    recording = true
    fixes.push({ found: event.details.found })
    queueMicrotask(() => void (recording = false))
  }
  const state = await ServerState.open({ kind: 'file', path: join(dir, 'state.json') }, {}, key, {
    now,
    unopenedGraceMs: GRACE,
    writeAfterMs: 3_600_000,
    retryMs: 3_600_000,
  })
  const settings = new ClusterSettings(
    state,
    { administered: false, isAdmin: () => true } as unknown as ServerAccess,
    { record } as unknown as AuditLog,
    { now },
  )
  settings.close()
  return {
    state,
    settings,
    fixes,
    demo: () => state.get<ClusterEntry>('clusters', 'demo'),
    outside: () => recorded.filter((event) => event.details?.outside === true),
    written: () => state.flush({ strict: true }),
    /** Read again, and what that fixed written. */
    refreshed: async () => {
      await settings.refresh()
      await state.flush({ strict: true })
    },
  }
}
type Replica = Awaited<ReturnType<typeof replica>>

/** What's kept in `dir`, by entry name. */
const entries = (dir: string): Record<string, string> => {
  try {
    return (
      JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as {
        entries: Record<string, string>
      }
    ).entries
  } catch {
    return {}
  }
}
const keep = (dir: string, kept: Record<string, string>) =>
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ entries: kept }))
/** The name an entry is kept under, with `key`: demo's settings, by default. */
const demoName = (key: Buffer, entry = 'clusters\0demo') =>
  createHmac('sha256', Buffer.from(hkdfSync('sha256', key, 'lumovi', 'state names', 32)))
    .update(entry)
    .digest('base64url')

test.describe('replicas over one kept state', () => {
  let dir: string
  let key: Buffer
  let time: Clock
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumovi-replicas-'))
    key = randomBytes(32)
    time = clock()
  })

  test('a fix made from an older view doesn’t undo a newer change: the replica that knew it puts it back', async () => {
    const a = await replica(dir, key, time)
    const b = await replica(dir, key, time)
    a.settings.setReadOnly('demo', false, ADMIN)
    await a.written()
    const changeable = entries(dir)[demoName(key)]!
    const found = a.demo()!.version
    a.settings.setMetricsSource('demo', OFF, ADMIN)
    await a.written()
    await b.refreshed()
    b.settings.setReadOnly('demo', true, ADMIN)
    await b.written()

    // The changeable copy put back. A finds it first: from its older view, read-only isn't
    // what changed, only the metrics source, which it puts back, and its fix is written.
    keep(dir, { ...entries(dir), [demoName(key)]: changeable })
    await a.refreshed()
    expect(a.outside().map((event) => [event.action, event.details?.found])).toEqual([
      ['metrics-source.changed', found],
    ])
    expect(a.demo()?.readOnly).toBeUndefined()
    // B knows better: read-only in A's fix is set before what B knew, so B puts it back,
    // recording the copy A's fix was made over.
    await b.refreshed()
    expect(b.outside()).toEqual([
      expect.objectContaining({
        action: 'read-only.changed',
        summary:
          'Changed outside Lumovi: demo’s read-only was turned off, as an older copy of its setting was put back where Lumovi keeps it, and Lumovi made it read-only again',
        details: expect.objectContaining({ found }),
      }),
    ])
    expect(b.settings.isReadOnly('demo')).toBe(true)
    await a.refreshed()
    expect(a.demo()).toMatchObject({ readOnly: { by: ADMIN.name }, metricsSource: OFF })
    expect(a.outside()).toHaveLength(1)
  })

  test('an admin’s change, written over a copy put back meanwhile, is made over its fix', async () => {
    const a = await replica(dir, key, time)
    const b = await replica(dir, key, time)
    a.settings.setReadOnly('demo', false, ADMIN)
    await a.written()
    const changeable = entries(dir)[demoName(key)]!
    a.settings.setReadOnly('demo', true, ADMIN)
    await a.written()
    await b.refreshed()

    keep(dir, { ...entries(dir), [demoName(key)]: changeable })
    const conflicts = b.state.conflicts
    b.settings.setMetricsSource('demo', AUTO, ADMIN)
    await b.written()
    // Its write met the copy (the file changed since B read it).
    expect(b.state.conflicts).toBe(conflicts + 1)
    expect(b.outside()).toEqual([
      expect.objectContaining({
        action: 'read-only.changed',
        details: expect.objectContaining({ readOnly: true }),
      }),
    ])
    expect(b.demo()).toMatchObject({
      readOnly: { by: ADMIN.name },
      metricsSource: AUTO,
      // Still shown: a metrics source isn't read-only, which it's about.
      outside: { how: 'replaced', readOnly: 'restored' },
    })
    await a.refreshed()
    expect(a.demo()).toMatchObject({ readOnly: { by: ADMIN.name }, metricsSource: AUTO })
    expect(a.outside()).toEqual([])
  })

  test('a change not yet written, as its replica reads another’s newer one, is made over theirs at once, and written with no conflict', async () => {
    const a = await replica(dir, key, time)
    const b = await replica(dir, key, time)
    a.settings.setReadOnly('demo', false, ADMIN)
    await a.written()
    await b.refreshed()
    b.settings.setReadOnly('demo', true, ADMIN)
    await b.written()

    // A reads again, and while it does, an admin changes the metrics source there, from A's
    // older view: as soon as A has read B's, it's read-only there too.
    const reading = a.settings.refresh()
    a.settings.setMetricsSource('demo', OFF, ADMIN)
    await reading
    expect(a.settings.isReadOnly('demo')).toBe(true)
    const conflicts = a.state.conflicts
    await a.written()
    expect(a.state.conflicts).toBe(conflicts)
    await b.refreshed()
    for (const r of [a, b]) {
      expect(r.demo()).toMatchObject({ readOnly: { by: ADMIN.name }, metricsSource: OFF })
      expect(r.outside()).toEqual([])
    }
  })

  test('a fix isn’t kept over a newer change of Lumovi’s, and a copy two find at once is recorded once by each', async () => {
    const a = await replica(dir, key, time)
    const b = await replica(dir, key, time)
    a.settings.setReadOnly('demo', false, ADMIN)
    await a.written()
    const changeable = entries(dir)[demoName(key)]!
    a.settings.setReadOnly('demo', true, ADMIN)
    await a.written()
    await b.refreshed()

    keep(dir, { ...entries(dir), [demoName(key)]: changeable })
    // Both find the copy before either's fix is written (the store can't be, for a moment).
    chmodSync(dir, 0o555)
    await a.settings.refresh()
    await b.settings.refresh()
    chmodSync(dir, 0o755)
    // Then an admin's change on B is written before A's fix.
    b.settings.setMetricsSource('demo', AUTO, ADMIN)
    await b.written()
    await a.written()
    // B's change stands (made over the copy's fix), not A's fix over it.
    for (const r of [a, b]) {
      await r.refreshed()
      expect(r.demo()).toMatchObject({ readOnly: { by: ADMIN.name }, metricsSource: AUTO })
    }
    // Both found the same copy before either's fix was written: the one copy, both naming it.
    const copies = new Set([...a.outside(), ...b.outside()].map((event) => event.details?.found))
    expect(copies.size).toBe(1)
    expect(a.outside().length + b.outside().length).toBe(2)
    // Read again and again: nothing more.
    for (let round = 0; round < 3; round++) {
      await a.refreshed()
      await b.refreshed()
    }
    expect(a.outside().length + b.outside().length).toBe(2)
  })

  test('two quick changes, the first not written (a write that failed), aren’t taken for one made outside', async () => {
    const a = await replica(dir, key, time)
    a.settings.setReadOnly('demo', true, ADMIN)
    await a.written()
    // The store can't be written for a moment: "Allow changes" waits to be tried again.
    chmodSync(dir, 0o555)
    a.settings.setReadOnly('demo', false, ADMIN)
    await expect(a.written()).rejects.toThrow()
    // And a metrics source, meanwhile, from the view with read-only off.
    a.settings.setMetricsSource('demo', OFF, ADMIN)
    chmodSync(dir, 0o755)
    await a.written()
    expect(a.outside()).toEqual([])
    const b = await replica(dir, key, time)
    expect(b.demo()).toMatchObject({ metricsSource: OFF })
    expect(b.demo()?.readOnly).toBeUndefined()
    expect(b.demo()?.outside).toBeUndefined()
  })

  test('replicas sealing with different keys leave each other be for the grace, then let the old go', async () => {
    const old = await replica(dir, key, time)
    old.settings.setReadOnly('demo', true, ADMIN)
    await old.written()
    // A new key, rolled out beside the old.
    const next = randomBytes(32)
    const rolled = await replica(dir, next, time)
    rolled.settings.setReadOnly('demo', true, ADMIN)
    await rolled.written()
    for (let round = 0; round < 3; round++) {
      time.turn(GRACE / 6)
      await old.refreshed()
      await rolled.refreshed()
    }
    // Within the grace: both kept, nothing recorded, each read-only.
    expect(Object.keys(entries(dir))).toEqual(
      expect.arrayContaining([demoName(key), demoName(next)]),
    )
    expect([...old.outside(), ...rolled.outside()]).toEqual([])
    expect(old.settings.isReadOnly('demo')).toBe(true)
    // Nothing changing, neither writes: what each keeps of the other's is by name, which a
    // write of the other's doesn't change.
    const kept = readFileSync(join(dir, 'state.json'), 'utf8')
    await old.refreshed()
    await rolled.refreshed()
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe(kept)
    // Past it, the new key's replica lets the old key's go: what it opens is gone.
    time.turn(GRACE)
    await rolled.refreshed()
    expect(Object.keys(entries(dir))).not.toContain(demoName(key))
    expect(rolled.outside()).toEqual([])
    expect(rolled.settings.isReadOnly('demo')).toBe(true)
  })

  test('a change that can’t be made again over what’s kept holds back only itself, and is written as it was made after a few tries', async () => {
    const a = await replica(dir, key, time)
    a.state.set('clusters', 'stuck', { mine: true }, () => {
      throw new Error('no')
    })
    a.state.set('clusters', 'other', { fine: true })
    // The rest is written; whoever waits for it all is told it isn't.
    await expect(a.written()).rejects.toThrow('held back')
    const b = await replica(dir, key, time)
    expect(b.state.get('clusters', 'other')).toEqual({ fine: true })
    expect(b.state.get('clusters', 'stuck')).toBeUndefined()
    await expect(a.written()).rejects.toThrow('held back')
    await a.written()
    const c = await replica(dir, key, time)
    expect(c.state.get('clusters', 'stuck')).toEqual({ mine: true })
  })

  test('junk shaped like entries, rewritten before every read, never holds a replica up long', async () => {
    const a = await replica(dir, key, time)
    a.settings.setReadOnly('demo', true, ADMIN)
    await a.written()
    const own = entries(dir)
    // As much as a Secret holds: about 11,000 entries, each tried and failing.
    const junk = () => {
      const made: Record<string, string> = { ...own }
      for (let size = 0; size < 1_000_000;) {
        const name = randomBytes(32).toString('base64url')
        const sealed = randomBytes(30).toString('base64url')
        made[name] = sealed
        size += name.length + sealed.length + 6
      }
      return made
    }
    // Made beforehand: what's timed is the replica's reading, not the test's making it.
    const rounds = [junk(), junk(), junk()]
    const delay = monitorEventLoopDelay({ resolution: 1 })
    delay.enable()
    for (const round of rounds) {
      keep(dir, round)
      await a.settings.refresh()
    }
    delay.disable()
    // Opened a few hundred at a time: never long without the event loop let go.
    // About 25 ms here, and up to 85 on a CI runner busy with three other tests; without opening
    // a few hundred at a time, about 160 here, and several times that there.
    expect(delay.max / 1e6).toBeLessThan(150)
    expect(a.settings.isReadOnly('demo')).toBe(true)
    expect(a.outside()).toEqual([])
  })

  test('an older copy put back over an entry made again, after a deletion while no replica ran, brings nothing back unrecorded', async () => {
    const a = await replica(dir, key, time)
    a.settings.setNodeShell('demo', { namespace: 'ops', image: 'busybox:1.36' }, ADMIN)
    a.settings.setReadOnly('demo', true, ADMIN)
    await a.written()
    const older = entries(dir)[demoName(key)]!
    const found = a.demo()!.version
    // Deleted while no replica runs; one starts, knowing nothing, and an admin sets only metrics.
    const { [demoName(key)]: _deleted, ...rest } = entries(dir)
    keep(dir, rest)
    const b = await replica(dir, key, time)
    b.settings.setMetricsSource('demo', OFF, ADMIN)
    await b.written()

    // The older copy put back: its node shell is from before the entry was made again, so it's
    // put back as unset, and its read-only is kept, as made outside Lumovi; both recorded.
    keep(dir, { ...entries(dir), [demoName(key)]: older })
    await b.refreshed()
    expect(b.demo()).toMatchObject({
      metricsSource: OFF,
      readOnly: { outside: true },
      // The metrics source too: the copy had none.
      outside: { how: 'replaced', readOnly: 'made', restored: ['metricsSource', 'nodeShell'] },
    })
    expect(b.demo()?.nodeShell).toBeUndefined()
    expect(b.outside().map((event) => [event.action, event.details?.found])).toEqual([
      ['read-only.changed', found],
      ['metrics-source.changed', found],
      ['node-shell.changed', found],
    ])
    expect(readOnlyWhy(b.settings.readOnly('demo'), 'demo')).toBe(
      'demo is read-only for everyone on this server: it was made so outside Lumovi.',
    )
  })

  test('junk where the state is kept doesn’t stop it being written: what no key made goes at once, and what doesn’t open takes one time to keep', async () => {
    const a = await replica(dir, key, time)
    a.settings.setReadOnly('demo', true, ADMIN)
    await a.written()
    // A megabyte of tiny junk, which no key made, and some shaped like entries.
    const junk: Record<string, string> = { ...entries(dir) }
    for (let n = 0; n < 125_000; n++) junk[`j${n}`] = ''
    const shaped = Array.from({ length: 200 }, () => randomBytes(32).toString('base64url'))
    for (const name of shaped) junk[name] = randomBytes(40).toString('base64url')
    keep(dir, junk)
    await a.refreshed()
    const since = demoName(key, 'unopened\0since')
    expect(Object.keys(entries(dir)).sort()).toEqual([demoName(key), since, ...shaped].sort())
    // When they were first seen: one time, however many there are.
    expect(entries(dir)[since]!.length).toBeLessThan(200)
    expect(a.settings.isReadOnly('demo')).toBe(true)
    // Past the grace, they go, and so does the time, with none left.
    time.turn(GRACE + 1)
    await a.refreshed()
    await a.written()
    expect(Object.keys(entries(dir))).toEqual([demoName(key)])
    expect(a.outside()).toEqual([])
  })
})

/** A small seeded generator (mulberry32): a run that fails replays from its seed. */
function random(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A few dozen; more for a long run (LUMOVI_REPLICA_SEEDS=1000). */
const SEEDS = Array.from(
  { length: Number(process.env.LUMOVI_REPLICA_SEEDS) || 24 },
  (_, n) => n + 1,
)
// One again, as it failed (SEED=420).
if (process.env.SEED) SEEDS.splice(0, SEEDS.length, Number(process.env.SEED))

/** The time between steps, more than twice the most a replica's clock is off. */
const STEP_MS = 1_000
const SKEW_MS = 400

/** Replicas sealing with one key: what admins set through them, and which knew it. */
interface World {
  key: Buffer
  truth: { readOnly: boolean; metrics?: typeof AUTO | typeof OFF }
  /** The count of the write that set each, as admins last did. */
  set: { readOnly: number; metrics: number }
  /** Replicas that have known read-only on as last set (while it's on), and the metrics source. */
  knowsOn: Set<number>
  knowsMetrics: Set<number>
  /** Every copy of demo's entry its replicas wrote, with its count: what can be put back. */
  copies: { sealed: string; version: number }[]
  /** What the test did outside Lumovi: the copy put back (by its count), or null, a deletion. */
  outside: { found: number | null; step: number }[]
}

/** A replica, as the test has it: its world, its clock's skew, and its changes not yet written. */
interface Member {
  r: Replica
  world: World
  skew: number
  born: number
  pending: ({ readOnly: boolean } | { metrics: typeof AUTO | typeof OFF })[]
  /** When it first read what's kept since what it can't open last changed. */
  stable?: number
}

for (const seed of SEEDS) {
  test(`seeded run ${seed}: the invariants hold after every step`, async () => {
    const rand = random(seed)
    const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!
    const dir = mkdtempSync(join(tmpdir(), 'lumovi-replicas-'))
    const time = clock()
    const world = (): World => ({
      key: randomBytes(32),
      truth: { readOnly: false },
      set: { readOnly: 0, metrics: 0 },
      knowsOn: new Set(),
      knowsMetrics: new Set(),
      copies: [],
      outside: [],
    })
    let step = 0
    const members: Member[] = []
    const skews = [Math.floor((rand() * 2 - 1) * SKEW_MS), Math.floor((rand() * 2 - 1) * SKEW_MS)]
    const start = async (i: number, w: World) => {
      members[i] = {
        r: await replica(dir, w.key, time, skews[i]),
        world: w,
        skew: skews[i]!,
        born: step,
        pending: [],
        stable: time.now(),
      }
    }
    /** The key replicas move to (all of them, but in a rollout). */
    let newest = world()
    await start(0, newest)
    await start(1, newest)
    /** When replicas began sealing with different keys, while they do. */
    let mixedSince: number | undefined
    /** Old keys' entries, and whether a write past their grace has been. */
    let retired: { names: Set<string>; due: boolean }[] = []
    /** What replicas on other keys than `w`'s can't open changed: their grace starts again. */
    const changedFor = (w: World) => {
      for (const other of members) if (other.world !== w) other.stable = undefined
    }
    const log: string[] = []

    /** What's kept, as member `i` (which just read or wrote it) sees it: a copy to put back. */
    const noteCopy = (i: number) => {
      const { r, world: w } = members[i]!
      const sealed = entries(dir)[demoName(w.key)]
      const version = r.demo()?.version
      if (sealed && version !== undefined && !w.copies.some((c) => c.sealed === sealed)) {
        w.copies.push({ sealed, version })
      }
    }
    /** What member `i` knows now, by its view: what admins last set, or something newer. */
    const learn = (i: number) => {
      const { r, world: w, pending } = members[i]!
      if (pending.length > 0) return
      const view = r.demo()
      if (w.truth.readOnly && view?.readOnly && (view.counts?.readOnly ?? 0) >= w.set.readOnly) {
        w.knowsOn.add(i)
      }
      if (
        w.truth.metrics &&
        JSON.stringify(view?.metricsSource) === JSON.stringify(w.truth.metrics) &&
        (view?.counts?.metricsSource ?? 0) >= w.set.metrics
      ) {
        w.knowsMetrics.add(i)
      }
    }
    /** Member `i`'s changes, written: what admins set now. */
    const wrote = (i: number) => {
      const m = members[i]!
      const w = m.world
      const view = m.r.demo()
      for (const change of m.pending) {
        if ('readOnly' in change) {
          if (change.readOnly !== w.truth.readOnly) w.knowsOn.clear()
          w.truth = { ...w.truth, readOnly: change.readOnly }
          w.set.readOnly = view!.counts!.readOnly!
        } else {
          w.knowsMetrics.clear()
          w.truth = { ...w.truth, metrics: change.metrics }
          w.set.metrics = view!.counts!.metricsSource!
        }
      }
      m.pending = []
      noteCopy(i)
      learn(i)
    }
    /** An admin's change through member `i`, from its view (which it may not have read lately). */
    const change = (i: number) => {
      const m = members[i]!
      if (rand() < 0.4) {
        const metrics = pick([AUTO, OFF])
        m.r.settings.setMetricsSource('demo', metrics, ADMIN)
        m.pending.push({ metrics })
        m.world.knowsMetrics.delete(i)
      } else {
        const readOnly = rand() < 0.5
        m.r.settings.setReadOnly('demo', readOnly, ADMIN)
        m.pending.push({ readOnly })
        m.world.knowsOn.delete(i)
      }
    }
    /** Member `i` stopped as a server stops (what it hasn't written, written). */
    const stop = async (i: number) => {
      await members[i]!.r.written()
      members[i]!.r.state.close()
      wrote(i)
    }

    /** The invariants, after a step: what breaks one, said with every step that led there. */
    const holds = (action: string) => {
      log.push(action)
      const broken: string[] = []
      members.forEach(({ r, world: w }, i) => {
        // 1. Read-only, while admins have it on, on every replica that knew it on.
        if (w.truth.readOnly && w.knowsOn.has(i) && !r.settings.isReadOnly('demo')) {
          broken.push(`replica ${i} knew read-only on, and it’s off`)
        }
        // 2. The metrics source, as admins last set it, on every replica that knew it.
        const metrics = r.demo()?.metricsSource
        if (w.knowsMetrics.has(i) && !isDeepStrictEqual(metrics, w.truth.metrics)) {
          broken.push(
            `replica ${i}’s metrics source is ${JSON.stringify(metrics)}, not ${JSON.stringify(w.truth.metrics)}`,
          )
        }
      })
      // 3 and 4. A replica's fixes are of things the test did outside Lumovi since it started:
      // never more of them, after any step, than were done (each fix is of one done before it).
      // A copy a fix names, by its count, wasn't put back fewer times. (A copy that was itself
      // written over a deletion is named as one: what it was written over is all it tells.)
      members.forEach(({ r, world: w, born }, i) => {
        const done = w.outside.filter((d) => d.step > born)
        if (r.fixes.length > done.length) {
          broken.push(`replica ${i} fixed ${r.fixes.length} times, after ${done.length} done`)
        }
        const counted = new Map<unknown, number>()
        for (const { found } of r.fixes) counted.set(found, (counted.get(found) ?? 0) + 1)
        for (const [found, times] of counted) {
          const put = done.filter((d) => d.found === found).length
          if ((put > 0 || w.copies.some((copy) => copy.version === found)) && times > put) {
            broken.push(`replica ${i} recorded ${String(found)} ${times} times, put back ${put}`)
          }
        }
      })
      // 5. What retired keys open is gone, once a write past the grace has been.
      const kept = Object.keys(entries(dir))
      for (const { names, due } of retired) {
        const left = kept.filter((name) => names.has(name))
        if (due && left.length > 0) broken.push(`${left.length} retired entries left`)
      }
      // (Thrown, not expected step by step: every expect is kept in the report.)
      if (broken.length > 0) {
        throw new Error(`${broken.join('; ')} (seed ${seed}, after: ${log.join(' → ')})`)
      }
    }

    for (step = 1; step <= 150; step++) {
      time.turn(STEP_MS)
      const i = Math.floor(rand() * members.length)
      const m = members[i]!
      // Replicas on two keys for longer than the grace let each other's entries go (LMV-94): a
      // rollout that has taken a third of it is done.
      const due = mixedSince !== undefined && time.now() - mixedSince > GRACE / 3
      const picked = pick([
        'change',
        'change',
        'later',
        'later',
        'write',
        'refresh',
        'refresh',
        'peek',
        'peek',
        'delete',
        'replay',
        'replay',
        'restart',
        'fail',
        'time',
        'rotate',
        'rollout',
      ] as const)
      const action = due ? 'rollout' : picked
      if (action === 'change') {
        change(i)
        await m.r.written()
        wrote(i)
      } else if (action === 'later') {
        // Its write fails (the store can't be written for a moment), so it waits, unwritten, until
        // this replica next writes, whatever it reads meanwhile.
        chmodSync(dir, 0o555)
        change(i)
        await m.r.state.writing
        chmodSync(dir, 0o755)
        if (m.r.state.unwritten('clusters') === 0) wrote(i)
      } else if (action === 'write') {
        await m.r.written()
        wrote(i)
      } else if (action === 'fail') {
        chmodSync(dir, 0o555)
        change(i)
        await expect(m.r.written()).rejects.toThrow()
        chmodSync(dir, 0o755)
        await m.r.written()
        wrote(i)
      } else if (action === 'refresh') {
        m.stable ??= time.now()
        await m.r.refreshed()
        wrote(i)
        // Retired keys' entries, unchanged for the grace (no rollout under way), go as it writes.
        if (mixedSince === undefined && time.now() - m.stable > GRACE + STEP_MS) {
          for (const batch of retired) batch.due = true
        }
      } else if (action === 'peek') {
        // Read again, without writing what's waiting (unless a fix is written, and it with it).
        m.stable ??= time.now()
        await m.r.settings.refresh()
        await m.r.state.writing
        if (m.r.state.unwritten('clusters') === 0) wrote(i)
      } else if (action === 'delete') {
        const { [demoName(m.world.key)]: gone, ...rest } = entries(dir)
        if (gone) {
          keep(dir, rest)
          m.world.outside.push({ found: null, step })
        }
      } else if (action === 'replay') {
        if (m.world.copies.length > 0) {
          const copy = pick(m.world.copies)
          keep(dir, { ...entries(dir), [demoName(m.world.key)]: copy.sealed })
          m.world.outside.push({ found: copy.version, step })
        }
      } else if (action === 'restart') {
        // Started again, it knows nothing older: it takes what's kept as it finds it.
        await stop(i)
        m.world.knowsOn.delete(i)
        m.world.knowsMetrics.delete(i)
        await start(i, m.world)
      } else if (action === 'time') {
        // Never so long that replicas on different keys outlast the grace (LMV-94).
        const most = mixedSince === undefined ? GRACE : GRACE / 2 - (time.now() - mixedSince)
        time.turn(Math.max(0, Math.floor(rand() * most)))
      } else if (action === 'rotate' || action === 'rollout') {
        const mixed = members.some((other) => other.world !== members[0]!.world)
        // A rollout: one replica to a new key first, then (a later rollout) the rest to it.
        // A rotation: all at once.
        const next = action === 'rollout' && mixed ? newest : world()
        newest = next
        const moving = action === 'rollout' && !mixed ? [i] : [0, 1]
        // Stopped, then started (the ones that move): none starts before another's last write.
        const moved = moving.filter((n) => members[n]!.world !== next)
        for (const n of moved) await stop(n)
        for (const n of moved) await start(n, next)
        if (action === 'rollout' && !mixed) mixedSince = time.now()
        else {
          // All on one key: the rest are retired.
          const opened = new Set([demoName(next.key), demoName(next.key, 'unopened\0since')])
          const names = new Set(Object.keys(entries(dir)).filter((name) => !opened.has(name)))
          retired = retired.filter((batch) => {
            for (const name of names) batch.names.delete(name)
            return batch.names.size > 0
          })
          retired.push({ names, due: false })
          mixedSince = undefined
        }
        // The replicas that stopped wrote as they did.
        for (const [n, other] of members.entries()) if (!moved.includes(n)) other.stable = undefined
      }
      // What this one wrote, put back or deleted, others can't open: their grace starts again.
      if (action !== 'time' && action !== 'rotate' && action !== 'rollout') changedFor(m.world)
      holds(`${action}@${i}`)
    }
    // And past the last grace, once each replica reads and writes: nothing retired is left.
    if (mixedSince !== undefined) {
      const moved = [0, 1].filter((n) => members[n]!.world !== newest)
      for (const n of moved) await stop(n)
      for (const n of moved) await start(n, newest)
      const opened = new Set([demoName(newest.key), demoName(newest.key, 'unopened\0since')])
      retired.push({
        names: new Set(Object.keys(entries(dir)).filter((name) => !opened.has(name))),
        due: false,
      })
    }
    for (let n = 0; n < members.length; n++) {
      await members[n]!.r.refreshed()
      wrote(n)
    }
    time.turn(GRACE + 2 * STEP_MS)
    for (let round = 0; round < 2; round++) {
      for (let n = 0; n < members.length; n++) {
        await members[n]!.r.refreshed()
        wrote(n)
      }
    }
    for (const batch of retired) batch.due = true
    holds('settled')
    for (const { r } of members) r.state.close()
  })
}

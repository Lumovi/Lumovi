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
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { expect, test } from '@playwright/test'
import type { AuditLog } from '../../src/backend/audit/log.ts'
import type { ServerAccess } from '../../src/server/access.ts'
import { ClusterSettings, type ClusterEntry } from '../../src/server/cluster-settings.ts'
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
 * the test says (`written`), on `time`.
 */
async function replica(dir: string, key: Buffer, time: Clock) {
  const recorded: Recorded[] = []
  const state = await ServerState.open({ kind: 'file', path: join(dir, 'state.json') }, {}, key, {
    now: time.now,
    unopenedGraceMs: GRACE,
    writeAfterMs: 3_600_000,
  })
  const settings = new ClusterSettings(
    state,
    { administered: false, isAdmin: () => true } as unknown as ServerAccess,
    { record: (event: Recorded) => void recorded.push(event) } as unknown as AuditLog,
    { now: time.now },
  )
  settings.close()
  return {
    state,
    settings,
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
/** The name demo's settings are kept under, with `key`. */
const demoName = (key: Buffer) =>
  createHmac('sha256', Buffer.from(hkdfSync('sha256', key, 'lumovi', 'state names', 32)))
    .update('clusters\0demo')
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
    // Past it, the new key's replica lets the old key's go: what it opens is gone.
    time.turn(GRACE)
    await rolled.refreshed()
    expect(Object.keys(entries(dir))).not.toContain(demoName(key))
    expect(rolled.outside()).toEqual([])
    expect(rolled.settings.isReadOnly('demo')).toBe(true)
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
    const delay = monitorEventLoopDelay({ resolution: 1 })
    delay.enable()
    for (let round = 0; round < 3; round++) {
      keep(dir, junk())
      await a.settings.refresh()
    }
    delay.disable()
    // Opened a few hundred at a time: never long without the event loop let go.
    expect(delay.max / 1e6).toBeLessThan(50)
    expect(a.settings.isReadOnly('demo')).toBe(true)
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
for (const seed of SEEDS) {
  test(`seeded run ${seed}: the invariants hold after every step`, async () => {
    const rand = random(seed)
    const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!
    const dir = mkdtempSync(join(tmpdir(), 'lumovi-replicas-'))
    const time = clock()
    let key = randomBytes(32)
    const replicas: Replica[] = [await replica(dir, key, time), await replica(dir, key, time)]
    /**
     * What admins last set, through Lumovi, and the count of the write that set each: what
     * replicas that knew it (that write, or a later one) must hold to.
     */
    let truth: { readOnly: boolean; metrics?: typeof AUTO | typeof OFF } = { readOnly: false }
    const set = { readOnly: 0, metrics: 0 }
    /** Replicas that have known read-only on as last set (while it's on), and the metrics source. */
    const knowsOn = new Set<number>()
    const knowsMetrics = new Set<number>()
    /** Every copy of demo's entry Lumovi wrote, with its count: what can be put back. */
    const copies: { sealed: string; version: number }[] = []
    /** What the test did outside Lumovi: the counts of the copies put back, and deletions. */
    const made = new Set<number | null>()
    /** Old keys' entries, when they were retired, and whether a read past the grace has been. */
    let retired: { names: Set<string>; at: number; due: boolean }[] = []
    const log: string[] = []

    /** What's kept, as replica `i` (which just read or wrote it) sees it: a copy to put back. */
    const noteCopy = (i: number) => {
      const sealed = entries(dir)[demoName(key)]
      const version = replicas[i]!.demo()?.version
      if (sealed && version !== undefined && !copies.some((c) => c.sealed === sealed)) {
        copies.push({ sealed, version })
      }
    }
    /** What replica `i` knows now, by its view: what admins last set, or something newer. */
    const learn = (i: number) => {
      const view = replicas[i]!.demo()
      if (truth.readOnly && view?.readOnly && (view.counts?.readOnly ?? 0) >= set.readOnly) {
        knowsOn.add(i)
      }
      if (
        truth.metrics &&
        JSON.stringify(view?.metricsSource) === JSON.stringify(truth.metrics) &&
        (view?.counts?.metricsSource ?? 0) >= set.metrics
      ) {
        knowsMetrics.add(i)
      }
    }
    const holds = (step: string) => {
      log.push(step)
      const said = `seed ${seed}, after: ${log.join(' → ')}`
      // 1. Read-only, while admins have it on, on every replica that knew it on.
      if (truth.readOnly) {
        for (const i of knowsOn) expect(replicas[i]!.settings.isReadOnly('demo'), said).toBe(true)
      }
      // 2. The metrics source, as admins last set it, on every replica that knew it.
      for (const i of knowsMetrics) {
        expect(replicas[i]!.demo()?.metricsSource, said).toEqual(truth.metrics)
      }
      // 3 and 4. Every outside record names something the test did.
      for (const r of replicas) {
        for (const event of r.outside()) {
          expect(made.has(event.details?.found as number | null), said).toBe(true)
        }
      }
      // 5. What retired keys open is gone, once a read past the grace has been.
      const kept = Object.keys(entries(dir))
      for (const { names, due } of retired) {
        if (due)
          expect(
            kept.filter((name) => names.has(name)),
            said,
          ).toEqual([])
      }
    }

    for (let step = 0; step < 150; step++) {
      const i = Math.floor(rand() * replicas.length)
      const r = replicas[i]!
      const action = pick([
        'readOnly',
        'readOnly',
        'metrics',
        'refresh',
        'refresh',
        'refresh',
        'delete',
        'replay',
        'replay',
        'restart',
        'fail',
        'time',
        'rotate',
      ] as const)
      if (action === 'readOnly' || action === 'metrics' || action === 'fail') {
        if (action === 'fail') chmodSync(dir, 0o555)
        // An admin's change, made from this replica's view (which it may not have read lately).
        if (action === 'metrics') {
          const metrics = pick([AUTO, OFF])
          r.settings.setMetricsSource('demo', metrics, ADMIN)
          truth = { ...truth, metrics }
          knowsMetrics.clear()
        } else {
          const readOnly = rand() < 0.5
          r.settings.setReadOnly('demo', readOnly, ADMIN)
          if (readOnly !== truth.readOnly) knowsOn.clear()
          truth = { ...truth, readOnly }
        }
        if (action === 'fail') {
          await expect(r.written()).rejects.toThrow()
          chmodSync(dir, 0o755)
        }
        await r.written()
        if (action === 'metrics') set.metrics = r.demo()!.counts!.metricsSource!
        else set.readOnly = r.demo()!.counts!.readOnly!
        noteCopy(i)
        learn(i)
      } else if (action === 'refresh') {
        await r.refreshed()
        noteCopy(i)
        learn(i)
        for (const batch of retired) {
          if (time.now() - batch.at > GRACE) batch.due = true
        }
      } else if (action === 'delete') {
        const { [demoName(key)]: gone, ...rest } = entries(dir)
        if (gone) {
          keep(dir, rest)
          made.add(null)
        }
      } else if (action === 'replay') {
        if (copies.length) {
          const copy = pick(copies)
          keep(dir, { ...entries(dir), [demoName(key)]: copy.sealed })
          made.add(copy.version)
        }
      } else if (action === 'restart') {
        // Stopped as a server stops (what it hasn't written yet, written), and started again,
        // knowing nothing older: it takes what's kept as it finds it.
        await r.written()
        replicas[i] = await replica(dir, key, time)
        knowsOn.delete(i)
        knowsMetrics.delete(i)
      } else if (action === 'time') {
        time.turn(Math.floor(rand() * GRACE))
      } else if (action === 'rotate') {
        // Every replica to a new key at once: all that's kept is retired from now (what an older
        // key opens too: the new one can't tell them apart), and with it what was set.
        const names = new Set(Object.keys(entries(dir)))
        retired = retired.filter((batch) => {
          for (const name of names) batch.names.delete(name)
          return batch.names.size > 0
        })
        retired.push({ names, at: time.now(), due: false })
        key = randomBytes(32)
        for (let n = 0; n < replicas.length; n++) {
          await replicas[n]!.written()
          replicas[n] = await replica(dir, key, time)
        }
        truth = { readOnly: false }
        set.readOnly = set.metrics = 0
        knowsOn.clear()
        knowsMetrics.clear()
        copies.length = 0
      }
      holds(`${action}@${i}`)
    }
    // And past the last grace, once each replica reads and writes: nothing retired is left.
    time.turn(GRACE + 1)
    for (const r of replicas) await r.refreshed()
    for (const batch of retired) batch.due = true
    holds('settled')
  })
}

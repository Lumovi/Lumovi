/**
 * Two replicas over one kept state, as the server's own code has them (state.ts and
 * cluster-settings.ts over one file), each reading it again when the test says: the orders a
 * change made outside Lumovi can meet them in, which a running server leaves to its timers.
 */
import { createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { AuditLog } from '../../src/backend/audit/log.ts'
import type { ServerAccess } from '../../src/server/access.ts'
import { ClusterSettings, type ClusterEntry } from '../../src/server/cluster-settings.ts'
import { ServerState } from '../../src/server/state.ts'

const ADMIN = { name: 'admin@example.com', groups: [] }

/** A replica: its own view of the state kept in `dir`, sealed with `key`. */
async function replica(dir: string, key: Buffer) {
  const recorded: Parameters<AuditLog['record']>[0][] = []
  const state = await ServerState.open({ kind: 'file', path: join(dir, 'state.json') }, {}, key)
  const settings = new ClusterSettings(
    state,
    { administered: false, isAdmin: () => true } as unknown as ServerAccess,
    {
      record: (event: (typeof recorded)[number]) => void recorded.push(event),
    } as unknown as AuditLog,
  )
  // Read again only when the test says.
  settings.close()
  const demo = () => state.get<ClusterEntry>('clusters', 'demo')
  const outside = () => recorded.filter((event) => event.details?.outside === true)
  return { state, settings, demo, outside, written: () => state.flush({ strict: true }) }
}

/** What's kept in `dir`, by entry name; and demo's settings' name there, with `key`. */
const entries = (dir: string): Record<string, string> =>
  (JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { entries: Record<string, string> })
    .entries
const keep = (dir: string, kept: Record<string, string>) =>
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ entries: kept }))
const demoName = (key: Buffer) =>
  createHmac('sha256', Buffer.from(hkdfSync('sha256', key, 'lumovi', 'state names', 32)))
    .update('clusters\0demo')
    .digest('base64url')

const AUTO = { mode: 'auto' } as const
const OFF = { mode: 'off' } as const

test.describe('two replicas, one kept state', () => {
  let dir: string
  let key: Buffer
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumovi-replicas-'))
    key = randomBytes(32)
  })

  test('a stale replica’s fix counts below an admin’s newer change, which stands', async () => {
    const a = await replica(dir, key)
    const b = await replica(dir, key)
    // Changeable, as A made it: the copy kept. Then a metrics source, by A.
    a.settings.setReadOnly('demo', false, ADMIN)
    await a.written()
    const changeable = entries(dir)[demoName(key)]!
    a.settings.setMetricsSource('demo', OFF, ADMIN)
    await a.written()
    // B reads it, and an admin makes demo read-only there: A hasn't read that.
    await b.settings.refresh()
    b.settings.setReadOnly('demo', true, ADMIN)
    await b.written()

    // The changeable copy put back. A finds it first: from its older view, read-only isn't
    // what changed, only the metrics source, which it puts back.
    keep(dir, { ...entries(dir), [demoName(key)]: changeable })
    await a.settings.refresh()
    expect(a.outside().map((event) => event.action)).toEqual(['metrics-source.changed'])
    expect(a.demo()?.readOnly).toBeUndefined()
    // B knows better: A's fix counts below its change, so B fixes it from its own view.
    await b.settings.refresh()
    expect(b.outside()).toEqual([
      expect.objectContaining({
        action: 'read-only.changed',
        summary:
          'Changed outside Lumovi: demo’s read-only was turned off, as an older copy of its setting was put back where Lumovi keeps it, and Lumovi made it read-only again',
      }),
    ])
    expect(b.demo()).toMatchObject({ readOnly: { by: ADMIN.name }, metricsSource: OFF })
    // And A takes B's: read-only, as the admin made it.
    await a.settings.refresh()
    expect(a.demo()).toMatchObject({ readOnly: { by: ADMIN.name }, metricsSource: OFF })
    expect(a.outside()).toHaveLength(1)
  })

  test('an admin’s change, written over a copy put back meanwhile, is made over its fix', async () => {
    const a = await replica(dir, key)
    const b = await replica(dir, key)
    a.settings.setReadOnly('demo', false, ADMIN)
    await a.written()
    const changeable = entries(dir)[demoName(key)]!
    a.settings.setReadOnly('demo', true, ADMIN)
    await a.written()
    await b.settings.refresh()
    expect(b.demo()?.readOnly).toBeDefined()

    // The changeable copy put back, then an admin's change on B, which hasn't read it: its write
    // meets the copy (the file changed since B read it), and it's made over the copy's fix.
    keep(dir, { ...entries(dir), [demoName(key)]: changeable })
    b.settings.setMetricsSource('demo', AUTO, ADMIN)
    await b.written()
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
    await a.settings.refresh()
    expect(a.demo()).toMatchObject({ readOnly: { by: ADMIN.name }, metricsSource: AUTO })
    // Recorded once, by B alone.
    expect(a.outside()).toEqual([])
  })

  test('a change written after its replica read another’s newer one is made over theirs', async () => {
    const a = await replica(dir, key)
    const b = await replica(dir, key)
    a.settings.setReadOnly('demo', false, ADMIN)
    await a.written()
    await b.settings.refresh()
    b.settings.setReadOnly('demo', true, ADMIN)
    await b.written()

    // A changes the metrics source from its older view, and reads B's change before it writes
    // (no conflict, then: it read what it writes over). B's read-only stays.
    a.settings.setMetricsSource('demo', OFF, ADMIN)
    await a.settings.refresh()
    await a.written()
    await b.settings.refresh()
    for (const replica of [a, b]) {
      expect(replica.demo()).toMatchObject({ readOnly: { by: ADMIN.name }, metricsSource: OFF })
      expect(replica.outside()).toEqual([])
    }
  })

  test('replicas sealing with different keys (while keys are rotated) leave each other be', async () => {
    const other = randomBytes(32)
    const a = await replica(dir, key)
    const b = await replica(dir, other)
    a.settings.setReadOnly('demo', true, ADMIN)
    await a.written()
    // B can't open A's: it writes its own, and doesn't let A's go.
    b.settings.setReadOnly('demo', true, ADMIN)
    await b.written()
    expect(Object.keys(entries(dir))).toEqual(
      expect.arrayContaining([demoName(key), demoName(other)]),
    )
    // Neither takes the other's for something deleted: nothing's recorded, read-only stays.
    for (let round = 0; round < 3; round++) {
      await a.settings.refresh()
      await b.settings.refresh()
    }
    expect(a.outside()).toEqual([])
    expect(b.outside()).toEqual([])
    expect(a.demo()?.readOnly).toBeDefined()
    expect(b.demo()?.readOnly).toBeDefined()
  })
})

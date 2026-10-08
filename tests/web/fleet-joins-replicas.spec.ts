/**
 * Join tokens over replicas, as the server's own code has them (state.ts and joins.ts over one
 * file): a token works once, on whichever replica its agent reaches first, and only within its
 * time.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { expect, test } from '@playwright/test'
import type { AuditLog } from '../../src/backend/audit/log.ts'
import type { ServerAccess } from '../../src/server/access.ts'
import type { Joins } from '../../src/server/fleet/joins.ts'
import { ServerState } from '../../src/server/state.ts'

const ADMIN = { name: 'admin@example.com', groups: [] }
const ACTOR = { user: ADMIN.name, via: 'ui' } as const
const ACCESS = {
  administered: true,
  isAdmin: (user: { name: string }) => user.name === ADMIN.name,
} as unknown as ServerAccess

type Recorded = Parameters<AuditLog['record']>[0]

/** A replica's joins, over the state kept in `dir`, sealed with `key`. */
async function replica(dir: string, key: Buffer) {
  // (A token works for 4 seconds here: imported once that's set.)
  process.env.LUMOVI_FLEET_JOIN_SECONDS = '4'
  const { Joins } = await import('../../src/server/fleet/joins.ts')
  const state = await ServerState.open({ kind: 'file', path: join(dir, 'state.json') }, {}, key)
  const recorded: Recorded[] = []
  const joins: Joins = new Joins(
    state,
    ACCESS,
    { record: (event: Recorded) => recorded.push(event) } as unknown as AuditLog,
    () => false,
  )
  joins.close()
  return { joins, recorded }
}

test('a join token works once, on whichever replica its agent reaches first, and not once it’s expired', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-joins-'))
  const key = randomBytes(32)
  const a = await replica(dir, key)
  const b = await replica(dir, key)
  const request = { name: 'edge', labels: {}, groups: [] }
  const { token } = await a.joins.create(request, ADMIN, ACTOR)

  // Made on A, it's read on B as it's tried there; a token that isn't its isn't one.
  expect(await b.joins.check('edge', token)).toMatchObject({ join: { name: 'edge' } })
  expect(await b.joins.check('edge', `${token.slice(0, -1)}x`)).toEqual({ refused: 'unknown' })
  expect(await b.joins.check('lab', token)).toEqual({ refused: 'unknown' })

  // Used on both at once: one of them is its use.
  const used = await Promise.all([a.joins.spend('edge', token), b.joins.spend('edge', token)])
  expect(used.filter(Boolean)).toHaveLength(1)
  for (const { joins } of [a, b]) {
    expect(await joins.check('edge', token)).toEqual({ refused: 'used' })
    expect(await joins.spend('edge', token)).toBe(false)
  }
  expect([...a.recorded, ...b.recorded].filter((e) => e.action === 'agent.joined')).toHaveLength(1)
  // Each refused use is recorded (once a minute, for each join).
  expect(b.recorded.filter((e) => e.action === 'agent.join-refused')).toEqual([
    expect.objectContaining({ cluster: 'edge', details: expect.objectContaining({ why: 'used' }) }),
  ])

  // Past its time: refused, and not used, though nothing tried it before.
  const late = await a.joins.create({ ...request, name: 'lab' }, ADMIN, ACTOR)
  await sleep(4100)
  expect(await a.joins.spend('lab', late.token)).toBe(false)
  expect(await b.joins.check('lab', late.token)).toEqual({ refused: 'expired' })
  expect(
    b.recorded.filter((e) => e.action === 'agent.join-refused' && e.cluster === 'lab'),
  ).toEqual([
    expect.objectContaining({
      cluster: 'lab',
      details: expect.objectContaining({ why: 'expired' }),
    }),
  ])
})

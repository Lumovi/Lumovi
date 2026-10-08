/**
 * Join tokens over replicas, as the server's own code has them (state.ts and joins.ts over one
 * file): a token works once, on whichever replica its agent reaches first, and only within its
 * time.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
  return { joins, state, recorded }
}

/** The next time `state` writes, `first` happens just before: another replica's write, between. */
function before(state: ServerState, first: () => Promise<unknown>): void {
  const flush = state.flush.bind(state)
  state.flush = async (options) => {
    state.flush = flush
    await first()
    return flush(options)
  }
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

  // Given a credential for it on each (an agent that stopped half way, and joined again): only
  // the last works, on either, and its first connection is the join.
  const first = await a.joins.issue('edge', token)
  const last = await b.joins.issue('edge', token)
  if (!('credential' in first) || !('credential' in last)) throw new Error('No credential')
  expect(await a.joins.admit('edge', first.credential)).toBe(false)
  expect(a.joins.joined()).toEqual([])
  const joined = await Promise.all([
    a.joins.admit('edge', last.credential),
    b.joins.admit('edge', last.credential),
  ])
  expect(joined).toEqual([true, true])
  for (const { joins } of [a, b]) {
    expect(await joins.check('edge', token)).toEqual({ refused: 'used' })
    expect(await joins.issue('edge', token)).toEqual({ refused: 'used' })
    expect(await joins.admit('edge', first.credential)).toBe(false)
  }
  expect([...a.recorded, ...b.recorded].filter((e) => e.action === 'agent.joined')).toHaveLength(1)
  expect(b.joins.joined()).toEqual([
    expect.objectContaining({ name: 'edge', joined: expect.objectContaining({ by: ADMIN.name }) }),
  ])
  // Each refused use is recorded (once a minute, for each join).
  expect(b.recorded.filter((e) => e.action === 'agent.join-refused')).toEqual([
    expect.objectContaining({ cluster: 'edge', details: expect.objectContaining({ why: 'used' }) }),
  ])

  // Past its time: refused, and not used, though nothing tried it before.
  const late = await a.joins.create({ ...request, name: 'lab' }, ADMIN, ACTOR)
  const given = await a.joins.issue('lab', late.token)
  await sleep(4100)
  if (!('credential' in given)) throw new Error('No credential')
  expect(await a.joins.admit('lab', given.credential)).toBe(false)
  expect(await a.joins.issue('lab', late.token)).toEqual({ refused: 'expired' })
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

test('an older copy of a join, put back where it’s kept, isn’t taken again by a replica that saw it used', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-joins-'))
  const key = randomBytes(32)
  const a = await replica(dir, key)
  const b = await replica(dir, key)
  const { token } = await a.joins.create({ name: 'edge', labels: {}, groups: [] }, ADMIN, ACTOR)
  const given = await a.joins.issue('edge', token)
  if (!('credential' in given)) throw new Error('No credential')
  // As it was before its agent joined.
  const older = readFileSync(join(dir, 'state.json'), 'utf8')
  expect(await a.joins.admit('edge', given.credential)).toBe(true)
  // B reads it used (as any replica does, every few seconds).
  expect(await b.joins.check('edge', token)).toEqual({ refused: 'used' })

  writeFileSync(join(dir, 'state.json'), older)
  await b.state.refresh('joins')
  expect(b.joins.joined()).toEqual([])
  // Its token, nor the token it was given, joins again: refused before anything's written.
  expect(await b.joins.issue('edge', token)).toEqual({ refused: 'used' })
  expect(await b.joins.admit('edge', given.credential)).toBe(false)
  expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe(older)
})

test('a join used on another replica as one makes it again, or cancels it, is kept; the CA it pinned too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-joins-'))
  const key = randomBytes(32)
  const a = await replica(dir, key)
  const b = await replica(dir, key)
  const request = { name: 'edge', labels: {}, groups: [] }

  // Made again on A as its agent joins through B: A's is refused, B's join kept.
  const first = await a.joins.create(request, ADMIN, ACTOR)
  const given = await b.joins.issue('edge', first.token)
  if (!('credential' in given)) throw new Error('No credential')
  before(a.state, () => b.joins.admit('edge', given.credential))
  await expect(a.joins.create(request, ADMIN, ACTOR)).rejects.toThrow(
    'edge joined the fleet meanwhile, from another of Lumovi’s replicas: it’s in the fleet already.',
  )
  expect(a.joins.joined()).toEqual([expect.objectContaining({ name: 'edge' })])

  // Cancelled on A as its agent joins through B: refused, and not recorded as cancelled.
  const lab = await a.joins.create({ ...request, name: 'lab' }, ADMIN, ACTOR)
  // (B reads it, as it does every few seconds.)
  await b.state.refresh('joins')
  const labGiven = await b.joins.issue('lab', lab.token)
  if (!('credential' in labGiven)) throw new Error('No credential')
  before(a.state, () => b.joins.admit('lab', labGiven.credential))
  await expect(a.joins.cancel('lab', ADMIN, ACTOR)).rejects.toThrow(
    'lab’s agent joined meanwhile, through another of Lumovi’s replicas: it’s in the fleet.',
  )
  expect(a.joins.joined().map((agent) => agent.name)).toEqual(['edge', 'lab'])
  expect(a.recorded.filter((event) => event.action === 'agent.join-cancelled')).toEqual([])

  // Its agent's first connection, through two replicas at once: the one that lost leaves the
  // certificate authority the winner's agent pinned as it is.
  const late = await a.joins.create({ ...request, name: 'late' }, ADMIN, ACTOR)
  const lateGiven = await a.joins.issue('late', late.token)
  if (!('credential' in lateGiven)) throw new Error('No credential')
  await b.state.refresh('joins')
  const pin = { ca: ['ab'.repeat(32)], at: new Date().toISOString() }
  before(a.state, async () => {
    await b.joins.admit('late', lateGiven.credential)
    b.state.set('agents', 'late', pin)
    await b.state.flush({ strict: true })
  })
  expect(await a.joins.admit('late', lateGiven.credential)).toBe(true)
  await a.state.refresh('agents')
  expect(a.state.get('agents', 'late')).toEqual(pin)
})

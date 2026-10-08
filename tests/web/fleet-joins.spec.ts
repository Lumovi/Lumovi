/**
 * Clusters connected from the Fleet page: an admin names one, and the hub makes a join token for
 * its agent, shown once, that works once and for an hour. Only its SHA-256 is kept, and only the
 * start of that recorded.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { FleetJoinRequest } from '../../src/shared/fleet.ts'
import { FLEET } from '../mock-cluster/fleet.ts'
import { audited, expect, freePort, test } from './fixtures.ts'
import { as, card, fleetEnv } from './fleet.ts'

const EDGE = 'edge-ap-south'

/** What a fleet call from the page gives, or its error's message. */
const call = (
  page: Page,
  method: 'joins' | 'connect' | 'cancelJoin',
  ...args: unknown[]
): Promise<{ value?: unknown; error?: string }> =>
  page.evaluate(
    ([method, args]) =>
      (window.lumovi!.fleet![method] as (...args: unknown[]) => Promise<unknown>)(...args).then(
        (value) => ({ value }),
        (error: Error) => ({ error: error.message }),
      ),
    [method, args] as const,
  )

/** A token's SHA-256, as the audit log has it: its start. */
const recorded = (token: string) =>
  `${createHash('sha256').update(token).digest('hex').slice(0, 8)}…`

test('an admin makes a join token: shown once, kept by its hash, and recorded', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const data = mkdtempSync(join(tmpdir(), 'lumovi-joins-'))
  const env = {
    ...fleetEnv(clusters),
    LUMOVI_ADMINS: 'user:admin@example.com',
    LUMOVI_DATA_DIR: data,
  }
  const port = await freePort()
  const hub = await serve({ port, env })
  await as(context, 'admin@example.com')
  await page.goto(hub.url)
  await expect(card(page, FLEET.prodEu)).toBeVisible()
  expect(await call(page, 'joins')).toEqual({ value: { joins: [] } })

  const request: FleetJoinRequest = {
    name: EDGE,
    labels: { env: 'production', network: 'private' },
    groups: ['sre', 'sre'],
  }
  const made = (await call(page, 'connect', request)).value as { token: string; join: unknown }
  expect(made.token).toMatch(/^lumovi_join_[A-Za-z0-9_-]{43}$/)
  const joining = {
    name: EDGE,
    labels: { env: 'production', network: 'private' },
    groups: ['sre'],
    by: 'admin@example.com',
    at: expect.any(String),
    until: expect.any(String),
  }
  expect(made.join).toEqual(joining)
  const { at, until } = made.join as { at: string; until: string }
  // It works for an hour.
  expect(Date.parse(until) - Date.parse(at)).toBe(3_600_000)
  expect(await call(page, 'joins')).toEqual({ value: { joins: [made.join] } })
  expect(audited(hub, 'agent.join-created')).toEqual([
    expect.objectContaining({
      outcome: 'success',
      cluster: EDGE,
      actor: expect.objectContaining({ user: 'admin@example.com' }),
      details: {
        labels: ['env=production', 'network=private'],
        groups: ['sre'],
        until,
        token: recorded(made.token),
      },
    }),
  ])
  await hub.stop()
  // The token itself is nowhere: not in the log, nor where the state is kept.
  expect(hub.log()).not.toContain(made.token)
  expect(readFileSync(join(data, 'state.json'), 'utf8')).not.toContain(made.token)

  // Kept: a restart doesn't forget it.
  const again = await serve({ port, env })
  await page.goto(again.url)
  expect(await call(page, 'joins')).toEqual({ value: { joins: [made.join] } })
  // Made again (its command lost, say): a new token, and the old one no longer works.
  const remade = (await call(page, 'connect', { ...request, groups: [] })).value as {
    token: string
  }
  expect(remade.token).not.toBe(made.token)
  expect(await call(page, 'joins')).toEqual({
    value: { joins: [{ ...joining, groups: [] }] },
  })
  expect(audited(again, 'agent.join-created')).toEqual([
    expect.objectContaining({
      details: expect.objectContaining({
        token: recorded(remade.token),
        replaced: recorded(made.token),
      }),
    }),
  ])

  // Cancelled: gone, and recorded.
  expect(await call(page, 'cancelJoin', EDGE)).toEqual({})
  expect(await call(page, 'joins')).toEqual({ value: { joins: [] } })
  expect(audited(again, 'agent.join-cancelled')).toEqual([
    expect.objectContaining({
      cluster: EDGE,
      actor: expect.objectContaining({ user: 'admin@example.com' }),
      details: { token: recorded(remade.token) },
    }),
  ])
  expect(await call(page, 'cancelJoin', EDGE)).toEqual({
    error: `No cluster called ${EDGE} is being connected.`,
  })
  expect(again.log()).not.toContain(remade.token)
})

test('only admins connect clusters, where the server keeps them, with names the fleet doesn’t have', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const env = {
    ...fleetEnv(clusters),
    LUMOVI_ADMINS: 'user:admin@example.com',
    LUMOVI_DATA_DIR: mkdtempSync(join(tmpdir(), 'lumovi-joins-')),
  }
  const hub = await serve({ env })
  const request = { name: EDGE, labels: {}, groups: [] }

  // Someone who isn't an admin: refused, and their try recorded.
  await as(context, 'alice@example.com')
  await page.goto(hub.url)
  await expect(card(page, FLEET.prodEu)).toBeVisible()
  const notAdmin = 'Only Lumovi’s admins connect clusters to the fleet.'
  expect(await call(page, 'joins')).toEqual({ error: notAdmin })
  expect(await call(page, 'connect', request)).toEqual({ error: notAdmin })
  expect(await call(page, 'cancelJoin', EDGE)).toEqual({ error: notAdmin })
  expect(audited(hub, 'agent.join-created')).toEqual([
    expect.objectContaining({
      outcome: 'refused',
      cluster: EDGE,
      actor: expect.objectContaining({ user: 'alice@example.com' }),
      error: notAdmin,
    }),
  ])

  // An admin's request, checked as the page checks it.
  await as(context, 'admin@example.com')
  await page.reload()
  const refused = async (wanted: object) =>
    (await call(page, 'connect', { ...request, ...wanted })).error
  expect(await refused({ name: 'Edge_AP' })).toBe(
    'Its name: Up to 63 lowercase letters, digits or “-”, starting and ending with a letter or digit.',
  )
  expect(await refused({ name: undefined })).toBe('Give the cluster a name.')
  expect(await refused({ labels: { '-env': 'x' } })).toBe(
    'Its label -env: Up to 63 letters, digits, “-”, “_” or “.”, starting and ending with a letter or digit.',
  )
  expect(await refused({ labels: { env: 'pro duction' } })).toBe(
    'Its label env: Up to 63 letters, digits, “-”, “_” or “.”, starting and ending with a letter or digit.',
  )
  expect(await refused({ labels: ['env'] })).toBe(
    'Its labels must be a map of text, like { env: production }.',
  )
  expect(await refused({ groups: 'sre' })).toBe(
    'Its groups must be a list of text, like [platform, sre].',
  )
  expect(await refused({ groups: [' '] })).toBe('Its group “ ”: Enter a group.')
  expect(await refused({ groups: ['sre​'] })).toBe('Its group “sre​”: No control characters.')
  expect(await refused({ groups: Array.from({ length: 51 }, (_, i) => `g${i}`) })).toBe(
    'Up to 50 groups may see it.',
  )
  // A name the fleet has: another source's cluster keeps it.
  expect(await refused({ name: FLEET.prodEu })).toBe(
    `The fleet has a cluster called ${FLEET.prodEu} already: give this one another name.`,
  )
  expect(await call(page, 'joins')).toEqual({ value: { joins: [] } })
  // (Only the refused try was recorded.)
  expect(audited(hub, 'agent.join-created')).toHaveLength(1)
  await hub.stop()

  // A server that keeps nothing would forget them when it restarts.
  const forgets = await serve({
    env: { ...fleetEnv(clusters), LUMOVI_ADMINS: 'user:admin@example.com' },
  })
  await page.goto(forgets.url)
  const unkept =
    'This server keeps nothing when it restarts, so it would forget the clusters connected here: keep its state (the chart’s auth.keepSessions, or LUMOVI_DATA_DIR).'
  expect(await call(page, 'joins')).toEqual({ value: { joins: [], whyNot: unkept } })
  expect(await call(page, 'connect', request)).toEqual({ error: unkept })
  await forgets.stop()

  // A server without admins connects none: anyone signed in would.
  const unadministered = await serve({
    env: { ...fleetEnv(clusters), LUMOVI_DATA_DIR: mkdtempSync(join(tmpdir(), 'lumovi-joins-')) },
  })
  await page.goto(unadministered.url)
  const noAdmins =
    'Clusters are connected from this page by Lumovi’s admins, and it has none: name them in LUMOVI_ADMINS (the chart’s access.admins).'
  expect(await call(page, 'joins')).toEqual({ error: noAdmins })
  expect(await call(page, 'connect', request)).toEqual({ error: noAdmins })
})

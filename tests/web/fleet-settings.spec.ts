/**
 * A fleet's clusters' settings on its Fleet page: the name each is shown by, its labels and its
 * groups (who sees it, besides admins), set by its admins where its source leaves them unset,
 * kept in Lumovi's own state, and recorded.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { FLEET } from '../mock-cluster/fleet.ts'
import { audited, expect, freePort, test } from './fixtures.ts'
import { as, fleetEnv } from './fleet.ts'

/** What a fleet call from the page gives, or its error's message. */
const call = (
  page: Page,
  method: 'settings' | 'saveSettings',
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

/** The clusters someone sees, by name, with the name each is shown by. */
const seen = (page: Page) =>
  page.evaluate(() =>
    window
      .lumovi!.kube.contexts()
      .then(({ contexts }) =>
        Object.fromEntries(contexts.map((context) => [context.name, context.title ?? null])),
      ),
  )

const FROM_KUBECONFIG = {
  by: `the fleet’s kubeconfig, context ${FLEET.prodEu}`,
  key: 'lumovi.dev extension',
}

test('admins name, label and share clusters; what a source sets stays its own', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const env = {
    // Staging's kubeconfig doesn't label it: the page may.
    ...fleetEnv(clusters, { [FLEET.staging]: { labels: undefined } }),
    LUMOVI_ADMINS: 'user:admin@example.com',
    LUMOVI_DATA_DIR: mkdtempSync(join(tmpdir(), 'lumovi-fleet-settings-')),
  }
  const port = await freePort()
  const hub = await serve({ port, env })
  await as(context, 'admin@example.com')
  await page.goto(hub.url)
  expect(await call(page, 'settings', FLEET.prodEu)).toEqual({
    value: {
      name: FLEET.prodEu,
      title: {},
      labels: { value: { env: 'production', region: 'eu-west' }, managed: FROM_KUBECONFIG },
      groups: { value: [] },
      origin: { kind: 'kubeconfig', where: 'LUMOVI_FLEET_KUBECONFIG', context: FLEET.prodEu },
      removable: false,
    },
  })
  // Its labels are its kubeconfig's: changed there, not here.
  expect(await call(page, 'saveSettings', FLEET.prodEu, { labels: { env: 'dev' } })).toEqual({
    error: `Its labels are set by the fleet’s kubeconfig, context ${FLEET.prodEu}, in lumovi.dev extension: change them there.`,
  })
  // Its name as shown, and who sees it, are the page's.
  expect(
    await call(page, 'saveSettings', FLEET.prodEu, {
      title: ' Production EU ',
      groups: ['sre', 'sre'],
    }),
  ).toEqual({
    value: expect.objectContaining({
      title: { value: 'Production EU' },
      labels: { value: { env: 'production', region: 'eu-west' }, managed: FROM_KUBECONFIG },
      groups: { value: ['sre'] },
    }),
  })
  expect(
    await call(page, 'saveSettings', FLEET.staging, {
      title: FLEET.staging,
      labels: { env: 'staging', team: 'web' },
      groups: [],
    }),
  ).toEqual({
    value: expect.objectContaining({
      title: {},
      labels: { value: { env: 'staging', team: 'web' } },
      groups: { value: [] },
    }),
  })
  // Admins see them all, as they're named.
  expect(await seen(page)).toEqual({
    [FLEET.prodEu]: 'Production EU',
    [FLEET.prodUs]: null,
    [FLEET.staging]: null,
    [FLEET.edge]: null,
  })
  const labels = await page.evaluate(() => window.lumovi!.kube.contexts())
  expect(labels.contexts.find((c) => c.name === FLEET.staging)?.labels).toEqual({
    env: 'staging',
    team: 'web',
  })
  expect(
    audited(hub, 'cluster-settings.changed').map((event) => [
      event.outcome,
      event.cluster,
      event.summary,
      event.details,
    ]),
  ).toEqual([
    [
      'success',
      FLEET.prodEu,
      `Changed ${FLEET.prodEu}’s settings on the Fleet page: seen by sre, besides admins (was everyone signed in)`,
      {
        title: 'Production EU',
        labels: ['env=production', 'region=eu-west'],
        groups: ['sre'],
        groupsWere: [],
      },
    ],
    [
      'success',
      FLEET.staging,
      `Changed ${FLEET.staging}’s settings on the Fleet page`,
      { title: null, labels: ['env=staging', 'team=web'], groups: [], groupsWere: [] },
    ],
  ])

  // Who sees prod-eu now: those in sre; not others, who can't reach it either.
  await as(context, 'alice@example.com', 'developers')
  await page.reload()
  expect(Object.keys(await seen(page))).toEqual([FLEET.prodUs, FLEET.staging, FLEET.edge])
  expect(
    await page.evaluate((name) => window.lumovi!.kube.version(name), FLEET.prodEu),
  ).toMatchObject({ ok: false, error: { code: 'not-found' } })
  await as(context, 'sam@example.com', 'sre')
  await page.reload()
  expect(await seen(page)).toMatchObject({ [FLEET.prodEu]: 'Production EU' })

  // Kept: a restart doesn't forget them.
  await hub.stop()
  const again = await serve({ port, env })
  await page.goto(again.url)
  expect(await seen(page)).toMatchObject({ [FLEET.prodEu]: 'Production EU' })
  await as(context, 'alice@example.com', 'developers')
  await page.reload()
  expect(Object.keys(await seen(page))).not.toContain(FLEET.prodEu)

  // Back to everyone, as its own name.
  await as(context, 'admin@example.com')
  await page.reload()
  expect(await call(page, 'saveSettings', FLEET.prodEu, { title: '', groups: [] })).toEqual({
    value: expect.objectContaining({ title: {}, groups: { value: [] } }),
  })
  expect(audited(again, 'cluster-settings.changed')).toEqual([
    expect.objectContaining({
      summary: `Changed ${FLEET.prodEu}’s settings on the Fleet page: seen by everyone signed in, besides admins (was sre)`,
    }),
  ])
})

test('only admins see and change a cluster’s settings, where Lumovi has some', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const hub = await serve({
    env: { ...fleetEnv(clusters), LUMOVI_ADMINS: 'user:admin@example.com' },
  })
  await as(context, 'alice@example.com')
  await page.goto(hub.url)
  const notAdmin = 'Only Lumovi’s admins change a cluster’s settings on the Fleet page.'
  expect(await call(page, 'settings', FLEET.prodEu)).toEqual({ error: notAdmin })
  expect(await call(page, 'saveSettings', FLEET.prodEu, { groups: ['alice'] })).toEqual({
    error: notAdmin,
  })
  expect(audited(hub, 'cluster-settings.changed')).toEqual([
    expect.objectContaining({
      outcome: 'refused',
      cluster: FLEET.prodEu,
      actor: expect.objectContaining({ user: 'alice@example.com' }),
      error: notAdmin,
    }),
  ])

  // An admin's, checked.
  await as(context, 'admin@example.com')
  await page.reload()
  const refused = async (setting: object, name: string = FLEET.staging) =>
    (await call(page, 'saveSettings', name, setting)).error
  expect(await refused({}, 'nowhere')).toBe('This server has no cluster called “nowhere”.')
  expect(await refused({ title: 'Prod\u0000' })).toBe('Its name: No control characters.')
  expect(await refused({ title: 'x'.repeat(101) })).toBe('Its name: Up to 100 characters.')
  expect(await refused({ title: 7 })).toBe('Its name must be text.')
  expect(await refused({ groups: [''] })).toBe('Its group “”: Enter a group.')
  expect((await call(page, 'settings', 'nowhere')).error).toBe(
    'This server has no cluster called “nowhere”.',
  )
  await hub.stop()

  // Without admins, nobody: who sees a cluster is theirs to say.
  const unadministered = await serve({ env: fleetEnv(clusters) })
  await page.goto(unadministered.url)
  const noAdmins =
    'A cluster’s settings are changed on this page by Lumovi’s admins, and it has none: name them in LUMOVI_ADMINS (the chart’s access.admins).'
  expect(await call(page, 'settings', FLEET.prodEu)).toEqual({ error: noAdmins })
  expect(await call(page, 'saveSettings', FLEET.prodEu, {})).toEqual({ error: noAdmins })
})

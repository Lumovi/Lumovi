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
import { as, card, fleetEnv } from './fleet.ts'

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

test('an admin changes a cluster’s settings from its card; what its source sets is shown, locked', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const hub = await serve({
    env: {
      ...fleetEnv(clusters),
      LUMOVI_ADMINS: 'user:admin@example.com',
      LUMOVI_DATA_DIR: mkdtempSync(join(tmpdir(), 'lumovi-fleet-settings-')),
    },
  })
  // Someone else sees no ⋯.
  await as(context, 'alice@example.com')
  await page.goto(hub.url)
  await expect(card(page, FLEET.prodEu)).toBeVisible()
  await expect(page.getByRole('button', { name: `${FLEET.prodEu}’s actions` })).toHaveCount(0)

  await as(context, 'admin@example.com')
  await page.reload()
  const actions = page.getByRole('button', { name: `${FLEET.prodEu}’s actions` })
  // Outside the card's link.
  await expect(card(page, FLEET.prodEu).getByRole('button')).toHaveCount(0)
  await actions.click()
  await expect(page.getByRole('menuitem')).toHaveText(['Open', 'Settings…', 'Copy its name'])
  await page.getByRole('menuitem', { name: 'Settings…' }).click()
  const dialog = page.getByRole('dialog', { name: FLEET.prodEu })
  await expect(dialog).toContainText(`Comes from the fleet’s kubeconfig, context ${FLEET.prodEu}`)
  // Its labels are its kubeconfig's: shown, locked, with where to change them.
  await expect(dialog).toContainText(
    `env=productionregion=eu-westSet by the fleet’s kubeconfig, context ${FLEET.prodEu}, in lumovi.dev extension. Change it there.`,
  )
  await expect(dialog.getByRole('textbox', { name: 'Add a label' })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Remove env=production' })).toHaveCount(0)
  await expect(dialog).toContainText(
    'Who sees it, besides admins: with none, everyone signed in. A change applies at once.',
  )
  await expect(dialog).toContainText(
    `Comes fromKubeconfigThe fleet’s kubeconfig, context ${FLEET.prodEu}. What it sets is shown, not changed, here; it can’t be removed from this page.`,
  )
  await expect(dialog).toContainText('Recorded in the audit log')

  // A name, too long, then one that fits; a group, with one that can't be one refused.
  const name = dialog.getByLabel('Name')
  await name.fill('x'.repeat(101))
  await expect(dialog).toContainText('Up to 100 characters.')
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
  await name.fill('Production EU')
  const groups = dialog.getByRole('textbox', { name: 'Add a group' })
  await groups.fill('sre​')
  await groups.press('Enter')
  await expect(dialog.getByRole('alert')).toHaveText('No control characters.')
  await groups.fill('sre')
  await groups.press('Enter')
  await groups.fill('platform,')
  await groups.press(',')
  await expect(dialog.getByRole('button', { name: /^Remove / })).toHaveCount(2)
  await groups.press('Backspace')
  await expect(dialog.getByRole('button', { name: 'Remove sre' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Remove platform' })).toHaveCount(0)
  await expect(dialog).toContainText('Who sees it, besides admins. A change applies at once.')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    'Saved Production EU’s settings',
  )
  // Its card is called so now, its own name beside, and found by either.
  await expect(card(page, `Production EU \\(${FLEET.prodEu}\\)`)).toContainText(
    `Production EU${FLEET.prodEu}`,
  )
  await page.getByPlaceholder('Search clusters and labels…').fill('production eu')
  await expect(page.locator('[data-cluster-card]')).toHaveCount(1)
  expect(audited(hub, 'cluster-settings.changed')).toEqual([
    expect.objectContaining({
      details: expect.objectContaining({ title: 'Production EU', groups: ['sre'] }),
    }),
  ])

  // Opened again: as it was saved.
  await page.getByRole('button', { name: 'Production EU’s actions' }).click()
  await page.getByRole('menuitem', { name: 'Settings…' }).click()
  const again = page.getByRole('dialog', { name: 'Production EU' })
  await expect(again.getByLabel('Name')).toHaveValue('Production EU')
  await expect(again.getByRole('button', { name: 'Remove sre' })).toBeVisible()
  await again.getByRole('button', { name: 'Cancel' }).click()
  await expect(again).toHaveCount(0)
})

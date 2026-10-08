/**
 * A fleet's clusters' settings on its Fleet page: the name each is shown by, its labels and its
 * groups (who sees it, besides admins), set by its admins where its source leaves them unset,
 * kept in Lumovi's own state, and recorded.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
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
  by: 'the fleet’s kubeconfig',
  in: [{ key: 'lumovi.dev', context: FLEET.prodEu }],
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
      origin: {
        kind: 'kubeconfig',
        where: 'LUMOVI_FLEET_KUBECONFIG',
        context: FLEET.prodEu,
        server: clusters.demo.url,
      },
      removable: false,
    },
  })
  // Its labels are its kubeconfig's: changed there, not here.
  expect(await call(page, 'saveSettings', FLEET.prodEu, { labels: { env: 'dev' } })).toEqual({
    error: `Its labels are set by the fleet’s kubeconfig, in the lumovi.dev extension of context ${FLEET.prodEu}: change them there.`,
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
  // Its name as shown is its own: not another's name, nor what another is shown by.
  expect(await refused({ title: 'PROD-EU' })).toBe(
    'Its name: another cluster is called PROD-EU. Give it a name of its own.',
  )
  expect((await call(page, 'saveSettings', FLEET.prodUs, { title: 'Production' })).error).toBe(
    undefined,
  )
  expect(await refused({ title: 'production' })).toBe(
    `Its name: ${FLEET.prodUs} is shown as production. Give it a name of its own.`,
  )
  expect(
    (await call(page, 'saveSettings', FLEET.prodUs, { title: 'Production' })).error,
  ).toBeUndefined()
  // A field not given stays as it was; given empty, it's unset.
  expect(await call(page, 'saveSettings', FLEET.prodUs, { groups: ['sre'] })).toEqual({
    value: expect.objectContaining({ title: { value: 'Production' }, groups: { value: ['sre'] } }),
  })
  expect(await call(page, 'saveSettings', FLEET.prodUs, { title: '' })).toEqual({
    value: expect.objectContaining({ title: {}, groups: { value: ['sre'] } }),
  })
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
    `env=productionregion=eu-westSet by the fleet’s kubeconfig, in the lumovi.dev extension of context ${FLEET.prodEu}. Change it there.`,
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
  // Nothing set yet, it doesn't say it's set here.
  await expect(dialog).not.toContainText('Set on this page.')

  // A name, too long, then one that fits; a group, with one that can't be one refused.
  const name = dialog.getByLabel('Name')
  await name.fill('x'.repeat(101))
  await expect(dialog).toContainText('Up to 100 characters.')
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
  await name.fill('Production EU')
  await expect(dialog.locator('#fleet-cluster-title-from')).toHaveText('Set on this page.')
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

test('what the page set for a cluster isn’t another’s that comes by its name from elsewhere', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-fleet-files-'))
  const [first, second] = [join(dir, 'first.json'), join(dir, 'second.json')]
  const kubeconfig = (contexts: string[]) =>
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: contexts.map((name) => ({
        name,
        cluster: {
          server: clusters.demo.url,
          'certificate-authority-data': Buffer.from(clusters.demo.caPem!).toString('base64'),
        },
      })),
      users: [{ name: 'hub', user: { token: 'lumovi-demo-token' } }],
      contexts: contexts.map((name) => ({ name, context: { cluster: name, user: 'hub' } })),
    })
  writeFileSync(first, kubeconfig(['lab']))
  writeFileSync(second, kubeconfig(['other']))
  const hub = await serve({
    env: {
      LUMOVI_AUTH: 'proxy',
      LUMOVI_FLEET_KUBECONFIG_FILE: [first, second].join(delimiter),
      LUMOVI_FLEET_REFRESH_SECONDS: '1',
      LUMOVI_ADMINS: 'user:admin@example.com',
      LUMOVI_DATA_DIR: mkdtempSync(join(tmpdir(), 'lumovi-fleet-settings-')),
    },
  })
  await as(context, 'admin@example.com')
  await page.goto(hub.url)
  await call(page, 'saveSettings', 'lab', {
    title: 'Lab',
    labels: { env: 'staging' },
    groups: ['qa'],
  })
  const lab = async () =>
    (await page.evaluate(() => window.lumovi!.kube.contexts())).contexts.find(
      (c) => c.name === 'lab',
    )
  expect(await lab()).toMatchObject({ title: 'Lab', labels: { env: 'staging' } })

  // A cluster that comes by the name it's shown by: lab is shown by its own again. (A field not
  // given stays as it was.)
  await call(page, 'saveSettings', 'lab', { title: 'Later' })
  expect(await lab()).toMatchObject({ title: 'Later', labels: { env: 'staging' } })
  writeFileSync(second, kubeconfig(['other', 'later']))
  await expect.poll(async () => (await lab())?.title).toBeUndefined()
  await call(page, 'saveSettings', 'lab', {
    title: 'Lab',
    labels: { env: 'staging' },
    groups: ['qa'],
  })
  expect(await lab()).toMatchObject({ title: 'Lab', labels: { env: 'staging' } })

  // Another lab, from the other file: none of it is its.
  writeFileSync(first, kubeconfig([]))
  writeFileSync(second, kubeconfig(['other', 'lab']))
  await expect.poll(async () => (await lab())?.labels).toEqual({})
  expect((await lab())?.title).toBeUndefined()
  // Who saw the other was restricted: this one, until an admin says, only admins see.
  expect(await call(page, 'settings', 'lab')).toEqual({
    value: expect.objectContaining({
      title: {},
      labels: { value: {} },
      groups: { value: [] },
      adminsOnly: true,
      origin: { kind: 'kubeconfig', where: second, context: 'lab', server: clusters.demo.url },
    }),
  })
  // Let go, and recorded, by Lumovi.
  await expect
    .poll(() => audited(hub, 'cluster-settings.changed').map((e) => [e.actor.user, e.summary]))
    .toContainEqual([
      'lumovi',
      'Let go of what the Fleet page set for lab: it was set for another cluster by that name, and this one comes from elsewhere. Only admins see it until one of them saves its settings',
    ])
  await as(context, 'alice@example.com')
  await page.reload()
  expect(await lab()).toBeUndefined()
  // Saved without its groups (its name, say), it stays admins' alone.
  await as(context, 'admin@example.com')
  await page.reload()
  await call(page, 'saveSettings', 'lab', { title: 'New lab' })
  expect((await call(page, 'settings', 'lab')).value).toMatchObject({ adminsOnly: true })
  await as(context, 'alice@example.com')
  await page.reload()
  expect(await lab()).toBeUndefined()
  // An admin says who sees it: everyone.
  await as(context, 'admin@example.com')
  await page.reload()
  await call(page, 'saveSettings', 'lab', { groups: [] })
  expect((await call(page, 'settings', 'lab')).value).not.toHaveProperty('adminsOnly')
  await as(context, 'alice@example.com')
  await page.reload()
  expect(await lab()).toBeDefined()
})

test('a cluster its source gives no groups is an admin’s alone, as its settings say', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const hub = await serve({
    env: {
      ...fleetEnv(clusters, { [FLEET.edge]: { groups: [] } }),
      LUMOVI_ADMINS: 'user:admin@example.com',
    },
  })
  await as(context, 'alice@example.com')
  await page.goto(hub.url)
  await expect(card(page, FLEET.prodEu)).toBeVisible()
  await expect(card(page, FLEET.edge)).toHaveCount(0)
  await as(context, 'admin@example.com')
  await page.reload()
  await page.getByRole('button', { name: `${FLEET.edge}’s actions` }).click()
  await page.getByRole('menuitem', { name: 'Settings…' }).click()
  const dialog = page.getByRole('dialog', { name: FLEET.edge })
  await expect(dialog).toContainText(
    `NoneSet by the fleet’s kubeconfig, in the lumovi.dev extension of context ${FLEET.edge}. Change it there.Only admins see it: its source gives it no groups.`,
  )
})

test('a dialog opened from a menu keeps the focus: a card’s Settings, then Connect', async ({
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
  await as(context, 'admin@example.com')
  await page.goto(hub.url)
  await expect(card(page, FLEET.prodEu)).toContainText('Nodes')
  await page.getByRole('button', { name: `${FLEET.prodEu}’s actions` }).click()
  await page.getByRole('menuitem', { name: 'Settings…' }).click()
  await expect(page.getByRole('dialog')).toContainText('Comes from')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Add cluster' }).click()
  await page.getByRole('menuitem', { name: /^Connect with an agent…/ }).click()
  const form = page.getByRole('dialog', { name: 'Connect a cluster' })
  await form.getByLabel('Name').fill('edge-eu-north')
  // Typed, then Enter: it's a group (a menu's button didn't take the focus meanwhile, making it
  // one early), and the dialog waits for its button.
  const group = form.getByRole('textbox', { name: 'Add a group' })
  await group.fill('platform')
  await expect(group).toBeFocused()
  await expect(group).toHaveValue('platform')
  await group.press('Enter')
  await expect(form.getByRole('button', { name: 'Remove platform' })).toBeVisible()
  await expect(form).toBeVisible()
})

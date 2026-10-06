/**
 * Who may do what through Lumovi, on a server: what everyone signed in
 * gets, what grants give groups where they say, and limits nothing loosens;
 * the Admin pages its admins set them on, saved together and recorded;
 * what each person may do, and why; and refusals where they happen, decided
 * by the server whatever the page shows.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from '@playwright/test'
import { parse } from 'yaml'
import { startMockOidc } from '../mock-oidc/server.ts'
import { call, connect } from './assistant-client.ts'
import { as, fleetEnv } from './fleet.ts'
import {
  audited,
  DEMO,
  DEMO_TOKEN,
  expect,
  freePort,
  inCluster,
  PEOPLE,
  refusedConfig,
  signIn,
  test,
} from './fixtures.ts'

test('with no admins, everyone may do all their RBAC allows', async ({ page, serve }) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  // Nobody administers it: no way into the Admin pages, and theirs to see.
  await expect(page.getByRole('button', { name: 'Admin: who may do what' })).toHaveCount(0)
  await page.getByRole('button', { name: `Signed in as ${PEOPLE.alice.user.username}` }).click()
  const account = page.getByRole('dialog', { name: 'Account' })
  await expect(account.getByRole('link', { name: 'Admin' })).toHaveCount(0)
  await account.getByRole('link', { name: /^Your access/ }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Your accessWhat Lumovi lets you do, and why.',
  )
  const demo = page.getByRole('row', { name: /^demo/ })
  await expect(demo.getByRole('cell')).toHaveText([
    /^Make changeseverywhere/,
    /^Open themeverywhere/,
    /^Open themeveryone gets it/,
    /^Read themeverywhere/,
    /^Valueseverywhere/,
    /^Install, uninstalleverywhere/,
    /^As they set themeverywhere/,
  ])
  await expect(page.getByText('Everywhere: your own events in the audit log.')).toBeVisible()
  await expect(page.getByRole('note').or(page.getByText('Need more?'))).toContainText(
    'Need more? Lumovi’s admins decide it.',
  )

  await page.goto(`${served.url}access`)
  await expect(page.getByRole('heading', { name: 'Only Lumovi’s admins see this' })).toBeVisible()
  await expect(page.getByText('The server names nobody as an admin (LUMOVI_ADMINS).')).toBeVisible()
  // Nor does the server tell anyone but an admin.
  for (const call of [
    () => window.lumovi!.access!.admin() as Promise<unknown>,
    () => window.lumovi!.access!.set({} as never, '') as Promise<unknown>,
    () => window.lumovi!.access!.history() as Promise<unknown>,
  ]) {
    await expect(page.evaluate(call)).rejects.toThrow(
      'Only Lumovi’s admins (LUMOVI_ADMINS) see who may do what.',
    )
  }
  await page.getByRole('link', { name: 'See your access' }).click()
  await expect(page).toHaveURL(`${served.url}your-access`)
})

test('settings for access that don’t make sense stop the server', async ({ clusters }) => {
  expect(await refusedConfig(clusters, { LUMOVI_ACCESS: 'groups: [' })).toContain(
    'LUMOVI_ACCESS isn’t YAML:',
  )
  expect(await refusedConfig(clusters, { LUMOVI_ACCESS: 'abcd' })).toContain(
    'LUMOVI_ACCESS must be YAML, or YAML encoded in base64.',
  )
  for (const [policy, said] of [
    ['[]', 'LUMOVI_ACCESS: It isn’t a map.'],
    [
      'everyone: { changes: maybe }',
      'LUMOVI_ACCESS: everyone.changes is read, write, not “maybe”.',
    ],
    ['everyone: { changes: read }', 'LUMOVI_ACCESS: everyone doesn’t say shells.'],
    [
      'everyone: { flying: on }',
      'LUMOVI_ACCESS: everyone.flying isn’t something Lumovi lets people do.',
    ],
    ['groups: { a: 1 }', 'LUMOVI_ACCESS: groups isn’t a list.'],
    ['groups: [x]', 'LUMOVI_ACCESS: groups[0] isn’t a map.'],
    [
      'groups: [{ id: Team, name: A }]',
      'LUMOVI_ACCESS: groups[0].id needs an id: lowercase letters, digits and -.',
    ],
    [
      'groups: [{ id: a, name: A }, { id: a, name: B }]',
      'LUMOVI_ACCESS: there are two groups with the id “a”.',
    ],
    [
      'groups: [{ id: a, name: " " }]',
      'LUMOVI_ACCESS: groups[0].name needs a name of at most 100 characters.',
    ],
    [
      'groups: [{ id: a, name: A, people: [""] }]',
      'LUMOVI_ACCESS: groups[0].people[0] isn’t a name.',
    ],
    [
      'grants: [{ id: g, name: G, who: [nobody], profile: p }]',
      'LUMOVI_ACCESS: grants[0].who[0] names a group there isn’t: “nobody”.',
    ],
    [
      'grants: [{ id: g, name: G, profile: p }]',
      'LUMOVI_ACCESS: grants[0].profile names a profile there isn’t: “p”.',
    ],
    [
      'limits: [{ id: l, name: L, namespaces: ["a b"] }]',
      'LUMOVI_ACCESS: limits[0].namespaces[0] (“a b”): It has a space.',
    ],
    [
      'limits: [{ id: l, name: L, caps: { helm: install } }]',
      'LUMOVI_ACCESS: limits[0].caps.helm is install, which limits nothing: it’s the most there is.',
    ],
    ['names: { abc: 7 }', 'LUMOVI_ACCESS: names.abc isn’t a name of at most 100 characters.'],
    [
      `groups: [${Array.from({ length: 201 }, (_, i) => `{ id: g${i}, name: G }`).join(',')}]`,
      'LUMOVI_ACCESS: groups has more than 200.',
    ],
  ] as const) {
    expect(await refusedConfig(clusters, { LUMOVI_ACCESS: policy })).toContain(said)
  }
  expect(await refusedConfig(clusters, { LUMOVI_ACCESS_CONFIGMAP: 'Not_Valid' })).toContain(
    'LUMOVI_ACCESS_CONFIGMAP must name a ConfigMap, like lumovi-access, not "Not_Valid".',
  )
  expect(await refusedConfig(clusters, { LUMOVI_ACCESS_CONFIGMAP: 'lumovi-access' })).toContain(
    'LUMOVI_ACCESS_CONFIGMAP keeps who may do what in the cluster Lumovi runs in, and it isn’t running in one (KUBERNETES_SERVICE_HOST isn’t set).',
  )
  // What was kept, and makes no sense now: the server stops, rather than loosen anyone's.
  const data = mkdtempSync(join(tmpdir(), 'lumovi-access-'))
  writeFileSync(join(data, 'access.json'), 'not json')
  const env = { LUMOVI_ADMINS: 'platform-admins', LUMOVI_DATA_DIR: data }
  expect(await refusedConfig(clusters, env)).toContain(
    `${join(data, 'access.json')} isn’t JSON: Lumovi can’t read who may do what, kept there.`,
  )
  writeFileSync(join(data, 'access.json'), JSON.stringify({ version: 1, policy: { groups: 3 } }))
  expect(await refusedConfig(clusters, env)).toContain(
    `${join(data, 'access.json')}: groups isn’t a list.`,
  )
  for (const [policy, said] of [
    [{ groups: [null] }, 'groups[0] isn’t a map.'],
    [
      { grants: [{ id: 'g', name: 'G', who: 'everyone', profile: 'p' }] },
      'grants[0].who isn’t a list.',
    ],
  ] as const) {
    writeFileSync(join(data, 'access.json'), JSON.stringify({ version: 1, policy }))
    expect(await refusedConfig(clusters, env)).toContain(`${join(data, 'access.json')}: ${said}`)
  }
  writeFileSync(join(data, 'access.json'), 'null')
  expect(await refusedConfig(clusters, env)).toContain(
    `${join(data, 'access.json')}: It isn’t a map.`,
  )
})

/** What the chart says (LUMOVI_ACCESS): the platform team runs everything, as admins can't change. */
const BASE = `
groups:
  - id: platform
    name: Platform team
    description: Runs the clusters
    provider: [platform-admins]
profiles:
  - id: platform
    name: Platform
    values: { changes: write, shells: on, nodeShells: on, logs: on, secrets: values, helm: install, assistants: self, audit: all }
grants:
  - id: platform
    name: The platform team runs everything
    who: [platform]
    profile: platform
limits:
  - id: edge
    name: The edge is hands-off
    clusters: [edge-ap]
    caps: { nodeShells: off }
`

const ENTRA_GROUP = '61e0b4d7-8a2f-4c95-9d3e-7b1a5f2c4e80'

/** People signing in, each in a browser of their own: the server sees them, with their groups. */
async function signInAll(browser: Browser, url: string, people: [string, string][]) {
  for (const [user, groups] of people) {
    const context = await browser.newContext()
    await as(context, user, groups)
    const page = await context.newPage()
    await page.goto(url)
    await expect(page.getByRole('button', { name: `Signed in as ${user}` })).toBeVisible()
    await context.close()
  }
}

test('admins set who may do what, read it back, and save it together', async ({
  page,
  context,
  browser,
  serve,
  clusters,
}) => {
  const data = mkdtempSync(join(tmpdir(), 'lumovi-access-'))
  const served = await serve({
    env: {
      ...fleetEnv(clusters),
      LUMOVI_ADMINS: 'platform-admins,user:root@example.com',
      LUMOVI_ACCESS: BASE,
      LUMOVI_DATA_DIR: data,
    },
  })
  await signInAll(browser, served.url, [
    ['dan@example.com', 'developers, on-call, system:authenticated'],
    ['hugo@example.com', 'developers'],
    ['mara@example.com', ENTRA_GROUP],
    ['build-bot@example.com', ''],
  ])
  await as(context, 'ana@example.com', 'platform-admins')
  await page.goto(served.url)
  await page.getByRole('button', { name: 'Admin: who may do what' }).click()
  await expect(page).toHaveURL(`${served.url}access/groups`)
  await expect(page.getByText(/Admins are named by the server’s settings/)).toContainText(
    'LUMOVI_ADMINS: platform-admins, user:root@example.com',
  )

  // ——— Groups ———
  await expect(page.getByRole('note').first()).toContainText(
    'Your proxy sends groups as IDsGive each the name your team knows it by, once, and it shows everywhere: 1 group still has only an ID.',
  )
  const seen = page.getByRole('complementary', { name: 'Seen at sign-in' })
  await expect(seen.getByRole('listitem')).toHaveText([
    /^developers2 people.*Not in a group: they get what everyone does/,
    /^61e0b4d7.*1 person.*Not in a group/,
    /^on-call1 person/,
    /^platform-admins1 person.*In Platform team/,
  ])
  await expect(seen).toContainText(
    '1 person signed in without any groups, like build-bot@example.com: they get what everyone does, unless a group names them.',
  )
  // An ID, named once: it shows by its name everywhere.
  await seen.getByRole('button', { name: 'Name it' }).click()
  await seen.getByRole('textbox', { name: `A name for ${ENTRA_GROUP}` }).fill('Security')
  await seen.getByRole('textbox', { name: `A name for ${ENTRA_GROUP}` }).press('Enter')
  await expect(seen.getByRole('listitem').nth(1)).toContainText(`Security${ENTRA_GROUP}`)
  await expect(page.getByRole('note').first()).toContainText('Every group has a name.')
  // Renamed, thought better of; then its name taken away, and given again.
  const naming = seen.getByRole('textbox', { name: `A name for ${ENTRA_GROUP}` })
  await seen.getByRole('button', { name: 'Rename' }).click()
  await expect(naming).toHaveValue('Security')
  await naming.press('Escape')
  await expect(naming).toHaveCount(0)
  await seen.getByRole('button', { name: 'Rename' }).click()
  await naming.fill('')
  await seen.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('note').first()).toContainText('1 group still has only an ID.')
  await seen.getByRole('button', { name: 'Name it' }).click()
  await naming.fill('Security')
  await seen.getByRole('button', { name: 'Save' }).click()

  // The chart's: shown, not changed.
  await page.getByRole('button', { name: /^Platform team/ }).click()
  const platform = page.getByRole('article', { name: 'Platform team' })
  await expect(platform.getByRole('note')).toContainText(
    'Set in the Helm chart (access.policy.groups)',
  )
  await expect(platform.getByRole('textbox', { name: 'Name' })).toBeDisabled()
  await expect(platform.getByRole('button', { name: /^Delete group/ })).toHaveCount(0)
  await expect(platform).toContainText(
    'In it now, as they last signed in: 1 personAana@example.comvia platform-admins',
  )

  // A group of their own: a provider group found as it's typed, people by name.
  await page.getByRole('button', { name: 'New group' }).click()
  const group = page.getByRole('article', { name: 'New group' })
  await group.getByRole('textbox', { name: 'Name' }).fill('')
  await expect(page.getByText('Untitled group')).toBeVisible()
  await page
    .getByRole('article', { name: '', exact: true })
    .getByRole('textbox', { name: 'Name' })
    .fill('Developers')
  const developers = page.getByRole('article', { name: 'Developers' })
  await developers.getByRole('textbox', { name: 'What it’s for' }).fill('Build the shop')
  const members = developers.getByRole('combobox', { name: 'Members' })
  await members.fill('dev')
  await expect(developers.getByRole('option')).toHaveText([
    /^Group from your proxydevelopers2 people$/,
    /^Group from your proxydevnot seen yet$/,
    /^Persondevnot signed in yet$/,
  ])
  await members.press('Enter')
  await members.fill('zoe@example.com')
  await expect(developers.getByRole('option')).toHaveText([
    /^Personzoe@example.comnot signed in yet$/,
  ])
  await members.press('ArrowDown')
  await members.press('ArrowUp')
  await developers.getByRole('option').click()
  await members.fill('hu')
  await expect(developers.getByRole('option')).toHaveText([
    /^Personhugo@example.comsigned in .+ ago$/,
    /^Group from your proxyhunot seen yet$/,
    /^Personhunot signed in yet$/,
  ])
  await members.press('Escape')
  await expect(members).toHaveValue('')
  await expect(developers).toContainText('In it now, as they last signed in: 2 people')
  await expect(developers).toContainText('hugo@example.comvia developers')
  // Nobody seen is that: marked (a typo, or someone yet to sign in).
  await expect(developers).toContainText('personzoe@example.comnot seen yet')
  // Already in it: not offered again.
  await members.fill('zoe@example.com')
  await expect(developers.getByRole('option')).toHaveCount(0)
  await members.fill('')
  await developers.getByRole('button', { name: 'Remove zoe@example.com' }).click()
  await members.press('Backspace')
  await expect(developers).toContainText('Nobody yet: add a group or a person.')
  await members.fill('developers')
  await members.press('Enter')
  await developers.getByRole('button', { name: 'Done' }).click()
  await expect(developers).toContainText('Build the shop · developers')
  await expect(developers).toContainText('In no rule yet')
  // From what was seen: the provider's group added to one of Lumovi's.
  await seen
    .getByRole('combobox', { name: 'Add on-call to a group' })
    .selectOption({ label: 'Developers' })
  await expect(developers.getByRole('textbox', { name: 'Name' })).toBeVisible()
  await expect(developers).toContainText('In it now, as they last signed in: 2 people')
  await expect(seen.getByRole('listitem').nth(2)).toContainText('In Developers')
  // Auditors: the named group (shown by its name, with its ID), and someone by name.
  await page.getByRole('button', { name: 'New group' }).click()
  await page
    .getByRole('article', { name: 'New group' })
    .getByRole('textbox', { name: 'Name' })
    .fill('Auditors')
  const auditors = page.getByRole('article', { name: 'Auditors' })
  const auditorMembers = auditors.getByRole('combobox', { name: 'Members' })
  await auditorMembers.fill('secu')
  await auditorMembers.press('Enter')
  await expect(auditors.getByRole('button', { name: 'Remove Security' })).toBeVisible()
  await expect(auditors).toContainText(`groupSecurity${ENTRA_GROUP}`)
  await auditorMembers.fill('build-bot')
  await auditors
    .getByRole('option', { name: /build-bot@example\.com/ })
    .first()
    .click()
  await expect(auditors).toContainText('build-bot@example.comnamed')
  await expect(auditors).toContainText('mara@example.comvia Security')
  // Temps: their provider's group, before anyone's signed in with it.
  await page.getByRole('button', { name: 'New group' }).click()
  await page
    .getByRole('article', { name: 'New group' })
    .getByRole('textbox', { name: 'Name' })
    .fill('Temps')
  const temps = page.getByRole('article', { name: 'Temps' })
  await temps.getByRole('combobox', { name: 'Members' }).fill('temps')
  await temps.getByRole('option').filter({ hasText: 'Group from your proxy' }).click()
  await expect(temps).toContainText(
    'Nobody yet: nobody has signed in with temps in the last 30 days.',
  )
  await expect(temps).toContainText('grouptempsnot seen yet')
  // Another, made and thought better of.
  await page.getByRole('button', { name: 'New group' }).click()
  await page
    .getByRole('article', { name: 'New group' })
    .getByRole('button', { name: 'Delete group' })
    .click()
  await expect(page.getByRole('article', { name: 'New group' })).toHaveCount(0)

  // ——— Profiles ———
  await page.getByRole('link', { name: /^Profiles/ }).click()
  // What everyone gets, less; and what developers get, more (a new one starts as everyone's).
  const set = (label: string, level: string) =>
    page.getByRole('combobox', { name: label, exact: true }).selectOption(level)
  await set('Changes for Everyone', 'read')
  await set('Shells for Everyone', 'off')
  await set('Node shells for Everyone', 'off')
  await set('Secrets for Everyone', 'keys')
  await set('Helm for Everyone', 'off')
  await page.getByRole('button', { name: 'New profile' }).click()
  await page.getByRole('textbox', { name: 'Name of the profile New profile' }).fill('Developer')
  await set('Changes for Developer', 'write')
  await set('Shells for Developer', 'on')
  await set('Helm for Developer', 'upgrade')
  await expect(
    page.getByRole('combobox', { name: 'Changes for Platform', exact: true }),
  ).toBeDisabled()
  await expect(page.getByRole('img', { name: 'Set in the Helm chart' })).toBeVisible()
  await page.getByRole('button', { name: 'New profile' }).click()
  await page.getByRole('textbox', { name: 'Name of the profile New profile' }).fill('Viewer')
  await expect(page.getByRole('columnheader')).toHaveText([
    'Each may',
    'EveryoneEveryone signed in',
    'Platform1 group, in 1 grant',
    /^In no grant yet$/,
    /^In no grant yet$/,
  ])

  // ——— Grants & limits ———
  await page.getByRole('link', { name: /^Grants & limits/ }).click()
  // The chart's: shown, not changed.
  await page.getByRole('button', { name: /^The platform team runs everything/ }).click()
  const chartGrant = page.getByRole('article', { name: 'The platform team runs everything' })
  await expect(chartGrant.getByRole('note')).toContainText('(access.policy.grants)')
  await expect(chartGrant.getByRole('button', { name: 'Remove Platform team' })).toHaveCount(0)
  await expect(chartGrant).toContainText('All clusters')
  await expect(chartGrant.getByRole('button', { name: /^Delete/ })).toHaveCount(0)
  await chartGrant.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: /^The edge is hands-off/ }).click()
  const chartLimit = page.getByRole('article', { name: 'The edge is hands-off' })
  await expect(chartLimit.getByRole('note')).toContainText('(access.policy.limits)')
  await expect(chartLimit).toContainText('Node shellsOff')
  await expect(chartLimit).toContainText('ChangesNot limited')
  await chartLimit.getByRole('button', { name: 'Done' }).click()
  // One given everyone's, thought better of.
  await page.getByRole('button', { name: 'New grant' }).click()
  const viewer = page.getByRole('article', { name: 'New grant' })
  await viewer
    .getByRole('group', { name: 'Profile' })
    .getByRole('button', { name: 'Viewer' })
    .click()
  await expect(viewer).toContainText('Viewer gives nothing more than everyone gets.')
  await viewer.getByRole('button', { name: 'Delete grant' }).click()
  await page.getByRole('button', { name: 'New grant' }).click()
  const grant = page.getByRole('article', { name: 'New grant' })
  await grant.getByRole('textbox', { name: 'Name' }).fill('Developers build in staging')
  const built = page.getByRole('article', { name: 'Developers build in staging' })
  await built.getByRole('combobox', { name: 'Who' }).fill('Dev')
  await built.getByRole('combobox', { name: 'Who' }).press('Enter')
  await built.getByRole('button', { name: 'Remove Developers' }).click()
  await built.getByRole('combobox', { name: 'Who' }).fill('Dev')
  await built.getByRole('combobox', { name: 'Who' }).press('Enter')
  const clustersField = built.getByRole('combobox', { name: 'Clusters' })
  await clustersField.fill('env=st')
  await expect(built.getByRole('option')).toHaveText([/^labelenv=stnone yet$/])
  await clustersField.fill('st')
  await expect(built.getByRole('option').first()).toHaveText(/^patternst\*1 cluster$/)
  await clustersField.fill('env=staging')
  await clustersField.press('Enter')
  await built.getByRole('button', { name: 'Remove env=staging' }).click()
  await clustersField.fill('env=staging')
  await clustersField.press('Enter')
  const namespacesField = built.getByRole('combobox', { name: 'Namespaces' })
  await namespacesField.fill('a b')
  await expect(built.getByRole('alert')).toHaveText('It has a space.')
  await namespacesField.press('Shift')
  await namespacesField.press('Enter')
  await expect(namespacesField).toHaveValue('a b')
  await namespacesField.fill('!kube-*')
  await namespacesField.press('Enter')
  await built.getByRole('button', { name: 'Remove !kube-*' }).click()
  await expect(
    built.getByRole('group', { name: 'Profile' }).getByRole('button', { pressed: true }),
  ).toHaveText('Platform')
  await built
    .getByRole('group', { name: 'Profile' })
    .getByRole('button', { name: 'Developer' })
    .click()
  await expect(built).toContainText(
    'Where it reaches, Developer adds to what everyone gets: changes: make changes, shells: open them, helm: upgrade, roll back.',
  )
  await expect(built.getByText('people get it, as they last signed in')).toBeVisible()
  await built.getByRole('button', { name: 'Done' }).click()
  await expect(built).toContainText('Developersinenv=staging  /  all namespaces')
  await expect(built).toContainText('2 people')

  await page.getByRole('button', { name: 'New limit' }).click()
  const limit = page.getByRole('article', { name: 'New limit' })
  await expect(limit).toContainText('Limits nothing yet')
  await limit.getByRole('textbox', { name: 'Name' }).fill('Production')
  const production = page.getByRole('article', { name: 'Production' })
  await production.getByRole('combobox', { name: 'Clusters' }).fill('env=production')
  await production.getByRole('combobox', { name: 'Clusters' }).press('Enter')
  await production
    .getByRole('group', { name: 'Node shells' })
    .getByRole('button', { name: 'Off' })
    .click()
  await production
    .getByRole('group', { name: 'Helm' })
    .getByRole('button', { name: 'Upgrade, roll back' })
    .click()
  await production.getByRole('group', { name: 'Logs' }).getByRole('button', { name: 'Off' }).click()
  await production
    .getByRole('group', { name: 'Logs' })
    .getByRole('button', { name: 'Not limited' })
    .click()
  await expect(production).toContainText('No node shells')
  await expect(production).toContainText('No Helm installs')
  await expect(production).toContainText('people it holds back')
  await page.getByRole('button', { name: 'New limit' }).click()
  await page
    .getByRole('article', { name: 'New limit' })
    .getByRole('button', { name: 'Delete limit' })
    .click()
  // A limit on Temps alone: it goes when they do.
  await page.getByRole('button', { name: 'New limit' }).click()
  await page
    .getByRole('article', { name: 'New limit' })
    .getByRole('textbox', { name: 'Name' })
    .fill('Temps look only')
  const look = page.getByRole('article', { name: 'Temps look only' })
  await look.getByRole('combobox', { name: 'Who it holds back' }).fill('Temps')
  await look.getByRole('combobox', { name: 'Who it holds back' }).press('Enter')
  await look
    .getByRole('group', { name: 'Changes' })
    .getByRole('button', { name: 'Read-only' })
    .click()

  // A profile in use isn't deleted; one no longer used is.
  await page.getByRole('link', { name: /^Profiles/ }).click()
  await page.getByRole('button', { name: 'Delete Developer' }).locator('..').focus()
  await expect(page.getByRole('tooltip')).toHaveText('Given in 1 grant: give them another first')
  await page.getByRole('button', { name: 'Delete Developer' }).locator('..').blur()
  await page.getByRole('button', { name: 'Delete Viewer' }).click()
  // A group, and the limit that holds it alone back, deleted together.
  await page.getByRole('link', { name: /^Groups/ }).click()
  await page.getByRole('button', { name: /^Temps/ }).click()
  await expect(page.getByRole('button', { name: /^Temps/ })).toContainText('Limited')
  await page.getByRole('button', { name: 'Delete group (and take it out of 1 rule)' }).click()
  await page.getByRole('link', { name: /^Grants & limits/ }).click()
  await expect(page.getByRole('article', { name: 'Temps look only' })).toHaveCount(0)

  // ——— Read back, and saved together ———
  const bar = page.getByRole('region', { name: 'Changes not saved' })
  await expect(bar).toContainText('7 changes not saved')
  await bar.getByRole('button', { name: 'Read them' }).click()
  await expect(bar.getByRole('listitem')).toHaveText([
    'Changed what everyone may do: Changes: Make changes → Read-only; Shells: Open them → Off; Node shells: Open them → Off; Secrets: Values → Keys only; Helm: Install, uninstall → Off',
    'Added the group “Developers”',
    'Added the group “Auditors”',
    'Added the profile “Developer”',
    'Added the grant “Developers build in staging”',
    'Added the limit “Production”',
    `Named ${ENTRA_GROUP} “Security”`,
  ])
  await bar.getByRole('button', { name: 'Hide them' }).click()
  await bar.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('Saved')
  await expect(bar).toHaveCount(0)
  // Kept: theirs, not the chart's.
  const kept = JSON.parse(readFileSync(join(data, 'access.json'), 'utf8'))
  expect(kept.version).toBe(1)
  expect(kept.policy.groups.map((g: { id: string }) => g.id)).not.toContain('platform')
  expect(kept.policy.everyone.secrets).toBe('keys')
  expect(kept.policy.names).toEqual({ [ENTRA_GROUP]: 'Security' })
  const [changed] = audited(served, 'access.changed')
  expect(changed).toMatchObject({
    outcome: 'success',
    actor: { user: 'ana@example.com', via: 'ui' },
    summary:
      'Changed what everyone may do: Changes: Make changes → Read-only; Shells: Open them → Off; Node shells: Open them → Off; Secrets: Values → Keys only; Helm: Install, uninstall → Off, and 6 more',
    details: { changes: expect.arrayContaining(['Added the limit “Production”']) },
  })

  // ——— History ———
  await page.getByRole('link', { name: 'History' }).click()
  const history = page.getByRole('list').filter({ hasText: 'ana@example.com' })
  await expect(history).toContainText('ana@example.com, from 127.0.0.1')
  await expect(history).toContainText('Changed what everyone may do')
  await expect(history).toContainText('SecretsValuesKeys only')
  await expect(page.getByRole('link', { name: 'Open in the audit log' })).toHaveAttribute(
    'href',
    '/audit?category=settings&q=access.changed&range=all',
  )

  // ——— Check someone ———
  await page.getByRole('link', { name: 'Check someone' }).click()
  const who = page.getByRole('region', { name: 'Check someone' })
  await who.getByRole('combobox', { name: 'Person' }).fill('hugo')
  await who.getByRole('combobox', { name: 'Person' }).press('Enter')
  await expect(who).toContainText('hugo@example.com')
  await expect(who.getByRole('definition').last()).toHaveText('Developers')
  const where = page.getByRole('region', { name: 'Where' })
  await where
    .getByRole('group', { name: 'Cluster' })
    .getByRole('button', { name: 'staging' })
    .click()
  const rows = where.getByRole('row')
  await expect(rows.filter({ hasText: /^Changes/ })).toContainText(
    'Make changesGrantDevelopers build in staging (Developer)',
  )
  await where
    .getByRole('group', { name: 'Cluster' })
    .getByRole('button', { name: 'prod-eu' })
    .click()
  await where.getByRole('combobox', { name: 'Namespace' }).fill('sho')
  await where.getByRole('combobox', { name: 'Namespace' }).press('Enter')
  await expect(where).toContainText('shop')
  await expect(rows.filter({ hasText: /^Changes/ })).toContainText(
    'Read-onlyEveryoneWhat everyone signed in gets',
  )
  await where.getByRole('combobox', { name: 'Namespace' }).fill('own')
  await where.getByRole('option', { name: /Its own objects/ }).click()
  await expect(where).toContainText('prod-euIts own objects')
  // Someone who hasn't signed in: as named, with no groups.
  await who.getByRole('combobox', { name: 'Person' }).fill('nobody@example.com')
  await who.getByRole('combobox', { name: 'Person' }).press('Enter')
  await expect(who).toContainText('Not seen signing in lately: checked as named, with no groups')
  await expect(who).toContainText('None arrived')
  await expect(who).toContainText('None: what everyone gets')
  // An admin themselves, the Platform: a limit holds back what the grant would give.
  await who.getByRole('combobox', { name: 'Person' }).fill('ana')
  await who.getByRole('option').first().click()
  await expect(rows.filter({ hasText: /^Node shells/ })).toContainText(
    'OffGrants would give open themLimitProduction',
  )
  // Found by the keyboard: arrows choose, Escape lets go.
  const person = who.getByRole('combobox', { name: 'Person' })
  await person.fill('example')
  await person.press('Shift')
  await person.press('ArrowDown')
  await person.press('ArrowUp')
  await expect(who.getByRole('option', { selected: true })).toHaveCount(1)
  await person.press('Escape')
  await expect(person).toHaveValue('')
  // A namespace there isn't: nothing to choose.
  await where.getByRole('combobox', { name: 'Namespace' }).fill('zzz')
  await where.getByRole('combobox', { name: 'Namespace' }).press('Enter')
  await expect(where.getByRole('combobox', { name: 'Namespace' })).toHaveValue('zzz')
  await where.getByRole('combobox', { name: 'Namespace' }).fill('')
  // A cluster whose namespaces can't be listed: its own objects.
  await where
    .getByRole('group', { name: 'Cluster' })
    .getByRole('button', { name: 'edge-ap' })
    .click()
  await expect(where).toContainText('edge-apIts own objects')
  await expect(rows.filter({ hasText: /^Node shells/ })).toContainText(
    'OffGrants would give open themLimitThe edge is hands-off',
  )
  // Exactly as someone signed in: them, not someone named so.
  await person.fill('dan@example.com')
  await expect(who.getByRole('option')).toHaveCount(1)
  await person.press('Enter')
  await expect(who).toContainText('Signed in')

  // The ways in: the command palette, and the account menu.
  await page.goto(`${served.url}cluster/prod-eu`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: 'Your access' }).click()
  await expect(page).toHaveURL(`${served.url}your-access`)
  await page.goto(`${served.url}cluster/prod-eu`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: /^Access/ }).click()
  await expect(page).toHaveURL(`${served.url}access/groups`)
  await page.goto(`${served.url}cluster/prod-eu`)
  await page.getByRole('button', { name: 'Signed in as ana@example.com' }).click()
  const account = page.getByRole('dialog', { name: 'Account' })
  await expect(account).toContainText('Platform team · Admin')
  await account.getByRole('link', { name: /^Admin/ }).click()
  await expect(page).toHaveURL(`${served.url}access/groups`)
  // Her own: an admin's, and the way to the rest.
  await page.goto(`${served.url}your-access`)
  await expect(page.getByRole('heading', { name: 'Cluster by cluster' })).toBeVisible()
  await expect(
    page
      .getByRole('row', { name: /^prod-eu/ })
      .getByRole('cell')
      .nth(2),
  ).toHaveText('Offlimit: Production')
  await expect(
    page
      .getByRole('row', { name: /^staging/ })
      .getByRole('cell')
      .nth(2),
  ).toHaveText('Open themThe platform team runs everything')
  await expect(
    page
      .getByRole('row', { name: /^edge-ap/ })
      .getByRole('cell')
      .first(),
  ).toHaveText('Make changesits namespaces can’t be listed')
  await page.getByRole('link', { name: 'Open Admin' }).click()
  await expect(page).toHaveURL(`${served.url}access/groups`)
})

/** Who may do what in the demo cluster: developers run the shop, but not its Secrets' values. */
const POLICY = `
# (Helm writes off and on as no and yes: they're taken as they're meant.)
everyone: { changes: read, shells: false, nodeShells: false, logs: true, secrets: keys, helm: off, assistants: ask, audit: own }
groups:
  - { id: dev, name: Developers, provider: [developers], people: [Dana@Example.com] }
  - { id: sec, name: Security, provider: [security] }
profiles:
  - id: developer
    name: Developer
    values: { changes: write, shells: on, nodeShells: off, logs: on, secrets: values, helm: upgrade, assistants: self, audit: own }
  - id: auditor
    name: Auditor
    values: { changes: read, shells: off, nodeShells: off, logs: on, secrets: keys, helm: off, assistants: ask, audit: all }
grants:
  # The shop by its label: what's decided reads namespaces' labels.
  - { id: shop, name: Developers run the shop, who: [dev], profile: developer, namespaces: [kubernetes.io/metadata.name=shop, data, batch] }
  - { id: sec, name: Security reads every event, who: [sec], profile: auditor }
limits:
  - { id: data, name: Data stays put, namespaces: [data], caps: { logs: off, secrets: hidden, helm: off } }
  - { id: shop, name: Card data, namespaces: [shop], caps: { secrets: keys } }
  - { id: system, name: Developers keep out of the system, who: [dev], namespaces: [kube-system], caps: { shells: off } }
`

/** What the page's api answers, from inside the page: a cluster call's error, if it failed. */
const refusal = (page: Page, call: string) =>
  page.evaluate(async (body) => {
    const result = (await new Function('api', `return ${body}`)(window.lumovi)) as {
      ok: boolean
      error?: { code: string; message: string }
    }
    return result.ok ? 'ok' : `${result.error!.code}: ${result.error!.message}`
  }, call)

test('grants and limits decide what someone may do, where; the server holds to it', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const served = await serve({
    env: {
      LUMOVI_AUTH: 'proxy',
      LUMOVI_ACCESS: POLICY,
      LUMOVI_ADMINS: 'platform-admins,user:root@example.com',
      LUMOVI_AUDITORS: 'auditors,user:Ivy@Example.com',
    },
  })
  await as(context, 'dave@example.com', 'developers')
  const coredns = DEMO.pods.coredns[0]!

  // Namespaces' labels decide some of it: until they're read, the page leaves it to the server.
  const unlisted = clusters.demo.fail('/api/v1/namespaces', { status: 500 })
  await page.goto(`${served.url}cluster/demo/pods?open=Pod/kube-system/${coredns}`)
  const panel = page.getByRole('complementary').filter({ hasText: coredns })
  await expect(panel.getByRole('button', { name: 'Restart', exact: true })).toBeEnabled()
  unlisted()
  // Not theirs to change: said on the action, before it's tried…
  await expect(panel.getByRole('button', { name: 'Restart', exact: true })).toBeDisabled()
  const restart = panel.getByRole('button', { name: 'Restart', exact: true }).locator('..')
  await restart.focus()
  await expect(page.getByRole('tooltip')).toHaveText(
    'Your access doesn’t let you make changes in kube-system: none of your grants gives it here.',
  )
  await restart.blur()
  await panel.getByRole('tab', { name: 'Shell' }).click()
  await expect(panel.getByRole('note')).toHaveText(
    'You can’t open shells hereYour access doesn’t let you open shells in kube-system: none of your grants gives it here.Lumovi’s admins can change it: platform-admins and root@example.com.See your access',
  )
  // …and refused by the server whatever the page asks.
  expect(
    await refusal(
      page,
      `api.kube.change({ context: 'demo', kind: 'Pod', namespace: 'kube-system', name: '${coredns}', change: { action: 'delete' } })`,
    ),
  ).toBe(
    'not-allowed: Lumovi doesn’t let you make changes in kube-system: no grant of yours gives it there.',
  )
  expect(
    await refusal(
      page,
      `api.kube.change({ context: 'demo', kind: 'Pod', namespace: 'kube-system', name: '${coredns}', change: { action: 'debug', container: 'debug', image: 'busybox' } })`,
    ),
  ).toBe(
    'not-allowed: Lumovi doesn’t let you debug pods in kube-system: no grant of yours gives it there.',
  )
  expect(
    await refusal(
      page,
      `api.terminal.open('access-shell-1', { target: 'container', context: 'demo', namespace: 'kube-system', pod: '${coredns}', container: 'coredns' })`,
    ),
  ).toBe(
    'not-allowed: Lumovi doesn’t let you open shells in kube-system: no grant of yours gives it there.',
  )
  expect(
    await refusal(
      page,
      `api.terminal.open('access-shell-2', { target: 'node', context: 'demo', node: 'worker-1', mode: 'node' })`,
    ),
  ).toBe(
    'not-allowed: Lumovi doesn’t let you open node shells on demo: no grant of yours gives it there.',
  )
  expect(
    await refusal(
      page,
      `api.kube.change({ context: 'demo', kind: 'Node', name: 'worker-1', change: { action: 'patch', patchType: 'merge', patch: { spec: { unschedulable: true } } } })`,
    ),
  ).toBe(
    'not-allowed: Lumovi doesn’t let you make changes on demo: no grant of yours gives it there.',
  )
  expect(
    await refusal(
      page,
      `api.kube.change({ context: 'demo', kind: 'Namespace', name: 'kube-system', change: { action: 'delete' } })`,
    ),
  ).toBe(
    'not-allowed: Lumovi doesn’t let you make changes in kube-system: no grant of yours gives it there.',
  )
  await expect
    .poll(() => audited(served, 'resource.delete').map((e) => e.outcome))
    .toEqual(['refused', 'refused'])

  // Theirs in the shop: changes, and shells.
  await page.goto(`${served.url}cluster/demo/pods?open=Pod/shop/${DEMO.pods.storefront[0]}`)
  await expect(page.getByRole('button', { name: 'Restart', exact: true })).toBeEnabled()

  // Data's logs and Secrets aren't theirs: a limit holds them back.
  await page.goto(`${served.url}cluster/demo/pods?open=Pod/data/${DEMO.pods.postgres[0]}`)
  await page.getByRole('tab', { name: 'Logs' }).click()
  await expect(page.getByRole('note')).toContainText(
    'You can’t read logs hereYour access doesn’t let you read logs in data: the limit “Data stays put” holds it back.',
  )
  expect(
    await refusal(
      page,
      `api.logs.start('access-logs-1', { context: 'demo', namespace: 'data', pod: '${DEMO.pods.postgres[0]}', container: 'postgres' })`,
    ),
  ).toBe(
    'not-allowed: Lumovi doesn’t let you read logs in data: the limit “Data stays put” says so.',
  )
  expect(
    await refusal(
      page,
      `api.kube.get({ context: 'demo', kind: 'Secret', namespace: 'data', name: 'postgres-credentials' })`,
    ),
  ).toBe(
    'not-allowed: Lumovi doesn’t let you see Secrets in data: the limit “Data stays put” says so.',
  )
  // Every namespace's Secrets: those of data's left out.
  const secrets = (await page.evaluate(() =>
    window.lumovi!.kube.list({ context: 'demo', kind: 'Secret' }),
  )) as unknown as {
    ok: true
    data: { items: { metadata: { name: string; namespace: string } }[] }
  }
  expect(secrets.data.items.map((s) => s.metadata.namespace)).not.toContain('data')
  expect(secrets.data.items.length).toBeGreaterThan(0)
  await page.goto(`${served.url}cluster/demo/secrets`)
  await page.getByRole('button', { name: 'Namespace' }).click()
  await page.getByRole('option', { name: 'data', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Not for you, here')
  await page.getByRole('alert').getByRole('link', { name: 'See your access' }).click()
  await expect(page).toHaveURL(`${served.url}your-access`)

  // The shop's Secrets: keys, not values; nor written whole (it would lose them).
  const tls = (await page.evaluate(() =>
    window.lumovi!.kube.get({
      context: 'demo',
      kind: 'Secret',
      namespace: 'shop',
      name: 'storefront-tls',
    }),
  )) as unknown as { ok: true; data: { data: Record<string, string> } }
  expect(tls.data.data).toEqual({ 'tls.crt': '', 'tls.key': '' })
  await page.goto(`${served.url}cluster/demo/secrets?open=Secret/shop/storefront-tls`)
  await expect(page.getByText(/^Only the keys:/)).toHaveText(
    'Only the keys: Your access doesn’t let you see Secrets’ values in shop: the limit “Card data” holds it back. See your access',
  )
  await expect(page.getByText('Value hidden by your access')).toHaveCount(2)
  await page.getByRole('tab', { name: 'YAML' }).click()
  await expect(page.getByText('Values hidden by your access')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Edit', exact: true }).locator('..').focus()
  await expect(page.getByRole('tooltip')).toHaveText(
    'Your access doesn’t let you edit Secrets whole in shop: the limit “Card data” holds it back.',
  )
  await page.getByRole('button', { name: 'Edit', exact: true }).locator('..').blur()
  expect(
    await refusal(
      page,
      `api.kube.change({ context: 'demo', kind: 'Secret', namespace: 'shop', name: 'storefront-tls', change: { action: 'replace', object: { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'storefront-tls', namespace: 'shop' } } } })`,
    ),
  ).toBe(
    'not-allowed: Lumovi doesn’t let you edit Secrets whole in shop: the limit “Card data” says so.',
  )
  expect(
    await refusal(
      page,
      `api.kube.change({ context: 'demo', kind: 'Secret', namespace: 'shop', name: 'storefront-tls', change: { action: 'apply', fieldManager: 'lumovi', force: false, object: { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'storefront-tls', namespace: 'shop' } } } })`,
    ),
  ).toBe(
    'not-allowed: Lumovi doesn’t let you edit Secrets whole in shop: the limit “Card data” says so.',
  )

  // A change answers with what it changed: a Secret's values, only to whom they're shown.
  const patched = (await page.evaluate(() =>
    window.lumovi!.kube.change({
      context: 'demo',
      kind: 'Secret',
      namespace: 'shop',
      name: 'storefront-tls',
      change: { action: 'patch', patchType: 'json', patch: [] },
      dryRun: true,
    }),
  )) as unknown as { ok: true; data: { data: Record<string, string> } }
  expect(patched.data.data).toEqual({ 'tls.crt': '', 'tls.key': '' })
  const created = await page.evaluate(() =>
    window.lumovi!.kube.change({
      context: 'demo',
      kind: 'Secret',
      namespace: 'shop',
      change: {
        action: 'create',
        object: {
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: { name: 'new-one', namespace: 'shop' },
          stringData: { password: 'hunter2' },
        },
      },
      dryRun: true,
    }),
  )
  expect(created.ok).toBe(true)
  expect(JSON.stringify(created)).not.toContain('hunter2')
  // Where they're hidden, not changed either.
  expect(
    await refusal(
      page,
      `api.kube.change({ context: 'demo', kind: 'Secret', namespace: 'data', name: 'postgres-credentials', change: { action: 'patch', patchType: 'merge', patch: {} }, dryRun: true })`,
    ),
  ).toBe(
    'not-allowed: Lumovi doesn’t let you change Secrets in data: the limit “Data stays put” says so.',
  )

  // Helm: rolled back in the shop, not uninstalled; its values withheld, so not upgraded.
  const release = (await page.evaluate(() =>
    window.lumovi!.helm.release('demo', 'shop', 'storefront'),
  )) as unknown as {
    ok: true
    data: { withheld?: string; revisions: { values: object; manifest: string }[] }
  }
  expect(release.data.withheld).toBe(
    'Its values and manifests can hold Secrets, and your access shows only their keys in shop.',
  )
  expect(
    release.data.revisions.every((r) => r.manifest === '' && Object.keys(r.values).length === 0),
  ).toBe(true)
  const redis = (await page.evaluate(() =>
    window.lumovi!.helm.release('demo', 'data', 'redis'),
  )) as unknown as { ok: true; data: { withheld?: string } }
  expect(redis.data.withheld).toBe(
    'Its values and manifests can hold Secrets, and your access hides them in data.',
  )
  for (const [call, said] of [
    [
      `api.helm.uninstall({ context: 'demo', namespace: 'shop', name: 'storefront' })`,
      'not-allowed: Lumovi doesn’t let you uninstall releases in shop: “Developers run the shop” gives Developer, and no more.',
    ],
    [
      `api.helm.deploy({ context: 'demo', namespace: 'shop', name: 'storefront', source: 'stored', values: '', dryRun: true })`,
      'not-allowed: Lumovi doesn’t let you upgrade releases in shop: the limit “Card data” says so.',
    ],
    [
      `api.helm.deploy({ context: 'demo', namespace: 'shop', name: 'web', source: { chart: 'nginx', repository: 'https://charts.example.com' }, values: '', install: true, dryRun: true })`,
      'not-allowed: Lumovi doesn’t let you install charts in shop: “Developers run the shop” gives Developer, and no more.',
    ],
    [
      `api.helm.rollback({ context: 'demo', namespace: 'data', name: 'redis', revision: 1 })`,
      'not-allowed: Lumovi doesn’t let you roll releases back in data: the limit “Data stays put” says so.',
    ],
    [
      `api.helm.rollback({ context: 'demo', namespace: 'shop', name: 'storefront', revision: 2 })`,
      'ok',
    ],
  ] as const) {
    expect(await refusal(page, call)).toBe(said)
  }
  await page.goto(`${served.url}cluster/demo/helm?release=shop/storefront`)
  const actions = page.getByRole('toolbar', { name: 'Release actions' })
  await expect(actions.getByRole('button', { name: 'Upgrade…' })).toBeDisabled()
  await expect(actions.getByRole('button', { name: 'Roll back…' })).toBeEnabled()
  await expect(actions.getByRole('button', { name: 'Uninstall…' })).toBeDisabled()
  const uninstall = actions.getByRole('button', { name: 'Uninstall…' }).locator('..')
  await uninstall.focus()
  await expect(page.getByRole('tooltip')).toHaveText(
    'Your access doesn’t let you uninstall releases in shop: your grant “Developers run the shop” gives Developer, and no more.',
  )
  await uninstall.blur()
  await page.getByRole('tab', { name: 'Values' }).click()
  await expect(page.getByRole('note')).toContainText(
    'Its values and manifests are hiddenIts values and manifests can hold Secrets, and your access shows only their keys in shop.',
  )
  // (Into the namespace picked: data, since its Secrets were asked for.)
  await page.getByRole('button', { name: 'Install chart' }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
    'Your access doesn’t let you install charts in data: the limit “Data stays put” holds it back.',
  )
  await page.keyboard.press('Escape')

  // Nodes: no shells there, and no changes to them.
  await page.goto(`${served.url}cluster/demo/nodes?open=Node//worker-1`)
  await page.getByRole('tab', { name: 'Shell' }).click()
  await expect(page.getByRole('note')).toContainText(
    'You can’t open shells on nodes hereYour access doesn’t let you open shells on nodes on demo: none of your grants gives it here.',
  )
  await expect(page.getByRole('button', { name: 'Cordon' })).toBeDisabled()

  // Many at once: none, where one isn't theirs.
  await page.goto(`${served.url}cluster/demo/pods`)
  await page.getByRole('button', { name: 'Namespace' }).click()
  await page.getByRole('option', { name: 'kube-system', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Select all rows on this page' }).click()
  const selected = page.getByRole('toolbar', { name: 'Selected rows' })
  await expect(selected.getByRole('button', { name: 'Delete' })).toBeDisabled()
  await selected.getByRole('button', { name: 'Delete' }).locator('..').focus()
  await expect(page.getByRole('tooltip')).toHaveText(
    'Your access doesn’t let you make changes in kube-system: none of your grants gives it here.',
  )

  // A namespace, many at once: decided as in itself.
  await page.goto(`${served.url}cluster/demo/namespaces`)
  await page
    .getByRole('row', { name: /kube-system/ })
    .getByRole('checkbox')
    .check()
  await expect(selected.getByRole('button', { name: 'Delete' })).toBeDisabled()

  // His own, cluster by cluster: where it differs, how many namespaces allow it.
  await page.goto(`${served.url}your-access`)
  const demo = page.getByRole('row', { name: /^demo/ })
  await expect(demo.getByRole('cell')).toHaveText([
    'Make changesin 3 of 9; read-only in 6',
    'Open themin 3 of 9; off in 6',
    'Offno grant gives it here',
    'Read themin 8 of 9; off in 1: Data stays put',
    'Valuesin 1 of 9; keys only in 7; hidden in 1: Data stays put',
    'Upgrade, roll backin 2 of 9; off in 7',
    'As they set themin 3 of 9; changes ask first in 6',
  ])
  await expect(page.getByText('Need more?')).toHaveText(
    'Need more? Lumovi’s admins decide it: platform-admins and root@example.com.',
  )
  await expect(
    page.getByRole('region', { name: 'Why' }).getByText(/^(Grant|Limit|Everyone)$/),
  ).toHaveText(['Everyone', 'Grant', 'Limit', 'Limit', 'Limit'])
  // Not his to administer: who is.
  await page.goto(`${served.url}access`)
  await expect(
    page.getByText('The server names them: platform-admins, root@example.com.'),
  ).toBeVisible()

  // Named in a group, whatever the case of the name they sign in with.
  await as(context, 'dana@example.com', '')
  await page.goto(`${served.url}your-access`)
  await expect(page.getByText('So in Lumovi’s groups').locator('..')).toContainText('Developers')
  // An auditor the server's settings name: everyone's events, whatever their access says.
  await as(context, 'aud@example.com', 'auditors')
  await page.goto(`${served.url}your-access`)
  await expect(page.getByText('Everywhere: everyone’s events in the audit log.')).toBeVisible()

  // Whose audit events: everyone's, for those a grant gives it to.
  await as(context, 'sam@example.com', 'security')
  await page.goto(`${served.url}audit`)
  await expect
    .poll(() => page.evaluate(() => window.lumovi!.audit.info().then((info) => info.everyone)))
    .toBe(true)
  await page.goto(`${served.url}your-access`)
  await expect(page.getByText('Everywhere: everyone’s events in the audit log.')).toBeVisible()
  // Named by the server's settings, whatever the case of their name.
  await as(context, 'ivy@example.com', '')
  await page.goto(`${served.url}your-access`)
  await expect(page.getByText('Everywhere: everyone’s events in the audit log.')).toBeVisible()

  // An admin checking an auditor: everyone's events, as the server's settings say.
  await as(context, 'root@example.com', '')
  await page.goto(`${served.url}access/check`)
  const who = page.getByRole('region', { name: 'Check someone' })
  await who.getByRole('combobox', { name: 'Person' }).fill('aud@')
  await who.getByRole('combobox', { name: 'Person' }).press('Enter')
  const audit = page
    .getByRole('region', { name: 'Where' })
    .getByRole('row')
    .filter({ hasText: /^Audit/ })
  await expect(audit).toContainText('Everyone’sServerLUMOVI_AUDITORS names them')
  // Someone it doesn't name: as their access says.
  await who.getByRole('combobox', { name: 'Person' }).fill('dave@')
  await who.getByRole('combobox', { name: 'Person' }).press('Enter')
  await expect(audit).toContainText('Their ownEveryone')
})

/** Assistants on a server whose admins say who may use them, and where. */
const ASSISTANTS = `
everyone: { changes: read, shells: off, nodeShells: off, logs: on, secrets: keys, helm: off, assistants: off, audit: own }
groups:
  - { id: dev, name: Developers, provider: [developers] }
  - { id: temps, name: Temps, provider: [temps] }
  - { id: ops, name: Ops, provider: [ops] }
profiles:
  - id: developer
    name: Developer
    values: { changes: write, shells: on, nodeShells: off, logs: on, secrets: values, helm: install, assistants: ask, audit: own }
grants:
  - { id: shop, name: Developers run the shop, who: [dev], profile: developer, namespaces: [shop, data] }
  - { id: temps, name: Temps get help, who: [temps], profile: developer }
  - { id: ops, name: Ops get help, who: [ops], profile: developer }
limits:
  - { id: data, name: Data stays put, namespaces: [data], caps: { logs: off, secrets: hidden } }
  - { id: no-temps, name: No assistants for temps, who: [temps], caps: { assistants: off } }
  - { id: no-demo, name: No assistants on demo, who: [ops], clusters: [demo], caps: { assistants: off } }
`

test('AI assistants never do more than their person may', async ({
  page,
  context,
  browser,
  serve,
}) => {
  // Kept as admins set it (the chart's, they couldn't change).
  const data = mkdtempSync(join(tmpdir(), 'lumovi-access-'))
  writeFileSync(
    join(data, 'access.json'),
    JSON.stringify({ version: 1, policy: parse(ASSISTANTS) }),
  )
  const served = await serve({
    env: {
      LUMOVI_AUTH: 'proxy',
      LUMOVI_ADMINS: 'platform-admins',
      LUMOVI_DATA_DIR: data,
      LUMOVI_APPROVAL_SLICE_MS: '1000',
    },
  })
  // Nowhere for bob: no assistant may act as him.
  await as(context, 'bob@example.com', '')
  await page.goto(`${served.url}cluster/demo`)
  const refused = await page.request.get(
    `${served.url}api/assistants/authorize?client_id=x&redirect_uri=http://127.0.0.1/cb`,
  )
  expect(refused.status()).toBe(403)
  expect(await refused.json()).toEqual({
    error:
      'Lumovi’s admins don’t let you use AI assistants on this server. Your access, in Lumovi’s account menu, says more.',
  })

  // Nor for temps: a limit says off everywhere, whatever a grant gives.
  await as(context, 'erin@example.com', 'temps')
  await page.goto(`${served.url}cluster/demo`)
  expect(
    (
      await page.request.get(
        `${served.url}api/assistants/authorize?client_id=x&redirect_uri=http://127.0.0.1/cb`,
      )
    ).status(),
  ).toBe(403)
  // Ops may use them, but not on demo: there, it's as if there were no cluster.
  await as(context, 'fay@example.com', 'ops')
  await page.goto(`${served.url}cluster/demo`)
  const ops = await connect(page, served)
  expect((await call(ops.client, 'list_clusters')).text).toBe('clusters: []\n')

  // Dave's, where developers may: in the shop and data, their changes asking first.
  await as(context, 'dave@example.com', 'developers')
  // (Not his logs in data: said where they'd be, with who can change it.)
  await page.goto(`${served.url}cluster/demo/pods?open=Pod/data/${DEMO.pods.postgres[0]}`)
  await page.getByRole('tab', { name: 'Logs' }).click()
  await expect(page.getByRole('note')).toContainText(
    'Lumovi’s admins can change it: platform-admins.',
  )
  await page.goto(`${served.url}cluster/demo`)
  await page.evaluate(() =>
    window.lumovi!.aiPermissions!.set({
      defaults: { changes: 'allow', secrets: 'values', env: 'show', logs: 'read' },
      rules: [],
    }),
  )
  const { client } = await connect(page, served)
  expect(
    (
      await call(client, 'list_resources', {
        cluster: 'demo',
        kind: 'pods',
        namespace: 'kube-system',
      })
    ).text,
  ).toBe('kind: Pod\ntotal: 0\nitems: []\n')
  expect(
    await call(client, 'get_resource', {
      cluster: 'demo',
      kind: 'Pod',
      namespace: 'kube-system',
      name: DEMO.pods.coredns[0],
    }),
  ).toMatchObject({ error: true })
  expect(audited(served, 'assistant.tool').at(-1)!.error).toContain(
    'kube-system is hidden: Lumovi’s admins don’t let the person',
  )
  expect(
    await call(client, 'get_resource', {
      cluster: 'demo',
      kind: 'Secret',
      namespace: 'data',
      name: 'postgres-credentials',
    }),
  ).toEqual({
    error: true,
    text: 'Lumovi doesn’t show AI assistants the Secrets in data: Lumovi’s admins don’t let the person (“Data stays put”).',
  })
  expect(
    await call(client, 'get_logs', {
      cluster: 'demo',
      namespace: 'data',
      pod: DEMO.pods.postgres[0],
    }),
  ).toMatchObject({
    error: true,
    text: 'Lumovi doesn’t let AI assistants read logs in data: Lumovi’s admins don’t let the person (“Data stays put”).',
  })
  const asked = await call(client, 'scale', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    replicas: 3,
    reason: 'Busy.',
  })
  expect(asked.text).toMatch(/^Still waiting for the person’s answer in Lumovi/)

  // An admin takes the grant away: his assistant can't act as him any more.
  const admin = await browser.newContext()
  await as(admin, 'ana@example.com', 'platform-admins')
  const ana = await admin.newPage()
  await ana.goto(`${served.url}cluster/demo`)
  expect(
    await ana.evaluate(async () => {
      const { policy, version } = await window.lumovi!.access!.admin()
      return (await window.lumovi!.access!.set({ ...policy, grants: [] }, version)).ok
    }),
  ).toBe(true)
  await expect(call(client, 'list_clusters')).rejects.toThrow(
    'Lumovi’s admins don’t let you use AI assistants on this server.',
  )
})

test('kept in a ConfigMap of the namespace Lumovi runs in, as the chart keeps it', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const sa = inCluster(clusters)
  const env = {
    ...sa.env,
    LUMOVI_AUTH: 'proxy',
    LUMOVI_ADMINS: 'platform-admins',
    LUMOVI_ACCESS_CONFIGMAP: 'lumovi-access',
    LUMOVI_ACCESS_REFRESH_MS: '300',
  }
  const demo = clusters.demo
  expect(await refusedConfig(clusters, env)).toContain(
    'Lumovi can’t read ConfigMap lumovi/lumovi-access, where it keeps access settings: configmaps "lumovi-access" not found',
  )
  const configMap = (data?: Record<string, string>) => ({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: 'lumovi-access',
      namespace: 'lumovi',
      creationTimestamp: new Date().toISOString(),
      labels: { 'app.kubernetes.io/name': 'lumovi' },
      annotations: { 'helm.sh/resource-policy': 'keep' },
    },
    ...(data ? { data } : {}),
  })
  // As the chart makes it: empty, so everyone may do all.
  demo.upsert(configMap())
  const served = await serve({ env })
  await as(context, 'ana@example.com', 'platform-admins')
  await page.goto(`${served.url}access/profiles`)
  await page.getByRole('combobox', { name: 'Logs for Everyone', exact: true }).selectOption('off')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByRole('region', { name: 'Changes not saved' })).toHaveCount(0)
  const stored = () =>
    JSON.parse(
      (demo.object('ConfigMap', 'lumovi', 'lumovi-access')!.data as Record<string, string>)[
        'access.json'
      ]!,
    ).policy
  expect(stored().everyone.logs).toBe('off')
  // Its data alone is written: what the chart set on it stays (uninstalling keeps it).
  const kept = demo.object('ConfigMap', 'lumovi', 'lumovi-access')!.metadata
  expect(kept.annotations).toEqual({ 'helm.sh/resource-policy': 'keep' })
  expect(kept.labels).toEqual({ 'app.kubernetes.io/name': 'lumovi' })

  // Someone else's change (another replica's): it arrives, and a page with nothing unsaved
  // shows it.
  demo.upsert(
    configMap({
      'access.json': JSON.stringify({
        version: 1,
        policy: { ...stored(), everyone: { ...stored().everyone, shells: 'off' } },
      }),
    }),
  )
  await expect(
    page.getByRole('combobox', { name: 'Shells for Everyone', exact: true }),
  ).toHaveValue('off')
  // Then while something's unsaved: said, and theirs is what's kept.
  await page.getByRole('combobox', { name: 'Helm for Everyone', exact: true }).selectOption('off')
  demo.upsert(
    configMap({
      'access.json': JSON.stringify({
        version: 1,
        policy: { ...stored(), everyone: { ...stored().everyone, nodeShells: 'off' } },
      }),
    }),
  )
  const bar = page.getByRole('region', { name: 'Changes not saved' })
  await expect(bar).toContainText(
    'Someone else saved changes to access since you started. Yours weren’t saved: start over from theirs, and make yours again.',
  )
  await bar.getByRole('button', { name: 'Start over from theirs' }).click()
  await expect(bar).toHaveCount(0)
  await expect(
    page.getByRole('combobox', { name: 'Node shells for Everyone', exact: true }),
  ).toHaveValue('off')
  // Changed by hand where it's kept, not on the page: recorded, as changed outside Lumovi.
  expect(audited(served, 'access.changed').map((e) => e.summary)).toEqual([
    'Changed what everyone may do: Logs: Read them → Off',
    'Changed outside Lumovi: Changed what everyone may do: Shells: Open them → Off',
    'Changed outside Lumovi: Changed what everyone may do: Node shells: Open them → Off',
  ])
  expect(audited(served, 'access.changed').at(-1)).toMatchObject({
    actor: { user: 'lumovi', via: 'server' },
    details: { outside: true },
  })
  // Sealed once recorded: recorded once (by whichever replica read it first), not again.
  const sealOf = () =>
    JSON.parse(
      (demo.object('ConfigMap', 'lumovi', 'lumovi-access')!.data as Record<string, string>)[
        'access.json'
      ]!,
    ).seal
  await expect.poll(sealOf).toMatch(/^[0-9a-f]{64}$/)
  await page.getByRole('link', { name: 'History' }).click()
  await expect(page.getByText('Outside Lumovi, where it’s kept')).toHaveCount(2)
  // Recorded, but it can't be sealed: said, since it's recorded again as Lumovi starts.
  const unsealable = demo.fail(/\/configmaps\/lumovi-access$/, { status: 403, method: 'PATCH' })
  demo.upsert(
    configMap({
      'access.json': JSON.stringify({
        version: 1,
        policy: { ...stored(), everyone: { ...stored().everyone, logs: 'on' } },
      }),
    }),
  )
  await expect
    .poll(() => served.log())
    .toContain(
      'Access: Lumovi recorded a change made outside it, and can’t seal it, so it’s recorded again as Lumovi starts:',
    )
  expect(audited(served, 'access.changed').at(-1)!.summary).toBe(
    'Changed outside Lumovi: Changed what everyone may do: Logs: Off → Read them',
  )
  unsealable()
  await page.getByRole('link', { name: /^Profiles/ }).click()
  await expect(page.getByRole('combobox', { name: 'Helm for Everyone', exact: true })).toHaveValue(
    'install',
  )

  // It can't be read again for a while: what was read holds, and the log says so, once.
  const good = stored()
  demo.upsert(configMap({ 'access.json': 'nope' }))
  await expect
    .poll(() => served.log())
    .toContain(
      'Access: Lumovi can’t read who may do what again: ConfigMap lumovi/lumovi-access isn’t JSON: Lumovi can’t read who may do what, kept there.',
    )
  // (Read again, and again: said once.)
  await new Promise((done) => setTimeout(done, 1_000))
  demo.upsert(configMap({ 'access.json': JSON.stringify({ version: 1, policy: good }) }))
  await expect.poll(() => served.log()).toContain('Access: Lumovi reads who may do what again.')
  expect(served.log().split('can’t read who may do what again').length).toBe(2)

  // Lumovi can't write it: not saved, and said why.
  const refusing = demo.fail(/\/configmaps\/lumovi-access$/, { status: 403 })
  await page.getByRole('combobox', { name: 'Helm for Everyone', exact: true }).selectOption('off')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(bar.getByRole('alert')).toContainText(
    'Not saved: Lumovi couldn’t keep who may do what:',
  )
  refusing()
})

test('saving over another replica’s change is refused; leaving unsaved asks first', async ({
  page,
  context,
  browser,
  serve,
}) => {
  const data = mkdtempSync(join(tmpdir(), 'lumovi-access-'))
  const env = {
    LUMOVI_AUTH: 'proxy',
    LUMOVI_ADMINS: 'platform-admins',
    LUMOVI_DATA_DIR: data,
    LUMOVI_ACCESS_REFRESH_MS: '600000',
  }
  // Two replicas, keeping it in one folder.
  // (Each its own audit history: one folder is one Lumovi's.)
  const [one, two] = await Promise.all([
    serve({ env: { ...env, LUMOVI_AUDIT_DIR: join(data, 'audit-one') } }),
    serve({ env: { ...env, LUMOVI_AUDIT_DIR: join(data, 'audit-two') } }),
  ])
  await as(context, 'ana@example.com', 'platform-admins')
  await page.goto(`${one.url}access/profiles`)
  const other = await browser.newContext()
  await as(other, 'ben@example.com', 'platform-admins')
  const ben = await other.newPage()
  await ben.goto(`${two.url}access/profiles`)
  await ben.getByRole('combobox', { name: 'Shells for Everyone', exact: true }).selectOption('off')
  await ben.getByRole('button', { name: 'Save changes' }).click()
  await expect(ben.getByRole('region', { name: 'Changes not saved' })).toHaveCount(0)

  // Ana's, saved after his on another replica: refused, not written over his.
  const logs = page.getByRole('combobox', { name: 'Logs for Everyone', exact: true })
  await logs.selectOption('off')
  const bar = page.getByRole('region', { name: 'Changes not saved' })
  await bar.getByRole('button', { name: 'Discard' }).click()
  await expect(bar).toHaveCount(0)
  await expect(logs).toHaveValue('on')
  await logs.selectOption('off')
  await bar.getByRole('button', { name: 'Save changes' }).click()
  await expect(bar).toContainText('Someone else saved changes to access')
  await bar.getByRole('button', { name: 'Start over from theirs' }).click()
  await expect(
    page.getByRole('combobox', { name: 'Shells for Everyone', exact: true }),
  ).toHaveValue('off')
  await expect(logs).toHaveValue('on')
  expect(JSON.parse(readFileSync(join(data, 'access.json'), 'utf8')).policy.everyone.shells).toBe(
    'off',
  )
  // Another replica writing it right now: not written over, and said.
  const lock = join(data, 'access.json.lock')
  writeFileSync(lock, String(Date.now()))
  await logs.selectOption('off')
  await bar.getByRole('button', { name: 'Save changes' }).click()
  await expect(bar).toContainText('Someone else saved changes to access')
  await bar.getByRole('button', { name: 'Start over from theirs' }).click()
  // One that stopped mid-write, long ago: its lock holds nobody back.
  writeFileSync(lock, String(Date.now() - 60_000))
  await logs.selectOption('off')
  await bar.getByRole('button', { name: 'Save changes' }).click()
  await expect(bar).toHaveCount(0)
  expect(existsSync(lock)).toBe(false)

  // What doesn't make sense isn't saved, and the server says why.
  await page.getByRole('link', { name: /^Grants & limits/ }).click()
  await page.getByRole('button', { name: 'New limit' }).click()
  await page
    .getByRole('article', { name: 'New limit' })
    .getByRole('textbox', { name: 'Name' })
    .fill('')
  await bar.getByRole('button', { name: 'Save changes' }).click()
  await expect(bar.getByRole('alert')).toHaveText(
    'Not saved: Access: limits[0].name needs a name of at most 100 characters.',
  )
  // Leaving with it unsaved asks first.
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  const leave = page.getByRole('dialog', { name: 'Leave without saving?' })
  await expect(leave).toContainText('Not saved yet, and lost if you leave: 1 change to access.')
  // Escape stays, too.
  await page.keyboard.press('Escape')
  await expect(leave).toHaveCount(0)
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await leave.getByRole('button', { name: 'Stay' }).click()
  await expect(page).toHaveURL(`${one.url}access/rules`)
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Leave without saving?' })
    .getByRole('button', { name: 'Leave' })
    .click()
  await expect(page).not.toHaveURL(/access/)

  // Where it's kept can't be written: not saved, and said why.
  rmSync(join(data, 'access.json'))
  mkdirSync(join(data, 'access.json'))
  await page.goto(`${one.url}access/profiles`)
  await logs.selectOption('on')
  await bar.getByRole('button', { name: 'Save changes' }).click()
  await expect(bar.getByRole('alert')).toContainText(
    'Not saved: Lumovi couldn’t keep who may do what:',
  )
  // More than a ConfigMap holds: refused, before it's tried.
  const many = await page.evaluate(async () => {
    const { policy, version } = await window.lumovi!.access!.admin()
    const groups = Array.from({ length: 200 }, (_, i) => ({
      id: `g${i}`,
      name: `Group ${i}`,
      provider: [],
      people: Array.from({ length: 300 }, (_, j) => `person-${j}@example.com`),
    }))
    return window.lumovi!.access!.set({ ...policy, groups }, version)
  })
  expect(many).toEqual({
    ok: false,
    error: {
      code: 'invalid',
      message: 'Lumovi can’t keep that much: who may do what would be over 1 MB.',
    },
  })
})

test('what the chart no longer has, what was kept can’t name', async ({ page, context, serve }) => {
  const data = mkdtempSync(join(tmpdir(), 'lumovi-access-'))
  writeFileSync(
    join(data, 'access.json'),
    JSON.stringify({
      version: 1,
      policy: {
        groups: [{ id: 'dev', name: 'Developers', provider: ['developers'] }],
        profiles: [],
        grants: [
          { id: 'old', name: 'Old platform grant', who: ['platform'], profile: 'platform' },
          { id: 'gone', name: 'Gone profile', who: ['dev'], profile: 'retired' },
          { id: 'nobody', name: 'Nobody yet', profile: 'platform' },
        ],
        limits: [{ id: 'temp', name: 'Temps', who: ['temps'], caps: { changes: 'read' } }],
      },
    }),
  )
  const served = await serve({
    env: {
      LUMOVI_AUTH: 'proxy',
      LUMOVI_ADMINS: 'platform-admins',
      LUMOVI_DATA_DIR: data,
      LUMOVI_ACCESS_REFRESH_MS: '200',
      LUMOVI_ACCESS: `
profiles:
  - id: platform
    name: Platform
    values: { changes: write, shells: on, nodeShells: on, logs: on, secrets: values, helm: install, assistants: self, audit: all }
`,
    },
  })
  expect(served.log()).toContain(
    'Access: the grant “Old platform grant”, the grant “Gone profile”, the limit “Temps” named groups or profiles the chart no longer has, and no longer apply.',
  )
  // Written by hand while no Lumovi ran: recorded as it starts, then sealed (as it was written,
  // what no longer applies too), so it's recorded once.
  expect(audited(served, 'access.changed')).toMatchObject([
    {
      actor: { user: 'lumovi', via: 'server' },
      summary: 'Changed outside Lumovi, while it wasn’t running: what it was before can’t be known',
      details: {
        changes: [
          'Changed while Lumovi wasn’t running, from what it can’t say: it now has 1 group, no profiles, 1 grant and no limits',
        ],
        outside: true,
      },
    },
  ])
  const sealed = JSON.parse(readFileSync(join(data, 'access.json'), 'utf8'))
  expect(sealed.seal).toMatch(/^[0-9a-f]{64}$/)
  expect(sealed.policy.grants).toHaveLength(3)
  await as(context, 'ana@example.com', 'platform-admins')
  await page.goto(`${served.url}access/history`)
  await expect(
    page.getByText(
      'Changed while Lumovi wasn’t running, from what it can’t say: it now has 1 group, no profiles, 1 grant and no limits',
    ),
  ).toBeVisible()
  await page.getByRole('link', { name: /^Grants/ }).click()
  await expect(page.getByRole('article')).toHaveText([/^Nobody yet/])
  // Said once, however often it's read again.
  await new Promise((done) => setTimeout(done, 1_000))
  expect(served.log().split('named groups or profiles the chart no longer has')).toHaveLength(2)
})

test('kept in memory, an admin is told it doesn’t last', async ({ page, context, serve }) => {
  const served = await serve({
    env: { LUMOVI_AUTH: 'proxy', LUMOVI_ADMINS: 'user:ana@example.com' },
  })
  expect(served.log()).toContain(
    'Access settings are kept in memory: they’re lost when Lumovi stops. Set LUMOVI_DATA_DIR, or install the Helm chart, to keep them.',
  )
  await as(context, 'ana@example.com', '')
  await page.goto(`${served.url}access`)
  await expect(page.getByText(/This server keeps it in memory/)).toBeVisible()
  // Nobody has signed in but her: what the page says to do until they do.
  await expect(page.getByRole('note')).toContainText('Your proxy sends no groups as people sign in')
  await page.getByRole('link', { name: 'History' }).click()
  await expect(page.getByText(/^No changes yet/)).toBeVisible()
})

test('who signed in is remembered as the server starts again, the most lately seen', async ({
  page,
  browser,
  serve,
}) => {
  const data = mkdtempSync(join(tmpdir(), 'lumovi-access-'))
  const env = {
    LUMOVI_ADMINS: 'user:alice@example.com',
    LUMOVI_DATA_DIR: data,
    LUMOVI_ACCESS_SEEN_MAX: '2',
  }
  const first = await serve({ env })
  // (One that didn't work: nobody's.)
  const tried = await page.request.post(`${first.url}api/session`, {
    data: { token: 'not-a-token' },
    headers: { Origin: new URL(first.url).origin },
  })
  expect(tried.ok()).toBe(false)
  for (const token of [DEMO_TOKEN, PEOPLE.bob.token, PEOPLE.alice.token]) {
    const context = await browser.newContext()
    await signIn(await context.newPage(), `${first.url}cluster/demo`, token)
    await context.close()
  }
  await first.stop()
  // Its audit history says who signed in: they're seen again, the most lately seen kept.
  const again = await serve({ env })
  await signIn(page, `${again.url}cluster/demo`, PEOPLE.alice.token)
  await page.goto(`${again.url}access/check`)
  const people = await page.evaluate(() =>
    window.lumovi!.access!.admin().then(({ seen }) => seen.map((p) => p.name)),
  )
  expect(people).toEqual(['alice@example.com', 'bob@example.com'])
  const who = page.getByRole('region', { name: 'Check someone' })
  await who.getByRole('combobox', { name: 'Person' }).fill('bob')
  await who.getByRole('combobox', { name: 'Person' }).press('Enter')
  await expect(who).toContainText(/Signed in .+ ago, with a token/)
  // Its history, a page at a time; and where a page ends, only as Lumovi said it.
  expect(
    await page.evaluate(() =>
      window.lumovi!.access!.history('x').catch((error: Error) => error.message),
    ),
  ).toBe(
    'Where the page ended isn’t one this Lumovi gave (it may have started again since): search again.',
  )
  expect(
    await page.evaluate(() =>
      window.lumovi!.access!.history(7 as never).catch((error: Error) => error.message),
    ),
  ).toBe(
    'Where the page ended isn’t one this Lumovi gave (it may have started again since): search again.',
  )
  // Saved against a version that isn't the latest: refused.
  expect(
    await page.evaluate(async () => {
      const { policy } = await window.lumovi!.access!.admin()
      return window.lumovi!.access!.set(policy, 'stale')
    }),
  ).toEqual({
    ok: false,
    error: {
      code: 'conflict',
      message:
        'Someone else changed access since you opened it. Theirs is shown now: make your change again.',
    },
  })
  // Saved as it was: nothing changed, nothing recorded.
  await page.evaluate(async () => {
    const { policy, version } = await window.lumovi!.access!.admin()
    await window.lumovi!.access!.set(policy, version)
  })
  expect(audited(again, 'access.changed')).toEqual([])
  // More than a page of changes: the rest, when asked for.
  await page.evaluate(async () => {
    for (let i = 0; i < 51; i++) {
      const { policy, version } = await window.lumovi!.access!.admin()
      const everyone = { ...policy.everyone, logs: i % 2 ? 'on' : 'off' } as typeof policy.everyone
      await window.lumovi!.access!.set({ ...policy, everyone }, version)
    }
  })
  await page.getByRole('link', { name: 'History' }).click()
  const changes = page
    .getByRole('list')
    .filter({ hasText: 'alice@example.com' })
    .getByRole('listitem')
  await expect(changes.filter({ hasText: 'alice@example.com, from' })).toHaveCount(50)
  await page.getByRole('button', { name: 'Earlier changes' }).click()
  await expect(changes.filter({ hasText: 'alice@example.com, from' })).toHaveCount(51)
  await expect(page.getByRole('button', { name: 'Earlier changes' })).toHaveCount(0)
})

test('single sign-on that sends no groups: said, and how to send them', async ({ page, serve }) => {
  const oidc = await startMockOidc({ clientId: 'lumovi' })
  oidc.person = { sub: 'u-1', email: 'alice@example.com' }
  const port = await freePort()
  const served = await serve({
    port,
    env: {
      LUMOVI_AUTH: 'oidc',
      LUMOVI_URL: `http://127.0.0.1:${port}`,
      LUMOVI_OIDC_ISSUER: oidc.issuer,
      LUMOVI_OIDC_CLIENT_ID: 'lumovi',
      LUMOVI_OIDC_PROVIDER_NAME: 'Okta',
      LUMOVI_ADMINS: 'user:alice@example.com',
    },
  })
  await page.goto(`${served.url}access`)
  await page.getByRole('button', { name: 'Sign in with Okta' }).click()
  await expect(page.getByRole('note').first()).toHaveText(
    'Okta sends no groups as people sign inSo nobody is in a group through Okta: only people named in one are. To use its groups, add a groups claim to Lumovi’s app in Okta: Lumovi reads the ID token’s “groups” claim. They’ll show here as people sign in again.',
  )
  await page.goto(`${served.url}your-access`)
  await expect(page.getByText('Signed in with Okta')).toBeVisible()
  await expect(page.getByText('None arrived as you signed in')).toBeVisible()
  await oidc.close()
})

test('every change, said as it was and as it is', async ({ page, context, serve }) => {
  const served = await serve({ env: { LUMOVI_AUTH: 'proxy', LUMOVI_ADMINS: 'platform-admins' } })
  await as(context, 'ana@example.com', 'platform-admins')
  await page.goto(`${served.url}access/history`)
  const levels = (over: Record<string, string> = {}) => ({
    changes: 'read',
    shells: 'off',
    nodeShells: 'off',
    logs: 'on',
    secrets: 'keys',
    helm: 'off',
    assistants: 'ask',
    audit: 'own',
    ...over,
  })
  const before = {
    everyone: levels({
      changes: 'write',
      shells: 'on',
      nodeShells: 'on',
      secrets: 'values',
      helm: 'install',
      assistants: 'self',
    }),
    groups: [
      { id: 'dev', name: 'Developers', provider: ['developers'], people: ['amy@example.com'] },
      { id: 'sre', name: 'SRE', description: 'Keeps it running', provider: [], people: [] },
      { id: 'ops', name: 'Ops', description: 'Runs the clusters', provider: [], people: [] },
    ],
    profiles: [
      { id: 'dev', name: 'Developer', values: levels({ changes: 'write' }) },
      { id: 'ops', name: 'Operator', values: levels({ changes: 'write', shells: 'on' }) },
    ],
    grants: [
      {
        id: 'g',
        name: 'Developers build',
        who: ['dev'],
        profile: 'dev',
        clusters: [],
        namespaces: [],
      },
      {
        id: 'h',
        name: 'Both of them',
        who: ['dev', 'sre'],
        profile: 'dev',
        clusters: [],
        namespaces: [],
      },
    ],
    limits: [
      {
        id: 'l',
        name: 'Production',
        who: ['dev'],
        clusters: [],
        namespaces: [],
        caps: { logs: 'off' },
      },
    ],
    names: { developers: 'Devs', old: 'Old name' },
  }
  const after = {
    ...before,
    groups: [
      {
        id: 'dev',
        name: 'Engineers',
        description: 'Everyone who builds',
        provider: ['sre-team', 'oncall'],
        people: ['bo@example.com'],
      },
      { id: 'sre', name: 'SRE', provider: [], people: [] },
      // Someone more, described as it was.
      { ...before.groups[2]!, people: ['cy@example.com'] },
      { id: 'qa', name: 'QA', provider: [], people: [] },
    ],
    profiles: [
      { id: 'dev', name: 'Developer', values: levels({ changes: 'write', helm: 'upgrade' }) },
      before.profiles[1]!,
    ],
    grants: [
      {
        id: 'g',
        name: 'Developers build',
        who: ['qa'],
        profile: 'ops',
        clusters: ['env=staging'],
        namespaces: ['shop'],
      },
      // The same two, the other way round.
      { ...before.grants[1]!, who: ['sre', 'dev'] },
    ],
    limits: [{ ...before.limits[0]!, caps: { shells: 'off' } }],
    // (A name of nothing but spaces is none.)
    names: { developers: 'Devs', 'sre-team': 'SRE team', blank: '  ' },
  }
  const save = (policy: unknown) =>
    page.evaluate(async (given) => {
      const { version } = await window.lumovi!.access!.admin()
      return (await window.lumovi!.access!.set(given as never, version)).ok
    }, policy)
  expect(await save(before)).toBe(true)
  expect(await save(after)).toBe(true)
  expect(audited(served, 'access.changed').at(-1)!.details!.changes).toEqual([
    'Changed the group “Engineers”: renamed it from “Developers”; described it; added SRE team; added oncall; took out Devs; added bo@example.com; took out amy@example.com',
    'Changed the group “SRE”: described it',
    'Changed the group “Ops”: added cy@example.com',
    'Added the group “QA”',
    'Changed the profile “Developer”: Helm: Off → Upgrade, roll back',
    'Changed the grant “Developers build”: who: added “QA”, took out “Engineers”; clusters all → env=staging; namespaces all → shop; profile Developer → Operator',
    'Changed the grant “Both of them”',
    'Changed the limit “Production”: Shells: not limited → Off; Logs: Off → not limited',
    'Took the name “Old name” from old',
    'Named sre-team “SRE team”',
  ])
  // Shown in the history, each part as it was and as it is.
  await page.reload()
  const changes = page.getByRole('list').filter({ hasText: 'ana@example.com' }).first()
  await expect(changes).toContainText('Changed the profile “Developer”HelmOffUpgrade, roll back')
  await expect(changes).toContainText('clusters allenv=staging')
  await expect(changes).toContainText('added bo@example.com')
})

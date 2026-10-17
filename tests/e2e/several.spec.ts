/**
 * Several clusters in one list: picked on the Clusters page, their lists merged, each row named
 * by its cluster and acted on there alone. A cluster that signs in is read only on its own Open;
 * one that doesn't answer is given up on for the read, and says so; a terminal asks which.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { MockCluster } from '../mock-cluster/server.ts'
import type { KubeObject } from '../mock-cluster/types.ts'
import { placed } from '../placed.ts'
import { dialog, toasts, writes } from './action-helpers.ts'
import { clusterOption, CONTEXTS, expect, panel, row, rows, test } from './fixtures.ts'

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)

/** The page of several clusters' `page`, over `contexts`. */
const several = (page: Page, list: string, contexts: string[]) =>
  go(page, `#/clusters/${list}?${new URLSearchParams(contexts.map((c) => ['c', c]))}`)

const strip = (page: Page) => page.getByRole('group', { name: 'Clusters' })
const chip = (page: Page, context: string) => strip(page).locator(`[data-cluster="${context}"]`)
const dock = (page: Page) => page.getByRole('region', { name: 'Tabs below' })

/** A running pod, `name` in `namespace` of a cluster: undone by its reset. */
function aPod(cluster: MockCluster, namespace: string, name: string) {
  cluster.upsert({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace,
      uid: `pod-${cluster.port}-${namespace}-${name}`,
      creationTimestamp: '2026-10-01T00:00:00Z',
      labels: { app: name },
    },
    spec: { containers: [{ name: 'web', image: 'nginx:1.27' }] },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [
        {
          name: 'web',
          ready: true,
          restartCount: 0,
          image: 'nginx:1.27',
          state: { running: { startedAt: '2026-10-01T00:00:00Z' } },
        },
      ],
    },
  } as unknown as KubeObject)
}

test('two clusters’ pods in one list, each row named by its cluster; what’s done to a sandbox row is done on the sandbox alone', async ({
  page,
  clusters,
}) => {
  aPod(clusters.demo, 'default', 'twin')
  aPod(clusters.sandbox, 'default', 'twin')
  await several(page, 'pods', [CONTEXTS.demo, CONTEXTS.sandbox])
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods · 2 clusters')
  await expect(strip(page)).toContainText('2 of 2 answered')
  await page.getByPlaceholder('Filter pods').fill('twin')
  const twins = row(page, 'Pods', 'twin')
  await expect(twins).toHaveCount(2)
  const onSandbox = twins.filter({ hasText: CONTEXTS.sandbox })
  await expect(onSandbox).toHaveCount(1)

  // A chip pressed: that cluster alone, and pressed again, all of them.
  await chip(page, CONTEXTS.sandbox).getByRole('button', { pressed: false }).click()
  await expect(rows(page, 'Pods')).toHaveCount(1)
  await expect(page).toHaveURL(/only=sandbox/)
  await chip(page, CONTEXTS.sandbox).getByRole('button', { pressed: true }).click()
  await expect(twins).toHaveCount(2)

  // Its menu names its cluster; its dialog does too, and it deletes the sandbox's alone.
  await onSandbox.click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu).toContainText(`Actions on ${CONTEXTS.sandbox}`)
  await menu.getByRole('menuitem', { name: 'Delete…' }).click()
  await expect(dialog(page)).toContainText(CONTEXTS.sandbox)
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(toasts(page)).toContainText('Deleted pod twin')
  await expect
    .poll(() => writes(clusters.sandbox, 'DELETE', '/api/v1/namespaces/default/pods/twin').length)
    .toBe(1)
  expect(writes(clusters.demo, 'DELETE', /\/pods\//)).toHaveLength(0)
  expect(clusters.demo.object('Pod', 'default', 'twin')).toBeDefined()
  await expect(twins).toHaveCount(1)
  await expect(twins).toContainText(CONTEXTS.demo)
})

test('the panel reads its own cluster, says which, and opens it there; rows on two clusters aren’t acted on together', async ({
  page,
  clusters,
}) => {
  aPod(clusters.demo, 'default', 'twin')
  aPod(clusters.sandbox, 'default', 'twin')
  await several(page, 'pods', [CONTEXTS.demo, CONTEXTS.sandbox])
  await page.getByPlaceholder('Filter pods').fill('twin')
  const twins = row(page, 'Pods', 'twin')
  await expect(twins).toHaveCount(2)
  await twins.filter({ hasText: CONTEXTS.sandbox }).getByRole('gridcell').nth(1).click()
  const detail = panel(page, 'Pod', 'twin')
  await expect(detail).toContainText(`Pod · default · on ${CONTEXTS.sandbox}`)
  await expect(page).toHaveURL(/oc=sandbox/)

  // Ticked on both: nothing acts on them together, and the keys say why.
  await page.keyboard.press('Escape')
  await expect(detail).toHaveCount(0)
  for (const twin of await twins.all()) {
    await twin.getByRole('checkbox', { name: 'Select twin' }).click()
  }
  const why = 'They’re on 2 clusters: pick rows on one to act on them together.'
  const bar = page.getByRole('toolbar', { name: 'Selected rows' })
  await expect(bar).toContainText(why)
  // Its actions are there, turned off.
  await expect(bar.getByRole('button', { name: 'Delete' })).toBeDisabled()
  await page.locator('#content').focus()
  await page.keyboard.press('.')
  await expect(toasts(page)).toContainText(why)
  await expect(page.getByRole('menu')).toHaveCount(0)

  // Open in sandbox: that cluster's own page, the pod open there.
  await bar.getByRole('button', { name: 'Clear selection' }).click()
  await twins.filter({ hasText: CONTEXTS.sandbox }).getByRole('gridcell').nth(1).click()
  await detail.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: `Open in ${CONTEXTS.sandbox}` }).click()
  await expect(page).toHaveURL(/#\/cluster\/sandbox\/pods\?open=Pod%2Fdefault%2Ftwin/)
  await expect(panel(page, 'Pod', 'twin')).toBeVisible()
})

test('an action that opens the panel opens it on its row’s cluster: Shell on the sandbox’s pod, with the panel on the demo’s of one name, is the sandbox’s', async ({
  page,
  clusters,
}) => {
  aPod(clusters.demo, 'default', 'twin')
  aPod(clusters.sandbox, 'default', 'twin')
  await several(page, 'pods', [CONTEXTS.demo, CONTEXTS.sandbox])
  await page.getByPlaceholder('Filter pods').fill('twin')
  const twins = row(page, 'Pods', 'twin')
  await expect(twins).toHaveCount(2)
  const detail = panel(page, 'Pod', 'twin')
  // The panel on the sandbox's; Edit YAML from the demo's row takes it to the demo's.
  await twins.filter({ hasText: CONTEXTS.sandbox }).getByRole('gridcell').nth(1).click()
  await expect(detail).toContainText(`on ${CONTEXTS.sandbox}`)
  await twins.filter({ hasText: CONTEXTS.demo }).click({ button: 'right' })
  await expect(page.getByRole('menu')).toContainText(`Actions on ${CONTEXTS.demo}`)
  await page.getByRole('menuitem', { name: 'Edit YAML' }).click()
  await expect(page).toHaveURL(/oc=demo/)
  await expect(detail).toContainText(`on ${CONTEXTS.demo}`)
  // Shell from the sandbox's row, the panel on the demo's: the sandbox's pod's shell.
  await twins.filter({ hasText: CONTEXTS.sandbox }).click({ button: 'right' })
  await expect(page.getByRole('menu')).toContainText(`Actions on ${CONTEXTS.sandbox}`)
  await page.getByRole('menuitem', { name: 'Shell', exact: true }).click()
  await expect(page).toHaveURL(/oc=sandbox/)
  await expect(detail).toContainText(`on ${CONTEXTS.sandbox}`)
  await expect(detail.getByRole('tab', { name: 'Shell' })).toHaveAttribute('aria-selected', 'true')
  const exec = (cluster: MockCluster) =>
    cluster.requests.filter((r) => r.path === '/api/v1/namespaces/default/pods/twin/exec')
  await expect.poll(() => exec(clusters.sandbox).length).toBeGreaterThan(0)
  expect(exec(clusters.demo)).toHaveLength(0)
})

test('beside the panel at 1024, a chip with a long name gives way, its words first, then its name, never its button: the list never scrolls sideways', async ({
  launch,
  clusters,
}) => {
  // Named as an EKS context is: about 50 characters.
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({
      theme: 'system',
      clusters: {
        [CONTEXTS.execMissing]: { name: 'arn:aws:eks:eu-west-1:123456789012:cluster/prod-eu' },
      },
    }),
  )
  const { page } = await launch({
    userDataDir,
    env: { LUMOVI_E2E_WINDOW: '1024x768' },
    fullLayout: false,
  })
  aPod(clusters.sandbox, 'default', 'twin')
  await several(page, 'pods', [CONTEXTS.demo, CONTEXTS.sandbox, CONTEXTS.execMissing])
  await page.getByPlaceholder(/^Filter/).fill('twin')
  await row(page, 'Pods', 'twin').getByRole('gridcell').nth(1).click()
  await expect(panel(page, 'Pod', 'twin')).toBeVisible()
  const long = chip(page, CONTEXTS.execMissing)
  await expect(long.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
  // All of its name is there to hear and in its title, however it's cut.
  await expect(long).toContainText('arn:aws:eks:eu-west-1:123456789012:cluster/prod-eu')
  await expect
    .poll(() =>
      page.locator('#content').evaluate((content) => content.scrollWidth - content.clientWidth),
    )
    .toBeLessThanOrEqual(1)
  const strip = await placed(page.getByRole('group', { name: 'Clusters' }))
  const box = await placed(long)
  expect(box.x + box.width).toBeLessThanOrEqual(strip.x + strip.width + 1)
})

test('beside the panel at 1024, where the Cluster column gives way, a row’s names say its cluster', async ({
  launch,
  clusters,
}) => {
  const { page } = await launch({ env: { LUMOVI_E2E_WINDOW: '1024x768' }, fullLayout: false })
  aPod(clusters.demo, 'default', 'twin')
  aPod(clusters.sandbox, 'default', 'twin')
  await several(page, 'pods', [CONTEXTS.demo, CONTEXTS.sandbox])
  await page.getByPlaceholder(/^Filter/).fill('twin')
  const twins = row(page, 'Pods', 'twin')
  await expect(twins).toHaveCount(2)
  await twins.filter({ hasText: CONTEXTS.sandbox }).getByRole('gridcell').nth(1).click()
  await expect(panel(page, 'Pod', 'twin')).toContainText(`on ${CONTEXTS.sandbox}`)
  const grid = page.getByRole('grid', { name: 'Pods' })
  await expect(grid.getByRole('columnheader', { name: 'Cluster' })).toHaveCount(0)
  await expect(twins.filter({ hasText: CONTEXTS.sandbox })).toHaveCount(1)
  await expect(twins.filter({ hasText: CONTEXTS.demo })).toHaveCount(1)
})

test('one that signs in is read only on its Open; one that doesn’t answer is given up on after 10 seconds, with Retry', async ({
  page,
  clusters,
}) => {
  // The sandbox's pods never answer; the offline cluster refuses at once.
  aPod(clusters.sandbox, 'default', 'twin')
  const answer = clusters.sandbox.fail(/\/pods$/, { hang: true })
  await several(page, 'pods', [
    CONTEXTS.demo,
    CONTEXTS.execMissing,
    CONTEXTS.sandbox,
    CONTEXTS.offline,
  ])
  await expect(chip(page, CONTEXTS.execMissing)).toContainText('Signs in when opened')
  await expect(chip(page, CONTEXTS.sandbox)).toContainText('Reading…')
  await expect(chip(page, CONTEXTS.offline)).toContainText('didn’t answer in time')
  // Rows come as each answers: the demo's while the sandbox is still read.
  await expect(chip(page, CONTEXTS.sandbox)).toContainText('Reading…')
  await expect(rows(page, 'Pods').first()).toBeVisible()
  await expect(chip(page, CONTEXTS.sandbox)).toContainText('didn’t answer in time', {
    timeout: 20_000,
  })
  await expect(strip(page)).toContainText('1 of 4 answered')
  // Retry asks it again.
  answer()
  await chip(page, CONTEXTS.sandbox).getByRole('button', { name: 'Retry' }).click()
  await expect(strip(page)).toContainText('2 of 4 answered')
  await expect(chip(page, CONTEXTS.sandbox)).not.toContainText('didn’t answer')
  // One that answered, then stops: its last rows stay, and its chip says so, with Retry.
  await page.getByPlaceholder('Filter pods').fill('twin')
  await expect(row(page, 'Pods', 'twin')).toHaveCount(1)
  const answerAgain = clusters.sandbox.fail(/\/pods$/, { hang: true })
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(chip(page, CONTEXTS.sandbox)).toContainText(
    'couldn’t refresh · showing the last data',
    { timeout: 20_000 },
  )
  await expect(chip(page, CONTEXTS.sandbox).getByRole('button', { name: 'Retry' })).toBeVisible()
  await expect(row(page, 'Pods', 'twin')).toHaveCount(1)
  await expect(strip(page)).toContainText('2 of 4 answered')
  answerAgain()
  await chip(page, CONTEXTS.sandbox).getByRole('button', { name: 'Retry' }).click()
  await expect(chip(page, CONTEXTS.sandbox)).not.toContainText('couldn’t refresh')
  // Still unread: nothing started its sign-in.
  await expect(chip(page, CONTEXTS.execMissing)).toContainText('Signs in when opened')
  await chip(page, CONTEXTS.execMissing).getByRole('button', { name: 'Open', exact: true }).click()
  await expect(chip(page, CONTEXTS.execMissing)).not.toContainText('Signs in when opened')
})

test('none answering says so, with Retry all; a capped cluster says how many it shows', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_MAX_LIST_ITEMS: '1000' } })
  await several(page, 'pods', [CONTEXTS.offline, CONTEXTS.expired])
  await expect(page.getByText('None of the 2 clusters answered')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Retry all' })).toBeVisible()

  await several(page, 'pods', [CONTEXTS.sandbox, CONTEXTS.large])
  await expect(
    page.getByText(
      /^large shows the first 1,000 of [\d,]+ pods\. Choose a namespace or use a label selector to see the rest\.$/,
    ),
  ).toBeVisible({ timeout: 20_000 })
  await expect(chip(page, CONTEXTS.large)).toContainText(/1,000 of [\d,]+/)
})

test('picked on the Clusters page: ticks, Enter opens the ticked ones together, Esc leaves', async ({
  page,
}) => {
  await expect(clusterOption(page, CONTEXTS.demo)).toBeVisible()
  const toggle = page.getByRole('button', { name: 'Several clusters' })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await clusterOption(page, CONTEXTS.demo).click()
  await clusterOption(page, CONTEXTS.sandbox).click()
  await clusterOption(page, CONTEXTS.execMissing).click()
  const bar = page.getByRole('toolbar', { name: 'Clusters ticked' })
  await expect(bar).toContainText('3 clusters')
  await expect(bar).toContainText('1 sign in when opened')
  // A click ticks, and ticks off; nothing opened yet.
  await clusterOption(page, CONTEXTS.execMissing).click()
  await expect(bar).toContainText('2 clusters')
  await expect(page).not.toHaveURL(/clusters/)
  // Esc leaves, and forgets the ticks.
  await page.getByPlaceholder('Search clusters and labels…').press('Escape')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(bar).toHaveCount(0)

  await toggle.click()
  await clusterOption(page, CONTEXTS.demo).click()
  await clusterOption(page, CONTEXTS.sandbox).click()
  await page.getByPlaceholder('Search clusters and labels…').press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods · 2 clusters')
  await expect(page).toHaveURL(/#\/clusters\/pods\?c=demo&c=sandbox$/)
})

test('with words in the search, Tab goes into the list to tick; the set opened last is offered again, in the palette too, and forgotten', async ({
  page,
}) => {
  await expect(clusterOption(page, CONTEXTS.demo)).toBeVisible()
  await page.getByRole('button', { name: 'Several clusters' }).click()
  const search = page.getByPlaceholder('Search clusters and labels…')
  const footer = page.getByText(/to tick$/)
  await expect(footer).toHaveText('Space to tick')
  // With words searched for, Space types a space; Tab, then Space, ticks.
  await search.fill('sand')
  await expect(footer).toHaveText('Tab, then Space to tick')
  await search.press('Space')
  await expect(search).toHaveValue('sand ')
  const bar = page.getByRole('toolbar', { name: 'Clusters ticked' })
  await expect(bar).toHaveCount(0)
  await search.press('Tab')
  await page.keyboard.press('Space')
  await expect(bar).toContainText('1 cluster')
  await expect(clusterOption(page, CONTEXTS.sandbox)).toHaveAttribute('aria-checked', 'true')
  // A letter goes back to the search, with it.
  await page.keyboard.press('x')
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('sand x')
  await search.fill('')
  await clusterOption(page, CONTEXTS.demo).click()
  await search.press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods · 2 clusters')

  // Back on the Clusters page: the set, a row above Recent.
  await go(page, '#/')
  const last = page.getByRole('option', { name: /^Last opened together/ })
  await expect(last).toContainText('sandbox, demo')
  await last.click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods · 2 clusters')
  await expect(page).toHaveURL(/c=sandbox&c=demo$/)
  // In a cluster's palette.
  await go(page, '#/cluster/demo')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: /^Open the last several clusters/ }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods · 2 clusters')
  // Demo opened alone since: it's under the set's row, and Enter opens it, as before.
  await go(page, '#/')
  await expect(last).toBeVisible()
  await expect(page.locator('[cmdk-item][data-selected="true"]')).toHaveAttribute(
    'data-value',
    `recent\u0000${CONTEXTS.demo}`,
  )
  // Forgotten, from its ⋯.
  await last.hover()
  await last.getByRole('button', { name: 'Actions for the last set' }).click()
  await page.getByRole('menuitem', { name: 'Forget it' }).click()
  await expect(last).toHaveCount(0)
})

test('a terminal’s + asks which cluster, the panel’s first', async ({ launch, clusters }) => {
  const { page } = await launch({ env: { SHELL: '/bin/sh' } })
  aPod(clusters.sandbox, 'default', 'twin')
  await several(page, 'pods', [CONTEXTS.demo, CONTEXTS.sandbox])
  await page.getByPlaceholder('Filter pods').fill('twin')
  await row(page, 'Pods', 'twin').getByRole('gridcell').nth(1).click()
  await expect(panel(page, 'Pod', 'twin')).toBeVisible()
  await dock(page)
    .getByRole('button', { name: /^New terminal/ })
    .click()
  const menu = page.getByRole('menu')
  await expect(menu).toContainText('Open a terminal on')
  const items = menu.getByRole('menuitem')
  await expect(items).toHaveText([`${CONTEXTS.sandbox}In the panel`, CONTEXTS.demo])
  await expect(items.first()).toBeFocused()
  await page.keyboard.press('Enter')
  const tabs = dock(page).getByRole('tablist', { name: 'Tabs below' })
  await expect(tabs.getByRole('tab')).toHaveText([CONTEXTS.sandbox])
})

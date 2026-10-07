/**
 * A fleet: one server showing many clusters, each as the person signed in may
 * see it there, summed up on its page, worst first.
 */
import type { Page } from '@playwright/test'
import { parse } from 'yaml'
import { HELM } from '../mock-cluster/fixtures/helm.ts'
import { FLEET, fleetKubeconfig } from '../mock-cluster/fleet.ts'
import { startMockOidc } from '../mock-oidc/server.ts'
import {
  expect,
  freePort,
  helmKubeconfigs,
  test,
  type ServeOptions,
  type Served,
} from './fixtures.ts'
import { as, card, fleetEnv } from './fleet.ts'

/** The cards' clusters, in order. */
async function names(page: Page): Promise<string[]> {
  const labels = await page
    .locator('[data-cluster-card]')
    .evaluateAll((cards) => cards.map((c) => c.getAttribute('aria-label')!))
  return labels.map((label) => label.split(', ')[0]!)
}

async function openFleet(
  page: Page,
  serve: (options?: ServeOptions) => Promise<Served>,
  env: Record<string, string | undefined>,
): Promise<Served> {
  const served = await serve({ env })
  await page.goto(served.url)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  return served
}

test('every cluster, worst first, as each person may see it', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  await as(context, 'alice@example.com', 'developers')
  const served = await openFleet(
    page,
    serve,
    fleetEnv(clusters, { [FLEET.staging]: { labels: { env: 'staging' }, groups: ['developers'] } }),
  )
  expect(served.log()).toContain(
    `shows a fleet of 4 clusters (${FLEET.prodEu}, ${FLEET.prodUs}, ${FLEET.staging}, ${FLEET.edge})`,
  )
  await expect(page).toHaveTitle('Clusters — Lumovi')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('4 clusters2 need attention')
  // The audit log of a fleet: each of its clusters'.
  await page.goto(`${served.url}audit`)
  await expect(page.getByRole('banner')).toContainText('Fleetalice@example.com')
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('4 clusters2 need attention')
  await expect
    .poll(() => names(page))
    .toEqual([FLEET.edge, FLEET.prodEu, FLEET.prodUs, FLEET.staging])

  // Each card says what its cluster's overview would.
  const eu = card(page, FLEET.prodEu)
  await expect(eu).toHaveAccessibleName(`${FLEET.prodEu}, 1 node not ready`)
  await expect(eu).toContainText('v1.34.1')
  await expect(eu).toContainText('env=productionregion=eu-west')
  await expect(eu).toContainText('Nodes3/41 not ready')
  await expect(eu).toContainText('Pods running288 unhealthy')
  await expect(eu).toContainText('Workloads8/124 degraded')
  await expect(eu).toContainText('Warnings12Last hour')
  await expect(eu.getByRole('meter', { name: 'CPU in use' })).toBeVisible()
  await expect(eu.getByRole('meter', { name: 'Memory in use' })).toBeVisible()
  const us = card(page, FLEET.prodUs)
  await expect(us).toHaveAccessibleName(`${FLEET.prodUs}, Healthy`)
  await expect(us).toContainText('Pods running2,500All fine')
  await expect(us).toContainText('Workloads0None yet')
  // Without metrics-server, and without pods.
  const staging = card(page, FLEET.staging)
  await expect(staging).toContainText('Pods running0None yet')
  await expect(staging).toContainText('CPUNo metrics')
  // What can't be reached says why.
  const edge = card(page, FLEET.edge)
  await expect(edge).toHaveAccessibleName(`${FLEET.edge}, Unreachable`)
  await expect(edge).toContainText('ECONNREFUSED')

  // Each cluster is asked as the person: impersonated, with their groups.
  await expect
    .poll(() => clusters.demo.requests.findLast((r) => r.path === '/api/v1/nodes'))
    .toMatchObject({ user: 'alice@example.com', headers: { 'impersonate-group': 'developers' } })

  // Someone else sees only what's shared with them: staging is the developers'.
  await as(context, 'bob@example.com')
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('3 clusters2 need attention')
  await expect(card(page, FLEET.staging)).toHaveCount(0)
  // And can't reach it by its address either.
  await page.goto(`${served.url}cluster/${FLEET.staging}`)
  await expect(page.getByRole('alert')).toContainText(
    `This server has no cluster called “${FLEET.staging}” that you can see.`,
  )
})

test('filters, labels and grouping, kept in the URL', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  await as(context, 'alice@example.com')
  const served = await openFleet(page, serve, fleetEnv(clusters))
  await expect.poll(() => names(page)).toHaveLength(4)
  const show = page.getByRole('group', { name: 'Show' })
  await expect(show).toContainText('All4Needs attention2Healthy2Unreachable1')

  await show.getByRole('button', { name: /^Needs attention/ }).click()
  await expect(page).toHaveURL(`${served.url}?show=attention`)
  await expect.poll(() => names(page)).toEqual([FLEET.edge, FLEET.prodEu])
  await show.getByRole('button', { name: /^Unreachable/ }).click()
  await expect.poll(() => names(page)).toEqual([FLEET.edge])
  await show.getByRole('button', { name: /^Healthy/ }).click()
  await expect.poll(() => names(page)).toEqual([FLEET.prodUs, FLEET.staging])
  await show.getByRole('button', { name: /^All/ }).click()
  await expect(page).toHaveURL(served.url)

  // Labels: each with how many clusters have it; picked ones all apply.
  const labels = page.getByRole('group', { name: 'Labels' })
  await expect(labels.getByRole('button')).toHaveText([
    'env=production3',
    'env=staging1',
    'region=ap-south1',
    'region=eu-west2',
    'region=us-east1',
  ])
  await labels.getByRole('button', { name: /^region=eu-west/ }).click()
  await expect.poll(() => names(page)).toEqual([FLEET.prodEu, FLEET.staging])
  await labels.getByRole('button', { name: /^env=production/ }).click()
  await expect.poll(() => names(page)).toEqual([FLEET.prodEu])
  await labels.getByRole('button', { name: /^region=eu-west/ }).click()
  await expect.poll(() => names(page)).toEqual([FLEET.edge, FLEET.prodEu, FLEET.prodUs])
  await page.goBack()
  await expect.poll(() => names(page)).toEqual([FLEET.prodEu])
  await page.goForward()
  await labels.getByRole('button', { name: /^env=production/ }).click()

  // Search: by name and by label.
  await page.getByPlaceholder('Search clusters and labels…').fill('us-east')
  await expect.poll(() => names(page)).toEqual([FLEET.prodUs])
  await page.keyboard.press('ArrowDown')
  await expect(card(page, FLEET.prodUs)).toBeFocused()
  await page.getByPlaceholder('Search clusters and labels…').fill('nothing-like-it')
  await expect(page.getByText('No clusters match')).toBeVisible()
  await page.getByRole('button', { name: 'Show every cluster' }).click()
  await expect.poll(() => names(page)).toHaveLength(4)

  // Grouped by a label: its values in order, clusters without it last.
  await page.getByRole('button', { name: 'Group by' }).click()
  await page.getByRole('menuitemradio', { name: 'region' }).click()
  await expect(page).toHaveURL(`${served.url}?group=region`)
  await expect(page.getByRole('main').getByRole('region')).toHaveText([
    /^region=ap-south1/,
    /^region=eu-west2/,
    /^region=us-east1/,
  ])
  await page.getByRole('button', { name: 'Grouped by region' }).click()
  await page.getByRole('menuitemradio', { name: 'Nothing' }).click()
  await expect(page).toHaveURL(served.url)
})

test('clusters without a label are grouped last', async ({ page, context, serve, clusters }) => {
  await as(context, 'alice@example.com')
  await openFleet(page, serve, {
    ...fleetEnv(clusters, { [FLEET.edge]: { labels: {} } }),
  })
  await page.goto(`${page.url()}?group=env`)
  await expect(page.getByRole('region', { name: 'No env' })).toContainText(FLEET.edge)
  // Its card has no labels to show.
  await expect(card(page, FLEET.edge)).toContainText('ECONNREFUSED')
  await expect(card(page, FLEET.edge)).not.toContainText('=')
})

test('opening a cluster, switching to another, and back to them all', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  await as(context, 'alice@example.com')
  const served = await openFleet(page, serve, fleetEnv(clusters))
  await card(page, FLEET.prodEu).click()
  await expect(page).toHaveURL(`${served.url}cluster/${FLEET.prodEu}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview')

  await page.getByRole('button', { name: 'Switch cluster' }).click()
  const switcher = page.getByRole('dialog')
  await expect(switcher.getByRole('option')).toHaveText([
    FLEET.prodEu,
    FLEET.prodUs,
    FLEET.staging,
    FLEET.edge,
    'All clusters',
  ])
  // The read-only switch is everyone's, on this server.
  await expect(switcher).toContainText(
    `Lumovi won’t change ${FLEET.prodEu} for anyone on this server`,
  )
  await switcher.getByRole('option', { name: FLEET.prodUs }).click()
  await expect(page).toHaveURL(`${served.url}cluster/${FLEET.prodUs}`)

  await page.keyboard.press('ControlOrMeta+K')
  await page.getByRole('option', { name: 'All clusters' }).click()
  await expect(page).toHaveURL(served.url)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^4 clusters/)

  // A cluster that can't be reached says so, with a way back to them all.
  await card(page, FLEET.edge).click()
  const banner = page.getByRole('status').filter({ hasText: `Can’t reach ${FLEET.edge}.` })
  await banner.getByRole('button', { name: 'All clusters' }).click()
  await expect(page).toHaveURL(served.url)
  // The logo leads there too, as the page first shows.
  await page
    .getByRole('group', { name: 'Show' })
    .getByRole('button', { name: /^Healthy/ })
    .click()
  await expect(page).toHaveURL(`${served.url}?show=healthy`)
  await page.getByRole('link', { name: 'Lumovi: every cluster' }).click()
  await expect(page).toHaveURL(served.url)
})

test('finding a workload in every cluster', async ({ page, context, serve, clusters }) => {
  // Enough of one name in staging that not all of them are listed.
  for (let i = 0; i < 52; i += 1) {
    clusters.sandbox.upsert({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: `worker-${i}`,
        namespace: 'default',
        creationTimestamp: new Date().toISOString(),
      },
      spec: { replicas: 1, template: { spec: { containers: [{ name: 'w', image: 'w:1' }] } } },
      status: { readyReplicas: 1 },
    })
  }
  await as(context, 'alice@example.com')
  const served = await openFleet(page, serve, fleetEnv(clusters))
  await expect.poll(() => names(page)).toHaveLength(4)
  await page.getByRole('button', { name: 'Find a workload' }).click()
  const find = page.getByRole('dialog', { name: 'Find a workload' })
  const input = find.getByRole('combobox', { name: 'Workload name' })
  await expect(input).toBeFocused()
  // Where it looks: the clusters that answered (not edge-ap).
  await expect(find).toContainText('In 3 clusters: their Deployments, StatefulSets')

  await input.fill('checkout')
  const found = find.getByRole('listbox', { name: 'Workloads found' })
  await expect(found.getByRole('option')).toHaveText([
    `checkout · Deployment in shopDegraded${FLEET.prodEu}`,
  ])
  await input.fill('nothing-is-called-this')
  await expect(find).toContainText('No workload here is called “nothing-is-called-this”.')

  await input.fill('worker')
  await expect(found.getByRole('option')).toHaveCount(50)
  await expect(find).toContainText('And 2 more: type more of a name to narrow them down.')
  // One opens with a click…
  await found.getByRole('option', { name: /^worker-17 / }).click()
  await expect(find).toBeHidden()
  await expect(page).toHaveURL(
    `${served.url}cluster/${FLEET.staging}/workloads?open=Deployment%2Fdefault%2Fworker-17`,
  )

  // …or with the keyboard. (⌘K / Ctrl+K finds a cluster, as on the desktop's start screen.)
  await page.goto(served.url)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+K')
  await expect(page.getByPlaceholder('Search clusters and labels…')).toBeFocused()
  await page.getByRole('button', { name: 'Find a workload' }).focus()
  await page.keyboard.press('Enter')
  await expect(find).toBeVisible()
  await page.keyboard.type('checkout')
  await expect(found.getByRole('option')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(
    `${served.url}cluster/${FLEET.prodEu}/workloads?open=Deployment%2Fshop%2Fcheckout`,
  )
  await expect(page.getByRole('complementary', { name: 'Deployment checkout' })).toBeVisible()
})

test('a search waits for the clusters it looks in', async ({ page, context, serve, clusters }) => {
  // (Not a kind a summary counts: the cards come first.)
  clusters.demo.fail('/apis/batch/v1/cronjobs', { hang: true })
  await as(context, 'alice@example.com')
  await openFleet(page, serve, fleetEnv(clusters))
  await expect.poll(() => names(page)).toHaveLength(4)
  await page.getByRole('button', { name: 'Find a workload' }).click()
  const find = page.getByRole('dialog', { name: 'Find a workload' })
  await find.getByRole('combobox', { name: 'Workload name' }).fill('nowhere')
  await expect(find.getByRole('status')).toHaveText('Looking in 3 clusters…')
  // Escape closes it.
  await page.keyboard.press('Escape')
  await expect(find).toBeHidden()
})

test('what a person may not see of a cluster', async ({ page, context, serve, clusters }) => {
  const forbidden = { status: 403 }
  // prod-eu: neither its nodes nor its Deployments (so none of its workloads), nor its events.
  clusters.demo.fail('/api/v1/nodes', forbidden)
  const deployments = clusters.demo.fail('/apis/apps/v1/deployments', forbidden)
  clusters.demo.fail('/api/v1/events', forbidden)
  // prod-us: neither its pods nor their metrics.
  clusters.large.fail('/api/v1/pods', forbidden)
  clusters.large.fail('/apis/metrics.k8s.io/v1beta1/nodes', forbidden)
  // staging: nothing that says how it is.
  for (const path of ['/api/v1/nodes', '/api/v1/pods', '/apis/apps/v1/statefulsets']) {
    clusters.sandbox.fail(path, forbidden)
  }
  await as(context, 'alice@example.com')
  const served = await openFleet(page, serve, fleetEnv(clusters))
  const eu = card(page, FLEET.prodEu)
  await expect(eu).toContainText('Nodes—No access')
  await expect(eu).toContainText('Workloads—No access')
  await expect(eu).toContainText('Warnings—No access')
  // Usage is weighed against the nodes: without them, it can't be.
  await expect(eu).toContainText('CPUNo access')
  // What it may see is what it's judged by.
  await expect(eu).toHaveAccessibleName(`${FLEET.prodEu}, 8 pods unhealthy`)
  const us = card(page, FLEET.prodUs)
  await expect(us).toContainText('Pods running—No access')
  await expect(us).toContainText('MemoryNo access')
  await expect(us).toHaveAccessibleName(`${FLEET.prodUs}, Healthy`)
  // Seeing none of it, a cluster isn't said to be healthy.
  const staging = card(page, FLEET.staging)
  await expect(staging).toHaveAccessibleName(`${FLEET.staging}, No access`)
  await expect(page.getByRole('group', { name: 'Show' })).toContainText('Healthy1')

  // With its Deployments, prod-eu's workloads say more.
  deployments()
  await page.reload()
  await expect(eu).toHaveAccessibleName(`${FLEET.prodEu}, 4 workloads degraded`)
  void served
})

test('nothing shared with someone, and all well for another', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const sre = { groups: ['sre'] }
  const qa = { groups: ['qa'] }
  const served = await serve({
    env: fleetEnv(clusters, {
      [FLEET.prodEu]: { labels: {}, ...sre },
      [FLEET.edge]: { labels: {}, ...sre },
      [FLEET.prodUs]: { labels: {}, ...qa },
      [FLEET.staging]: { labels: {}, ...qa },
    }),
  })
  await as(context, 'bob@example.com')
  await page.goto(served.url)
  await expect(page.getByText('No clusters for you here')).toBeVisible()
  await expect(page.getByRole('main')).toContainText(
    'This Lumovi shows a fleet of clusters, but none of them is shared with you.',
  )

  await as(context, 'carol@example.com', 'qa')
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('2 clustersAll healthy')
  // Without labels, nothing to filter or group by.
  await expect(page.getByRole('group', { name: 'Labels' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Group by' })).toHaveCount(0)
  await context.route('https://github.com/**', (route) => route.fulfill({ body: 'GitHub' }))
  const opened = context.waitForEvent('page')
  await page.getByRole('button', { name: 'Lumovi on GitHub' }).click()
  expect((await opened).url()).toBe('https://github.com/Lumovi/Lumovi')
})

test('when the page can’t reach the server', async ({ page, context, serve, clusters }) => {
  await page.clock.install()
  await as(context, 'alice@example.com')
  const served = await serve({ env: fleetEnv(clusters) })
  // Its connection doesn't open, until it does.
  let reachable = false
  await page.routeWebSocket(/api\/socket$/, (ws) => {
    if (reachable) ws.connectToServer()
    else ws.close()
  })
  await page.goto(served.url)
  const reconnecting = page.getByRole('status').filter({ hasText: 'Reconnecting to Lumovi…' })
  await expect(reconnecting).toBeVisible()
  // The clusters it couldn't read: it says so, rather than that there are none.
  await page.clock.fastForward('00:31')
  const failed = page.getByRole('alert')
  await expect(failed).toContainText('Lost the connection to Lumovi.')
  await expect(page.getByText('No clusters for you here')).toHaveCount(0)
  reachable = true
  await failed.getByRole('button', { name: 'Try again' }).click()
  await expect(card(page, FLEET.prodEu)).toBeVisible()
  await expect(reconnecting).toBeHidden()
})

test('a cluster too large to count whole', async ({ page, context, serve, clusters }) => {
  await as(context, 'alice@example.com')
  await openFleet(page, serve, { ...fleetEnv(clusters), LUMOVI_MAX_LIST_ITEMS: '1000' })
  await expect(card(page, FLEET.prodUs)).toContainText('Pods running1,000+')
})

test('clusters that can’t be used, and why', async ({ page, context, serve, clusters }) => {
  const served = await serve({
    env: fleetEnv(clusters, {
      // Its people's own tokens, which a proxy has none of.
      [FLEET.prodEu]: { forwardToken: true },
      // Names that would be Kubernetes' own.
      [FLEET.prodUs]: { usernamePrefix: 'system:' },
      // Not what Lumovi's settings look like.
      [FLEET.staging]: { labels: ['staging'] as unknown as Record<string, string> },
    }),
  })
  await as(context, 'alice@example.com')
  await page.goto(served.url)
  await expect(card(page, FLEET.prodEu)).toHaveAccessibleName(`${FLEET.prodEu}, Credentials failed`)
  await expect(card(page, FLEET.prodEu)).toContainText(
    'It takes each person’s own token, and this server doesn’t pass tokens on: set LUMOVI_OIDC_FORWARD_TOKEN.',
  )
  await expect(card(page, FLEET.prodUs)).toHaveAccessibleName(`${FLEET.prodUs}, Forbidden`)
  await expect(card(page, FLEET.prodUs)).toContainText(
    'Lumovi doesn’t act as system:alice@example.com: names starting with system: are Kubernetes’ own.',
  )
  await expect(card(page, FLEET.staging)).toHaveAccessibleName(`${FLEET.staging}, Misconfigured`)
  await expect(card(page, FLEET.staging)).toContainText(
    'Its lumovi.dev extension: labels must be a map of text, like { env: production }.',
  )
})

test('helm in a fleet acts as the person, in the cluster it’s for', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  await as(context, 'alice@example.com', 'developers')
  const served = await openFleet(page, serve, fleetEnv(clusters))
  await page.goto(`${served.url}cluster/${FLEET.prodEu}/helm`)
  await page
    .getByRole('grid', { name: 'Helm releases' })
    .getByRole('row')
    .filter({ hasText: HELM.storefront })
    .first()
    .getByRole('gridcell')
    .nth(1)
    .click()
  const release = page.getByRole('complementary', { name: `Helm release ${HELM.storefront}` })
  await release.getByRole('button', { name: 'Roll back…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Roll back', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    `Rolled back ${HELM.storefront}`,
  )
  const run = helmKubeconfigs(served).find((r) => r.args[0] === 'rollback')!
  expect(run.args.slice(-2)).toEqual(['--kube-context', FLEET.prodEu])
  const kubeconfig = parse(run.kubeconfig) as {
    'current-context': string
    users: { user: { as: string; 'as-groups': string[]; token: string } }[]
  }
  expect(kubeconfig['current-context']).toBe(FLEET.prodEu)
  expect(kubeconfig.users[0]!.user).toMatchObject({
    as: 'alice@example.com',
    'as-groups': ['developers'],
    token: 'lumovi-demo-token',
  })
})

test('with single sign-on: people’s own tokens, where a cluster takes them', async ({
  page,
  serve,
  clusters,
}) => {
  const oidc = await startMockOidc({ clientId: 'lumovi', clientSecret: 's3cret' })
  oidc.person = { sub: 'alice', email: 'alice@example.com', groups: ['developers'] }
  const issued: string[] = []
  oidc.issued = (token, kind) => {
    if (kind === 'id') issued.push(`Bearer ${token}`)
  }
  const port = await freePort()
  const served = await serve({
    port,
    env: {
      LUMOVI_AUTH: 'oidc',
      LUMOVI_URL: `http://127.0.0.1:${port}`,
      LUMOVI_OIDC_ISSUER: oidc.issuer,
      LUMOVI_OIDC_CLIENT_ID: 'lumovi',
      LUMOVI_OIDC_CLIENT_SECRET: 's3cret',
      LUMOVI_OIDC_FORWARD_TOKEN: 'id',
      LUMOVI_FLEET_KUBECONFIG: fleetKubeconfig(clusters, {
        // A cluster that trusts the provider (the large one takes any token)…
        [FLEET.prodUs]: { forwardToken: true },
        // …and one that doesn't.
        [FLEET.prodEu]: { forwardToken: true },
      }),
    },
  })
  await page.goto(`${served.url}auth/sign-in`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^4 clusters/)
  // Her own token, and no one impersonated.
  await expect(card(page, FLEET.prodUs)).toContainText('Pods running2,500')
  const nodes = clusters.large.requests.findLast((r) => r.path === '/api/v1/nodes')!
  expect(issued).toContain(nodes.headers.authorization)
  expect(nodes.headers['impersonate-user']).toBeUndefined()
  // A cluster that won't have it says so, and she stays signed in to the others.
  await expect(card(page, FLEET.prodEu)).toHaveAccessibleName(`${FLEET.prodEu}, Unauthorized`)
  await page.reload()
  await expect(card(page, FLEET.staging)).toHaveAccessibleName(`${FLEET.staging}, Healthy`)
  await expect(page.getByRole('button', { name: 'Signed in as alice@example.com' })).toBeVisible()
  await oidc.close()
})

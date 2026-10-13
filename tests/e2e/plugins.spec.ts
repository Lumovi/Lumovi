import type { Page } from '@playwright/test'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { CONTEXTS, expect, openCluster, panel, row, rows, test } from './fixtures.ts'

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Resources' })
const heading = (page: Page) => page.getByRole('heading', { level: 1 })
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Selected rows' })
const { kustomizations, namespaces } = CUSTOM

/** Every link in the sidebar, top to bottom. */
const links = (page: Page) => sidebar(page).getByRole('link').allTextContents()

/** A Flux Kustomization, for lists longer than a page. */
const kustomization = (name: string) => ({
  apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
  kind: 'Kustomization',
  metadata: { name, namespace: namespaces.flux, creationTimestamp: new Date().toISOString() },
  spec: { interval: '10m', path: `./apps/${name}`, prune: true },
})

test('the tools a cluster has: one entry each, leading to everything of theirs', async ({
  page,
}) => {
  await openCluster(page)
  const nav = sidebar(page)
  // Plugins by name, under a section of their own; Gateway API sits with Kubernetes' networking.
  await expect(nav.getByText('Plugins', { exact: true })).toBeVisible()
  const names = await links(page)
  const at = (name: string) => names.findIndex((text) => text.trim().startsWith(name))
  const order = [
    'Argo CD',
    'Argo Rollouts',
    'cert-manager',
    'Flux',
    'Istio',
    'Karpenter',
    'Prometheus Operator',
    'API resources',
  ].map(at)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(order.every((index) => index >= 0)).toBe(true)
  expect(at('Gateway API')).toBe(at('Network Policies') + 1)

  // A plugin's page: everything of its kinds, the ones in trouble first, each kind a tab away.
  await nav.getByRole('link', { name: 'Flux', exact: true }).click()
  await expect(heading(page)).toHaveText('Flux')
  await expect(page).toHaveTitle(/^Flux · demo/)
  const tabs = page.getByRole('navigation', { name: 'Flux' })
  await expect(tabs.getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'page')
  await expect(tabs).toContainText('AllKustomizations3HelmReleases1GitRepositories1')
  await expect(page.getByText('5 objects')).toBeVisible()
  await expect(rows(page, 'Flux').first()).toContainText(
    `${kustomizations.failing}${namespaces.flux}KustomizationBuildFailedkustomize build failed`,
  )
  await expect(row(page, 'Flux', kustomizations.suspended)).toContainText('Suspended—')

  // Filters, by health and by text, and sorting by any column.
  await page.getByRole('button', { name: /^Failing/ }).click()
  await expect(rows(page, 'Flux')).toHaveCount(1)
  await page.getByRole('button', { name: /^Failing/ }).click()
  await page.getByPlaceholder('Filter Flux').fill('podinfo')
  await expect(rows(page, 'Flux')).toHaveCount(1)
  await expect(rows(page, 'Flux')).toContainText('HelmRelease')
  await page.getByPlaceholder('Filter Flux').fill('nothing like it')
  await expect(page.getByText('Nothing from Flux matches the current filters.')).toBeVisible()
  await page.getByPlaceholder('Filter Flux').fill('')
  await page.getByPlaceholder('Filter Flux').press('ArrowDown')
  await expect(page.getByRole('grid', { name: 'Flux' })).toBeFocused()
  const grid = page.getByRole('grid', { name: 'Flux' })
  await grid.getByRole('columnheader', { name: 'Type' }).getByRole('button').click()
  await expect(rows(page, 'Flux').first()).toContainText('GitRepository')
  await grid.getByRole('columnheader', { name: 'Message' }).getByRole('button').click()
  await grid.getByRole('columnheader', { name: 'Message' }).getByRole('button').click()
  await expect(rows(page, 'Flux').first()).toContainText('stored artifact for revision')

  // Rows open in the panel, and are picked for bulk changes like any list's.
  await row(page, 'Flux', 'podinfo').getByRole('gridcell').nth(1).click()
  await expect(panel(page, 'HelmRelease', 'podinfo')).toBeVisible()
  await page.keyboard.press('Escape')
  await row(page, 'Flux', 'podinfo').getByRole('checkbox').click()
  await expect(toolbar(page)).toContainText('1 selected')
  await page.getByLabel('Label selector').fill('team=nobody')
  await page.getByLabel('Label selector').press('Enter')
  await expect(page.getByText('Nothing matches the label selector “team=nobody”.')).toBeVisible()
  await page.getByLabel('Label selector').fill('')
  await page.getByLabel('Label selector').press('Enter')
  await expect(toolbar(page)).toContainText('1 selected')
  await toolbar(page).getByRole('button', { name: 'Clear selection' }).click()
  await expect(toolbar(page)).toHaveCount(0)
  await row(page, 'Flux', 'podinfo').getByRole('checkbox').click()
  await page.getByRole('button', { name: 'Namespace' }).click()
  await page.getByRole('option', { name: 'shop' }).click()
  await expect(toolbar(page)).toHaveCount(0)
  // A namespace without any: what would show up here.
  await expect(page.getByText(`Nothing from Flux in shop`)).toBeVisible()
  await expect(
    page.getByText('Kustomizations, HelmReleases and GitRepositories show up here.'),
  ).toBeVisible()

  // A kind's own list keeps the plugin's tabs, and the plugin stays current in the sidebar.
  await tabs.getByRole('link', { name: /^Kustomizations/ }).click()
  await expect(heading(page)).toHaveText('Kustomizations')
  await expect(tabs.getByRole('link', { name: /^Kustomizations/ })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(nav.getByRole('link', { name: 'Flux', exact: true })).toHaveClass(/font-medium/)
  // It doesn't need a place among the kinds opened lately: Flux is a click away already.
  const lately = nav.getByRole('group', { name: 'Opened lately' })
  await expect(lately.getByRole('link')).toHaveCount(0)

  // Kinds of objects nobody wrote messages for: no column for them.
  await nav.getByRole('link', { name: 'Gateway API' }).click()
  await expect(heading(page)).toHaveText('Gateway API')
  await expect(
    page.getByRole('grid', { name: 'Gateway API' }).getByRole('columnheader', { name: 'Message' }),
  ).toHaveCount(0)
  // Cluster-wide kinds stay listed whatever the namespace.
  await page.getByRole('button', { name: 'Namespace' }).click()
  await page.getByRole('option', { name: 'shop' }).click()
  await expect(row(page, 'Gateway API', CUSTOM.gatewayClass)).toBeVisible()
  await expect(rows(page, 'Gateway API')).toHaveCount(3)
})

test('the command palette finds plugins, and their pages say when a cluster lacks them', async ({
  page,
}) => {
  await openCluster(page)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('rollouts')
  await expect(page.getByRole('option', { name: /^Argo Rollouts/ })).toContainText('Plugin')
  await page.getByRole('option', { name: /^Argo Rollouts/ }).click()
  await expect(heading(page)).toHaveText('Argo Rollouts')
  await expect(row(page, 'Argo Rollouts', CUSTOM.rollout)).toBeVisible()
  // Objects are found by their labels too.
  await sidebar(page).getByRole('link', { name: 'cert-manager', exact: true }).click()
  await page.getByPlaceholder('Filter cert-manager').fill('app.kubernetes.io/name=api')
  await expect(rows(page, 'cert-manager')).toHaveCount(1)
  // Its kinds can be found by name too.
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('certificates')
  await expect(page.getByRole('option', { name: /^cert-manager/ })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.evaluate(() => {
    window.location.hash = '#/cluster/demo/plugins/velero'
  })
  await expect(page.getByText('This cluster doesn’t have it')).toBeVisible()
  await expect(heading(page)).toHaveText('Plugins')
  await expect(page.getByText('None of the kinds of “velero” are served here')).toBeVisible()
})

test('lists a plugin couldn’t read, couldn’t refresh, or couldn’t load whole', async ({
  launch,
  clusters,
}) => {
  const path = (group: string, version: string, plural: string) =>
    `/apis/${group}/${version}/${plural}`
  const lists = {
    kustomizations: path('kustomize.toolkit.fluxcd.io', 'v1', 'kustomizations'),
    helmReleases: path('helm.toolkit.fluxcd.io', 'v2', 'helmreleases'),
    gitRepositories: path('source.toolkit.fluxcd.io', 'v1', 'gitrepositories'),
  }
  // HelmReleases can't be listed from the start: they're left out, and it says so.
  const helm = clusters.demo.fail(lists.helmReleases, { status: 403 })
  const { page } = await launch({ env: { LUMOVI_MAX_LIST_ITEMS: '2' } })
  await openCluster(page)
  await sidebar(page).getByRole('link', { name: 'Flux', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Couldn’t list' })).toContainText(
    'Couldn’t list HelmReleases: injected fault (HTTP 403)',
  )
  // Three Kustomizations are more than this app loads of a kind.
  const note = page.getByRole('note')
  await expect(note).toContainText('Some lists are too long to load whole')
  await note.getByRole('button', { name: 'Filter by label' }).click()
  await expect(page.getByLabel('Label selector')).toBeFocused()
  helm()

  // A list that loaded once and then couldn't be refreshed keeps what it had.
  const clear = clusters.demo.fail(lists.gitRepositories, { status: 503, body: 'overloaded' })
  await expect(page.getByText(/Couldn’t refresh — showing the last data/)).toBeVisible({
    timeout: 20_000,
  })
  clear()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByText(/Couldn’t refresh/)).toHaveCount(0)

  // None of them can be listed: what went wrong, and a way to try again.
  const faults = Object.values(lists).map((list) => clusters.demo.fail(list, { status: 403 }))
  await page.getByLabel('Label selector').fill('team=platform')
  await page.getByLabel('Label selector').press('Enter')
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  for (const fault of faults) fault()
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByText('Nothing matches the label selector “team=platform”.')).toBeVisible()
})

test('a plugin with more objects than a page', async ({ page, clusters }) => {
  for (let i = 0; i < 60; i++) clusters.demo.upsert(kustomization(`app-${i}`))
  await openCluster(page)
  await sidebar(page).getByRole('link', { name: 'Flux', exact: true }).click()
  await expect(page.getByText('65 objects')).toBeVisible()
  await page.getByLabel('Rows per page').selectOption('50')
  await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText('1–50 of 65')
  await page.getByRole('button', { name: 'Next page' }).click()
  await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText('51–65 of 65')
  await rows(page, 'Flux').first().getByRole('gridcell').nth(1).click()
  await page.keyboard.press('Escape')
  await page.getByRole('grid', { name: 'Flux' }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText('1–50 of 65')
})

test('Karpenter’s kinds are all cluster-wide, so there’s no namespace to pick', async ({
  page,
}) => {
  await openCluster(page, CONTEXTS.demo)
  await sidebar(page).getByRole('link', { name: 'Karpenter', exact: true }).click()
  await expect(page.getByLabel('Namespace', { exact: true })).toHaveText('Cluster-wide')
  await sidebar(page).getByRole('link', { name: 'cert-manager', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Namespace' })).toBeVisible()
})

test('a plugin’s page opened before the cluster says what it serves, or when it can’t', async ({
  page,
  clusters,
}) => {
  // Straight from the start screen, while discovery fails: what went wrong, and a way to retry.
  const clear = clusters.demo.fail('/apis', { status: 500 })
  await page.evaluate(() => {
    window.location.hash = '#/cluster/demo/plugins/flux'
  })
  await expect(page.getByRole('alert')).toContainText('injected fault (HTTP 500)')
  clear()
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(heading(page)).toHaveText('Flux')
  await expect(rows(page, 'Flux')).toHaveCount(5)
})

/** The CRD Gatekeeper makes for a constraint template: a kind of constraint of its own. */
const constraintKind = (kind: string) => ({
  apiVersion: 'apiextensions.k8s.io/v1',
  kind: 'CustomResourceDefinition',
  metadata: { name: `${kind.toLowerCase()}.constraints.gatekeeper.sh` },
  spec: {
    group: 'constraints.gatekeeper.sh',
    names: {
      kind,
      plural: kind.toLowerCase(),
      singular: kind.toLowerCase(),
      listKind: `${kind}List`,
    },
    scope: 'Cluster',
    versions: [
      {
        name: 'v1beta1',
        served: true,
        storage: true,
        schema: {
          openAPIV3Schema: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
        },
      },
    ],
  },
})

test('Gatekeeper’s constraints: a tab for each kind its templates made', async ({
  page,
  clusters,
}) => {
  for (const kind of ['K8sRequiredLabels', 'K8sAllowedRepos']) {
    clusters.demo.upsert(constraintKind(kind))
  }
  const audited = new Date().toISOString()
  clusters.demo.upsert({
    apiVersion: 'constraints.gatekeeper.sh/v1beta1',
    kind: 'K8sRequiredLabels',
    metadata: { name: 'must-have-owner', creationTimestamp: audited },
    spec: { enforcementAction: 'dryrun' },
    status: {
      auditTimestamp: audited,
      totalViolations: 2,
      violations: [
        { kind: 'Namespace', name: 'legacy', message: 'you must provide labels: {"owner"}' },
        { kind: 'Namespace', name: 'batch', message: 'you must provide labels: {"owner"}' },
      ],
    },
  })
  clusters.demo.upsert({
    apiVersion: 'constraints.gatekeeper.sh/v1beta1',
    kind: 'K8sAllowedRepos',
    metadata: { name: 'trusted-registries', creationTimestamp: audited },
    spec: {},
    status: { auditTimestamp: audited, totalViolations: 0 },
  })
  await openCluster(page)
  await sidebar(page).getByRole('link', { name: 'Gatekeeper', exact: true }).click()
  // Each kind of constraint, by name, with what the last audit found.
  await expect(page.getByRole('navigation', { name: 'Gatekeeper' })).toContainText(
    'AllK8sAllowedRepos1K8sRequiredLabels1',
  )
  await expect(row(page, 'Gatekeeper', 'must-have-owner')).toContainText('2 violations')
  await expect(row(page, 'Gatekeeper', 'trusted-registries')).toContainText('No violations')
})

test('every plugin on one page: what’s in use on this cluster, and what each asks for', async ({
  page,
}) => {
  await openCluster(page)
  await sidebar(page).getByRole('link', { name: 'All plugins' }).click()
  await expect(heading(page)).toHaveText('Plugins')
  await expect(page.getByText('A plugin teaches Lumovi a tool’s kinds')).toBeVisible()
  await expect(page.getByText('32 come with Lumovi')).toBeVisible()
  const table = page.getByRole('table', { name: 'Plugins' })
  // Each once: its name and version, the kinds it shows (three at most, then how many more),
  // whether this cluster has it, and where it came from.
  const flux = table.getByRole('row').filter({ hasText: /^Flux/ })
  await expect(flux).toContainText('1.1.0')
  await expect(flux).toContainText(/Kustomizations, HelmReleases, \S+ and 4 more kinds/)
  await expect(flux).toContainText('On this cluster: in the sidebar')
  await expect(flux).toContainText('Comes with Lumovi')
  await expect(table.getByRole('row').filter({ hasText: /^Velero/ })).toContainText(
    'Not on this cluster',
  )

  // Opened, it says what it asks for, read from its file: what it may change, what it reads,
  // and each action with what it sends and whether it asks first.
  await table.getByRole('button', { name: /^Flux/ }).click()
  const change = page.getByRole('region', { name: 'May change and create' })
  await expect(change).toContainText('Only the kinds it shows:')
  await expect(change).toContainText('Kustomization, HelmRelease')
  await expect(change).toContainText(
    'all in the API groups it names: kustomize.toolkit.fluxcd.io, helm.toolkit.fluxcd.io, source.toolkit.fluxcd.io',
  )
  await expect(change).toContainText('Never Kubernetes’ own kinds')
  const read = page.getByRole('region', { name: 'May read' })
  await expect(read).toContainText('Its own kinds’ objects')
  await expect(read).toContainText(
    'It reads no logs. It reads no Secret’s value. It sends nothing anywhere but to this cluster.',
  )
  const actions = page.getByRole('region', { name: 'Its actions, and what each sends' })
  const reconcile = actions.getByRole('listitem').filter({ hasText: 'Reconcile' }).first()
  await expect(reconcile).toContainText('on all 7 kinds')
  await expect(reconcile).toContainText('runs at once')
  await expect(actions.getByRole('listitem')).toHaveCount(3)
  await expect(reconcile).toContainText('reconcile.fluxcd.io/requestedAt: (now)')
  // What takes an action back is sent too, and is shown under it.
  const suspend = actions.getByRole('listitem').filter({ hasText: 'Suspend' }).first()
  await expect(suspend).toContainText('Undo sends:')
  await expect(suspend).toContainText('suspend: (removed)')
  // One that asks first and creates; one that lists other kinds beside its objects and links
  // to some; one with no actions at all.
  await table.getByRole('button', { name: /^Tekton/ }).click()
  await expect(page.getByRole('region', { name: 'May change and create' })).toContainText(
    'Creates: PipelineRun, one of its own kinds.',
  )
  await expect(page.getByRole('region', { name: 'May change and create' })).toContainText(
    'Nor the owners or finalizers of one it creates.',
  )
  const run = page
    .getByRole('region', { name: 'Its actions, and what each sends' })
    .getByRole('listitem')
    .filter({ hasText: 'Creates' })
    .first()
  await expect(run).toContainText('asks first')
  await expect(run).toContainText('kind: PipelineRun')
  await table.getByRole('button', { name: /^Argo Rollouts/ }).click()
  await expect(
    page
      .getByRole('region', { name: 'Its actions, and what each sends' })
      .getByRole('listitem')
      .filter({ hasText: 'Promote' })
      .first(),
  ).toContainText('to its status')
  await table.getByRole('button', { name: /^CloudNativePG/ }).click()
  await expect(page.getByRole('region', { name: 'May read' })).toContainText(
    /Beside an object it lists .*Pods.*, picked by their labels or fields\. The list is Lumovi’s own/,
  )
  await table.getByRole('button', { name: /^cert-manager/ }).click()
  await expect(page.getByRole('region', { name: 'May read' })).toContainText(
    /It links to .*Secrets.* by name\. A link opens Lumovi’s page for the object/,
  )
  await expect(page.getByRole('region', { name: 'May change and create' })).toHaveText(
    /Nothing\. It has no actions\./,
  )
  // Pressed again, it closes.
  await table.getByRole('button', { name: /^cert-manager/ }).click()
  await expect(page.getByRole('region', { name: 'May read' })).toHaveCount(0)

  // Narrowed: to what this cluster has, and by name.
  const which = page.getByRole('group', { name: 'Which plugins' })
  await expect(which.getByRole('button', { name: /^All 32$/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await which.getByRole('button', { name: /^On this cluster/ }).click()
  await expect(table.getByRole('row').filter({ hasText: /^Velero/ })).toHaveCount(0)
  await expect(table.getByRole('row').filter({ hasText: /^Flux/ })).toHaveCount(1)
  await which.getByRole('button', { name: /^Not in use 0$/ }).click()
  await expect(page.getByText('Nothing matches')).toBeVisible()
  await which.getByRole('button', { name: /^All/ }).click()
  await page.getByPlaceholder('Search plugins').fill('velero')
  await expect(table.getByRole('row')).toHaveCount(2)
  await expect(page.getByText('1 of 32 shown.')).toBeVisible()
  // Down goes from the search to the first plugin.
  await page.keyboard.press('ArrowDown')
  await expect(table.getByRole('button', { name: /^Velero/ })).toBeFocused()

  // And the command palette finds the page.
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('all plugins')
  await page.getByRole('option', { name: 'All plugins' }).click()
  await expect(heading(page)).toHaveText('Plugins')
})

test('a plugin’s row opens from the address that names it, and only a name does', async ({
  page,
}) => {
  await openCluster(page)
  const table = page.getByRole('table', { name: 'Plugins' })
  const change = page.getByRole('region', { name: 'May change and create' })
  const go = (query: string) =>
    page.evaluate((to) => {
      window.location.hash = `#/cluster/demo/plugins${to}`
    }, query)
  // Named in the address, a plugin's row is open and in view, with what it asks for.
  await go('?plugin=tekton')
  await expect(heading(page)).toHaveText('Plugins')
  await expect(change).toContainText('Creates: PipelineRun, one of its own kinds.')
  await expect(change).toBeInViewport()
  await expect(table.getByRole('button', { name: /^Tekton/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  // Another name, another row: the address is what's followed until a person opens one by hand.
  await go('?plugin=flux')
  await expect(change).toContainText('Kustomization, HelmRelease')
  await table.getByRole('button', { name: /^Tekton/ }).click()
  await expect(change).toContainText('Creates: PipelineRun')
  // Then the address names none, so going back to the page doesn't open the old one again.
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/cluster/demo/plugins')
  await table.getByRole('button', { name: /^Tekton/ }).click()
  await expect(change).toHaveCount(0)
  // After a row was opened and closed by hand, a link that names another plugin still opens its
  // row and brings it into view, by the plugin's own line and not only what's under it.
  await go('?plugin=velero')
  const velero = table.getByRole('button', { name: /^Velero/ })
  await expect(velero).toHaveAttribute('aria-expanded', 'true')
  await expect(velero).toBeInViewport()
  await expect(change).toBeInViewport()
  // And again from the top of the page, to one far down it.
  await page
    .getByRole('table', { name: 'Plugins' })
    .getByRole('row')
    .nth(1)
    .scrollIntoViewIfNeeded()
  await go('?plugin=flux')
  await expect(table.getByRole('button', { name: /^Flux/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await go('?plugin=velero')
  await expect(velero).toHaveAttribute('aria-expanded', 'true')
  await expect(velero).toBeInViewport()
  // Closed by hand, the address names none again, and nothing is open.
  await velero.click()
  await expect(change).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/cluster/demo/plugins')
  // A name no plugin has, and what isn't a name at all, open nothing: the page as it is.
  for (const query of [
    '?plugin=no-such-plugin',
    '?plugin=Flux%20',
    '?plugin=..%2Fflux',
    '?plugin=',
  ]) {
    await go(query)
    await expect(table.getByRole('row').filter({ hasText: /^Flux/ })).toBeVisible()
    await expect(change).toHaveCount(0)
  }
})

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
  // Add-ons by name, under a section of their own; Gateway API sits with Kubernetes' networking.
  await expect(nav.getByText('Add-ons', { exact: true })).toBeVisible()
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

  // An add-on's page: everything of its kinds, the ones in trouble first, each kind a tab away.
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

  // A kind's own list keeps the add-on's tabs, and the add-on stays current in the sidebar.
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

test('the command palette finds add-ons, and their pages say when a cluster lacks them', async ({
  page,
}) => {
  await openCluster(page)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('rollouts')
  await expect(page.getByRole('option', { name: /^Argo Rollouts/ })).toContainText('Add-on')
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
    window.location.hash = '#/cluster/demo/add-ons/velero'
  })
  await expect(page.getByText('This cluster doesn’t have it')).toBeVisible()
  await expect(heading(page)).toHaveText('Add-ons')
  await expect(page.getByText('None of the kinds of “velero” are served here')).toBeVisible()
})

test('lists an add-on couldn’t read, couldn’t refresh, or couldn’t load whole', async ({
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
  const { page } = await launch({ env: { KUBESTACKS_MAX_LIST_ITEMS: '2' } })
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

test('an add-on with more objects than a page', async ({ page, clusters }) => {
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

test('an add-on’s page opened before the cluster says what it serves, or when it can’t', async ({
  page,
  clusters,
}) => {
  // Straight from the start screen, while discovery fails: what went wrong, and a way to retry.
  const clear = clusters.demo.fail('/apis', { status: 500 })
  await page.evaluate(() => {
    window.location.hash = '#/cluster/demo/add-ons/flux'
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

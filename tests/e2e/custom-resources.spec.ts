import type { Page } from '@playwright/test'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { dialog, menuAction, toasts, writes } from './action-helpers.ts'
import {
  CONTEXTS,
  expect,
  hoverForTooltip,
  openCluster,
  panel,
  row,
  rows,
  test,
} from './fixtures.ts'

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Resources' })

/** Opens a custom kind's list from its API group on the API resources page. */
async function openKind(page: Page, group: string, label: string) {
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  await page
    .getByRole('rowgroup', { name: group, exact: true })
    .getByRole('button', { name: new RegExp(`^${label}\\b`) })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(label)
}

/** Opens an object of the list on screen. */
async function openRow(page: Page, label: string, name: string) {
  await row(page, label, name).first().getByRole('gridcell').nth(1).click()
}

const headers = (page: Page, label: string) =>
  page.getByRole('grid', { name: label }).getByRole('columnheader')

test.describe('custom resources', () => {
  test.beforeEach(async ({ page }) => {
    await openCluster(page)
  })

  test('browse them by API group, with their view’s columns, status and details', async ({
    page,
  }) => {
    const nav = sidebar(page)
    await expect(nav.getByText('Custom resources')).toBeVisible()
    // However many custom kinds there are, the sidebar only keeps those opened lately.
    const lately = nav.getByRole('group', { name: 'Opened lately' })
    await expect(lately.getByRole('link')).toHaveCount(0)
    await expect(nav.getByRole('link', { name: /API resources/ })).toContainText(/\d+/)
    await openKind(page, 'example.com', 'Databases')
    await expect(lately.getByRole('link', { name: 'Databases' })).toBeVisible()
    // Custom resources are browsed by API group, with the filter ready.
    await nav.getByRole('link', { name: /API resources/ }).click()
    await expect(page.getByPlaceholder('Filter kinds')).toBeFocused()
    await expect(
      page.getByRole('rowgroup', { name: 'cert-manager.io', exact: true }),
    ).toContainText('ClusterIssuers')
    // A tool's kinds are a click away under its add-on, so they aren't kept here too.
    await openKind(page, 'cert-manager.io', 'Certificates')
    await expect(page).toHaveTitle(/^Certificates · demo/)
    await expect(lately.getByRole('link', { name: 'Certificates' })).toHaveCount(0)
    await expect(lately.getByRole('link', { name: 'Databases' })).toBeVisible()
    await expect(headers(page, 'Certificates')).toHaveText([
      '',
      'Name',
      'Status',
      'Hosts',
      'Secret',
      'Expires',
      'Age',
    ])
    const ready = row(page, 'Certificates', CUSTOM.certificates.ready)
    await expect(ready).toContainText('Ready')
    await expect(ready).toContainText('shop.example.com, www.shop.example.com')
    await expect(ready).toContainText(/in (79|80)d/)
    await expect(row(page, 'Certificates', CUSTOM.certificates.failing)).toContainText('Failed')
    await expect(row(page, 'Certificates', CUSTOM.certificates.issuing)).toContainText('Issuing')
    await expect(page.getByRole('button', { name: /^Failing/ })).toContainText('1')

    // Sorting by a view's date column, and filtering by what it shows.
    await headers(page, 'Certificates').filter({ hasText: 'Expires' }).getByRole('button').click()
    await expect(rows(page, 'Certificates').first()).toContainText(CUSTOM.certificates.failing)
    await page.getByPlaceholder('Filter Certificates').fill('www.shop')
    await expect(rows(page, 'Certificates')).toHaveCount(1)
    await page.getByPlaceholder('Filter Certificates').fill('')

    await openRow(page, 'Certificates', CUSTOM.certificates.failing)
    const detail = panel(page, 'Certificate', CUSTOM.certificates.failing)
    await expect(detail).toContainText('Certificate · shop')
    await expect(detail.locator('header')).toContainText('Failed')
    await expect(detail).toContainText('cert-manager.io/v1')
    await expect(detail).toContainText('api.shop.example.com')
    await expect(detail).toContainText(/Failed attempts\s*4/)
    await expect(detail).toContainText('Lifetime2160h0m0s')
    // Its status message is a condition; conditions aren't repeated in the status tree.
    await expect(detail.getByRole('tree', { name: 'Status' })).not.toContainText('conditions')
    await expect(detail.getByRole('tree', { name: 'Status' })).toContainText(
      'failedIssuanceAttempts',
    )

    // Fields are explained by the CRD's schema.
    const spec = detail.getByRole('tree', { name: 'Spec' })
    await hoverForTooltip(
      spec.getByText('secretName'),
      'Name of the Secret resource that will be automatically created',
    )
    // Nested fields fold.
    await expect(spec.getByRole('treeitem', { name: 'name', exact: true })).toContainText(
      'letsencrypt-prod',
    )
    await spec.getByRole('button', { name: 'Fold issuerRef' }).click()
    await expect(spec.getByRole('treeitem', { name: 'issuerRef' })).toContainText('3 fields')
    await spec.getByRole('button', { name: 'Unfold issuerRef' }).click()
    await expect(spec.getByRole('treeitem', { name: 'kind' })).toContainText('ClusterIssuer')

    // Its view links what it relates to: a Secret, and a cluster-wide issuer.
    await detail.getByRole('button', { name: 'ClusterIssuer/letsencrypt-prod' }).click()
    const issuer = panel(page, 'ClusterIssuer', CUSTOM.clusterIssuers.production)
    await expect(issuer).toContainText('acme-v02.api.letsencrypt.org')
    await expect(issuer).toContainText('ClusterIssuer · ')
    await page.goBack()
    await detail.getByRole('button', { name: `Secret/${CUSTOM.certificates.failing}` }).click()
    // That certificate never got its secret.
    await expect(panel(page, 'Secret', CUSTOM.certificates.failing)).toContainText(
      'secrets "api-tls" not found',
    )
  })

  test('kinds without a view: the server’s columns and the usual status conventions', async ({
    page,
  }) => {
    await openKind(page, 'example.com', 'Databases')
    // Ready (True/False) is what the status shows; priority columns are left out, like kubectl.
    await expect(headers(page, 'Databases')).toHaveText([
      '',
      'Name',
      'Status',
      'Engine',
      'Storage',
      'CPU',
      'HA',
      'Backed up',
      'Age',
    ])
    const status = (name: string) => row(page, 'Databases', name).getByRole('gridcell').nth(2)
    await expect(status('orders')).toHaveText('Ready')
    await expect(status('analytics')).toHaveText('ProvisioningFailed')
    await expect(status('search')).toHaveText('Progressing')
    await expect(status('legacy')).toHaveText('UpgradeBlocked')
    await expect(status('cache')).toHaveText('Suspended')
    await expect(status('archive')).toHaveText('Reconciling')
    await expect(status('reports')).toHaveText('Terminating')
    await expect(status('staging')).toHaveText('Provisioning')
    await expect(status('metrics')).toHaveText('Degraded')
    await expect(status('sandbox')).toHaveText('Paused')
    await expect(status('warehouse')).toHaveText('Unknown')
    await expect(status('scratch')).toHaveText('Unknown')
    await expect(status('frozen')).toHaveText('Stalled')
    await expect(status('broken')).toHaveText('Not ready')
    await expect(status('odd')).toHaveText('Gibberish')
    const orders = row(page, 'Databases', 'orders')
    await expect(orders).toContainText('postgres')
    await expect(orders).toContainText('200')
    await expect(orders).toContainText('true')
    // Times come as the API server prints them.
    await expect(orders).toContainText('120m')
    // The API server prints future times as <invalid>; missing values are a dash.
    await expect(row(page, 'Databases', 'archive')).toContainText('<invalid>')
    await expect(row(page, 'Databases', 'staging').getByRole('gridcell').nth(7)).toHaveText('—')

    // Sorting by the server's numbers, text and times.
    await headers(page, 'Databases').filter({ hasText: 'Storage' }).getByRole('button').click()
    // Nothing to sort by sorts first.
    await expect(rows(page, 'Databases').first()).toContainText('scratch')
    await expect(rows(page, 'Databases').nth(1)).toContainText('cache')
    await headers(page, 'Databases').filter({ hasText: 'Engine' }).getByRole('button').click()
    await expect(rows(page, 'Databases').nth(1)).toContainText('analytics')
    await headers(page, 'Databases').filter({ hasText: 'Backed up' }).getByRole('button').click()
    await headers(page, 'Databases').filter({ hasText: 'Backed up' }).getByRole('button').click()
    await expect(rows(page, 'Databases').first()).toContainText('orders')
    await page.getByPlaceholder('Filter Databases').fill('mysql')
    await expect(rows(page, 'Databases')).toHaveCount(2)
    await page.getByPlaceholder('Filter Databases').fill('')
    await page.getByRole('button', { name: /^Failing/ }).click()
    await expect(rows(page, 'Databases')).toHaveCount(5)
    await page.getByRole('button', { name: /^Failing/ }).click()

    // Empty values in the tree, and descriptions too long for a tooltip.
    await openRow(page, 'Databases', 'orders')
    const orders$ = panel(page, 'Database', 'orders').getByRole('tree', { name: 'Spec' })
    await expect(orders$.getByRole('treeitem', { name: 'tags' })).toContainText('[]')
    await expect(orders$.getByRole('treeitem', { name: 'options' })).toContainText('{}')
    await expect(orders$.getByRole('treeitem', { name: 'backupWindow' })).toContainText('null')
    await hoverForTooltip(orders$.getByText('storageGB'), /How much disk.*…$/)

    // A single object of its kind, deleted from the list.
    await row(page, 'Databases', 'odd').getByRole('checkbox').click()
    await page
      .getByRole('toolbar', { name: 'Selected rows' })
      .getByRole('button', { name: 'Delete' })
      .click()
    await expect(dialog(page)).toContainText('Delete 1 database?')
    await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(row(page, 'Databases', 'odd')).toHaveCount(0)

    await openRow(page, 'Databases', 'analytics')
    const detail = panel(page, 'Database', 'analytics')
    await expect(detail.locator('header')).toContainText('ProvisioningFailed')
    await expect(detail.getByRole('tree', { name: 'Spec' })).toContainText('mysql')
    // A widget's schema has no status; it has no status tree, or status.
    await openKind(page, 'example.com', 'Widgets')
    await expect(headers(page, 'Widgets')).toHaveText(['', 'Name', 'Age'])
    await openRow(page, 'Widgets', CUSTOM.widget)
    const widget = panel(page, 'Widget', CUSTOM.widget)
    await expect(widget.getByRole('tree', { name: 'Spec' })).toContainText('blue')
    await expect(widget.getByRole('tree', { name: 'Status' })).toHaveCount(0)
    await expect(widget.locator('header [data-health]')).toHaveCount(0)
  })
})

test('every kind the cluster serves, pinned to the sidebar when wanted', async ({
  page,
  clusters,
}) => {
  // metrics-server is down: its API is stale in discovery, and left out.
  clusters.demo.setMetricsAvailable(false)
  await openCluster(page)
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('API resources')
  const custom = page.getByRole('region', { name: 'Custom resources' })
  const kubernetes = page.getByRole('region', { name: 'Kubernetes' })
  await expect(custom).toContainText('Certificates')
  await expect(custom).toContainText('cert, certs')
  // Two kinds named Gateway, in two groups.
  await expect(custom.getByRole('row').filter({ hasText: 'Gateways' })).toHaveCount(2)
  await expect(kubernetes).toContainText('ServiceAccounts')
  await expect(kubernetes).toContainText('rbac.authorization.k8s.io/v1')
  await expect(kubernetes).toContainText('Pods')
  await expect(page.getByText(/\d+ views from KubeStacks/)).toBeVisible()

  const filter = page.getByPlaceholder('Filter kinds')
  await filter.fill('ks')
  // One kind matches, in its group.
  await expect(custom.getByRole('rowgroup', { name: 'kustomize.toolkit.fluxcd.io' })).toBeVisible()
  await expect(custom.locator('[data-kind-link]')).toHaveCount(1)
  await filter.press('ArrowDown')
  await expect(custom.getByRole('button', { name: /^Kustomizations/ })).toBeFocused()
  await filter.fill('nothing-like-this')
  await expect(page.getByText('No kinds match “nothing-like-this”.')).toBeVisible()
  await filter.fill('')

  // Pinning puts a kind at the top of the custom resources, in every cluster that has it.
  await custom.getByRole('row').filter({ hasText: 'Kustomizations' }).hover()
  await custom.getByRole('button', { name: 'Pin Kustomizations' }).click()
  const pinned = sidebar(page).getByRole('heading', { name: 'Pinned' })
  await expect(pinned).toBeVisible()
  // Pins show in clusters that serve the kind; the sandbox doesn't run Flux.
  await page.evaluate(() => (location.hash = '#/cluster/sandbox'))
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toContainText('sandbox')
  await expect(sidebar(page).getByRole('link', { name: 'API resources' })).toBeVisible()
  await expect(pinned).toHaveCount(0)
  await page.evaluate(() => (location.hash = '#/cluster/demo/api-resources'))
  await expect(pinned).toBeVisible()
  await kubernetes.getByRole('button', { name: /^ServiceAccounts/ }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ServiceAccounts')
  await page.getByRole('button', { name: 'Pin ServiceAccounts to the sidebar' }).click()
  await expect(sidebar(page).getByRole('link', { name: 'ServiceAccounts' })).toBeVisible()
  await page.getByRole('button', { name: 'Unpin ServiceAccounts from the sidebar' }).click()
  await expect(sidebar(page).getByRole('link', { name: 'ServiceAccounts' })).toHaveCount(0)

  // Kubernetes' other kinds come with the server's columns, and core schemas explain them.
  await expect(headers(page, 'ServiceAccounts')).toHaveText(['', 'Name', 'Age'])
  await openRow(page, 'ServiceAccounts', 'storefront')
  const account = panel(page, 'ServiceAccount', 'storefront')
  await hoverForTooltip(
    account.getByRole('tree', { name: 'Fields' }).getByText('automountServiceAccountToken'),
    'API token automatically mounted',
  )

  // Kinds whose group the OpenAPI documents don't describe, or don't describe in full.
  for (const [label, name, kind] of <[string, string, string][]>[
    ['ClusterRoles', 'view', 'ClusterRole'],
    ['ControllerRevisions', 'postgres', 'ControllerRevision'],
  ]) {
    await sidebar(page).getByRole('link', { name: 'API resources' }).click()
    await kubernetes.getByRole('button', { name: new RegExp(`^${label}`) }).click()
    await row(page, label, name).first().getByRole('gridcell').nth(1).click()
    await expect(
      page.getByRole('complementary', { name: new RegExp(`^${kind} ${name}`) }).getByRole('tree'),
    ).not.toHaveCount(0)
  }
  await sidebar(page).getByRole('link', { name: 'Kustomizations' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Kustomizations')
  await page.getByRole('button', { name: 'Unpin Kustomizations from the sidebar' }).click()
  await expect(pinned).toHaveCount(0)
})

test('the command palette finds every kind, and objects of custom ones', async ({ page }) => {
  await openCluster(page)
  await openKind(page, 'argoproj.io', 'Applications')
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog')
  await palette.getByRole('combobox').fill('payments')
  await expect(palette.getByRole('option', { name: /payments/ })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.keyboard.press('Enter')
  await expect(panel(page, 'Application', CUSTOM.applications.progressing)).toBeVisible()

  await page.keyboard.press('ControlOrMeta+k')
  await palette.getByRole('combobox').fill('gtw')
  await palette.getByRole('option', { name: /Gateways/ }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Gateways')
  await expect(row(page, 'Gateways', CUSTOM.gateway)).toContainText('203.0.113.24')

  await page.keyboard.press('ControlOrMeta+k')
  await palette.getByRole('combobox').fill('API resources')
  await palette.getByRole('option', { name: 'API resources' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('API resources')
})

test('scale a custom workload through its scale subresource', async ({ page, clusters }) => {
  await openCluster(page)
  await openKind(page, 'argoproj.io', 'Rollouts')
  await expect(row(page, 'Rollouts', CUSTOM.rollout)).toContainText('Healthy')
  await openRow(page, 'Rollouts', CUSTOM.rollout)
  const detail = panel(page, 'Rollout', CUSTOM.rollout)
  // A workload of its own kind: its pods are found by its selector.
  await detail.getByRole('tab', { name: 'Pods' }).click()
  await expect(detail).toContainText('storefront-')
  await detail.getByRole('button', { name: 'Scale' }).click()
  const scale = dialog(page)
  await expect(scale.getByLabel('Replicas', { exact: true })).toHaveValue('4')
  await expect(scale).toContainText(
    'kubectl scale rollout.argoproj.io/checkout-canary --replicas=4 -n shop --context demo',
  )
  await scale.getByLabel('Replicas', { exact: true }).fill('6')
  await scale.getByRole('button', { name: 'Scale', exact: true }).click()
  await expect(toasts(page)).toContainText('Scaled checkout-canary to 6 replicas')
  const path = `/apis/argoproj.io/v1alpha1/namespaces/shop/rollouts/${CUSTOM.rollout}/scale`
  expect(writes(clusters.demo, 'PATCH', path).at(-1)!.body).toEqual({ spec: { replicas: 6 } })
  await expect
    .poll(() => clusters.demo.object('Rollout.argoproj.io', 'shop', CUSTOM.rollout)!.spec.replicas)
    .toBe(6)
  await toasts(page).getByRole('button', { name: 'Undo' }).click()
  await expect
    .poll(() => clusters.demo.object('Rollout.argoproj.io', 'shop', CUSTOM.rollout)!.spec.replicas)
    .toBe(4)

  // Reading the replicas can fail too.
  clusters.demo.fail(path, { status: 403 })
  await detail.getByRole('button', { name: 'Scale' }).click()
  await expect(dialog(page)).toContainText('injected fault (HTTP 403)')
  await expect(dialog(page).getByRole('button', { name: 'Scale', exact: true })).toBeDisabled()
})

test('view actions: reconcile, suspend and resume, sync, abort', async ({ page, clusters }) => {
  await openCluster(page)
  await openKind(page, 'kustomize.toolkit.fluxcd.io', 'Kustomizations')
  const status = (name: string) => row(page, 'Kustomizations', name).getByRole('gridcell').nth(2)
  await expect(status(CUSTOM.kustomizations.ready)).toHaveText('Ready')
  await expect(status(CUSTOM.kustomizations.suspended)).toHaveText('Suspended')
  await expect(status(CUSTOM.kustomizations.failing)).toHaveText('BuildFailed')

  await openRow(page, 'Kustomizations', CUSTOM.kustomizations.ready)
  const apps = panel(page, 'Kustomization', CUSTOM.kustomizations.ready)
  const path = (name: string) =>
    `/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/flux-system/kustomizations/${name}`
  await apps.getByRole('button', { name: 'Reconcile' }).click()
  await expect(toasts(page)).toContainText('Asked Flux to reconcile apps')
  const reconcile = writes(clusters.demo, 'PATCH', path('apps')).at(-1)!
  expect(reconcile.type).toBe('application/merge-patch+json')
  expect(reconcile.body.metadata.annotations['reconcile.fluxcd.io/requestedAt']).toMatch(
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/,
  )
  // The same, as a command.
  await page.getByRole('button', { name: /Activity/ }).click()
  await expect(page.getByRole('dialog', { name: 'Activity' })).toContainText(
    'kubectl patch kustomization.kustomize.toolkit.fluxcd.io/apps --type=merge -p',
  )
  await page.keyboard.press('Escape')

  await menuAction(page, 'Kustomization', CUSTOM.kustomizations.ready, 'Suspend')
  await expect(toasts(page)).toContainText('Suspended apps')
  await expect
    .poll(
      () =>
        clusters.demo.object('Kustomization.kustomize.toolkit.fluxcd.io', 'flux-system', 'apps')!
          .spec.suspend,
    )
    .toBe(true)
  await expect(apps.locator('header')).toContainText('Suspended')
  await toasts(page).getByRole('button', { name: 'Undo' }).first().click()
  await expect
    .poll(
      () =>
        clusters.demo.object('Kustomization.kustomize.toolkit.fluxcd.io', 'flux-system', 'apps')!
          .spec.suspend,
    )
    .toBeUndefined()

  await openRow(page, 'Kustomizations', CUSTOM.kustomizations.suspended)
  await panel(page, 'Kustomization', CUSTOM.kustomizations.suspended)
    .getByRole('button', { name: 'Resume' })
    .click()
  await expect(toasts(page)).toContainText('Resumed infra')
  const resumed = writes(clusters.demo, 'PATCH', path('infra')).at(-1)!.body
  expect(resumed.spec).toEqual({ suspend: null })

  // Argo CD syncs an application when it finds an operation on it.
  await openKind(page, 'argoproj.io', 'Applications')
  await openRow(page, 'Applications', CUSTOM.applications.progressing)
  await panel(page, 'Application', CUSTOM.applications.progressing)
    .getByRole('button', { name: 'Sync', exact: true })
    .click()
  await expect(toasts(page)).toContainText('Started syncing payments')
  expect(
    writes(
      clusters.demo,
      'PATCH',
      '/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/payments',
    ).at(-1)!.body,
  ).toEqual({
    operation: { initiatedBy: { username: 'kubestacks' }, sync: { syncStrategy: { hook: {} } } },
  })

  // Sources were fetched a while ago.
  await openKind(page, 'source.toolkit.fluxcd.io', 'GitRepositories')
  await expect(row(page, 'GitRepositories', CUSTOM.gitRepository)).toContainText(/\d+m(\d+s)? ago/)

  // Restarting asks first, without alarm.
  await openKind(page, 'argoproj.io', 'Rollouts')
  await openRow(page, 'Rollouts', CUSTOM.rollout)
  await menuAction(page, 'Rollout', CUSTOM.rollout, 'Restart…')
  await expect(dialog(page)).toContainText('replaced a few at a time')
  await dialog(page).getByRole('button', { name: 'Restart', exact: true }).click()
  await expect(toasts(page)).toContainText('Restarted checkout-canary')

  // Aborting a rollout asks first, and changes its status.
  await openKind(page, 'argoproj.io', 'Rollouts')
  const rollout = clusters.demo.object('Rollout.argoproj.io', 'shop', CUSTOM.rollout)!
  clusters.demo.upsert({
    ...rollout,
    status: {
      ...rollout.status,
      phase: 'Paused',
      message: 'CanaryPauseStep',
      pauseConditions: [{ reason: 'CanaryPauseStep' }],
    },
  })
  await openRow(page, 'Rollouts', CUSTOM.rollout)
  const canary = panel(page, 'Rollout', CUSTOM.rollout)
  await expect(canary.locator('header')).toContainText('Paused')
  await menuAction(page, 'Rollout', CUSTOM.rollout, 'Abort…')
  await expect(dialog(page)).toContainText('traffic goes back to the stable version')
  await expect(dialog(page)).toContainText('--subresource=status')
  await dialog(page).getByRole('button', { name: 'Abort', exact: true }).click()
  await expect(toasts(page)).toContainText('Aborted the rollout of checkout-canary')
  expect(
    writes(
      clusters.demo,
      'PATCH',
      `/apis/argoproj.io/v1alpha1/namespaces/shop/rollouts/${CUSTOM.rollout}/status`,
    ).at(-1)!.body,
  ).toEqual({ status: { abort: true } })
  await expect(canary.locator('header')).toContainText('Aborted')
})

test('what an account may do decides view actions too', async ({ page, clusters }) => {
  clusters.demo.deny({ verb: 'patch', resource: 'kustomizations' })
  await openCluster(page)
  await openKind(page, 'kustomize.toolkit.fluxcd.io', 'Kustomizations')
  await openRow(page, 'Kustomizations', CUSTOM.kustomizations.ready)
  const reconcile = panel(page, 'Kustomization', CUSTOM.kustomizations.ready).getByRole('button', {
    name: 'Reconcile',
  })
  await expect(reconcile).toBeDisabled()
  await reconcile.locator('..').focus()
  await expect(page.getByRole('tooltip')).toContainText(
    'Your account can’t change kustomizations in flux-system.',
  )

  // Scaling and status changes are their own permissions.
  clusters.demo.deny({ verb: 'patch', resource: 'rollouts' })
  const rollout = clusters.demo.object('Rollout.argoproj.io', 'shop', CUSTOM.rollout)!
  clusters.demo.upsert({
    ...rollout,
    status: {
      ...rollout.status,
      phase: 'Paused',
      pauseConditions: [{ reason: 'CanaryPauseStep' }],
    },
  })
  await openKind(page, 'argoproj.io', 'Rollouts')
  await openRow(page, 'Rollouts', CUSTOM.rollout)
  const canary = panel(page, 'Rollout', CUSTOM.rollout)
  for (const [action, reason] of [
    ['Scale', 'Your account can’t scale rollouts in shop.'],
    ['Promote', 'Your account can’t change rollouts in shop.'],
  ]) {
    const button = canary.getByRole('button', { name: action, exact: true })
    await expect(button).toBeDisabled()
    await button.locator('..').focus()
    await expect(page.getByRole('tooltip').filter({ hasText: reason! })).toBeVisible()
  }
})

test('CRDs come and go: new kinds appear, and removed ones say so', async ({ page, clusters }) => {
  await openCluster(page)
  await page.keyboard.press('ControlOrMeta+n')
  const editor = dialog(page).getByRole('textbox', { name: 'YAML to create' })
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(`apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: gizmos.toys.example.org
spec:
  group: toys.example.org
  names: { kind: Gizmo, plural: gizmos, singular: gizmo }
  scope: Namespaced
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                speed: { type: integer, description: How fast it spins. }
`)
  await dialog(page).getByRole('button', { name: 'Create', exact: true }).click()
  await expect(toasts(page)).toContainText(
    'Created customresourcedefinition gizmos.toys.example.org',
  )
  // Discovery looks again, and the new kind is there.
  await openKind(page, 'toys.example.org', 'Gizmos')
  await expect(page.getByText('No Gizmos in this cluster')).toBeVisible()

  await page.keyboard.press('ControlOrMeta+n')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(
    'apiVersion: toys.example.org/v1\nkind: Gizmo\nmetadata:\n  name: spinner\n  namespace: default\nspec:\n  speed: 3\n',
  )
  await dialog(page).getByRole('button', { name: 'Create', exact: true }).click()
  await expect(toasts(page)).toContainText('Created gizmo spinner')
  await toasts(page)
    .getByRole('status')
    .filter({ hasText: 'Created gizmo spinner' })
    .getByRole('button', { name: 'Open' })
    .click()
  const spinner = panel(page, 'Gizmo', 'spinner')
  await hoverForTooltip(spinner.getByText('speed'), 'How fast it spins.')

  // Deleting the CRD deletes its objects; that has to be typed.
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  await page
    .getByRole('region', { name: 'Kubernetes' })
    .getByRole('button', { name: /^CustomResourceDefinitions/ })
    .click()
  await expect(row(page, 'CustomResourceDefinitions', 'gizmos.toys.example.org')).toContainText(
    'Gizmo',
  )
  await openRow(page, 'CustomResourceDefinitions', 'gizmos.toys.example.org')
  await menuAction(page, 'CustomResourceDefinition', 'gizmos.toys.example.org', 'Delete…')
  await expect(dialog(page)).toContainText('Every Gizmo in the cluster is deleted with it')
  await dialog(page).getByRole('textbox').fill('gizmos.toys.example.org')
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(sidebar(page).getByRole('link', { name: 'Gizmos' })).toHaveCount(0)
  expect(clusters.demo.object('Gizmo.toys.example.org', 'default', 'spinner')).toBeUndefined()
  await page.evaluate(() => (location.hash = '#/cluster/demo/r/Gizmo.toys.example.org'))
  await expect(page.getByText('demo doesn’t serve Gizmo.toys.example.org')).toBeVisible()
})

test('YAML edits of custom resources are checked against their schema', async ({ page }) => {
  await openCluster(page)
  await openKind(page, 'example.com', 'Widgets')
  await openRow(page, 'Widgets', CUSTOM.widget)
  await menuAction(page, 'Widget', CUSTOM.widget, 'Edit YAML')
  const detail = panel(page, 'Widget', CUSTOM.widget)
  const editor = detail.getByRole('textbox', { name: `YAML of ${CUSTOM.widget}` })
  const text = await editor.innerText()
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(text.replace('size: 3', 'size: 0'))
  await page.keyboard.press('ControlOrMeta+s')
  await expect(detail.getByRole('alert')).toContainText(
    'spec.size: Invalid value: 0: spec.size in body should be greater than or equal to 1',
  )
})

test('cluster-wide custom resources, and events about custom resources', async ({ page }) => {
  await openCluster(page)
  await openKind(page, 'cert-manager.io', 'ClusterIssuers')
  await expect(page.getByLabel('Namespace')).toHaveText('Cluster-wide')
  await expect(row(page, 'ClusterIssuers', CUSTOM.clusterIssuers.staging)).toContainText(
    'acme-staging-v02',
  )
  await openKind(page, 'cert-manager.io', 'Certificates')
  await openRow(page, 'Certificates', CUSTOM.certificates.issuing)
  const detail = panel(page, 'Certificate', CUSTOM.certificates.issuing)
  await detail.getByRole('tab', { name: 'Events' }).click()
  await expect(detail).toContainText('Issuing certificate as Secret does not exist')
  // Events link back to custom resources.
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'Events' })
    .click()
  await page.getByPlaceholder('Filter events').fill(CUSTOM.certificates.issuing)
  await rows(page, 'Events').first().getByRole('gridcell').nth(1).click()
  await page.getByRole('button', { name: `Certificate/${CUSTOM.certificates.issuing}` }).click()
  await expect(panel(page, 'Certificate', CUSTOM.certificates.issuing)).toBeVisible()
})

test('an older cluster: discovery a group at a time, no schemas', async ({ page, clusters }) => {
  // One group's discovery fails: the rest still shows, like kubectl.
  clusters.sandbox.fail('/apis/storage.k8s.io/v1', { status: 503 })
  await openCluster(page, CONTEXTS.sandbox)
  await openKind(page, 'example.com', 'Widgets')
  await openRow(page, 'Widgets', CUSTOM.widget)
  const widget = panel(page, 'Widget', CUSTOM.widget)
  await expect(widget.getByRole('tree', { name: 'Spec' })).toContainText('size')
  // Without OpenAPI v3 there is nothing to explain the fields with.
  await expect(
    widget.getByRole('tree', { name: 'Spec' }).locator('[aria-description]'),
  ).toHaveCount(0)
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  await expect(page.getByRole('region', { name: 'Kubernetes' })).toContainText('Deployments')
  await expect(page.getByRole('region', { name: 'Kubernetes' })).not.toContainText(
    'Storage Classes',
  )
})

test('when discovery fails', async ({ page, clusters }) => {
  const clear = clusters.demo.fail('/apis', { status: 500 })
  await openCluster(page)
  // Built-in kinds keep working; custom resources wait for discovery.
  await expect(sidebar(page).getByRole('link', { name: 'API resources' })).toBeVisible()
  await expect(sidebar(page).getByText('None in this cluster')).toHaveCount(0)
  await sidebar(page).getByRole('link', { name: 'API resources' }).click()
  await expect(page.getByRole('alert')).toContainText('injected fault (HTTP 500)')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('alert')).toContainText('injected fault (HTTP 500)')
  // The palette still finds the built-in kinds.
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('dialog').getByRole('combobox').fill('Deployments')
  await expect(page.getByRole('dialog').getByRole('option', { name: /Deployments/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.goto(page.url().replace(/api-resources.*$/, 'r/Widget.example.com'))
  await expect(page.getByRole('alert')).toContainText('injected fault (HTTP 500)')
  clear()
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Widgets')
})

test('hundreds of CRDs stay manageable', async ({ page }) => {
  await openCluster(page, CONTEXTS.large)
  const nav = sidebar(page)
  await expect(nav.getByRole('link', { name: /API resources/ })).toContainText('400')
  await nav.getByRole('link', { name: /API resources/ }).click()
  await expect(page.getByRole('region', { name: 'Custom resources' })).toContainText(
    '400 kinds in 10 groups',
  )
  await expect(
    page.getByRole('rowgroup', { name: 'ec2.aws.upbound.io', exact: true }),
  ).toContainText('40')
  await openKind(page, 'rds.aws.upbound.io', 'Resource07s')
  await expect(page.getByText('No Resource07s in this cluster')).toBeVisible()
  // The sidebar keeps the five opened last, newest first.
  for (const kind of ['Resource01s', 'Resource02s', 'Resource03s', 'Resource04s', 'Resource05s']) {
    await openKind(page, 's3.aws.upbound.io', kind)
  }
  await expect(nav.getByRole('group', { name: 'Opened lately' }).getByRole('link')).toHaveText([
    'Resource05s',
    'Resource04s',
    'Resource03s',
    'Resource02s',
    'Resource01s',
  ])
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('dialog').getByRole('combobox').fill('Resource39 sqs')
  await expect(page.getByRole('dialog').getByRole('option', { name: /Resource39s/ })).toHaveCount(1)
})

test('a cluster without custom resources', async ({ page, clusters }) => {
  for (const crd of [
    'widgets.example.com',
    'nodepools.karpenter.sh',
    'nodeclaims.karpenter.sh',
    'ec2nodeclasses.karpenter.k8s.aws',
  ]) {
    clusters.sandbox.remove('CustomResourceDefinition.apiextensions.k8s.io', undefined, crd)
  }
  await openCluster(page, CONTEXTS.sandbox)
  await expect(sidebar(page).getByText('None in this cluster')).toBeVisible()
})

test('fields go unexplained when the schema can’t be read', async ({ page, clusters }) => {
  clusters.demo.fail(/^\/openapi\/v3\/apis\/cert-manager\.io\/v1$/, { status: 500 })
  await openCluster(page)
  await openKind(page, 'cert-manager.io', 'Certificates')
  await openRow(page, 'Certificates', CUSTOM.certificates.ready)
  const spec = panel(page, 'Certificate', CUSTOM.certificates.ready).getByRole('tree', {
    name: 'Spec',
  })
  await expect(spec).toContainText('secretName')
  await expect(spec.locator('[aria-description]')).toHaveCount(0)
})

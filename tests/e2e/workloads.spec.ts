import type { Page } from '@playwright/test'
import { demoCluster } from '../mock-cluster/fixtures/demo.ts'
import { dialog, toasts, writes } from './action-helpers.ts'
import { CONTEXTS, expect, openCluster, panel, rows, test } from './fixtures.ts'

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Resources' })
const tabs = (page: Page) => page.getByRole('navigation', { name: 'Workload types' })
/** A workload's row, by its name (rows start with their checkbox). */
const workload = (page: Page, name: string) =>
  rows(page, 'Workloads').filter({ has: page.getByText(name, { exact: true }) })
const cell = (page: Page, name: string, column: number) =>
  workload(page, name).getByRole('gridcell').nth(column)

async function openWorkloads(page: Page) {
  await sidebar(page).getByRole('link', { name: 'Workloads', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workloads')
}

test('every workload, whatever its kind, in one list', async ({ page }) => {
  await openCluster(page)
  await page.keyboard.press('g')
  await page.keyboard.press('w')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workloads')
  await expect(page).toHaveTitle(/^Workloads · demo/)
  await expect(tabs(page).getByRole('link', { name: 'All' })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(tabs(page)).toContainText('Deployments8StatefulSets2DaemonSets2Jobs4CronJobs3')
  await expect(page.getByText('21 workloads')).toBeVisible()

  // Each kind, with what it runs and uses.
  await expect(workload(page, 'storefront')).toContainText('DeploymentReady3/32–10')
  await expect(cell(page, 'storefront', 5)).toHaveText('714m')
  await expect(workload(page, 'postgres')).toContainText('StatefulSetReady3/3')
  await expect(workload(page, 'kube-proxy')).toContainText('DaemonSetReady4/4')
  await expect(workload(page, 'nightly-report')).toContainText('CronJobScheduled—')
  await expect(workload(page, 'db-migrate')).toContainText('JobFailed0/1 done')
  await expect(workload(page, 'debug-shell')).toContainText('PodRunning1/1')
  await expect(workload(page, 'old-task')).toContainText('PodCompleted0/1')
  // What runs them isn't listed: a Deployment's ReplicaSets, a CronJob's Jobs, a node's static pods.
  await expect(workload(page, 'nightly-report-29310')).toHaveCount(0)
  await expect(rows(page, 'Workloads').filter({ hasText: 'ReplicaSet' })).toHaveCount(0)
  await expect(workload(page, 'kube-apiserver')).toHaveCount(0)

  // Sorting, by each column.
  const grid = page.getByRole('grid', { name: 'Workloads' })
  const first = rows(page, 'Workloads').first()
  await grid.getByRole('button', { name: 'Type' }).click()
  await expect(first).toContainText('CronJob')
  await grid.getByRole('button', { name: 'Pods' }).click()
  await expect(first).toContainText('Job')
  await grid.getByRole('button', { name: 'CPU' }).click()
  await grid.getByRole('button', { name: 'CPU' }).click()
  await expect(first).toContainText('reindex')
  await grid.getByRole('button', { name: 'Memory' }).click()
  await grid.getByRole('button', { name: 'Memory' }).click()
  await expect(first).toContainText('redis')
  await grid.getByRole('button', { name: 'Name' }).click()
  await expect(first).toContainText('backfill')

  // Filters: health, text (names, kinds, images and labels), and a page at a time.
  await page.getByRole('button', { name: /^Failing/ }).click()
  await expect(rows(page, 'Workloads')).toHaveCount(2)
  await page.getByRole('button', { name: /^Failing/ }).click()
  const filter = page.getByPlaceholder('Filter workloads')
  await filter.fill('statefulset')
  await expect(rows(page, 'Workloads')).toHaveCount(2)
  await filter.fill('redis:8')
  await expect(rows(page, 'Workloads')).toHaveCount(1)
  await filter.fill('nothing like it')
  await expect(page.getByText('No workloads match the current filters.')).toBeVisible()
  await filter.fill('')
  await filter.press('ArrowDown')
  await expect(grid).toBeFocused()

  // A page at a time, and a sort the list doesn't have.
  const pagination = page.getByRole('navigation', { name: 'Pagination' })
  await pagination.getByLabel('Rows per page').selectOption('50')
  await expect(page).toHaveURL(/size=50/)
  await grid.focus()
  await page.keyboard.press('ArrowRight')
  await expect(pagination).toContainText('Page 1 of 1')
  await page.evaluate(() => {
    window.location.hash = window.location.hash.replace(/sort=\w+/, 'sort=bogus')
  })
  await expect(first).toContainText('backfill')

  // Opening one shows it in the panel, by its kind.
  await workload(page, 'postgres').getByRole('gridcell').nth(1).click()
  await expect(panel(page, 'StatefulSet', 'postgres')).toBeVisible()
  await expect(workload(page, 'postgres')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')

  // One kind, with its own columns, a tab away; Workloads stays current in the sidebar.
  await tabs(page)
    .getByRole('link', { name: /^Deployments/ })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Deployments')
  await expect(page.getByRole('grid', { name: 'Deployments' })).toBeVisible()
  await expect(sidebar(page).getByRole('link', { name: 'Workloads', exact: true })).toHaveClass(
    /bg-surface-3 font-medium/,
  )
  await tabs(page).getByRole('link', { name: 'All' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workloads')
})

test('narrowed to namespaces, labels and what the account can read', async ({ page, clusters }) => {
  await openCluster(page)
  await openWorkloads(page)

  // The namespace picked in the header scopes the page.
  await page.getByRole('button', { name: 'Namespace', exact: true }).click()
  await page.getByRole('option', { name: 'shop', exact: true }).click()
  await expect(page.getByText('4 workloads')).toBeVisible()

  // A label selector, asked of the API server.
  const labels = page.getByLabel('Label selector')
  await labels.fill('app.kubernetes.io/name=checkout')
  await labels.press('Enter')
  await expect(rows(page, 'Workloads')).toHaveCount(1)
  await labels.fill('app.kubernetes.io/name=nothing')
  await labels.press('Enter')
  await expect(page.getByText('No workloads in shop')).toBeVisible()
  await expect(
    page.getByText('Nothing matches the label selector “app.kubernetes.io/name=nothing”.'),
  ).toBeVisible()
  await labels.fill('')
  await labels.press('Enter')

  // Kinds that can't be listed are left out, and said so.
  clusters.demo.fail('/apis/apps/v1/namespaces/shop/deployments', { status: 403 })
  await labels.fill('app.kubernetes.io/part-of=shop')
  await labels.press('Enter')
  await expect(page.getByRole('status').filter({ hasText: 'Couldn’t list' })).toContainText(
    'Couldn’t list Deployments: injected fault (HTTP 403)',
  )
  await expect(page.getByText('No workloads in shop')).toBeVisible()
})

test('when nothing can be read, or only part is fresh', async ({ page, clusters }) => {
  for (const path of ['deployments', 'statefulsets', 'daemonsets', 'replicasets']) {
    clusters.demo.fail(`/apis/apps/v1/${path}`, { status: 500 })
  }
  clusters.demo.fail('/apis/batch/v1/jobs', { status: 500 })
  clusters.demo.fail('/apis/batch/v1/cronjobs', { status: 500 })
  clusters.demo.fail('/api/v1/pods', { status: 500 })
  await openCluster(page)
  await openWorkloads(page)
  await expect(page.getByRole('alert')).toContainText('injected fault (HTTP 500)')
  clusters.demo.reset()
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByText('21 workloads')).toBeVisible()

  // A list that fails after it worked keeps what it had.
  clusters.demo.fail('/apis/apps/v1/daemonsets', { status: 500 })
  await page.getByRole('button', { name: /^Refresh/ }).click()
  const stale = page.getByRole('status').filter({ hasText: 'Couldn’t refresh' })
  await expect(stale).toContainText('injected fault (HTTP 500)')
  await expect(page.getByText('21 workloads')).toBeVisible()
  clusters.demo.reset()
  await stale.getByRole('button', { name: 'Retry' }).click()
  await expect(stale).toHaveCount(0)
})

test('restart and delete workloads of different kinds together', async ({ page, clusters }) => {
  await openCluster(page)
  await openWorkloads(page)
  await workload(page, 'storefront').getByRole('checkbox').check()
  await workload(page, 'postgres').getByRole('checkbox').check()
  await workload(page, 'nightly-report').getByRole('checkbox').check()
  const bar = page.getByRole('toolbar', { name: 'Selected rows' })
  await expect(bar).toContainText('3 selected')
  await bar.getByRole('button', { name: 'Restart' }).click()
  const restart = dialog(page)
  await expect(restart.getByRole('heading')).toHaveText('Restart 2 workloads?')
  await expect(restart).toContainText(
    'Left out: 1 of the selected, which restart doesn’t apply to.',
  )
  await expect(restart).toContainText(
    'kubectl rollout restart deployment/storefront -n shop --context demo',
  )
  await expect(restart).toContainText(
    'kubectl rollout restart statefulset/postgres -n data --context demo',
  )
  await restart.getByRole('button', { name: 'Restart', exact: true }).click()
  await expect(toasts(page)).toContainText('Restarted 2 workloads')
  expect(writes(clusters.demo, 'PATCH', /deployments\/storefront$/)).toHaveLength(1)
  expect(writes(clusters.demo, 'PATCH', /statefulsets\/postgres$/)).toHaveLength(1)

  // Kinds share names, but not rows.
  const twin = demoCluster().objects.find(
    (o) => o.kind === 'StatefulSet' && o.metadata.name === 'postgres',
  )!
  clusters.demo.upsert({ ...twin, metadata: { ...twin.metadata, namespace: 'shop', name: 'cart' } })
  await page.getByRole('button', { name: /^Refresh/ }).click()
  await expect(workload(page, 'cart')).toHaveCount(2)
  await workload(page, 'cart').filter({ hasText: 'StatefulSet' }).getByRole('checkbox').check()
  await expect(bar).toContainText('1 selected')
  await bar.getByRole('button', { name: 'Delete' }).click()
  await expect(dialog(page).getByRole('heading')).toHaveText('Delete 1 StatefulSet?')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await workload(page, 'cart').filter({ hasText: 'Deployment' }).getByRole('checkbox').check()
  await bar.getByRole('button', { name: 'Delete' }).click()
  await expect(dialog(page).getByRole('heading')).toHaveText('Delete 2 workloads?')
  await expect(dialog(page)).toContainText('kubectl delete statefulset/cart -n shop')
  await expect(dialog(page)).toContainText('kubectl delete deployment/cart -n shop')
})

test('runs, autoscalers and jobs of other shapes', async ({ page, clusters }) => {
  const demo = demoCluster().objects
  const cronJob = demo.find((o) => o.kind === 'CronJob' && o.metadata.name === 'nightly-report')!
  clusters.demo.upsert({
    ...cronJob,
    status: { ...cronJob.status, active: [{ kind: 'Job', name: 'nightly-report-29311' }] },
  })
  const job = demo.find((o) => o.kind === 'Job' && o.metadata.name === 'db-migrate')!
  clusters.demo.upsert({
    ...job,
    metadata: { ...job.metadata, name: 'queue-worker' },
    spec: { ...job.spec, completions: undefined, parallelism: 3 },
    status: { active: 3 },
  })
  const hpa = demo.find((o) => o.kind === 'HorizontalPodAutoscaler')!
  clusters.demo.upsert({
    ...hpa,
    metadata: { ...hpa.metadata, name: 'cart' },
    spec: {
      ...hpa.spec,
      minReplicas: undefined,
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'cart' },
    },
  })
  await openCluster(page)
  await openWorkloads(page)
  await expect(workload(page, 'nightly-report')).toContainText('1 running')
  await expect(workload(page, 'queue-worker')).toContainText('0/1 done')
  await expect(workload(page, 'cart')).toContainText('2/21–')
  await expect(
    workload(page, 'cart').getByTitle(/^cart scales it between 1 and \d+ replicas$/),
  ).toBeVisible()
})

test('a cluster without metrics, and lists too long to load whole', async ({ launch }) => {
  const { page } = await launch({ env: { KUBESTACKS_MAX_LIST_ITEMS: '1000' } })
  await openCluster(page, CONTEXTS.sandbox)
  await openWorkloads(page)
  await expect(page.getByText('Live usage needs metrics-server')).toBeVisible()
  await expect(
    page.getByRole('grid', { name: 'Workloads' }).getByRole('button', { name: 'CPU' }),
  ).toHaveCount(0)

  await page.getByRole('button', { name: 'Switch cluster' }).click()
  await page.getByRole('option', { name: /^large\b/ }).click()
  await openWorkloads(page)
  const note = page.getByRole('note')
  await expect(note).toContainText('Some lists are too long to load whole')
  await note.getByRole('button', { name: 'Filter by label' }).click()
  await expect(page.getByLabel('Label selector')).toBeFocused()
})

test('Workloads is a shortcut and a palette entry away', async ({ page }) => {
  await openCluster(page)
  await page.keyboard.press('Meta+2')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workloads')
  await page.keyboard.press('Meta+1')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('workloads')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workloads')
  // Pods have their own place, next to it.
  await sidebar(page).getByRole('link', { name: 'Pods', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  await expect(tabs(page)).toHaveCount(0)
})

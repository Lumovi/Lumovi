/**
 * Quotas show how full they are: each resource used against its limit, on a meter with its %
 * written (floored, so 3.75 Gi of 4 Gi is 93%), worst first; a namespace's quotas and limit
 * ranges on its Overview; a quota from 90% in Needs attention; a rollout a quota stops says so.
 */
import type { Page } from '@playwright/test'
import { bounds, quotas, REFUSED, stuckRollout } from '../mock-cluster/fixtures/quotas.ts'
import { open } from './action-helpers.ts'
import { expect, goTo, openCluster, panel, row, test } from './fixtures.ts'

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)

test('the Resource Quotas list: each quota’s fullest resource, its % floored and its meter, worst first', async ({
  page,
  clusters,
}) => {
  quotas(clusters.demo)
  await openCluster(page)
  await goTo(page, 'Resource Quotas')
  const grid = page.getByRole('grid', { name: 'Resource Quotas' })
  const compute = row(page, 'Resource Quotas', /^compute/)
  await expect(compute).toContainText('requests.memory93%')
  await expect(compute).toContainText('Nearly full')
  const meter = compute.getByRole('meter')
  await expect(meter).toHaveAttribute('aria-valuetext', '93%')
  await expect(meter).toHaveAttribute('aria-valuenow', '93')
  await expect(row(page, 'Resource Quotas', /^storage/)).toContainText('persistentvolumeclaims100%')
  await expect(row(page, 'Resource Quotas', /^storage/)).toContainText('Full')
  // One that only forbids is within quota; one not counted yet says so, with no meter.
  await expect(row(page, 'Resource Quotas', /^no-balancers/)).toContainText('Within quota')
  const fresh = row(page, 'Resource Quotas', /^fresh/)
  await expect(fresh).toContainText('Not counted yet')
  await expect(fresh.getByRole('meter')).toHaveCount(0)
  // Worst first; the chips by status.
  await expect(grid.getByRole('row').nth(1)).toContainText('storage')
  const filters = page.getByRole('group', { name: 'Filters' })
  await expect(filters.getByRole('button', { name: 'Full 1', exact: true })).toBeVisible()
  await expect(filters.getByRole('button', { name: 'Nearly full 1', exact: true })).toBeVisible()
  await expect(filters.getByRole('button', { name: 'Within quota 3', exact: true })).toBeVisible()
})

test('a quota’s Usage, a meter a resource, worst first, and what it applies to; a limit range’s tables', async ({
  page,
  clusters,
}) => {
  quotas(clusters.demo)
  await openCluster(page)
  await open(page, 'Resource Quotas', 'compute')
  const detail = panel(page, 'ResourceQuota', 'compute')
  const usage = detail
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Usage', exact: true }) })
  await expect(usage).toContainText('requests.memory is 93% used')
  await expect(usage).toContainText('Memory requests')
  await expect(usage).toContainText('93% · 3.75 Gi of 4 Gi')
  await expect(usage).toContainText('90% · 1.8 cores of 2 cores')
  await expect(usage).toContainText('80% · 3.2 cores of 4 cores')
  await expect(usage).toContainText('45% · 9 of 20')
  // A thing it forbids: no meter, and no %.
  await expect(usage).toContainText('Not allowed · 0 of 0')
  await expect(usage.getByRole('meter')).toHaveCount(5)
  await expect(usage.getByRole('meter').first()).toHaveAccessibleName('Memory requests used')
  await expect(detail).toContainText('Every pod in shop')

  await open(page, 'Limit Ranges', 'pvc-size')
  await expect(row(page, 'Limit Ranges', /^pvc-size/)).toContainText('PersistentVolumeClaim')
  const range = panel(page, 'LimitRange', 'pvc-size')
  const table = range.getByRole('table', { name: 'PersistentVolumeClaim limits' })
  await expect(table.getByRole('row').nth(1)).toContainText('Storage1Gi100Gi———')
})

test('a namespace shows its quotas and limit ranges; none says so, and access that doesn’t list them says that', async ({
  page,
  clusters,
}) => {
  quotas(clusters.demo)
  await openCluster(page)
  await open(page, 'Namespaces', 'shop')
  const shop = panel(page, 'Namespace', 'shop')
  // A card's title is its button, heard with its status; its meters are each heard on their own.
  const title = shop.getByRole('button', { name: 'compute Nearly full' })
  const compute = title.locator('..')
  await expect(compute.getByRole('meter')).toHaveCount(2)
  await expect(compute).toContainText('93% · 3.75 Gi of 4 Gi')
  await expect(compute).toContainText('90% · 1.8 cores of 2 cores')
  // What it forbids, each its line; then those under 90%, counted alone.
  await expect(compute).toContainText('Not allowed · 0 of 0')
  await expect(compute).toContainText('and 3 more under 90%')
  const storage = shop.getByRole('button', { name: 'storage Full' }).locator('..')
  await expect(storage).toContainText('100% · 10 of 10')
  await expect(
    shop.getByRole('button', { name: 'objects Within quota' }).locator('..'),
  ).toContainText('1 resource under 90%')
  await expect(shop).toContainText('A container’s default request 100m CPU, 64Mi memory')
  await expect(shop).toContainText('A volume claim from 1Gi to 100Gi')
  // A card opens its quota: by its title, or anywhere on it.
  await title.click()
  await expect(panel(page, 'ResourceQuota', 'compute')).toBeVisible()
  await open(page, 'Namespaces', 'shop')
  await storage.getByRole('meter').click()
  await expect(panel(page, 'ResourceQuota', 'storage')).toBeVisible()

  // One not counted yet says so alone; bounds name what their first amounts are of.
  bounds(clusters.demo)
  await open(page, 'Namespaces', 'data')
  await expect(panel(page, 'Namespace', 'data')).toContainText(
    'A container from 50m CPU, 64Mi memory to 2, 4Gi',
  )
  await expect(panel(page, 'Namespace', 'data')).toContainText('A pod up to 4 CPU, 8Gi memory')
  const fresh = panel(page, 'Namespace', 'data').getByRole('button', {
    name: 'fresh Not counted yet',
  })
  await expect(fresh.locator('..')).toHaveText(/Not counted yet$/)
  await expect(fresh.locator('..')).not.toContainText('under 90%')

  // None in a namespace: said; one access doesn't list: said with a lock, the other still shown.
  await open(page, 'Namespaces', 'monitoring')
  const monitoring = panel(page, 'Namespace', 'monitoring')
  await expect(monitoring).toContainText('No quotas in monitoring.')
  await expect(monitoring).toContainText('No limit ranges in monitoring.')
  clusters.demo.fail('/api/v1/namespaces/batch/resourcequotas', {
    status: 403,
    body: JSON.stringify({ kind: 'Status', status: 'Failure', reason: 'Forbidden', code: 403 }),
  })
  await go(page, '#/cluster/demo/namespaces?open=Namespace%2F%2Fbatch')
  const batch = panel(page, 'Namespace', 'batch')
  await expect(batch).toContainText('Your access doesn’t list ResourceQuotas in batch.')
  await expect(batch).toContainText('No limit ranges in batch.')
})

test('a quota from 90% needs attention, with its fullest resource; a rollout a quota stops says so, and opens it', async ({
  page,
  clusters,
}) => {
  quotas(clusters.demo)
  stuckRollout(clusters.demo)
  await openCluster(page)
  const attention = page.getByRole('list', { name: 'Needs attention' })
  const more = page.getByRole('button', { name: /^Show all \d+$/ })
  if (await more.isVisible()) await more.click()
  await expect(attention).toContainText(
    'ResourceQuota · shop · requests.memory 93% · 3.75 Gi of 4 Gi',
  )
  await expect(attention).toContainText('ResourceQuota · shop · persistentvolumeclaims 10 of 10')
  await expect(attention).toContainText(
    'Deployment · shop · 2 of 3 ready: exceeded quota compute (requests.memory)',
  )
  // Not one that only forbids, nor one not counted yet.
  await expect(attention).not.toContainText('no-balancers')
  await expect(attention).not.toContainText('fresh')

  await open(page, 'Deployments', 'checkout-quota')
  const stuck = panel(page, 'Deployment', 'checkout-quota')
  await expect(stuck).toContainText('Quota exceeded')
  const note = stuck.getByRole('note')
  await expect(note).toContainText(
    '1 of its 3 pods can’t be made: the namespace’s quota compute has no room for its memory request.',
  )
  await expect(note).toContainText(REFUSED)
  await note.getByRole('button', { name: 'Open quota compute' }).click()
  await expect(panel(page, 'ResourceQuota', 'compute')).toBeVisible()
})

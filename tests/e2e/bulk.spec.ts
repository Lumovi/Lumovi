import type { Page } from '@playwright/test'
import { dialog, toasts, writes } from './action-helpers.ts'
import { DEMO, expect, goTo, openCluster, row, rows, test } from './fixtures.ts'

const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Selected rows' })
/** Clicks a row's checkbox cell, with Shift to pick a range. */
const pick = (page: Page, label: string, name: string, shift = false) =>
  row(page, label, name)
    .first()
    .getByRole('checkbox')
    .click(shift ? { modifiers: ['Shift'] } : undefined)
const filter = (page: Page, label: string) => page.getByPlaceholder(`Filter ${label.toLowerCase()}`)

test.beforeEach(async ({ page }) => {
  await openCluster(page)
})

test('pick rows with the mouse and the keyboard', async ({ page }) => {
  await goTo(page, 'Pods')
  const all = page.getByRole('checkbox', { name: 'Select all rows on this page' })
  // Rows are virtualized, so count them from the list's total (all on one page).
  const count = Number((await page.getByText(/^\d+ items$/).textContent())!.split(' ')[0])

  // Picking a row doesn't open it; Shift picks everything in between.
  await rows(page, 'Pods').nth(0).getByRole('checkbox').click()
  await expect(toolbar(page)).toContainText('1 selected')
  await expect(page.getByRole('complementary', { name: /^Pod / })).toHaveCount(0)
  await rows(page, 'Pods')
    .nth(3)
    .getByRole('checkbox')
    .click({ modifiers: ['Shift'] })
  await expect(toolbar(page)).toContainText('4 selected')
  await expect(rows(page, 'Pods').nth(2)).toHaveAttribute('data-picked', 'true')
  expect(await all.evaluate((input: HTMLInputElement) => input.indeterminate)).toBe(true)
  // Shift-clicking a picked row lets go of the range from the last one clicked.
  await rows(page, 'Pods')
    .nth(2)
    .getByRole('checkbox')
    .click({ modifiers: ['Shift'] })
  await expect(toolbar(page)).toContainText('2 selected')
  await expect(rows(page, 'Pods').nth(1)).toHaveAttribute('data-picked', 'true')

  // The header picks the whole page, then none of it.
  await all.click()
  await expect(toolbar(page)).toContainText(`${count} selected`)
  await expect(all).toBeChecked()
  await all.click()
  await expect(toolbar(page)).toHaveCount(0)

  // x picks the active row, Shift+x a range, ⌘A the page, Escape none.
  const grid = page.getByRole('grid', { name: 'Pods' })
  await grid.focus()
  await page.keyboard.press('x')
  await expect(toolbar(page)).toContainText('1 selected')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Shift+X')
  await expect(toolbar(page)).toContainText('3 selected')
  // A plain a does nothing.
  await page.keyboard.press('a')
  await expect(toolbar(page)).toContainText('3 selected')
  await page.keyboard.press('ControlOrMeta+a')
  await expect(toolbar(page)).toContainText(`${count} selected`)
  // Escape lets go of the selection, but leaves an open panel alone.
  await rows(page, 'Pods').nth(5).getByRole('gridcell').nth(1).click()
  await expect(page.getByRole('complementary', { name: /^Pod / })).toBeVisible()
  await grid.focus()
  await page.keyboard.press('Escape')
  await expect(toolbar(page)).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: /^Pod / })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('complementary', { name: /^Pod / })).toHaveCount(0)
  await page.keyboard.press('x')
  await toolbar(page).getByRole('button', { name: 'Clear selection' }).click()
  await expect(toolbar(page)).toHaveCount(0)

  // Only rows on screen count: a filter that hides picked rows leaves them out.
  await pick(page, 'Pods', DEMO.pods.checkout[0]!)
  await pick(page, 'Pods', DEMO.pods.cart[0]!)
  await expect(toolbar(page)).toContainText('2 selected')
  await filter(page, 'Pods').fill('checkout')
  await expect(toolbar(page)).toContainText('1 selected')
  await filter(page, 'Pods').fill('')
  await expect(toolbar(page)).toContainText('2 selected')

  // Each list has its own selection; events can't be picked.
  await goTo(page, 'Deployments')
  await expect(toolbar(page)).toHaveCount(0)
  await goTo(page, 'Events')
  await expect(page.getByRole('grid', { name: 'Events' }).getByRole('checkbox')).toHaveCount(0)
})

test('delete several pods at once', async ({ page, clusters }) => {
  await goTo(page, 'Pods')
  await filter(page, 'Pods').fill('checkout')
  await page.getByRole('checkbox', { name: 'Select all rows on this page' }).click()
  await expect(toolbar(page)).toContainText('3 selected')
  await toolbar(page).getByRole('button', { name: 'Delete' }).click()

  const confirm = dialog(page)
  await expect(confirm).toContainText('Delete 3 pods?')
  const list = confirm.getByRole('list', { name: 'Selected pods' })
  for (const pod of DEMO.pods.checkout) await expect(list).toContainText(pod)
  for (const pod of DEMO.pods.checkout) await expect(confirm).toContainText(`pod/${pod}`)
  await expect(confirm).toContainText('-n shop --context demo')
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()

  await expect(toasts(page)).toContainText('Deleted 3 pods')
  await expect(confirm).toHaveCount(0)
  await expect(toolbar(page)).toHaveCount(0)
  expect(writes(clusters.demo, 'DELETE', /\/namespaces\/shop\/pods\/checkout-/)).toHaveLength(3)
  // The activity log has each one.
  await page.getByRole('button', { name: 'Activity' }).click()
  for (const pod of DEMO.pods.checkout) {
    await expect(page.getByRole('dialog', { name: 'Activity' })).toContainText(`Deleted pod ${pod}`)
  }
})

test('restart what can be restarted, and say what was left out', async ({ page, clusters }) => {
  // A pod without a controller wouldn't come back, so restarting leaves it out.
  await goTo(page, 'Pods')
  await pick(page, 'Pods', DEMO.pods.debugShell)
  await pick(page, 'Pods', DEMO.pods.cart[0]!)
  await toolbar(page).getByRole('button', { name: 'Restart' }).click()
  await expect(dialog(page)).toContainText('Restart 1 pod?')
  await expect(dialog(page)).toContainText(
    'Left out: 1 of the selected, which restart doesn’t apply to.',
  )
  await expect(dialog(page)).toContainText(
    `kubectl delete pod/${DEMO.pods.cart[0]} -n shop --context demo`,
  )
  // Restarting a pod deletes it, so its ReplicaSet makes a new one.
  await dialog(page).getByRole('button', { name: 'Restart', exact: true }).click()
  await expect(toasts(page)).toContainText('Restarted 1 pod')
  expect(
    writes(clusters.demo, 'DELETE', `/api/v1/namespaces/shop/pods/${DEMO.pods.cart[0]}`),
  ).toHaveLength(1)

  await goTo(page, 'Deployments')
  await pick(page, 'Deployments', DEMO.deployments.storefront)
  await pick(page, 'Deployments', DEMO.deployments.cart)
  await toolbar(page).getByRole('button', { name: 'Restart' }).click()
  const confirm = dialog(page)
  await expect(confirm).toContainText('Restart 2 deployments?')
  await expect(confirm).toContainText('kubectl rollout restart deployment/')
  await confirm.getByRole('button', { name: 'Restart', exact: true }).click()
  await expect(toasts(page)).toContainText('Restarted 2 deployments')
  for (const name of [DEMO.deployments.storefront, DEMO.deployments.cart]) {
    const [patch] = writes(
      clusters.demo,
      'PATCH',
      `/apis/apps/v1/namespaces/shop/deployments/${name}`,
    )
    expect(patch!.body.spec.template.metadata.annotations).toHaveProperty([
      'kubectl.kubernetes.io/restartedAt',
    ])
  }

  // Kinds with CamelCase names keep them.
  await goTo(page, 'StatefulSets')
  await pick(page, 'StatefulSets', DEMO.statefulSets.postgres)
  await pick(page, 'StatefulSets', DEMO.statefulSets.redis)
  await toolbar(page).getByRole('button', { name: 'Restart' }).click()
  await expect(dialog(page)).toContainText('Restart 2 StatefulSets?')
  await page.keyboard.press('Escape')
})

test('cordon nodes together; deleting them asks to type it', async ({ page, clusters }) => {
  await goTo(page, 'Nodes')
  await pick(page, 'Nodes', DEMO.nodes.worker1)
  await pick(page, 'Nodes', DEMO.nodes.worker2)
  await pick(page, 'Nodes', DEMO.nodes.worker3)
  // worker-3 is already cordoned: it can be uncordoned instead.
  await expect(toolbar(page).getByRole('button')).toHaveText(['Cordon', 'Uncordon', 'Delete', ''])
  await toolbar(page).getByRole('button', { name: 'Cordon', exact: true }).click()
  const confirm = dialog(page)
  await expect(confirm).toContainText('Cordon 2 nodes?')
  // In the list's order: worker-2 is under pressure, so it sorts first.
  await expect(confirm).toContainText('kubectl cordon worker-2 worker-1 --context demo')
  await confirm.getByRole('button', { name: 'Cordon', exact: true }).click()
  await expect(toasts(page)).toContainText('Cordoned 2 nodes')
  expect(clusters.demo.object('Node', undefined, DEMO.nodes.worker1)!.spec.unschedulable).toBe(true)

  await pick(page, 'Nodes', DEMO.nodes.worker1)
  await toolbar(page).getByRole('button', { name: 'Uncordon' }).click()
  await expect(dialog(page)).toContainText('Uncordon 1 node?')
  await expect(dialog(page)).toContainText('kubectl uncordon worker-1 --context demo')
  await dialog(page).getByRole('button', { name: 'Uncordon', exact: true }).click()
  await expect(toasts(page)).toContainText('Uncordoned 1 node')

  // Nodes are hard to get back: deleting them needs the words typed.
  await pick(page, 'Nodes', DEMO.nodes.worker2)
  await toolbar(page).getByRole('button', { name: 'Delete' }).click()
  const remove = dialog(page)
  await expect(remove).toContainText('Delete 1 node?')
  const del = remove.getByRole('button', { name: 'Delete', exact: true })
  await expect(del).toBeDisabled()
  await remove.getByRole('textbox').fill('delete nodes')
  await expect(del).toBeEnabled()
  await remove.getByRole('button', { name: 'Cancel' }).click()
})

test('suspend and resume CronJobs in bulk', async ({ page, clusters }) => {
  await goTo(page, 'CronJobs')
  await pick(page, 'CronJobs', DEMO.cronJobs.nightlyReport)
  await pick(page, 'CronJobs', DEMO.cronJobs.cleanup)
  await toolbar(page).getByRole('button', { name: 'Suspend' }).click()
  await expect(dialog(page)).toContainText('Suspend 1 CronJob?')
  await expect(dialog(page)).toContainText(
    `kubectl patch cronjob/${DEMO.cronJobs.nightlyReport} --type=merge -p '{"spec":{"suspend":true}}'`,
  )
  await dialog(page).getByRole('button', { name: 'Suspend', exact: true }).click()
  await expect(toasts(page)).toContainText('Suspended 1 CronJob')
  const stored = clusters.demo.object('CronJob', 'batch', DEMO.cronJobs.nightlyReport)
  expect(stored!.spec.suspend).toBe(true)

  await page.getByRole('checkbox', { name: 'Select all rows on this page' }).click()
  await toolbar(page).getByRole('button', { name: 'Resume' }).click()
  await expect(dialog(page)).toContainText('Resume 2 CronJobs?')
  await expect(dialog(page)).toContainText('{"spec":{"suspend":false}}')
  await dialog(page).getByRole('button', { name: 'Resume', exact: true }).click()
  await expect(toasts(page)).toContainText('Resumed 2 CronJobs')
})

test('failures are listed next to each object and can be retried', async ({ page, clusters }) => {
  const [first, second] = DEMO.pods.cart
  const clear = clusters.demo.fail(`/api/v1/namespaces/shop/pods/${second}`, {
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ kind: 'Status', message: 'etcdserver: request timed out' }),
  })
  await goTo(page, 'Pods')
  await filter(page, 'Pods').fill('cart-')
  await pick(page, 'Pods', first!)
  await pick(page, 'Pods', second!)
  await toolbar(page).getByRole('button', { name: 'Delete' }).click()
  const confirm = dialog(page)
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()

  await expect(confirm.getByRole('status')).toHaveText('1 of 2 couldn’t be changed; see why below.')
  const list = confirm.getByRole('list', { name: 'Selected pods' })
  await expect(
    list.getByRole('listitem').filter({ hasText: first! }).getByLabel('Done'),
  ).toBeVisible()
  const failed = list.getByRole('listitem').filter({ hasText: second! })
  await expect(failed.getByLabel('Failed')).toBeVisible()
  await expect(failed).toContainText('etcdserver: request timed out')

  // Retrying only touches what failed.
  clear()
  await confirm.getByRole('button', { name: 'Retry failed' }).click()
  await expect(toasts(page)).toContainText('Deleted 2 pods')
  expect(writes(clusters.demo, 'DELETE', `/api/v1/namespaces/shop/pods/${first}`)).toHaveLength(1)
  await expect(toolbar(page)).toHaveCount(0)
})

test('closing a finished bulk change with failures keeps the selection', async ({
  page,
  clusters,
}) => {
  clusters.demo.deny({ verb: 'delete', resource: 'pods', namespace: 'batch' })
  await goTo(page, 'Pods')
  await pick(page, 'Pods', DEMO.pods.dbMigrate[0]!)
  await toolbar(page).getByRole('button', { name: 'Delete' }).click()
  await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(dialog(page)).toContainText('is forbidden')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(toolbar(page)).toContainText('1 selected')
})

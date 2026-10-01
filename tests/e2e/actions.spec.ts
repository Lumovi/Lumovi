import { dialog, menuAction, open, toasts, writes } from './action-helpers.ts'
import { CONTEXTS, DEMO, expect, goTo, openCluster, panel, row, rows, test } from './fixtures.ts'

const DEPLOYMENT = `/apis/apps/v1/namespaces/shop/deployments/${DEMO.deployments.storefront}`

test.beforeEach(async ({ page }) => {
  await openCluster(page)
})

test('scale a deployment, then undo it', async ({ page, clusters }) => {
  await open(page, 'Deployments', DEMO.deployments.storefront)
  const detail = panel(page, 'Deployment', DEMO.deployments.storefront)
  await detail.getByRole('button', { name: 'Scale' }).click()
  const scale = dialog(page)
  await expect(scale).toContainText('Scale storefront')
  await expect(scale).toContainText('Deployment · shop · demo')
  // The autoscaler would fight a manual change, so the dialog says so.
  await expect(scale).toContainText('The autoscaler storefront keeps storefront between 2 and 10')
  await expect(scale).toContainText('3 pods, unchanged')
  const confirm = scale.getByRole('button', { name: 'Scale', exact: true })
  await expect(confirm).toBeDisabled()

  const replicas = scale.getByLabel('Replicas', { exact: true })
  await expect(replicas).toBeFocused()
  await replicas.press('ArrowUp')
  await expect(scale).toContainText('3 → 4 · 1 pod added')
  await scale.getByRole('button', { name: 'Increase replicas' }).click()
  await expect(scale).toContainText('3 → 5 · 2 pods added')
  await expect(scale).toContainText(
    'kubectl scale deployment/storefront --replicas=5 -n shop --context demo',
  )
  await scale.getByRole('button', { name: 'Decrease replicas' }).click()
  await replicas.press('ArrowDown')
  await replicas.press('ArrowDown')
  await expect(scale).toContainText('3 → 2 · 1 pod removed')
  await scale.getByRole('button', { name: '10' }).click()
  await expect(scale.getByRole('button', { name: '10' })).toHaveAttribute('aria-pressed', 'true')
  // Too many pods to draw: just the numbers.
  await replicas.fill('30')
  await expect(scale).toContainText('3 → 30 · 27 pods added')
  // An emptied field can't be submitted; stepping starts from zero.
  await replicas.fill('')
  await expect(confirm).toBeDisabled()
  await expect(scale.getByRole('button', { name: 'Decrease replicas' })).toBeDisabled()
  await scale.getByRole('button', { name: 'Increase replicas' }).click()
  await expect(replicas).toHaveValue('1')
  await replicas.fill('5')
  await replicas.press('Enter')

  await expect(toasts(page)).toContainText('Scaled storefront to 5 replicas')
  expect(writes(clusters.demo, 'PATCH', DEPLOYMENT).at(-1)).toMatchObject({
    body: { spec: { replicas: 5 } },
    type: 'application/merge-patch+json',
  })
  await expect(row(page, 'Deployments', DEMO.deployments.storefront)).toContainText('5/5')

  await toasts(page).getByRole('button', { name: 'Undo' }).click()
  await expect(toasts(page)).toContainText('Scaled storefront back to 3 replicas')
  expect(writes(clusters.demo, 'PATCH', DEPLOYMENT).at(-1)!.body).toEqual({ spec: { replicas: 3 } })
})

test('scale to zero and back; a cancelled dialog changes nothing', async ({ page, clusters }) => {
  await open(page, 'Deployments', DEMO.deployments.cart)
  const detail = panel(page, 'Deployment', DEMO.deployments.cart)
  await detail.getByRole('button', { name: 'Scale' }).click()
  await expect(dialog(page)).not.toContainText('autoscaler')
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog(page)).toHaveCount(0)

  await detail.getByRole('button', { name: 'Scale' }).click()
  await dialog(page).getByRole('button', { name: '0', exact: true }).click()
  await expect(dialog(page)).toContainText('2 → 0 · 2 pods removed')
  await dialog(page).getByRole('button', { name: 'Scale', exact: true }).click()
  await expect(row(page, 'Deployments', DEMO.deployments.cart)).toContainText('0/0')
  await detail.getByRole('button', { name: 'Scale' }).click()
  await expect(dialog(page)).toContainText('0 pods, unchanged')
  await page.keyboard.press('Escape')
  expect(writes(clusters.demo, 'PATCH', /deployments\/cart$/)).toHaveLength(1)
})

test('restart workloads', async ({ page, clusters }) => {
  await open(page, 'Deployments', DEMO.deployments.storefront)
  await panel(page, 'Deployment', DEMO.deployments.storefront)
    .getByRole('button', { name: 'Restart' })
    .click()
  await expect(dialog(page)).toContainText('replaced a few at a time')
  await dialog(page).getByRole('button', { name: 'Restart', exact: true }).click()
  await expect(toasts(page)).toContainText('Restarted storefront')
  const patch = writes(clusters.demo, 'PATCH', DEPLOYMENT).at(-1)!
  expect(patch.type).toBe('application/strategic-merge-patch+json')
  expect(
    patch.body.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'],
  ).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  // A new rollout replaces every pod.
  await goTo(page, 'Pods')
  await page.getByPlaceholder('Filter pods').fill('storefront')
  await expect(rows(page, 'Pods')).toHaveCount(3)
  await expect(rows(page, 'Pods').filter({ hasText: DEMO.pods.storefront[0]! })).toHaveCount(0)

  // Recreate deployments stop everything first, and say so.
  const recreate = structuredClone(clusters.demo.object('Deployment', 'shop', 'checkout')!)
  recreate.spec.strategy = { type: 'Recreate' }
  clusters.demo.upsert(recreate)
  await open(page, 'Deployments', 'checkout')
  await panel(page, 'Deployment', 'checkout').getByRole('button', { name: 'Restart' }).click()
  await expect(dialog(page)).toContainText('expect downtime')
  await page.keyboard.press('Escape')

  await open(page, 'StatefulSets', DEMO.statefulSets.postgres)
  await panel(page, 'StatefulSet', DEMO.statefulSets.postgres)
    .getByRole('button', { name: 'Restart' })
    .click()
  await expect(dialog(page)).toContainText('from the highest ordinal down')
  await dialog(page).getByRole('button', { name: 'Restart', exact: true }).click()
  await expect(toasts(page)).toContainText('Restarted postgres')

  await open(page, 'DaemonSets', DEMO.daemonSets.nodeExporter)
  await panel(page, 'DaemonSet', DEMO.daemonSets.nodeExporter)
    .getByRole('button', { name: 'Restart' })
    .click()
  await expect(dialog(page)).toContainText('node by node')
  await dialog(page).getByRole('button', { name: 'Restart', exact: true }).click()
  await expect(toasts(page)).toContainText('Restarted node-exporter')
})

test('restart, evict and force-delete pods', async ({ page, clusters }) => {
  const pod = DEMO.pods.storefront[1]!
  await open(page, 'Pods', pod)
  await panel(page, 'Pod', pod).getByRole('button', { name: 'Restart' }).click()
  await expect(dialog(page)).toContainText(
    `its ReplicaSet ${DEMO.replicaSets.storefront} starts a new one`,
  )
  await dialog(page).getByRole('button', { name: 'Restart pod' }).click()
  await expect(toasts(page)).toContainText(`Restarted pod ${pod}`)
  expect(writes(clusters.demo, 'DELETE', `/api/v1/namespaces/shop/pods/${pod}`)).toHaveLength(1)
  // The panel shows that the pod is gone.
  await expect(panel(page, 'Pod', pod).getByRole('alert')).toContainText('Not found')

  // Evictions can be refused by a PodDisruptionBudget.
  const victim = DEMO.pods.storefront[0]!
  const eviction = `/api/v1/namespaces/shop/pods/${victim}/eviction`
  const clear = clusters.demo.fail(eviction, {
    status: 429,
    body: JSON.stringify({
      kind: 'Status',
      message: 'Cannot evict pod as it would violate the pod’s disruption budget.',
    }),
  })
  await open(page, 'Pods', victim)
  await menuAction(page, 'Pod', victim, 'Evict…')
  await expect(dialog(page)).toContainText('Its controller starts a replacement')
  await dialog(page).getByRole('button', { name: 'Evict', exact: true }).click()
  await expect(dialog(page).getByRole('alert')).toContainText('disruption budget')
  clear()
  await dialog(page).getByRole('button', { name: 'Evict', exact: true }).click()
  await expect(toasts(page)).toContainText(`Evicted ${victim}`)
  expect(writes(clusters.demo, 'POST', eviction).at(-1)!.body).toMatchObject({
    apiVersion: 'policy/v1',
    kind: 'Eviction',
    metadata: { name: victim, namespace: 'shop' },
  })

  // Pods without a controller can't be restarted, only deleted or evicted for good.
  await open(page, 'Pods', DEMO.pods.debugShell)
  const shell = panel(page, 'Pod', DEMO.pods.debugShell)
  await expect(shell.getByRole('button', { name: 'Restart' })).toHaveCount(0)
  await menuAction(page, 'Pod', DEMO.pods.debugShell, 'Evict…')
  await expect(dialog(page)).toContainText('nothing will replace it')
  await page.keyboard.press('Escape')
  await menuAction(page, 'Pod', DEMO.pods.debugShell, 'Delete…')
  await expect(dialog(page)).toContainText('It has no controller, so nothing replaces it.')
  await dialog(page).getByRole('checkbox').check()
  await expect(dialog(page)).toContainText('--grace-period=0 --force')
  await dialog(page).getByRole('button', { name: 'Force delete' }).click()
  const deletes = () =>
    writes(clusters.demo, 'DELETE', `/api/v1/namespaces/default/pods/${DEMO.pods.debugShell}`)
  await expect.poll(() => deletes().length).toBe(1)
  expect(deletes()[0]!.body).toMatchObject({ gracePeriodSeconds: 0 })
  // The panel closes on what was deleted.
  await expect(shell).toHaveCount(0)

  // Stuck terminating pods default to a forced delete.
  await open(page, 'Pods', DEMO.pods.stuckTerminating)
  await menuAction(page, 'Pod', DEMO.pods.stuckTerminating, 'Delete…')
  await expect(dialog(page).getByRole('checkbox')).toBeChecked()
  await expect(dialog(page)).toContainText('It has been terminating since it was deleted')
  await dialog(page).getByRole('checkbox').uncheck()
  await expect(dialog(page).getByRole('button', { name: 'Delete', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('run a CronJob now, suspend it and resume it', async ({ page, clusters }) => {
  await open(page, 'CronJobs', DEMO.cronJobs.nightlyReport)
  const cron = panel(page, 'CronJob', DEMO.cronJobs.nightlyReport)
  await cron.getByRole('button', { name: 'Run now' }).click()
  await expect(dialog(page)).toContainText('outside its schedule.')
  const name = (await dialog(page).locator('.font-mono').first().textContent())!
  expect(name).toMatch(/^nightly-report-manual-[a-z0-9]{5}$/)
  await dialog(page).getByRole('button', { name: 'Run now' }).click()
  await expect(toasts(page)).toContainText(`Started job ${name}`)
  expect(
    writes(clusters.demo, 'POST', '/apis/batch/v1/namespaces/batch/jobs')[0]!.body,
  ).toMatchObject({
    metadata: {
      name,
      annotations: { 'cronjob.kubernetes.io/instantiate': 'manual' },
      ownerReferences: [{ kind: 'CronJob', name: DEMO.cronJobs.nightlyReport, controller: true }],
    },
  })
  await toasts(page).getByRole('button', { name: 'Open' }).click()
  const job = panel(page, 'Job', name)
  await expect(job).toBeVisible()
  // The job runs and finishes, like on a real cluster.
  await expect(job).toContainText('Complete', { timeout: 15_000 })
  // A finished job can't be suspended.
  await job.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Suspend' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await open(page, 'CronJobs', DEMO.cronJobs.nightlyReport)
  await menuAction(page, 'CronJob', DEMO.cronJobs.nightlyReport, 'Suspend')
  await expect(toasts(page)).toContainText(`Suspended ${DEMO.cronJobs.nightlyReport}`)
  await toasts(page).getByRole('button', { name: 'Undo' }).last().click()
  await expect(toasts(page)).toContainText(`Resumed ${DEMO.cronJobs.nightlyReport}`)
  const patches = writes(
    clusters.demo,
    'PATCH',
    '/apis/batch/v1/namespaces/batch/cronjobs/nightly-report',
  )
  expect(patches.map((p) => p.body)).toEqual([
    { spec: { suspend: true } },
    { spec: { suspend: false } },
  ])

  // A suspended CronJob offers to resume, and can still be run by hand.
  await open(page, 'CronJobs', DEMO.cronJobs.cleanup)
  const cleanup = panel(page, 'CronJob', DEMO.cronJobs.cleanup)
  await cleanup.getByRole('button', { name: 'Run now' }).click()
  await expect(dialog(page)).toContainText('the schedule itself stays suspended')
  await page.keyboard.press('Escape')
  await cleanup.getByRole('button', { name: 'Resume' }).click()
  await expect(toasts(page)).toContainText(`Resumed ${DEMO.cronJobs.cleanup}`)

  // Running jobs can be suspended too, and suspended ones resumed.
  await open(page, 'Jobs', DEMO.jobs.reindex)
  await menuAction(page, 'Job', DEMO.jobs.reindex, 'Suspend')
  await expect(toasts(page)).toContainText(`Suspended ${DEMO.jobs.reindex}`)
  await goTo(page, 'Jobs')
  await expect(row(page, 'Jobs', 'backfill')).toContainText('0/1—')
  await open(page, 'Jobs', 'backfill')
  await panel(page, 'Job', 'backfill').getByRole('button', { name: 'Resume' }).click()
  await expect(toasts(page)).toContainText('Resumed backfill')
})

test('cordon and uncordon nodes', async ({ page, clusters }) => {
  await open(page, 'Nodes', DEMO.nodes.worker1)
  const node = panel(page, 'Node', DEMO.nodes.worker1)
  await node.getByRole('button', { name: 'Cordon' }).click()
  await expect(toasts(page)).toContainText(`Cordoned ${DEMO.nodes.worker1}`)
  await expect(node.getByRole('button', { name: 'Uncordon' })).toBeVisible()
  await toasts(page).getByRole('button', { name: 'Undo' }).click()
  await expect(toasts(page)).toContainText(`Uncordoned ${DEMO.nodes.worker1}`)
  expect(
    writes(clusters.demo, 'PATCH', `/api/v1/nodes/${DEMO.nodes.worker1}`).map((p) => p.body),
  ).toEqual([{ spec: { unschedulable: true } }, { spec: { unschedulable: null } }])
  await expect(node.getByRole('button', { name: 'Cordon' })).toBeVisible()

  // worker-3 is cordoned already.
  await open(page, 'Nodes', DEMO.nodes.worker3)
  await panel(page, 'Node', DEMO.nodes.worker3).getByRole('button', { name: 'Uncordon' }).click()
  await expect(toasts(page)).toContainText(`Uncordoned ${DEMO.nodes.worker3}`)
})

test('drain a node', async ({ page, clusters }) => {
  // One storefront pod on worker-2 keeps a cache in an emptyDir volume.
  await open(page, 'Nodes', DEMO.nodes.worker2)
  await menuAction(page, 'Node', DEMO.nodes.worker2, 'Drain…')
  await dialog(page)
    .getByRole('checkbox', { name: /Evict pods without a controller/ })
    .check()
  await expect(dialog(page)).toContainText('1 pod needs one of these options')
  await page.keyboard.press('Escape')

  await open(page, 'Nodes', DEMO.nodes.worker1)
  await menuAction(page, 'Node', DEMO.nodes.worker1, 'Drain…')
  const drain = dialog(page)
  const pods = drain.getByRole('list', { name: 'Pods on the node' })
  await expect(pods).toContainText('DaemonSet pod, stays on the node')
  await expect(pods).toContainText('No controller: it won’t come back')
  // Pods without a controller hold the drain until the user allows evicting them.
  await expect(drain).toContainText(/\d+ pods? needs? one of these options/)
  const confirm = drain.getByRole('button', { name: 'Drain', exact: true })
  await expect(confirm).toBeDisabled()
  await drain.getByRole('checkbox', { name: /Evict pods without a controller/ }).check()
  await drain.getByRole('checkbox', { name: /Delete local data/ }).check()
  await expect(drain).toContainText('--delete-emptydir-data --force')
  await expect(drain).not.toContainText('options before the node can be drained')

  // One eviction fails at first, and can be retried.
  const stuck = DEMO.pods.postgres[0]!
  const clear = clusters.demo.fail(`/api/v1/namespaces/data/pods/${stuck}/eviction`, {
    status: 429,
    body: JSON.stringify({
      kind: 'Status',
      message: 'Cannot evict pod as it would violate the pod’s disruption budget.',
    }),
  })
  await confirm.click()
  await expect(drain.getByRole('button', { name: 'Done' })).toBeVisible()
  await expect(drain.getByRole('status')).toContainText('1 pod couldn’t be evicted')
  const failed = pods.getByRole('listitem').filter({ hasText: stuck })
  await expect(failed).toContainText('disruption budget')
  clear()
  await failed.getByRole('button', { name: 'Retry' }).click()
  await expect(failed.getByLabel('Evicted')).toBeVisible()
  await expect(drain.getByRole('status')).toContainText(`Drained ${DEMO.nodes.worker1}:`)
  await drain.getByRole('button', { name: 'Done' }).click()
  expect(writes(clusters.demo, 'PATCH', `/api/v1/nodes/${DEMO.nodes.worker1}`)[0]!.body).toEqual({
    spec: { unschedulable: true },
  })
  // DaemonSet pods stay.
  expect(writes(clusters.demo, 'POST', /\/pods\/node-exporter-[^/]+\/eviction$/)).toHaveLength(0)

  // Cordoned nodes aren't cordoned again; a clean drain says so.
  await open(page, 'Nodes', DEMO.nodes.worker3)
  await menuAction(page, 'Node', DEMO.nodes.worker3, 'Drain…')
  await dialog(page).getByRole('button', { name: 'Drain', exact: true }).click()
  await expect(dialog(page).getByRole('status')).toContainText(`Drained ${DEMO.nodes.worker3}`)
  expect(writes(clusters.demo, 'PATCH', `/api/v1/nodes/${DEMO.nodes.worker3}`)).toHaveLength(0)
  await dialog(page).getByRole('button', { name: 'Done' }).click()

  // Static pods stay with their node.
  await open(page, 'Nodes', DEMO.nodes.controlPlane)
  await menuAction(page, 'Node', DEMO.nodes.controlPlane, 'Drain…')
  await expect(dialog(page)).toContainText('Static pod, managed by the kubelet')
  await page.keyboard.press('Escape')

  // A drain that can't even cordon the node stops there.
  await open(page, 'Nodes', DEMO.nodes.worker2)
  await menuAction(page, 'Node', DEMO.nodes.worker2, 'Drain…')
  await dialog(page)
    .getByRole('checkbox', { name: /Evict pods without a controller/ })
    .check()
  await dialog(page)
    .getByRole('checkbox', { name: /Delete local data/ })
    .check()
  clusters.demo.fail(`/api/v1/nodes/${DEMO.nodes.worker2}`, {
    status: 500,
    body: 'etcdserver: request timed out',
  })
  await dialog(page).getByRole('button', { name: 'Drain', exact: true }).click()
  await expect(dialog(page).getByRole('alert')).toContainText('HTTP 500')
  await expect(dialog(page).getByRole('button', { name: 'Drain', exact: true })).toBeEnabled()
})

test('draining an empty node', async ({ page }) => {
  await page.getByRole('button', { name: 'Switch cluster' }).click()
  await page.getByRole('option', { name: new RegExp(`^${CONTEXTS.sandbox}`) }).click()
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toContainText(CONTEXTS.sandbox)
  await open(page, 'Nodes', 'sandbox-node')
  await menuAction(page, 'Node', 'sandbox-node', 'Drain…')
  await expect(dialog(page)).toContainText('No pods run on sandbox-node.')
  await expect(dialog(page)).toContainText('0 pods to evict, 0 staying')
})

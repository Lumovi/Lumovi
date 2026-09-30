import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { dialog, menuAction, open, toasts, writes, focusDisabled } from './action-helpers.ts'
import {
  CONTEXTS,
  DEMO,
  DEMO_TOKEN,
  expect,
  goTo,
  openCluster,
  panel,
  row,
  test,
} from './fixtures.ts'

test.describe('deleting', () => {
  test.beforeEach(async ({ page }) => {
    await openCluster(page)
  })

  test('deletes a deployment and what it owns, the way the user picks', async ({
    page,
    clusters,
  }) => {
    await open(page, 'Deployments', DEMO.deployments.cart)
    await menuAction(page, 'Deployment', DEMO.deployments.cart, 'Delete…')
    const remove = dialog(page)
    await expect(remove).toContainText('What happens to what it owns')
    // Destructive dialogs start on Cancel.
    await expect(remove.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await remove.getByRole('radio', { name: /Keep what it owns/ }).check()
    await expect(remove).toContainText('--cascade=orphan')
    await remove.getByRole('radio', { name: /Delete what it owns first/ }).check()
    await expect(remove).toContainText(
      'kubectl delete deployment/cart --cascade=foreground -n shop --context demo',
    )
    await remove.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(toasts(page)).toContainText('Deleted deployment cart')
    expect(
      writes(clusters.demo, 'DELETE', '/apis/apps/v1/namespaces/shop/deployments/cart')[0]!.body,
    ).toMatchObject({
      propagationPolicy: 'Foreground',
    })
    await expect(panel(page, 'Deployment', DEMO.deployments.cart)).toHaveCount(0)
    await expect(row(page, 'Deployments', DEMO.deployments.cart)).toHaveCount(0)
  })

  test('pods say what replaces them; rows can be deleted without opening them', async ({
    page,
    clusters,
  }) => {
    const pod = DEMO.pods.storefront[2]!
    await open(page, 'Pods', pod)
    await menuAction(page, 'Pod', pod, 'Delete…')
    await expect(dialog(page)).toContainText(
      `Its ReplicaSet ${DEMO.replicaSets.storefront} will start a new pod to replace it.`,
    )
    await page.keyboard.press('Escape')

    await goTo(page, 'Services')
    await row(page, 'Services', DEMO.services.legacyGateway).first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Delete…' }).click()
    await dialog(page).getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(toasts(page)).toContainText(`Deleted service ${DEMO.services.legacyGateway}`)
    expect(
      writes(
        clusters.demo,
        'DELETE',
        `/api/v1/namespaces/shop/services/${DEMO.services.legacyGateway}`,
      ),
    ).toHaveLength(1)
    await expect(page).not.toHaveURL(/open=/)
  })

  test('asks for the name before deleting what is hard to get back', async ({ page, clusters }) => {
    await open(page, 'Namespaces', 'legacy')
    await menuAction(page, 'Namespace', 'legacy', 'Delete…')
    const remove = dialog(page)
    await expect(remove).toContainText('Everything in legacy is deleted with it.')
    const confirm = remove.getByLabel('Type legacy to confirm')
    await expect(confirm).toBeFocused()
    await expect(remove.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled()
    // Enter does nothing until the name is typed.
    await confirm.press('Enter')
    await expect(remove).toBeVisible()
    await confirm.fill('legac')
    await expect(remove.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled()
    await confirm.fill('legacy')
    await confirm.press('Enter')
    await expect(toasts(page)).toContainText('Deleted namespace legacy')
    expect(writes(clusters.demo, 'DELETE', '/api/v1/namespaces/legacy')).toHaveLength(1)

    // Nodes and volumes say what deleting them means.
    for (const [label, kind, name, note] of [
      ['Nodes', 'Node', DEMO.nodes.worker3, 'The node leaves the cluster.'],
      ['Volume Claims', 'PersistentVolumeClaim', 'data-redis-0', 'depending on the reclaim policy'],
      ['Volumes', 'PersistentVolume', 'pv-spare', 'Its reclaim policy is'],
    ] as const) {
      await open(page, label, name)
      await menuAction(page, kind, name, 'Delete…')
      await expect(dialog(page)).toContainText(note)
      await expect(dialog(page).getByLabel(`Type ${name} to confirm`)).toBeVisible()
      await dialog(page).getByRole('button', { name: 'Cancel' }).click()
    }
    // Most kinds need no typing.
    await open(page, 'Services', DEMO.services.grafana)
    await menuAction(page, 'Service', DEMO.services.grafana, 'Delete…')
    await expect(dialog(page).getByRole('textbox')).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  test('⌘⌫ deletes the open object', async ({ page }) => {
    await open(page, 'Services', DEMO.services.grafana)
    await expect(
      panel(page, 'Service', DEMO.services.grafana).getByRole('button', { name: 'More actions' }),
    ).toBeVisible()
    await page.keyboard.press('ControlOrMeta+Backspace')
    await expect(dialog(page)).toContainText(`Delete ${DEMO.services.grafana}?`)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+Backspace')
    await expect(dialog(page)).toContainText(`Delete ${DEMO.services.grafana}?`)
    // An unready dialog ignores Enter.
    await page.keyboard.press('Escape')
    // Other keys, and typing in fields, do nothing.
    await page.keyboard.press('Backspace')
    await page.keyboard.press('ControlOrMeta+j')
    await page.getByPlaceholder('Filter services').focus()
    await page.keyboard.press('ControlOrMeta+Backspace')
    await page.keyboard.press('.')
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.getByRole('menu')).toHaveCount(0)
  })
})

test.describe('permissions', () => {
  test('actions the account may not do are disabled, with the reason', async ({
    page,
    clusters,
  }) => {
    clusters.demo.deny({ verb: 'delete', resource: 'pods', namespace: 'shop' })
    clusters.demo.deny({ verb: 'patch', resource: 'nodes' })
    clusters.demo.deny({ verb: 'create', resource: 'pods', subresource: 'eviction' })
    await openCluster(page)
    const pod = DEMO.pods.storefront[0]!
    await open(page, 'Pods', pod)
    const restart = panel(page, 'Pod', pod).getByRole('button', { name: 'Restart' })
    await expect(restart).toBeDisabled()
    await focusDisabled(restart)
    await expect(page.getByRole('tooltip')).toContainText('Your account can’t delete pods in shop.')
    await panel(page, 'Pod', pod).getByRole('button', { name: 'More actions' }).click()
    await expect(page.getByRole('menuitem', { name: 'Delete…' })).toBeDisabled()
    await expect(page.getByRole('menuitem', { name: 'Evict…' })).toBeDisabled()
    await expect(page.getByRole('menu')).toContainText('Your account can’t delete pods in shop.')
    await page.keyboard.press('Escape')
    // Denied deletes can't be started from the keyboard either.
    await page.keyboard.press('ControlOrMeta+Backspace')
    await expect(dialog(page)).toHaveCount(0)

    await open(page, 'Nodes', DEMO.nodes.worker1)
    await focusDisabled(
      panel(page, 'Node', DEMO.nodes.worker1).getByRole('button', { name: 'Cordon' }),
    )
    await expect(page.getByRole('tooltip')).toContainText('Your account can’t change nodes.')
    // …and the API server has the last word on anything the checks allowed.
    await open(page, 'Pods', DEMO.pods.coredns[0]!)
    await panel(page, 'Pod', DEMO.pods.coredns[0]!)
      .getByRole('button', { name: 'More actions' })
      .click()
    await expect(page.getByRole('menuitem', { name: 'Evict…' })).toBeDisabled()
    await expect(page.getByRole('menu')).not.toContainText('Your account can’t delete')
  })
})

test('each denied action says what the account can’t do', async ({ page, clusters }) => {
  clusters.demo.deny({ verb: 'update', resource: 'deployments', namespace: 'kube-system' })
  clusters.demo.deny({ verb: 'create', resource: 'jobs', namespace: 'batch' })
  clusters.demo.deny({
    verb: 'create',
    resource: 'pods',
    subresource: 'portforward',
    namespace: 'data',
  })
  clusters.demo.deny({
    verb: 'patch',
    resource: 'pods',
    subresource: 'ephemeralcontainers',
    namespace: 'monitoring',
  })
  await openCluster(page)

  await open(page, 'Deployments', 'coredns')
  const coredns = panel(page, 'Deployment', 'coredns')
  await coredns.getByRole('tab', { name: 'YAML' }).click()
  await focusDisabled(coredns.getByRole('button', { name: 'Edit', exact: true }))
  await expect(page.getByRole('tooltip')).toContainText(
    'Your account can’t edit deployments in kube-system.',
  )

  await open(page, 'CronJobs', DEMO.cronJobs.nightlyReport)
  await focusDisabled(
    panel(page, 'CronJob', DEMO.cronJobs.nightlyReport).getByRole('button', { name: 'Run now' }),
  )
  await expect(page.getByRole('tooltip')).toContainText('Your account can’t create jobs in batch.')

  await open(page, 'Pods', DEMO.pods.postgres[0]!)
  await panel(page, 'Pod', DEMO.pods.postgres[0]!)
    .getByRole('button', { name: 'More actions' })
    .click()
  await expect(page.getByRole('menu')).toContainText(
    'Your account can’t forward ports to pods in data.',
  )
  await page.keyboard.press('Escape')

  await open(page, 'Pods', DEMO.pods.grafana[0]!)
  await panel(page, 'Pod', DEMO.pods.grafana[0]!)
    .getByRole('button', { name: 'More actions' })
    .click()
  await expect(page.getByRole('menu')).toContainText('Your account can’t debug pods in monitoring.')
})

test.describe('read-only clusters', () => {
  test('changes can be turned off per cluster', async ({ page }) => {
    await openCluster(page)
    await open(page, 'Deployments', DEMO.deployments.storefront)
    const detail = panel(page, 'Deployment', DEMO.deployments.storefront)
    await page.getByRole('button', { name: 'Switch cluster' }).click()
    await expect(page.getByText('KubeStacks won’t change demo')).toBeVisible()
    await page.getByRole('switch', { name: 'Read-only' }).click()
    await page.keyboard.press('Escape')
    await expect(
      page.getByRole('button', { name: 'Switch cluster' }).getByLabel('Read-only'),
    ).toBeVisible()
    await expect(detail.getByRole('button', { name: 'Scale' })).toBeDisabled()
    await detail.getByRole('button', { name: 'More actions' }).click()
    await expect(page.getByRole('menu')).toContainText('Changes are turned off for this cluster.')
    await page.keyboard.press('Escape')
    await detail.getByRole('tab', { name: 'YAML' }).click()
    await focusDisabled(detail.getByRole('button', { name: 'Edit', exact: true }))
    await expect(page.getByRole('tooltip')).toContainText(
      'Changes are turned off for this cluster.',
    )
    await detail.getByRole('tab', { name: 'Overview' }).click()

    // The main process refuses too, whatever the page asks for.
    const refused = await page.evaluate(() =>
      window.kubestacks.kube.change({
        context: 'demo',
        kind: 'Deployment',
        namespace: 'shop',
        name: 'storefront',
        change: { action: 'patch', patchType: 'merge', patch: { spec: { replicas: 0 } } },
      }),
    )
    expect(refused).toMatchObject({ ok: false, error: { code: 'read-only' } })

    // It's remembered.
    await page.reload()
    await detail.getByRole('button', { name: 'Read-only' }).click()
    await expect(page.getByRole('dialog')).toContainText(
      'KubeStacks won’t change anything in this cluster until you allow it.',
    )
    await page.getByRole('button', { name: 'Allow changes' }).click()
    await expect(detail.getByRole('button', { name: 'Scale' })).toBeEnabled()

    // The palette toggles it too.
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByRole('option', { name: 'Make demo read-only' }).click()
    await expect(detail.getByRole('button', { name: 'Read-only' })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByRole('option', { name: 'Allow changes to demo' }).click()
    await expect(detail.getByRole('button', { name: 'Read-only' })).toHaveCount(0)
  })

  test('KUBESTACKS_READ_ONLY turns changes off everywhere', async ({ launch }) => {
    const { page } = await launch({ env: { KUBESTACKS_READ_ONLY: '1' } })
    await openCluster(page)
    await open(page, 'Deployments', DEMO.deployments.storefront)
    const detail = panel(page, 'Deployment', DEMO.deployments.storefront)
    await detail.getByRole('button', { name: 'Read-only' }).click()
    await expect(page.getByRole('dialog')).toContainText('KUBESTACKS_READ_ONLY is set')
    await expect(page.getByRole('button', { name: 'Allow changes' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Switch cluster' }).click()
    await expect(page.getByRole('switch', { name: 'Read-only' })).toBeDisabled()
    await expect(page.getByText('Set by KUBESTACKS_READ_ONLY')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByPlaceholder(/Jump to/).fill('read-only')
    await expect(page.getByRole('option', { name: /read-only/ })).toHaveCount(0)
  })
})

test('production-looking clusters ask for the name before risky changes', async ({
  launch,
  clusters,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'kubestacks-prod-'))
  const kubeconfig = writeKubeconfig(dir, {
    clusters: [{ name: 'demo', server: clusters.demo.url, caPem: clusters.demo.caPem }],
    users: [{ name: 'u', token: DEMO_TOKEN }],
    contexts: [{ name: 'shop-prod', cluster: 'demo', user: 'u' }],
  })
  const { page } = await launch({ env: { KUBECONFIG: kubeconfig } })
  await openCluster(page, 'shop-prod')
  await open(page, 'Services', DEMO.services.grafana)
  await menuAction(page, 'Service', DEMO.services.grafana, 'Delete…')
  await expect(dialog(page)).toContainText('Production')
  await expect(dialog(page).getByLabel(`Type ${DEMO.services.grafana} to confirm`)).toBeFocused()
  await page.keyboard.press('Escape')
  await open(page, 'Nodes', DEMO.nodes.worker2)
  await menuAction(page, 'Node', DEMO.nodes.worker2, 'Drain…')
  await expect(dialog(page).getByLabel(`Type ${DEMO.nodes.worker2} to confirm`)).toBeVisible()
})

test.describe('activity and feedback', () => {
  test.beforeEach(async ({ page }) => {
    await openCluster(page)
  })

  test('the activity log lists every change with its command', async ({ page, clusters }) => {
    const activity = page.getByRole('button', { name: 'Activity' })
    await activity.click()
    await expect(page.getByRole('dialog', { name: 'Activity' })).toContainText(
      'Changes you make from KubeStacks show up here',
    )
    await page.keyboard.press('Escape')

    await open(page, 'Nodes', DEMO.nodes.worker1)
    await panel(page, 'Node', DEMO.nodes.worker1).getByRole('button', { name: 'Cordon' }).click()
    // A failed change is logged with its reason.
    clusters.demo.fail(`/api/v1/namespaces/shop/pods/${DEMO.pods.cart[0]}/eviction`, {
      status: 429,
      body: JSON.stringify({
        kind: 'Status',
        message: 'Cannot evict pod as it would violate the pod’s disruption budget.',
      }),
    })
    await open(page, 'Pods', DEMO.pods.cart[0]!)
    await menuAction(page, 'Pod', DEMO.pods.cart[0]!, 'Evict…')
    await dialog(page).getByRole('button', { name: 'Evict', exact: true }).click()
    await expect(dialog(page).getByRole('alert')).toBeVisible()
    await page.keyboard.press('Escape')

    await expect(activity.getByLabel('2 new')).toBeVisible()
    await activity.click()
    const log = page.getByRole('dialog', { name: 'Activity' })
    await expect(log.getByRole('listitem')).toHaveCount(2)
    await expect(log.getByRole('listitem').first()).toContainText('disruption budget')
    await expect(log.getByRole('listitem').first().getByLabel('Failed')).toBeVisible()
    await expect(log.getByRole('listitem').last()).toContainText(
      `kubectl cordon ${DEMO.nodes.worker1} --context demo`,
    )
    // Entries open what they changed, from anywhere.
    await log.getByRole('button', { name: `Cordoned ${DEMO.nodes.worker1}` }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
    await expect(panel(page, 'Node', DEMO.nodes.worker1)).toBeVisible()
    await expect(activity.getByLabel(/new/)).toHaveCount(0)
    // …and when already on the right list.
    await activity.click()
    await log.getByRole('button', { name: `Cordoned ${DEMO.nodes.worker1}` }).click()
    await expect(panel(page, 'Node', DEMO.nodes.worker1)).toBeVisible()

    // In another cluster, entries name their cluster and can't be opened.
    await page.getByRole('button', { name: 'Switch cluster' }).click()
    await page.getByRole('option', { name: /^sandbox/ }).click()
    await expect(page.getByRole('button', { name: 'Switch cluster' })).toContainText('sandbox')
    await activity.click()
    await expect(log.getByRole('listitem').last()).toContainText('· demo')
    await expect(log.getByRole('button', { name: `Cordoned ${DEMO.nodes.worker1}` })).toHaveCount(0)
    await log.getByRole('button', { name: 'Clear' }).click()
    await expect(log).toContainText('Changes you make from KubeStacks show up here')
  })

  test('toasts pause on hover, can be dismissed, and report failures', async ({
    page,
    clusters,
  }) => {
    await open(page, 'Nodes', DEMO.nodes.worker1)
    const node = panel(page, 'Node', DEMO.nodes.worker1)
    await node.getByRole('button', { name: 'Cordon' }).click()
    const done = toasts(page).getByRole('status')
    await done.hover()
    await page.waitForTimeout(6_500)
    await expect(done).toBeVisible()
    await page.mouse.move(0, 0)
    await done.getByRole('button', { name: 'Dismiss' }).click()
    await expect(done).toHaveCount(0)

    // Undo can fail too.
    await node.getByRole('button', { name: 'Uncordon' }).click()
    // Only once the uncordon went through.
    await expect(toasts(page).getByRole('button', { name: 'Undo' })).toBeVisible()
    const clear = clusters.demo.fail(`/api/v1/nodes/${DEMO.nodes.worker1}`, {
      status: 500,
      body: 'boom',
    })
    await toasts(page).getByRole('button', { name: 'Undo' }).click()
    await expect(toasts(page).getByRole('alert')).toContainText('Couldn’t undo')
    // So can instant actions.
    await node.getByRole('button', { name: /^(Cordon|Uncordon)$/ }).click()
    await expect(toasts(page).getByRole('alert').last()).toContainText(`Couldn’t`)
    clear()
    // Errors stay longer, then go.
    await expect(toasts(page).getByRole('alert')).toHaveCount(0, { timeout: 15_000 })
  })

  test('actions are in the palette, the row menu and on the keyboard', async ({ page }) => {
    await open(page, 'Deployments', DEMO.deployments.storefront)
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByPlaceholder(/Jump to/).fill('scale')
    await page
      .getByRole('group', { name: 'Actions' })
      .getByRole('option', { name: /^Scale/ })
      .click()
    await expect(dialog(page)).toContainText('Scale storefront')
    // The dialog keeps focus rather than handing it back to the palette's opener.
    await expect(dialog(page).getByLabel('Replicas', { exact: true })).toBeFocused()
    await page.keyboard.press('Escape')

    // `.` opens the actions menu; Escape closes just the menu.
    await page.keyboard.press('.')
    await expect(page.getByRole('menu')).toContainText('Roll back…')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(panel(page, 'Deployment', DEMO.deployments.storefront)).toBeVisible()

    await row(page, 'Deployments', DEMO.deployments.storefront).first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Restart' }).click()
    await expect(dialog(page)).toContainText('Restart storefront?')
    await page.keyboard.press('Escape')

    // Read-only clusters show their actions disabled in the palette.
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByRole('option', { name: 'Make demo read-only' }).click()
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByPlaceholder(/Jump to/).fill('scale')
    await expect(
      page.getByRole('group', { name: 'Actions' }).getByRole('option', { name: /^Scale/ }),
    ).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')

    // Events have no actions; missing objects neither.
    await open(page, 'Events', 'NamespaceFinalizersRemaining')
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByRole('group', { name: 'Actions' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      window.location.hash = '#/cluster/demo/services?open=Service%2Fshop%2Fnope'
    })
    await expect(panel(page, 'Service', 'nope').getByRole('alert')).toBeVisible()
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByRole('group', { name: 'Actions' })).toHaveCount(0)
  })
})

test('contexts other than the demo aren’t affected by its read-only switch', async ({ page }) => {
  await openCluster(page, CONTEXTS.sandbox)
  await goTo(page, 'Namespaces')
  await row(page, 'Namespaces', 'default').first().getByRole('gridcell').nth(1).click()
  await expect(
    panel(page, 'Namespace', 'default').getByRole('button', { name: 'Read-only' }),
  ).toHaveCount(0)
})

/**
 * A node's taints without YAML: staged, applied as one patch that touches only what changed (each
 * taint removed checked first), said, in the audit log, and undone; one changed meanwhile refused
 * and shown as it is, one added meanwhile kept; a NoExecute taint said first with the pods it
 * evicts. And a drain with kubectl's options, waiting on the PodDisruptionBudgets that hold its
 * pods, saying which and why, until its timeout.
 */
import type { Page } from '@playwright/test'
import { holds } from '../holds.ts'
import type { KubeObject } from '../mock-cluster/types.ts'
import { dialog, menuAction, open, toasts, writes } from './action-helpers.ts'
import { CONTEXTS, DEMO, expect, openCluster, test } from './fixtures.ts'

test.beforeEach(async ({ page }) => {
  await openCluster(page)
})

const NODE = DEMO.nodes.worker1
const DEDICATED = { key: 'dedicated', value: 'shop', effect: 'PreferNoSchedule' }

/** The node as the cluster has it now. */
const nodeNow = (page: Page, name: string = NODE): Promise<KubeObject> =>
  page.evaluate(
    async ([context, name]) => {
      const read = await window.lumovi!.kube.get({ context: context!, kind: 'Node', name: name! })
      if (!read.ok) throw new Error(read.error.message)
      return read.data
    },
    [CONTEXTS.demo, name],
  ) as Promise<KubeObject>
const taintsNow = async (page: Page, name: string = NODE) =>
  (await nodeNow(page, name)).spec?.taints

async function openTaints(page: Page, name: string = NODE) {
  await open(page, 'Nodes', name)
  await menuAction(page, 'Node', name, 'Taints…')
  return dialog(page)
}

test('a node’s taints change without YAML: staged, applied as one, said, in the audit log, and undone', async ({
  page,
  clusters,
}) => {
  const taints = await openTaints(page)
  await expect(taints).toContainText(`Taints on ${NODE}`)
  const list = taints.getByRole('list', { name: 'Taints' })
  await expect(list).toContainText('dedicated=shop')
  const apply = taints.getByRole('button', { name: 'Apply', exact: true })
  // Nothing staged: nothing to apply.
  await expect(apply).toBeDisabled()

  // A key that can't be one says why; one that can is added.
  const key = taints.getByLabel('Key')
  await key.fill('dedicated gpu')
  await expect(taints).toContainText(
    'A key is letters, digits, “-”, “_” and “.”, with an optional prefix and “/”: no spaces.',
  )
  await expect(taints.getByRole('button', { name: 'Add' })).toBeDisabled()
  await key.fill('gpu')
  await taints.getByLabel('Value').fill('yes')
  await taints.getByRole('button', { name: 'Add' }).click()
  await taints.getByRole('button', { name: 'Remove dedicated=shop:PreferNoSchedule' }).click()
  await expect(list.getByRole('listitem').filter({ hasText: 'gpu=yes' })).toContainText('New')
  await expect(list.getByRole('listitem').filter({ hasText: 'dedicated=shop' })).toContainText(
    'Removed',
  )
  // The command: a line a change.
  await expect(taints).toContainText(
    `kubectl taint nodes ${NODE} dedicated=shop:PreferNoSchedule- --context demo`,
  )
  await expect(taints).toContainText(
    `kubectl taint nodes ${NODE} gpu=yes:NoSchedule --context demo`,
  )
  // Kept after all: staged no more, then struck again.
  await taints.getByRole('button', { name: 'Keep dedicated=shop:PreferNoSchedule' }).click()
  await expect(list).not.toContainText('Removed')
  await taints.getByRole('button', { name: 'Remove dedicated=shop:PreferNoSchedule' }).click()

  await apply.click()
  const said = `Changed ${NODE}’s taints: gpu=yes:NoSchedule added, dedicated=shop:PreferNoSchedule removed`
  await expect(toasts(page)).toContainText(said)
  // One patch, touching only those: the one removed checked first, where it was read.
  expect(writes(clusters.demo, 'PATCH', `/api/v1/nodes/${NODE}`).at(-1)).toEqual({
    body: [
      { op: 'test', path: '/spec/taints/0', value: DEDICATED },
      { op: 'remove', path: '/spec/taints/0' },
      {
        op: 'add',
        path: '/spec/taints/-',
        value: { key: 'gpu', value: 'yes', effect: 'NoSchedule' },
      },
    ],
    query: {},
    type: 'application/json-patch+json',
  })
  expect(await taintsNow(page)).toEqual([{ key: 'gpu', value: 'yes', effect: 'NoSchedule' }])
  // In the audit log as it went, with what kubectl would run.
  const { events } = await page.evaluate(() =>
    window.lumovi!.audit.query({ actions: ['resource.patch'], limit: 1 }),
  )
  expect(events[0]).toMatchObject({
    outcome: 'success',
    summary: `Changed Node ${NODE}’s taints: gpu=yes:NoSchedule added, dedicated=shop:PreferNoSchedule removed`,
    command: `kubectl taint nodes ${NODE} dedicated=shop:PreferNoSchedule- --context demo\nkubectl taint nodes ${NODE} gpu=yes:NoSchedule --context demo`,
  })

  // Undone: as they were.
  await toasts(page).getByRole('button', { name: 'Undo' }).click()
  await expect(toasts(page)).toContainText(
    `Changed ${NODE}’s taints: dedicated=shop:PreferNoSchedule added, gpu=yes:NoSchedule removed`,
  )
  expect(await taintsNow(page)).toEqual([DEDICATED])

  // One alone, said as itself; a new value for a key and effect it has replaces it.
  const again = await openTaints(page)
  await again.getByLabel('Key').fill('dedicated')
  await again.getByLabel('Value').fill('batch')
  await again
    .getByRole('group', { name: 'Effect' })
    .getByRole('button', { name: 'PreferNoSchedule' })
    .click()
  await expect(again).toContainText(
    'Replaces dedicated=shop:PreferNoSchedule: a node has one taint per key and effect.',
  )
  await again.getByRole('button', { name: 'Add' }).click()
  await expect(again).toContainText(
    `kubectl taint nodes ${NODE} dedicated=batch:PreferNoSchedule --overwrite --context demo`,
  )
  await again.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(toasts(page)).toContainText(
    `Changed ${NODE}’s taints: dedicated=batch:PreferNoSchedule added, dedicated=shop:PreferNoSchedule removed`,
  )
  expect(await taintsNow(page)).toEqual([
    { key: 'dedicated', value: 'batch', effect: 'PreferNoSchedule' },
  ])

  // A patch the dialog doesn't make isn't said as one it does: its own words, or the plain ones.
  const patched = (patch: Record<string, unknown>[]) =>
    page.evaluate(
      async ([context, name, patch]) => {
        await window.lumovi!.kube.change({
          context,
          kind: 'Node',
          name,
          change: { action: 'patch', patchType: 'json', patch },
        })
        const { events } = await window.lumovi!.audit.query({
          actions: ['resource.patch'],
          limit: 1,
        })
        return events[0]!.summary
      },
      [CONTEXTS.demo, NODE, patch] as [string, string, Record<string, unknown>[]],
    )
  // A removal not checked first, with an addition: not said as the addition alone.
  expect(
    await patched([
      { op: 'remove', path: '/spec/taints/0' },
      { op: 'add', path: '/spec/taints/-', value: { key: 'x', effect: 'NoSchedule' } },
    ]),
  ).not.toMatch(/^Tainted/)
  // A check alone removes nothing: not said as a removal.
  expect(
    await patched([
      { op: 'test', path: '/spec/taints/0', value: { key: 'x', effect: 'NoSchedule' } },
    ]),
  ).not.toMatch(/^Removed/)
  // The whole list set: said as what it was set to.
  const { resourceVersion } = (await nodeNow(page)).metadata
  expect(
    await patched([
      { op: 'test', path: '/metadata/resourceVersion', value: resourceVersion },
      { op: 'add', path: '/spec/taints', value: [] },
    ]),
  ).toBe(`Removed every taint from Node ${NODE}`)
})

test('taints changed while the dialog is open: nothing is overwritten, they’re shown as they are, and one added meanwhile is kept', async ({
  page,
  clusters,
}) => {
  const taints = await openTaints(page)
  await taints.getByRole('button', { name: 'Remove dedicated=shop:PreferNoSchedule' }).click()
  // Meanwhile Kubernetes puts one of its own first: the one struck isn't where it was read.
  const node = (await nodeNow(page)) as KubeObject
  const unreachable = {
    key: 'node.kubernetes.io/unreachable',
    effect: 'NoExecute',
    timeAdded: '2026-10-12T10:00:00Z',
  }
  clusters.demo.upsert({ ...node, spec: { ...node.spec, taints: [unreachable, DEDICATED] } })
  await taints.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(taints).toContainText(
    `${NODE}’s taints changed while this was open, so nothing was changed. Here they are now, with your changes still staged.`,
  )
  // Nothing was written; the list is as it is now, Kubernetes' own said so, the change still staged.
  expect(await taintsNow(page)).toEqual([unreachable, DEDICATED])
  const list = taints.getByRole('list', { name: 'Taints' })
  await expect(list.getByRole('listitem').filter({ hasText: 'unreachable' })).toContainText(
    'Set by Kubernetes',
  )
  await expect(list.getByRole('listitem').filter({ hasText: 'dedicated=shop' })).toContainText(
    'Removed',
  )
  // Applied again, on what's there now.
  await taints.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(toasts(page)).toContainText(`Removed dedicated=shop:PreferNoSchedule from ${NODE}`)
  expect(await taintsNow(page)).toEqual([unreachable])

  // One added meanwhile at the end isn't dropped by what's added here.
  const adding = await openTaints(page)
  await adding.getByLabel('Key').fill('gpu')
  await adding.getByRole('button', { name: 'Add' }).click()
  const now = (await nodeNow(page)) as KubeObject
  const notReady = { key: 'node.kubernetes.io/not-ready', effect: 'NoSchedule' }
  clusters.demo.upsert({ ...now, spec: { ...now.spec, taints: [unreachable, notReady] } })
  await adding.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(toasts(page)).toContainText(`Tainted ${NODE} with gpu:NoSchedule`)
  expect(await taintsNow(page)).toEqual([
    unreachable,
    notReady,
    { key: 'gpu', effect: 'NoSchedule' },
  ])
})

test('a NoExecute taint says first which pods it evicts at once; the control plane’s own says what striking it does', async ({
  page,
}) => {
  const taints = await openTaints(page)
  await taints.getByLabel('Key').fill('maintenance')
  await taints
    .getByRole('group', { name: 'Effect' })
    .getByRole('button', { name: 'NoExecute' })
    .click()
  await taints.getByRole('button', { name: 'Add' }).click()
  await expect(taints.getByRole('note')).toContainText(
    new RegExp(`^Applying this evicts (\\d+ pods|\\S+) from ${NODE} at once\\.`),
  )
  await expect(taints.getByRole('note')).toContainText(
    'PodDisruptionBudgets aren’t asked, and pods without a controller don’t come back.',
  )
  const apply = taints.getByRole('button', { name: /^Apply and evict \d+ pods?$/ })
  await expect(apply).toBeVisible()
  await apply.click()
  await expect(toasts(page)).toContainText(
    'Undo puts the taints back. Pods it evicted don’t come back.',
  )
  await toasts(page).getByRole('button', { name: 'Undo' }).click()
  await expect(toasts(page)).toContainText(`Removed maintenance:NoExecute from ${NODE}`)
  expect(await taintsNow(page)).toEqual([DEDICATED])

  // The control plane's own taint: Kubernetes', and what striking it means.
  const plane = await openTaints(page, DEMO.nodes.controlPlane)
  const row = plane
    .getByRole('listitem')
    .filter({ hasText: 'node-role.kubernetes.io/control-plane' })
  await expect(row).toContainText('Set by Kubernetes')
  await plane
    .getByRole('button', { name: 'Remove node-role.kubernetes.io/control-plane:NoSchedule' })
    .click()
  await expect(row).toContainText('Pods will be scheduled on this control-plane node.')
})

test('a drain’s options are kubectl drain’s flags, and a grace period of 0 isn’t taken', async ({
  page,
  clusters,
}) => {
  await open(page, 'Nodes', DEMO.nodes.worker2)
  await menuAction(page, 'Node', DEMO.nodes.worker2, 'Drain…')
  const drain = dialog(page)
  const confirm = drain.getByRole('button', { name: 'Drain', exact: true })
  await drain
    .getByRole('group', { name: 'Grace period' })
    .getByRole('button', { name: 'Seconds' })
    .click()
  const grace = drain.getByLabel('Grace period in seconds')
  await grace.fill('0')
  await expect(drain).toContainText(
    'At least 1 second: 0 would kill each pod without letting it stop.',
  )
  await expect(confirm).toBeDisabled()
  await grace.fill('45')
  await drain
    .getByRole('group', { name: 'Give up after' })
    .getByRole('button', { name: 'Seconds' })
    .click()
  await drain.getByLabel('Give up after, in seconds').fill('120')
  await drain.getByRole('checkbox', { name: /Delete emptyDir data/ }).check()
  await drain.getByRole('checkbox', { name: /Evict pods without a controller/ }).check()
  await expect(drain).toContainText(
    `drain ${DEMO.nodes.worker2} --ignore-daemonsets --delete-emptydir-data --force --grace-period=45 --timeout=120s`,
  )
  // Leaving DaemonSet pods off: they stop the drain, as kubectl's do.
  await drain.getByRole('checkbox', { name: /Leave DaemonSet pods/ }).uncheck()
  await expect(drain.getByRole('list', { name: 'Pods on the node' })).toContainText(
    'DaemonSet pod: the drain can’t go on with it here',
  )
  await expect(confirm).toBeDisabled()
  await expect(drain).not.toContainText('--ignore-daemonsets')
  await drain.getByRole('checkbox', { name: /Leave DaemonSet pods/ }).check()

  await confirm.click()
  await expect(drain.getByRole('status')).toContainText(`Drained ${DEMO.nodes.worker2}:`)
  // Each eviction with the grace period asked for.
  const evictions = writes(clusters.demo, 'POST', /\/eviction$/)
  expect(evictions.length).toBeGreaterThan(0)
  for (const { body } of evictions) {
    expect(body).toMatchObject({ deleteOptions: { gracePeriodSeconds: 45 } })
  }
  // And none of 0 from anywhere: the API refuses it too.
  const pod = (
    await page.evaluate(
      (context) => window.lumovi!.kube.list({ context, kind: 'Pod', namespace: 'shop' }),
      CONTEXTS.demo,
    )
  ).ok
  expect(pod).toBe(true)
  expect(
    await page.evaluate(
      ([context, name]) =>
        window.lumovi!.kube.change({
          context: context!,
          kind: 'Pod',
          namespace: 'shop',
          name: name!,
          change: { action: 'evict', gracePeriodSeconds: 0 },
        }),
      [CONTEXTS.demo, DEMO.pods.storefront[0]!],
    ),
  ).toMatchObject({ ok: false, error: { code: 'invalid' } })
})

test('a drain waits on the PodDisruptionBudgets that hold its pods, says which and why, and stops at its timeout', async ({
  page,
  clusters,
}) => {
  // A budget that allows no disruption now, over postgres on worker-1.
  const pdb = {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: { name: 'postgres', namespace: 'data', uid: 'pdb-postgres' },
    spec: { minAvailable: 1, selector: { matchLabels: { 'app.kubernetes.io/name': 'postgres' } } },
    status: { disruptionsAllowed: 0, currentHealthy: 1, desiredHealthy: 1, expectedPods: 1 },
  } as unknown as KubeObject
  clusters.demo.upsert(pdb)
  await open(page, 'Nodes', NODE)
  await menuAction(page, 'Node', NODE, 'Drain…')
  const drain = dialog(page)
  await drain.getByRole('checkbox', { name: /Evict pods without a controller/ }).check()
  await drain.getByRole('checkbox', { name: /Delete emptyDir data/ }).check()
  await drain
    .getByRole('group', { name: 'Give up after' })
    .getByRole('button', { name: 'Seconds' })
    .click()
  await drain.getByLabel('Give up after, in seconds').fill('8')
  await drain.getByRole('button', { name: 'Drain', exact: true }).click()

  // While it waits: which budget, and why; the pod's row says it, and when it's tried again.
  await expect(drain.getByRole('heading')).toContainText(`Draining ${NODE}`)
  const waiting = drain.getByRole('status').filter({ hasText: 'Waiting on' })
  await expect(waiting).toContainText('Waiting on 1 PodDisruptionBudget')
  await expect(waiting).toContainText(
    /data\/postgres holds \d+ pods?: no disruptions allowed now \(1 healthy, 1 needed\)/,
  )
  await expect(waiting).toContainText(/trying every 5 s · \d+:\d\d of 0:08/)
  const held = drain
    .getByRole('list', { name: 'Pods on the node' })
    .getByRole('listitem')
    .filter({ hasText: DEMO.pods.postgres[0]! })
  await expect(held).toContainText('Held by PodDisruptionBudget postgres')
  await expect(held.getByLabel('Held')).toBeVisible()

  // At the timeout: stopped, where, and the node still cordoned.
  await expect(drain.getByRole('heading')).toContainText(`Drain of ${NODE} stopped`, {
    timeout: 20_000,
  })
  await expect(drain.getByRole('status')).toContainText(
    new RegExp(
      `Stopped after 0:08: \\d+ pods? (is|are) still on ${NODE}, held by PodDisruptionBudgets\\. It stays cordoned\\.`,
    ),
  )
  await expect(drain.getByRole('status')).toContainText(`data/postgres: ${DEMO.pods.postgres[0]}`)
  expect((await nodeNow(page)).spec?.unschedulable).toBe(true)

  // Allowed now: its Retry evicts it.
  clusters.demo.upsert({ ...pdb, status: { ...pdb.status, disruptionsAllowed: 1 } } as KubeObject)
  await held.getByRole('button', { name: 'Retry' }).click()
  await expect(held.getByLabel('Evicted')).toBeVisible()
  // Uncordon from here puts the node back in use.
  await drain.getByRole('button', { name: 'Uncordon' }).click()
  await expect(toasts(page)).toContainText(`Uncordoned ${NODE}`)
  expect((await nodeNow(page)).spec?.unschedulable).toBeFalsy()
})

test('a drain without a timeout waits until it’s stopped, and a budget that allows it lets it go on', async ({
  page,
  clusters,
}) => {
  const pdb = {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: { name: 'postgres', namespace: 'data', uid: 'pdb-postgres' },
    spec: { minAvailable: 1, selector: { matchLabels: { 'app.kubernetes.io/name': 'postgres' } } },
    status: { disruptionsAllowed: 0, currentHealthy: 1, desiredHealthy: 1, expectedPods: 1 },
  } as unknown as KubeObject
  clusters.demo.upsert(pdb)
  await open(page, 'Nodes', NODE)
  await menuAction(page, 'Node', NODE, 'Drain…')
  const drain = dialog(page)
  await drain.getByRole('checkbox', { name: /Evict pods without a controller/ }).check()
  await drain.getByRole('checkbox', { name: /Delete emptyDir data/ }).check()
  await drain.getByRole('button', { name: 'Drain', exact: true }).click()
  const held = drain
    .getByRole('list', { name: 'Pods on the node' })
    .getByRole('listitem')
    .filter({ hasText: DEMO.pods.postgres[0]! })
  await expect(held.getByLabel('Held')).toBeVisible()
  // The budget allows them (each eviction uses one up): evicted at the next look, and it finishes.
  clusters.demo.upsert({ ...pdb, status: { ...pdb.status, disruptionsAllowed: 5 } } as KubeObject)
  await expect(held.getByLabel('Evicted')).toBeVisible({ timeout: 15_000 })
  await expect(drain.getByRole('status')).toContainText(`Drained ${NODE}:`)
  await drain.getByRole('button', { name: 'Done' }).click()

  // Held again, and stopped by hand: a budget over every pod in shop (an empty selector).
  clusters.demo.upsert({
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: { name: 'everything', namespace: 'shop', uid: 'pdb-everything' },
    spec: { minAvailable: 1, selector: {} },
    status: { disruptionsAllowed: 0, currentHealthy: 1, desiredHealthy: 1, expectedPods: 1 },
  } as unknown as KubeObject)
  await open(page, 'Nodes', DEMO.nodes.worker2)
  await menuAction(page, 'Node', DEMO.nodes.worker2, 'Drain…')
  const again = dialog(page)
  await again.getByRole('checkbox', { name: /Evict pods without a controller/ }).check()
  await again.getByRole('checkbox', { name: /Delete emptyDir data/ }).check()
  await again.getByRole('button', { name: 'Drain', exact: true }).click()
  await expect(again.getByRole('status').filter({ hasText: 'Waiting on' })).toContainText(
    'shop/everything holds',
  )
  await again.getByRole('button', { name: 'Stop' }).click()
  await expect(again.getByRole('heading')).toContainText(`Drain of ${DEMO.nodes.worker2} stopped`)
  await expect(again.getByRole('status')).toContainText(
    new RegExp(
      `^Stopped: \\d+ pods? (is|are) still on ${DEMO.nodes.worker2}\\. It stays cordoned\\.`,
    ),
  )
  // Uncordon, from there, puts it back in use.
  await again.getByRole('button', { name: 'Uncordon' }).click()
  await expect
    .poll(async () => (await nodeNow(page, DEMO.nodes.worker2)).spec?.unschedulable)
    .toBeFalsy()
})

test('closing a drain’s dialog while it waits ends it as Stop does: nothing more is sent, and a toast says where it is', async ({
  page,
  clusters,
}) => {
  const pdb = {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: { name: 'postgres', namespace: 'data', uid: 'pdb-postgres' },
    spec: { minAvailable: 1, selector: { matchLabels: { 'app.kubernetes.io/name': 'postgres' } } },
    status: { disruptionsAllowed: 0, currentHealthy: 1, desiredHealthy: 1, expectedPods: 1 },
  } as unknown as KubeObject
  clusters.demo.upsert(pdb)
  await open(page, 'Nodes', NODE)
  await menuAction(page, 'Node', NODE, 'Drain…')
  const drain = dialog(page)
  await drain.getByRole('checkbox', { name: /Evict pods without a controller/ }).check()
  await drain.getByRole('checkbox', { name: /Delete emptyDir data/ }).check()
  await drain.getByRole('button', { name: 'Drain', exact: true }).click()
  const held = drain
    .getByRole('list', { name: 'Pods on the node' })
    .getByRole('listitem')
    .filter({ hasText: DEMO.pods.postgres[0]! })
  await expect(held.getByLabel('Held')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drain).toHaveCount(0)
  await expect(toasts(page)).toContainText(
    new RegExp(
      `Stopped draining ${NODE}: (\\d+ of \\d+ pods|no pods) evicted\\. It stays cordoned\\.`,
    ),
  )
  // Its Uncordon (before the toast goes) puts the node back in use.
  await toasts(page).getByRole('button', { name: 'Uncordon' }).click()
  await expect.poll(async () => (await nodeNow(page)).spec?.unschedulable).toBeFalsy()
  // The budget allows it now: no eviction goes, the dialog being gone.
  const path = `/api/v1/namespaces/data/pods/${DEMO.pods.postgres[0]}/eviction`
  const before = writes(clusters.demo, 'POST', path).length
  clusters.demo.upsert({ ...pdb, status: { ...pdb.status, disruptionsAllowed: 5 } } as KubeObject)
  await holds(
    () => writes(clusters.demo, 'POST', path).length === before,
    10_000,
    'no eviction goes once the drain is stopped',
  )
})

test('closed while it cordons, a drain evicts nothing once the cordon answers', async ({
  page,
  clusters,
}) => {
  await open(page, 'Nodes', DEMO.nodes.worker2)
  await menuAction(page, 'Node', DEMO.nodes.worker2, 'Drain…')
  const drain = dialog(page)
  await drain.getByRole('checkbox', { name: /Evict pods without a controller/ }).check()
  await drain.getByRole('checkbox', { name: /Delete emptyDir data/ }).check()
  // The cordon takes its time, and then goes through.
  clusters.demo.fail(`/api/v1/nodes/${DEMO.nodes.worker2}`, { delayMs: 3_000 })
  await drain.getByRole('button', { name: 'Drain', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(drain).toHaveCount(0)
  await expect(toasts(page)).toContainText(
    `Stopped draining ${DEMO.nodes.worker2}: no pods evicted. It stays cordoned.`,
  )
  await expect
    .poll(async () => (await nodeNow(page, DEMO.nodes.worker2)).spec?.unschedulable)
    .toBe(true)
  await holds(
    () => writes(clusters.demo, 'POST', /\/eviction$/).length === 0,
    6_000,
    'no eviction goes once the cordon answers',
  )
})

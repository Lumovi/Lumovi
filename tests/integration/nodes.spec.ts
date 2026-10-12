/**
 * Cordoning and draining real nodes, with a disruption budget in the way; and their taints, as a
 * real API server answers a change whose test fails.
 */
import { refusedAsChanged } from '../../src/shared/taints.ts'
import { dialog, menuAction, open } from '../e2e/action-helpers.ts'
import { panel } from '../e2e/fixtures.ts'
import { CONTEXT, expect, freshNamespace, get, kubectl, test } from './fixtures.ts'
import { web, webBudget } from './workloads.ts'

const NS = 'it-nodes'
const NODE = 'lumovi-worker2'
const node = () => get('node', NODE)

test.beforeAll(() => freshNamespace(NS, [web(2), webBudget()]))

// Whatever happens, the node takes pods again afterwards, and has no taint of these tests'.
test.afterAll(() => {
  kubectl(['uncordon', NODE])
  try {
    kubectl(['taint', 'nodes', NODE, 'lumovi-test-'])
  } catch {
    // (Not there: nothing to take off.)
  }
})

test('cordon and uncordon a node', async ({ page }) => {
  await open(page, 'Nodes', NODE)
  const detail = panel(page, 'Node', NODE)
  await detail.getByRole('button', { name: 'Cordon' }).click()
  await expect.poll(() => node().spec.unschedulable).toBe(true)
  await detail.getByRole('button', { name: 'Uncordon' }).click()
  await expect.poll(() => node().spec.unschedulable ?? false).toBe(false)
})

test('drain a node: the disruption budget holds a pod back until it allows it', async ({
  page,
}) => {
  const webPods = () =>
    get('pods', '-n', NS, '-l', 'app=web').items.map(
      (p: { spec: { nodeName: string } }) => p.spec.nodeName,
    )
  // One web pod on each worker; the one on this node is held back by the budget.
  expect(webPods()).toContain(NODE)
  const onNode = get('pods', '-n', NS, '-l', 'app=web', '--field-selector', `spec.nodeName=${NODE}`)
    .items[0].metadata.name

  await open(page, 'Nodes', NODE)
  await menuAction(page, 'Node', NODE, 'Drain…')
  const drain = dialog(page)
  const pods = drain.getByRole('list', { name: 'Pods on the node' })
  await expect(pods).toContainText('DaemonSet pod, stays on the node')
  // Other tests share the cluster, and may have left pods that need these.
  await drain.getByRole('checkbox', { name: /Evict pods without a controller/ }).check()
  await drain.getByRole('checkbox', { name: /Delete emptyDir data/ }).check()
  await drain.getByRole('button', { name: 'Drain', exact: true }).click()

  // The API server refuses to evict the web pod (both must stay available): it's held, the
  // budget named, and tried again while the drain waits.
  const held = pods.getByRole('listitem').filter({ hasText: onNode })
  await expect(held.getByLabel('Held')).toBeVisible({ timeout: 120_000 })
  await expect(held).toContainText(`Held by PodDisruptionBudget web: no disruptions allowed now`)
  await expect(drain.getByRole('status').filter({ hasText: 'Waiting on' })).toContainText(
    `${NS}/web holds 1 pod`,
  )
  expect(node().spec.unschedulable).toBe(true)

  // Once the budget allows one pod to go, the next look evicts it.
  kubectl(['patch', 'pdb/web', '-n', NS, '--type=merge', '-p', '{"spec":{"minAvailable":1}}'])
  await expect(held.getByLabel('Evicted')).toBeVisible({ timeout: 60_000 })
  await expect(drain.getByRole('status')).toContainText(`Drained ${NODE}:`)
  await drain.getByRole('button', { name: 'Done' }).click()
  // The replacement runs elsewhere, and nothing but DaemonSet pods is left.
  await expect.poll(webPods, { timeout: 90_000 }).not.toContain(NODE)
  // Evicted pods take a moment to go; then only DaemonSet pods are left.
  const left = () =>
    get('pods', '--all-namespaces', '--field-selector', `spec.nodeName=${NODE}`)
      .items.filter(
        (pod: { metadata: { deletionTimestamp?: string } }) => !pod.metadata.deletionTimestamp,
      )
      .map(
        (pod: { metadata: { ownerReferences: { kind: string }[] } }) =>
          pod.metadata.ownerReferences[0]!.kind,
      )
  await expect
    .poll(() => left().filter((kind: string) => kind !== 'DaemonSet'), { timeout: 60_000 })
    .toEqual([])
  expect(left()).toContain('DaemonSet')
})

test('a taints change whose test fails is refused in words the Taints dialog reads as changed meanwhile', async ({
  page,
}) => {
  kubectl(['taint', 'nodes', NODE, 'lumovi-test=one:NoSchedule', '--overwrite'])
  // As the API server answers a test that fails: what the backend gives back, as it is.
  const refused = await page.evaluate(
    ([context, name]) =>
      window.lumovi!.kube.change({
        context,
        kind: 'Node',
        name,
        change: {
          action: 'patch',
          patchType: 'json',
          patch: [
            {
              op: 'test',
              path: '/spec/taints/0',
              value: { key: 'lumovi-test', value: 'two', effect: 'NoSchedule' },
            },
            { op: 'remove', path: '/spec/taints/0' },
          ],
        },
      }),
    [CONTEXT, NODE] as [string, string],
  )
  expect(refused.ok).toBe(false)
  if (refused.ok) return
  // (Said in the test's report: what a real API server says, for the record.)
  console.log(`A failed test, as the API server says it: ${JSON.stringify(refused.error)}`)
  expect(refusedAsChanged(refused.error)).toBe(true)
  // Nothing was removed.
  expect(node().spec.taints).toContainEqual({
    key: 'lumovi-test',
    value: 'one',
    effect: 'NoSchedule',
  })

  // And through the dialog: struck, changed behind its back, Apply refused and shown as it is.
  await open(page, 'Nodes', NODE)
  await menuAction(page, 'Node', NODE, 'Taints…')
  const taints = dialog(page)
  await taints.getByRole('button', { name: 'Remove lumovi-test=one:NoSchedule' }).click()
  kubectl(['taint', 'nodes', NODE, 'lumovi-test=two:NoSchedule', '--overwrite'])
  await taints.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(taints).toContainText(
    `${NODE}’s taints changed while this was open, so nothing was changed.`,
  )
  await expect(taints.getByRole('list', { name: 'Taints' })).toContainText('lumovi-test=two')
  expect(node().spec.taints).toContainEqual({
    key: 'lumovi-test',
    value: 'two',
    effect: 'NoSchedule',
  })
})

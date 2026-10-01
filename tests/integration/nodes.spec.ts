/** Cordoning and draining real nodes, with a disruption budget in the way. */
import { dialog, menuAction, open } from '../e2e/action-helpers.ts'
import { panel } from '../e2e/fixtures.ts'
import { expect, freshNamespace, get, kubectl, test } from './fixtures.ts'
import { web, webBudget } from './workloads.ts'

const NS = 'it-nodes'
const NODE = 'kubestacks-worker2'
const node = () => get('node', NODE)

test.beforeAll(() => freshNamespace(NS, [web(2), webBudget()]))

// Whatever happens, the node takes pods again afterwards.
test.afterAll(() => {
  kubectl(['uncordon', NODE])
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
  await drain.getByRole('checkbox', { name: /Delete local data/ }).check()
  await drain.getByRole('button', { name: 'Drain', exact: true }).click()
  await expect(drain.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 120_000 })

  // The API server refuses to evict the web pod: both must stay available.
  await expect(drain.getByRole('status')).toContainText('1 pod couldn’t be evicted')
  const held = pods.getByRole('listitem').filter({ hasText: onNode })
  await expect(held).toContainText('disruption budget')
  expect(node().spec.unschedulable).toBe(true)

  // Once the budget allows one pod to go, the retry goes through.
  kubectl(['patch', 'pdb/web', '-n', NS, '--type=merge', '-p', '{"spec":{"minAvailable":1}}'])
  await held.getByRole('button', { name: 'Retry' }).click()
  await expect(held.getByLabel('Evicted')).toBeVisible()
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

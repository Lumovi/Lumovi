/**
 * Logs streamed from a real kubelet: a Deployment's pods followed together,
 * and a pod that replaces another picked up.
 */
import { open } from '../e2e/action-helpers.ts'
import { panel } from '../e2e/fixtures.ts'
import { expect, freshNamespace, get, inNamespace, kubectl, test } from './fixtures.ts'
import { web } from './workloads.ts'

const NS = 'it-logs'
const podNames = (): string[] =>
  get('pods', '-n', NS, '-l', 'app=web')
    .items.filter(
      (p: { metadata: { deletionTimestamp?: string } }) => !p.metadata.deletionTimestamp,
    )
    .map((p: { metadata: { name: string } }) => p.metadata.name)
    .sort()

test.beforeAll(() => freshNamespace(NS, [web(2)]))

test.beforeEach(async ({ page }) => {
  await inNamespace(page, NS)
})

test('a deployment’s pods, followed together', async ({ page }) => {
  await open(page, 'Deployments', 'web')
  const detail = panel(page, 'Deployment', 'web')
  await detail.getByRole('tab', { name: 'Logs' }).click()
  const chips = detail.getByRole('group', { name: 'Show lines from' })
  const log = detail.getByRole('log', { name: 'Logs for web' })
  const pods = podNames()
  expect(pods).toHaveLength(2)

  // Each pod's readiness probe writes an access log line every few seconds.
  await detail.getByLabel('Search logs').fill('kube-probe')
  const counts = async () =>
    Promise.all(
      pods.map(async (pod) => {
        const chip = chips.getByRole('button', { name: new RegExp(`^${pod.split('-').at(-1)}`) })
        // The chip's last part is how many lines the pod has.
        return Number(await chip.locator('span').last().textContent())
      }),
    )
  const before = await counts()
  await expect.poll(counts, { timeout: 30_000 }).not.toEqual(before)
  await expect(log).toContainText('kube-probe')

  // A pod that replaces one is picked up.
  kubectl(['delete', 'pod', pods[0]!, '-n', NS, '--wait=false'])
  kubectl(['rollout', 'status', 'deployment/web', '-n', NS, '--timeout=120s'])
  const replacement = podNames().find((pod) => !pods.includes(pod))!
  await page.getByRole('button', { name: /^Refresh/ }).click()
  const chip = chips.getByRole('button', {
    name: new RegExp(`^${replacement.split('-').at(-1)}`),
  })
  await expect(chip).toBeVisible({ timeout: 30_000 })
  await expect(chip.locator('span').last()).not.toHaveText('0', { timeout: 30_000 })
})

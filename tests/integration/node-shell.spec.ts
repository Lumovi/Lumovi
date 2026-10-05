/** A shell on a real node: in its own namespaces, as root, through a pod that goes afterwards. */
import { open } from '../e2e/action-helpers.ts'
import { panel } from '../e2e/fixtures.ts'
import { expect, get, test } from './fixtures.ts'

const NODE = 'lumovi-worker'
const shellPods = () =>
  get('pods', '-n', 'kube-system', '-l', 'app.kubernetes.io/component=node-shell').items.length

test('a shell on a node, in its own namespaces', async ({ page }) => {
  await open(page, 'Nodes', NODE)
  const detail = panel(page, 'Node', NODE)
  await detail.getByRole('button', { name: 'Shell', exact: true }).click()
  await detail.getByRole('button', { name: 'Start shell' }).click()
  const screen = page.getByRole('region', { name: `Shell on ${NODE}` }).locator('.xterm-rows')
  // (The node may pull the image first.)
  await expect(screen).toContainText(`You’re root on ${NODE}.`, { timeout: 120_000 })
  expect(shellPods()).toBe(1)

  await page.keyboard.type('echo "on $(hostname) as $(id -un)"')
  await page.keyboard.press('Enter')
  await expect(screen).toContainText(`on ${NODE} as root`)
  // The node's files, not the image's: its kubelet's are there.
  await page.keyboard.type('test -d /var/lib/kubelet/pods && echo kubelet-files-here')
  await page.keyboard.press('Enter')
  await expect(screen).toContainText('kubelet-files-here')

  await detail.getByRole('button', { name: 'End' }).click()
  await expect.poll(shellPods, { timeout: 30_000 }).toBe(0)
})

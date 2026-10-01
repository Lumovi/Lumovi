/**
 * Shells, port forwards and debug containers over the real exec and
 * port-forward protocols, through the kind nodes' kubelets.
 */
import net from 'node:net'
import type { Page } from '@playwright/test'
import { dialog, menuAction, open, toasts } from '../e2e/action-helpers.ts'
import { goTo, panel } from '../e2e/fixtures.ts'
import { expect, freshNamespace, inNamespace, kubectl, test } from './fixtures.ts'
import { bare, db, web, webService } from './workloads.ts'

const NS = 'it-streams'

/** What the terminal shows. */
const screen = (page: Page, container: string | RegExp) =>
  page
    .getByRole('region', {
      name: typeof container === 'string' ? `Shell in ${container}` : container,
    })
    .locator('.xterm-rows')

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

test.beforeAll(() => {
  freshNamespace(NS, [...db(), web(1), webService(), bare()])
  kubectl(['wait', '--for=condition=Ready', 'pod/bare', '-n', NS, '--timeout=120s'])
})

test.beforeEach(async ({ page }) => {
  await inNamespace(page, NS)
})

test('a shell in a container', async ({ page }) => {
  await open(page, 'Pods', 'db-0')
  const detail = panel(page, 'Pod', 'db-0')
  await detail.getByRole('button', { name: 'Shell' }).click()
  const terminal = screen(page, 'db')
  await expect(terminal).toContainText('#')
  await page.keyboard.type('hostname')
  await page.keyboard.press('Enter')
  await expect(terminal).toContainText(/hostname\s*db-0/)
  await page.keyboard.type('echo $((6 * 7))')
  await page.keyboard.press('Enter')
  await expect(terminal).toContainText(/\n?42/)
  // The real exit status comes back over the exec protocol.
  await page.keyboard.type('exit 3')
  await page.keyboard.press('Enter')
  await expect(detail.getByRole('status')).toContainText('The shell exited with code 3.')
})

test('forward a port to a service, and stop', async ({ page }) => {
  const local = await freePort()
  await goTo(page, 'Services')
  await open(page, 'Services', 'web')
  await menuAction(page, 'Service', 'web', 'Forward a port…')
  await dialog(page).getByLabel('Local port', { exact: true }).fill(String(local))
  await dialog(page).getByRole('button', { name: 'Start forwarding' }).click()
  await expect(toasts(page)).toContainText(`Forwarding localhost:${local} to web`)
  const response = await fetch(`http://127.0.0.1:${local}/`)
  expect(await response.text()).toContain('Welcome to nginx!')

  await page.getByRole('button', { name: 'Port forwards' }).click()
  await page
    .getByRole('dialog', { name: 'Port forwards' })
    .getByRole('button', { name: 'Stop forwarding' })
    .click()
  await expect(fetch(`http://127.0.0.1:${local}/`)).rejects.toThrow()
})

test('debug a pod that has no shell', async ({ page }) => {
  await open(page, 'Pods', 'bare')
  const detail = panel(page, 'Pod', 'bare')
  await detail.getByRole('tab', { name: 'Shell' }).click()
  // The pause image is a single binary: the runtime says there's nothing to run.
  const status = detail.getByRole('status')
  await expect(status).toContainText('bare has no shell.')
  await status.getByRole('button', { name: 'Debug' }).click()
  await expect(dialog(page).getByLabel('Share processes with')).toHaveValue('bare')
  await dialog(page).getByRole('button', { name: 'Start debugging' }).click()
  // Once the ephemeral container runs, the shell opens in it, sharing the pod's processes.
  const terminal = screen(page, /^Shell in debugger-/)
  await expect(terminal).toContainText('#', { timeout: 90_000 })
  await page.keyboard.type('ps')
  await page.keyboard.press('Enter')
  await expect(terminal).toContainText('/pause')
  const pod = JSON.parse(kubectl(['get', 'pod', 'bare', '-n', NS, '-o', 'json']))
  expect(pod.spec.ephemeralContainers[0]).toMatchObject({
    image: 'busybox:1.37',
    targetContainerName: 'bare',
  })
})

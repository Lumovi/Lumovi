import net from 'node:net'
import type { Page } from '@playwright/test'
import { dialog, menuAction, open, toasts, writes } from './action-helpers.ts'
import { DEMO, expect, goTo, mockOpenExternal, openCluster, panel, row, test } from './fixtures.ts'

const POD = DEMO.pods.storefront[0]!

/** What the terminal shows. */
const screen = (page: Page, container = 'app') =>
  page.getByRole('region', { name: `Shell in ${container}` }).locator('.xterm-rows')

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

test.beforeEach(async ({ page }) => {
  await openCluster(page)
})

test('a shell in a container', async ({ page, clusters }) => {
  await open(page, 'Pods', POD)
  const detail = panel(page, 'Pod', POD)
  await detail.getByRole('button', { name: 'Shell' }).click()
  await expect(detail.getByRole('tab', { name: 'Shell' })).toHaveAttribute('aria-selected', 'true')
  await expect(screen(page)).toContainText(`root@${POD}:/#`)
  const exec = clusters.demo.requests.find((r) => r.path.endsWith(`/pods/${POD}/exec`))!
  expect(exec.search).toContain('container=app')
  expect(exec.search).toContain('tty=true')

  await page.keyboard.type('hostname')
  await page.keyboard.press('Enter')
  await expect(screen(page)).toContainText(new RegExp(`hostname\\s*${POD}`))
  await page.keyboard.type('nope')
  await page.keyboard.press('Enter')
  await expect(screen(page)).toContainText('sh: nope: not found')
  // Line editing: backspace, Ctrl+C.
  await page.keyboard.type('echo hix')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Enter')
  await expect(screen(page)).toContainText(/echo hi\s+hi/)
  await page.keyboard.type('half-typed')
  await page.keyboard.press('Control+c')
  await expect(screen(page)).toContainText('half-typed^C')

  // The shell knows the terminal's size, and follows it when the panel grows.
  await page.keyboard.type('stty size')
  await page.keyboard.press('Enter')
  const size = async () => {
    const text = await screen(page).innerText()
    return [...text.matchAll(/^\s*(\d+) (\d+)\s*$/gm)].at(-1)?.slice(1).map(Number) ?? []
  }
  await expect.poll(size).toHaveLength(2)
  const [, columns] = await size()
  await detail.getByRole('button', { name: 'Expand panel' }).click()
  await page.getByRole('region', { name: 'Shell in app' }).click()
  await page.keyboard.type('stty size')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await size())[1]).toBeGreaterThan(columns!)

  // Escape belongs to the shell, not to the panel.
  await page.keyboard.press('Escape')
  await expect(detail).toBeVisible()

  // Output of other sessions (here, one the test starts itself) stays out of this one.
  const lines = (await screen(page).innerText()).split('\n').length
  await page.evaluate(
    (pod) =>
      window.kubestacks.terminal.open('someone-else', {
        context: 'demo',
        namespace: 'shop',
        pod,
        container: 'envoy',
      }),
    POD,
  )
  await page.waitForTimeout(300)
  expect((await screen(page).innerText()).split('\n').length).toBe(lines)

  await page.keyboard.type('exit 3')
  await page.keyboard.press('Enter')
  await expect(detail.getByRole('status')).toContainText('The shell exited with code 3.')
  // Typing into an ended session goes nowhere.
  await page.getByRole('region', { name: 'Shell in app' }).click()
  await page.keyboard.type('ignored')
  await expect(screen(page)).not.toContainText('ignored')
  await detail.getByRole('status').getByRole('button', { name: 'Reconnect' }).click()
  await expect(screen(page)).toContainText(`root@${POD}:/#`)
  await expect(detail.getByRole('status')).toHaveCount(0)
  // Ctrl+D on an empty line ends the shell too.
  await page.keyboard.press('Control+d')
  await expect(detail.getByRole('status')).toContainText('The shell exited with code 0.')
  await detail.getByRole('button', { name: 'Reconnect' }).first().click()

  // Another container.
  await detail.getByLabel('Container').selectOption('envoy')
  await expect(screen(page, 'envoy')).toContainText(`root@${POD}:/#`)
  // The connection can drop, e.g. when the API server restarts.
  clusters.demo.reset()
  await expect(detail.getByRole('status')).toContainText('The connection to the container closed.')
})

test('an opened shell is ready to type, unless tabs are browsed by keyboard', async ({ page }) => {
  await open(page, 'Pods', POD)
  const detail = panel(page, 'Pod', POD)
  // Arrowing through the tabs passes over the shell instead of getting stuck in it.
  await detail.getByRole('tab', { name: 'Logs' }).click()
  await page.keyboard.press('ArrowRight')
  await expect(screen(page)).toContainText(`root@${POD}:/#`)
  await expect(detail.getByRole('tab', { name: 'Shell' })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(detail.getByRole('tab', { name: 'Metrics' })).toBeFocused()

  // Clicking the tab goes straight to the prompt.
  await detail.getByRole('tab', { name: 'Shell' }).click()
  await expect(screen(page)).toContainText(`root@${POD}:/#`)
  await page.keyboard.type('whoami')
  await page.keyboard.press('Enter')
  await expect(screen(page)).toContainText(/whoami\s*root/)
})

test('when a shell can’t run', async ({ page, clusters }) => {
  // No shell in the image: a debug container can help.
  const metrics = DEMO.pods.metricsServer[0]!
  await open(page, 'Pods', metrics)
  await panel(page, 'Pod', metrics).getByRole('button', { name: 'Shell' }).click()
  const status = panel(page, 'Pod', metrics).getByRole('status')
  await expect(status).toContainText('metrics-server has no shell.')
  await status.getByRole('button', { name: 'Debug' }).click()
  await expect(dialog(page)).toContainText(`Debug ${metrics}`)
  await page.keyboard.press('Escape')

  // A container that isn't running.
  const checkout = DEMO.pods.checkout[0]!
  await open(page, 'Pods', checkout)
  await panel(page, 'Pod', checkout).getByRole('tab', { name: 'Shell' }).click()
  await expect(panel(page, 'Pod', checkout)).toContainText('app isn’t running')
  await expect(
    panel(page, 'Pod', checkout).getByRole('button', { name: 'Reconnect' }),
  ).toBeDisabled()

  // Pods that aren't running offer no shell.
  await open(page, 'Pods', DEMO.pods.redis[1]!)
  const pending = panel(page, 'Pod', DEMO.pods.redis[1]!)
  await expect(pending.getByRole('button', { name: 'Shell' })).toHaveCount(0)
  await pending.getByRole('tab', { name: 'Shell' }).click()
  await expect(pending).toContainText('redis isn’t running')

  // The API server refuses the connection.
  clusters.demo.fail(`/api/v1/namespaces/shop/pods/${POD}/exec`, {
    status: 500,
    body: JSON.stringify({ kind: 'Status', message: 'container runtime is unavailable' }),
  })
  await open(page, 'Pods', POD)
  await panel(page, 'Pod', POD).getByRole('button', { name: 'Shell' }).click()
  await expect(panel(page, 'Pod', POD).getByRole('status')).toContainText('500')
})

test('shells need exec access and a writable cluster', async ({ page, clusters }) => {
  clusters.demo.deny({ verb: 'create', resource: 'pods', subresource: 'exec', namespace: 'shop' })
  await page.reload()
  await open(page, 'Pods', POD)
  const detail = panel(page, 'Pod', POD)
  await expect(detail.getByRole('button', { name: 'Shell' })).toBeDisabled()
  await detail.getByRole('tab', { name: 'Shell' }).click()
  await expect(detail).toContainText('Your account can’t open shells in shop.')
  // Even if the page asks anyway.
  await detail.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menu')).toContainText('Your account can’t open shells in shop.')
  await page.keyboard.press('Escape')

  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: 'Make demo read-only' }).click()
  await expect(detail).toContainText(
    'demo is read-only in KubeStacks, and a shell can change a container.',
  )
  const refused = await page.evaluate(
    (pod) =>
      window.kubestacks.terminal.open('refused-session', {
        context: 'demo',
        namespace: 'shop',
        pod,
        container: 'app',
      }),
    POD,
  )
  expect(refused).toMatchObject({ ok: false, error: { code: 'read-only' } })
})

test('debug a pod with a temporary container', async ({ page, clusters }) => {
  await goTo(page, 'Pods')
  await page.getByPlaceholder('Filter pods').fill(POD)
  // Started from a row, the pod opens on its shell.
  await row(page, 'Pods', POD).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Debug…' }).click()
  const debug = dialog(page)
  await expect(debug.getByRole('radio', { name: /busybox/ })).toBeChecked()
  await debug.getByRole('radio', { name: /netshoot/ }).check()
  await debug.getByLabel('Share processes with').selectOption('envoy')
  const container = (await debug.getByText(/--container=debugger-/).innerText()).match(
    /debugger-[a-z0-9]{5}/,
  )![0]
  await expect(debug).toContainText('--image=nicolaka/netshoot:v0.14')
  await expect(debug).toContainText('--target=envoy')
  await debug.getByRole('button', { name: 'Start debugging' }).click()
  await expect(toasts(page)).toContainText(`Started ${container} in ${POD}`)
  const patch = writes(
    clusters.demo,
    'PATCH',
    `/api/v1/namespaces/shop/pods/${POD}/ephemeralcontainers`,
  )[0]!
  expect(patch.type).toBe('application/strategic-merge-patch+json')
  expect(patch.body.spec.ephemeralContainers[0]).toMatchObject({
    name: container,
    image: 'nicolaka/netshoot:v0.14',
    targetContainerName: 'envoy',
    stdin: true,
    tty: true,
  })
  // The shell opens in the debug container once it runs.
  const detail = panel(page, 'Pod', POD)
  await expect(detail.getByRole('tab', { name: 'Shell' })).toHaveAttribute('aria-selected', 'true')
  await expect(detail.getByLabel('Container')).toHaveValue(container)
  await expect(screen(page, container)).toContainText(`root@${POD}:/#`, { timeout: 15_000 })

  // Any image, without sharing processes.
  await menuAction(page, 'Pod', POD, 'Debug…')
  await debug.getByLabel('Other image').fill('ubuntu:24.04')
  await expect(debug.getByRole('radio').last()).toBeChecked()
  await debug.getByLabel('Share processes with').selectOption('')
  await expect(debug).not.toContainText('--target')
  await debug.getByLabel('Other image').fill('')
  await expect(debug.getByRole('button', { name: 'Start debugging' })).toBeDisabled()
  await debug.getByLabel('Other image').fill('ubuntu:24.04')
  await debug.getByRole('button', { name: 'Start debugging' }).click()
  const patches = () =>
    writes(clusters.demo, 'PATCH', `/api/v1/namespaces/shop/pods/${POD}/ephemeralcontainers`)
  await expect.poll(() => patches().length).toBe(2)
  expect(patches()[1]!.body.spec.ephemeralContainers[0]).toEqual(
    expect.not.objectContaining({ targetContainerName: expect.anything() }),
  )
})

test('forward a port to a pod', async ({ page, kubestacks }) => {
  const opened = await mockOpenExternal(kubestacks.app)
  const local = await freePort()
  await open(page, 'Pods', POD)
  await menuAction(page, 'Pod', POD, 'Forward a port…')
  const forward = dialog(page)
  await expect(forward.getByRole('radio', { name: 'app · http · 8080' })).toBeChecked()
  await forward.getByRole('radio', { name: 'envoy · admin · 9901' }).check()
  await expect(forward.getByLabel('Local port', { exact: true })).toHaveValue('9901')
  await forward.getByRole('radio', { name: 'app · http · 8080' }).check()
  await forward.getByLabel('Local port', { exact: true }).fill('')
  await expect(forward).toContainText(`port-forward pod/${POD} :8080`)
  await expect(forward.getByRole('button', { name: 'Start forwarding' })).toBeDisabled()
  await forward.getByLabel('Local port', { exact: true }).fill(String(local))
  await forward.getByRole('checkbox').check()
  await forward.getByRole('button', { name: 'Start forwarding' }).click()
  await expect(toasts(page)).toContainText(`Forwarding localhost:${local} to ${POD}:8080`)
  await expect.poll(opened).toEqual([`http://localhost:${local}`])
  await toasts(page).getByRole('button', { name: 'Open' }).click()
  await expect.poll(opened).toHaveLength(2)

  // Traffic reaches the pod.
  const response = await fetch(`http://127.0.0.1:${local}/healthz`)
  expect(await response.text()).toBe(`Hello from ${POD}:8080/healthz\n`)

  const menu = page.getByRole('button', { name: 'Port forwards' })
  await menu.click()
  const list = page.getByRole('dialog', { name: 'Port forwards' })
  await expect(list).toContainText(`${POD}:8080 · shop · demo`)
  // Open connections are counted.
  const socket = net.connect(local, '127.0.0.1')
  await expect(list).toContainText('1 connection')
  socket.destroy()
  await expect(list).toContainText('0 connections')
  await list.getByRole('button', { name: `localhost:${local}` }).click()
  await expect.poll(opened).toHaveLength(3)
  // Stopping also ends the connections still open.
  const connection = net.connect(local, '127.0.0.1')
  const closed = new Promise((resolve) => connection.once('close', resolve))
  await expect(list).toContainText('1 connection')
  await list.getByRole('button', { name: 'Stop forwarding' }).click()
  await closed
  await expect(menu).toHaveCount(0)
  await expect(fetch(`http://127.0.0.1:${local}/`)).rejects.toThrow()
})

test('forward a port to a service, and what can go wrong', async ({ page, clusters }) => {
  const local = await freePort()
  await open(page, 'Services', DEMO.services.storefront)
  await menuAction(page, 'Service', DEMO.services.storefront, 'Forward a port…')
  const forward = dialog(page)
  await expect(forward.getByRole('radio', { name: 'http · 80 → 8080' })).toBeChecked()
  // Low ports get a nearby high local port by default.
  await expect(forward.getByLabel('Local port', { exact: true })).toHaveValue('8080')
  await forward.getByLabel('Local port', { exact: true }).fill(String(local))
  await forward.getByRole('button', { name: 'Start forwarding' }).click()
  await expect(toasts(page)).toContainText(`Forwarding localhost:${local} to storefront:80`)
  const text = await (await fetch(`http://127.0.0.1:${local}/`)).text()
  expect(text).toMatch(/^Hello from storefront-[a-z0-9]+-[a-z0-9]+:8080\/\n$/)
  await page.getByRole('button', { name: 'Port forwards' }).click()
  await expect(page.getByRole('dialog', { name: 'Port forwards' })).toContainText(
    'storefront → storefront-',
  )
  await page.keyboard.press('Escape')

  // A pod that goes away breaks the connections, and the menu says so until they work again.
  const clear = clusters.demo.fail(/\/portforward$/, { status: 404, body: 'pod not found' })
  await expect(fetch(`http://127.0.0.1:${local}/`)).rejects.toThrow()
  await page.getByRole('button', { name: 'Port forwards' }).click()
  await expect(page.getByRole('dialog', { name: 'Port forwards' })).toContainText('404')
  clear()
  await fetch(`http://127.0.0.1:${local}/`)
  await expect(page.getByRole('dialog', { name: 'Port forwards' })).not.toContainText('404')
  await page.keyboard.press('Escape')

  // A named target port, resolved on the pod.
  await open(page, 'Services', 'metrics-server')
  await menuAction(page, 'Service', 'metrics-server', 'Forward a port…')
  await dialog(page)
    .getByLabel('Local port', { exact: true })
    .fill(String(await freePort()))
  await dialog(page).getByRole('button', { name: 'Start forwarding' }).click()
  await expect(toasts(page)).toContainText('to metrics-server:443')

  // The local port is taken.
  await open(page, 'Services', DEMO.services.grafana)
  await menuAction(page, 'Service', DEMO.services.grafana, 'Forward a port…')
  await dialog(page).getByLabel('Local port', { exact: true }).fill(String(local))
  await dialog(page).getByRole('button', { name: 'Start forwarding' }).click()
  await expect(dialog(page).getByRole('alert')).toContainText(
    `Port ${local} on this computer can’t be used (EADDRINUSE)`,
  )
  await page.keyboard.press('Escape')

  // No ready pods behind the service.
  await open(page, 'Services', DEMO.services.legacyGateway)
  await menuAction(page, 'Service', DEMO.services.legacyGateway, 'Forward a port…')
  await dialog(page)
    .getByLabel('Local port', { exact: true })
    .fill(String(await freePort()))
  await dialog(page).getByRole('button', { name: 'Start forwarding' }).click()
  await expect(dialog(page).getByRole('alert')).toContainText('has no ready pods to forward to')
  await page.keyboard.press('Escape')

  // A target port no container has.
  const broken = structuredClone(clusters.demo.object('Service', 'shop', 'cart')!)
  broken.spec.ports[0].targetPort = 'grpc'
  clusters.demo.upsert(broken)
  await open(page, 'Services', 'cart')
  await menuAction(page, 'Service', 'cart', 'Forward a port…')
  await dialog(page)
    .getByLabel('Local port', { exact: true })
    .fill(String(await freePort()))
  await dialog(page).getByRole('button', { name: 'Start forwarding' }).click()
  await expect(dialog(page).getByRole('alert')).toContainText('has a port named grpc')
  await page.keyboard.press('Escape')

  // Services without a selector have no pods to forward to.
  await goTo(page, 'Services')
  await page.getByPlaceholder('Filter services').fill('kubernetes')
  await row(page, 'Services', 'kubernetes').first().click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Forward a port…' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Pods without declared ports can still be forwarded to; read-only clusters too.
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: 'Make demo read-only' }).click()
  await open(page, 'Pods', DEMO.pods.debugShell)
  await menuAction(page, 'Pod', DEMO.pods.debugShell, 'Forward a port…')
  await expect(dialog(page).getByRole('radio')).toHaveCount(0)
  await expect(dialog(page).getByLabel('Remote port', { exact: true })).toHaveValue('8080')
})

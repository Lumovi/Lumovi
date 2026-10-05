/**
 * Shells on nodes, from Lumovi served in a cluster: its pod is created, and
 * its shell opened, as whoever is signed in, where the server says (or the
 * page, for itself); and a server can turn them off.
 */
import type { BrowserContext, Page } from '@playwright/test'
import { DEMO, expect, test } from './fixtures.ts'

const NODE = DEMO.nodes.worker1
const PROXY = { LUMOVI_AUTH: 'proxy' }

async function as(context: BrowserContext, user: string) {
  await context.setExtraHTTPHeaders({ 'X-Forwarded-User': user, 'X-Forwarded-Groups': 'sre' })
}

/** A node's Shell tab, as the page opens it. */
async function shellTab(page: Page, url: string) {
  await page.goto(`${url}cluster/demo/nodes?open=Node//${NODE}`)
  const detail = page.getByRole('complementary', { name: `Node ${NODE}` })
  await detail.getByRole('tab', { name: 'Shell' }).click()
  return detail
}

test('a node shell as whoever is signed in', async ({ page, context, serve, clusters }) => {
  const served = await serve({
    env: {
      ...PROXY,
      LUMOVI_NODE_SHELL_NAMESPACE: 'ops-tools',
      LUMOVI_NODE_SHELL_IMAGE: 'busybox:1.37',
    },
  })
  await as(context, 'frank@example.com')
  const detail = await shellTab(page, served.url)
  // The server's defaults.
  await expect(detail).toContainText('Podops-tools/lumovi-node-shell-…')
  await expect(detail).toContainText('Imagebusybox:1.37')

  // This page's own, kept by the browser.
  await detail.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Node shells' })
  await settings.getByRole('textbox', { name: 'Namespace' }).fill('kube-system')
  await settings.getByRole('textbox', { name: 'Image' }).fill('alpine:3.22')
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    'Node shell settings saved',
  )
  await page.reload()
  await detail.getByRole('tab', { name: 'Shell' }).click()
  await expect(detail).toContainText('Podkube-system/lumovi-node-shell-…')

  await detail.getByRole('button', { name: 'Start shell' }).click()
  const screen = page.getByRole('region', { name: `Shell on ${NODE}` }).locator('.xterm-rows')
  await expect(screen).toContainText(`root@${NODE}:~#`)
  // Created, and opened, as Frank.
  const created = clusters.demo.requests.find(
    (r) => r.method === 'POST' && r.path === '/api/v1/namespaces/kube-system/pods',
  )!
  expect(created.user).toBe('frank@example.com')
  const exec = clusters.demo.requests.findLast((r) => r.path.endsWith('/exec'))!
  expect(exec.headers['impersonate-user']).toBe('frank@example.com')
  await page.keyboard.type('hostname')
  await page.keyboard.press('Enter')
  await expect(screen).toContainText(new RegExp(`hostname\\s*${NODE}`))

  // Back to the server's, from the settings: for the next shell (this one keeps going).
  await detail.getByRole('button', { name: 'Settings' }).click()
  await settings.getByRole('button', { name: 'Use the defaults: ops-tools, busybox:1.37' }).click()
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    'Node shell settings saved',
  )
  await expect(detail.getByRole('button', { name: 'End' })).toBeVisible()
  // Leaving the page ends the shell, and its pod goes.
  await page.goto('about:blank')
  await expect
    .poll(() => clusters.demo.requests.filter((r) => r.method === 'DELETE').length)
    .toBe(1)
})

test('a server stopped (a rollout) deletes the node shells’ pods first', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const served = await serve({ env: PROXY })
  await as(context, 'frank@example.com')
  const detail = await shellTab(page, served.url)
  await detail.getByRole('button', { name: 'Start shell' }).click()
  const screen = page.getByRole('region', { name: `Shell on ${NODE}` }).locator('.xterm-rows')
  await expect(screen).toContainText(`root@${NODE}:~#`)
  const deletes = () => clusters.demo.requests.filter((r) => r.method === 'DELETE').length
  expect(deletes()).toBe(0)
  // Stopped as Kubernetes stops it, it waits for the pod to be deleted (which takes a while).
  clusters.demo.fail(/^\/api\/v1\/namespaces\/kube-system\/pods\/lumovi-node-shell-\w+$/, {
    delayMs: 1500,
  })
  const stopping = Date.now()
  await served.stop()
  expect(Date.now() - stopping).toBeGreaterThanOrEqual(1400)
  expect(deletes()).toBe(1)
})

test('a server that turned node shells off', async ({ page, context, serve }) => {
  const served = await serve({ env: { ...PROXY, LUMOVI_NODE_SHELL: 'off' } })
  await as(context, 'frank@example.com')
  const detail = await shellTab(page, served.url)
  await expect(detail).toContainText('Node shells are off')
  await expect(detail).toContainText('This Lumovi server turned them off.')
  // Nor does it start one when asked; nor a shell on its own computer.
  const refused = await page.evaluate(() =>
    Promise.all([
      window.lumovi!.terminal.open('node-shell-off', {
        target: 'node',
        context: 'demo',
        node: 'worker-1',
        mode: 'node',
      }),
      window.lumovi!.terminal.open('local-on-server', { target: 'local', context: 'demo' }),
    ]),
  )
  expect(refused).toMatchObject([
    {
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Node shells are turned off on this Lumovi server (LUMOVI_NODE_SHELL=off).',
      },
    },
    {
      ok: false,
      error: { code: 'invalid', message: 'A shell here is in a container or on a node' },
    },
  ])
})

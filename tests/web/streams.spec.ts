/**
 * Logs and shells over the page's WebSocket, and what happens to them (and
 * to calls) when the connection to the server drops.
 */
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { DEMO, DEMO_TOKEN, expect, signIn, test } from './fixtures.ts'

const POD = DEMO.pods.storefront[0]!
const detail = (page: Page) => page.getByRole('complementary', { name: `Pod ${POD}` })
const screen = (page: Page) =>
  page.getByRole('region', { name: 'Shell in app' }).locator('.xterm-rows')
const banner = (page: Page) =>
  page.getByRole('status').filter({ hasText: 'Reconnecting to KubeStacks…' })

test('logs and shells, as in the desktop app', async ({ page, serve, clusters }) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo/pods?open=Pod/shop/${POD}`, DEMO_TOKEN)
  // A stream that fails to start is tried again.
  const failing = clusters.demo.fail(`/api/v1/namespaces/shop/pods/${POD}/log`, { status: 500 })
  await detail(page).getByRole('tab', { name: 'Logs' }).click()
  await expect
    .poll(() => clusters.demo.requests.some((r) => r.path.endsWith('/log') && r.status === 500))
    .toBe(true)
  failing()
  const log = detail(page).getByRole('log', { name: 'Logs for app' })
  clusters.demo.appendLogs('shop', POD, 'app', ['served over a websocket'])
  await expect(log).toContainText('served over a websocket')

  // Saved as a download.
  const download = page.waitForEvent('download')
  await detail(page).getByRole('button', { name: 'Download' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe(`${POD}.log`)
  expect(readFileSync((await file.path())!, 'utf8')).toContain('served over a websocket')
  const again = page.waitForEvent('download')
  await detail(page).getByRole('button', { name: 'Download' }).click()
  expect((await again).suggestedFilename()).toBe(`${POD}.log`)
  // The container stops: its stream ends, and is followed again.
  const follows = () => clusters.demo.requests.filter((r) => r.query.follow === 'true').length
  const before = follows()
  clusters.demo.endLogs('shop', POD)
  await expect.poll(follows).toBeGreaterThan(before)
  clusters.demo.appendLogs('shop', POD, 'app', ['started again'])
  await expect(log).toContainText('started again')

  await detail(page).getByRole('tab', { name: 'Shell' }).click()
  await expect(screen(page)).toContainText(`root@${POD}:/#`)
  await page.keyboard.type('hostname')
  await page.keyboard.press('Enter')
  await expect(screen(page)).toContainText(new RegExp(`hostname\\s*${POD}`))
  // The shell exiting ends the session; another one starts.
  await page.keyboard.type('exit')
  await page.keyboard.press('Enter')
  await expect(detail(page).getByRole('status').filter({ hasText: 'exited' })).toBeVisible()
  await detail(page).getByRole('button', { name: 'Reconnect' }).last().click()
  await expect(screen(page)).toContainText(`root@${POD}:/#`)
  // Closing the panel ends the shell in the container.
  await detail(page).getByRole('button', { name: 'Close (Esc)' }).click()
  await expect.poll(() => clusters.demo.shells()).toBe(0)
})

test('the connection drops: streams stop, calls wait, and it comes back', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  // Behind a proxy, nobody's signed in by the server: the next one knows who it is too.
  const proxy = { KUBESTACKS_AUTH: 'proxy' }
  await context.setExtraHTTPHeaders({ 'X-Forwarded-User': 'ivan@example.com' })
  const served = await serve({ env: proxy })
  await page.goto(`${served.url}cluster/demo/pods?open=Pod/shop/${POD}`)
  await detail(page).getByRole('tab', { name: 'Logs' }).click()
  const log = detail(page).getByRole('log', { name: 'Logs for app' })
  clusters.demo.appendLogs('shop', POD, 'app', ['before the restart'])
  await expect(log).toContainText('before the restart')
  // In another tab, a call that's still waiting for its answer when the connection drops.
  const other = await context.newPage()
  clusters.demo.fail('/api/v1/persistentvolumes', { hang: true })
  await other.goto(`${served.url}cluster/demo/persistentvolumes`)
  await expect
    .poll(() => clusters.demo.requests.some((r) => r.path === '/api/v1/persistentvolumes'))
    .toBe(true)

  await served.stop()
  await expect(banner(page)).toContainText('What’s shown may be out of date.')
  await expect(other.getByRole('alert')).toContainText('Lost the connection to KubeStacks.')
  // It keeps trying, and after a while says what may be wrong.
  await expect(banner(page)).toContainText('a proxy in front of it may not pass WebSockets', {
    timeout: 15_000,
  })

  await serve({ env: proxy, port: served.port })
  await expect(banner(page)).toHaveCount(0, { timeout: 15_000 })
  // The logs that stopped carry on where they left off.
  clusters.demo.appendLogs('shop', POD, 'app', ['after the restart'])
  await expect(log).toContainText('after the restart')
})

test('a restarted server has no sessions: people sign in again', async ({ page, serve }) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo/pods?open=Pod/shop/${POD}`, DEMO_TOKEN)
  await detail(page).getByRole('tab', { name: 'Shell' }).click()
  await expect(screen(page)).toContainText(`root@${POD}:/#`)
  await served.stop()
  // The shell ended with the connection; what's typed meanwhile goes nowhere.
  await expect(
    detail(page).getByRole('status').filter({ hasText: 'Lost the connection to KubeStacks.' }),
  ).toBeVisible()
  // Closing it then says nothing to the server either.
  await detail(page).getByRole('button', { name: 'Close (Esc)' }).click()
  await serve({ port: served.port })
  await expect(
    page.getByRole('status').filter({ hasText: 'Your session ended. Sign in again' }),
  ).toBeVisible({ timeout: 15_000 })
  await page.getByPlaceholder('Paste a token').fill(DEMO_TOKEN)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
})

test('calls give up waiting for a server that doesn’t come back', async ({ page, serve }) => {
  await page.clock.install()
  const served = await serve({ env: { KUBESTACKS_AUTH: 'proxy' } })
  await page.context().setExtraHTTPHeaders({ 'X-Forwarded-User': 'judy@example.com' })
  await page.goto(`${served.url}cluster/demo/nodes`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  await served.stop()
  await expect(banner(page)).toBeVisible()
  // A call made now waits for the connection: half a minute, then it fails.
  await page.getByRole('button', { name: /^Refresh/ }).click()
  await page.clock.fastForward('00:31')
  await expect(page.getByText('Lost the connection to KubeStacks.').first()).toBeVisible()
})

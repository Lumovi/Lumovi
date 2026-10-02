/**
 * Behind an authenticating proxy (oauth2-proxy, say), which signs people in
 * and names them in headers: the server acts as whoever they name.
 */
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'

const PROXY = { KUBESTACKS_AUTH: 'proxy' }

/** The page's heading of the app, once it's shown. */
const heading = (page: Page) => page.getByRole('heading', { level: 1 })

test('signed in as the proxy says', async ({ page, context, serve, clusters }) => {
  const served = await serve({ env: PROXY })
  await context.setExtraHTTPHeaders({
    'X-Forwarded-User': 'frank@example.com',
    'X-Forwarded-Groups': 'platform, sre,on-call , dba,auditors,  ,interns',
  })
  await page.goto(`${served.url}cluster/demo/pods`)
  await expect(heading(page)).toHaveText('Pods')
  await expect
    .poll(() => clusters.demo.requests.findLast((r) => r.path === '/api/v1/pods'))
    .toMatchObject({
      user: 'frank@example.com',
      headers: { 'impersonate-group': 'platform, sre, on-call, dba, auditors, interns' },
    })

  await page.getByRole('button', { name: 'Signed in as frank@example.com' }).click()
  const account = page.getByRole('dialog', { name: 'Account' })
  await expect(account.getByRole('list', { name: 'Groups' }).getByRole('listitem')).toHaveText([
    'platform',
    'sre',
    'on-call',
    'dba',
    '+2 more',
  ])
  // Signing out is the proxy's business.
  await expect(account).toContainText('Signed in by the proxy in front of KubeStacks.')
  await expect(account.getByRole('button', { name: 'Sign out' })).toHaveCount(0)
  const out = await page.request.delete(`${served.url}api/session`, {
    headers: { Origin: new URL(served.url).origin },
  })
  expect(out.status()).toBe(204)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Signed in as frank@example.com' })).toBeVisible()
})

test('a proxy with its own headers, and a place to sign out', async ({ page, context, serve }) => {
  const served = await serve({
    env: {
      ...PROXY,
      KUBESTACKS_PROXY_USER_HEADER: 'X-Auth-Request-Email',
      KUBESTACKS_PROXY_GROUPS_HEADER: 'X-Auth-Request-Groups',
      KUBESTACKS_PROXY_SIGN_OUT_URL: 'https://auth.example.com/oauth2/sign_out',
    },
  })
  await context.setExtraHTTPHeaders({ 'X-Auth-Request-Email': 'grace@example.com' })
  await page.goto(served.url)
  await expect(heading(page)).toHaveText('Overview')
  await page.getByRole('button', { name: 'Signed in as grace@example.com' }).click()
  await expect(page.getByRole('list', { name: 'Groups' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Sign out' })).toHaveAttribute(
    'href',
    'https://auth.example.com/oauth2/sign_out',
  )
})

test('without a proxy saying who, or saying one of Kubernetes’ own', async ({
  page,
  context,
  serve,
}) => {
  const served = await serve({ env: PROXY })
  await page.goto(served.url)
  await expect(page.getByRole('heading', { name: 'KubeStacks', exact: true })).toBeVisible()
  await expect(page.getByText('KubeStacks doesn’t know who you are')).toBeVisible()

  await context.setExtraHTTPHeaders({ 'X-Forwarded-User': 'system:kube-scheduler' })
  await page.reload()
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'KubeStacks won’t act as this account: names starting with system:' }),
  ).toBeVisible()
  // Nor will its WebSocket.
  const refused = await page.evaluate(
    (url) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(url)
        socket.onopen = () => resolve('open')
        socket.onerror = () => resolve('refused')
      }),
    `${served.url.replace('http', 'ws')}api/socket`,
  )
  expect(refused).toBe('refused')
})

test('when the server’s own credentials stop working', async ({ page, context, serve }) => {
  // Its service account's token, say, rotated away.
  const served = await serve({ env: { ...PROXY, KUBESTACKS_CONTEXT: 'expired' } })
  await context.setExtraHTTPHeaders({ 'X-Forwarded-User': 'heidi@example.com' })
  await page.goto(`${served.url}cluster/expired/nodes`)
  await expect(
    page.getByRole('alert').filter({ hasText: 'Your credentials were rejected' }),
  ).toContainText('KubeStacks’ own credentials may have expired, or been revoked.')
  // Nobody's session ends over it: there's nothing they could sign in with to fix it.
  await expect(page.getByRole('button', { name: 'Signed in as heidi@example.com' })).toBeVisible()
})

/** Signing in to a KubeStacks server with a token, and the session that follows. */
import type { Page } from '@playwright/test'
import { expect, PEOPLE, signIn, test } from './fixtures.ts'

/** What the sign-in page says about the last session. */
const notice = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text })
const ENDED = 'Your session ended. Sign in again to carry on where you were.'

test('sign in with a token, at the address that was opened', async ({
  page,
  context,
  browser,
  serve,
  clusters,
}) => {
  const served = await serve()
  await page.goto(`${served.url}cluster/demo/pods`)
  await expect(page.getByRole('heading', { name: 'Sign in to KubeStacks' })).toBeVisible()
  await expect(page).toHaveTitle('Sign in — KubeStacks')
  const token = page.getByPlaceholder('Paste a token')
  const submit = page.getByRole('button', { name: 'Sign in', exact: true })
  await expect(token).toBeFocused()
  await expect(submit).toBeDisabled()

  // How to get a token, to copy.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByRole('button', { name: 'Copy the command' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'kubectl create token NAME --namespace NAMESPACE',
  )

  await token.fill('not-a-token')
  await submit.click()
  await expect(page.getByRole('alert')).toHaveText('The cluster doesn’t accept this token.')
  await expect(token).toHaveAttribute('aria-invalid', 'true')

  await token.fill(` ${PEOPLE.alice.token}\n`)
  await submit.click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  await expect(page).toHaveURL(`${served.url}cluster/demo/pods`)
  await expect(page).toHaveTitle('Pods · demo — KubeStacks')
  // The cluster sees Alice, with her token.
  await expect.poll(() => clusters.demo.requests.at(-1)?.user).toBe('alice@example.com')
  expect(served.log()).toContain('alice@example.com signed in with a token')

  // Who is signed in; everyone's system:authenticated goes without saying.
  await page.getByRole('button', { name: 'Signed in as alice@example.com' }).click()
  const account = page.getByRole('dialog', { name: 'Account' })
  await expect(account).toContainText('alice@example.com')
  await expect(account.getByRole('list', { name: 'Groups' }).getByRole('listitem')).toHaveText([
    'developers',
    'on-call',
  ])

  // Someone else, in another browser, stays signed in when Alice signs out.
  const elsewhere = await browser.newContext()
  const bob = await elsewhere.newPage()
  await signIn(bob, `${served.url}cluster/demo/nodes`, PEOPLE.bob.token)
  await account.getByRole('button', { name: 'Sign out' }).click()
  await expect(notice(page, 'You’ve signed out.')).toBeVisible()
  await bob
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'Pods' })
    .click()
  await expect(bob.getByRole('heading', { level: 1 })).toHaveText('Pods')
  await elsewhere.close()
  await expect(page.getByPlaceholder('Paste a token')).toBeVisible()
  expect(served.log()).toContain('alice@example.com signed out')
  // Its pages can't reach the cluster any more.
  const session = await page.request.get(`${served.url}api/session`)
  expect(session.status()).toBe(401)
  expect(await session.json()).toEqual({ auth: 'token' })
})

test('a session ends: it expires, or its person signs out in another tab', async ({
  page,
  context,
  serve,
}) => {
  // About three seconds.
  const served = await serve({ env: { KUBESTACKS_SESSION_HOURS: '0.0008' } })
  await signIn(page, served.url, PEOPLE.bob.token)
  await expect(notice(page, ENDED)).toBeVisible({ timeout: 15_000 })

  const longer = await serve()
  await signIn(page, longer.url, PEOPLE.bob.token)
  const other = await context.newPage()
  await other.goto(`${longer.url}cluster/demo/nodes`)
  await expect(other.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  await page.getByRole('button', { name: 'Signed in as bob@example.com' }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  // The other tab learns of it from the server, and says so.
  await expect(notice(other, 'You’ve signed out.')).toBeVisible()
})

test('a token that stops working ends its session', async ({ page, serve, clusters }) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo/workloads`, PEOPLE.bob.token)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workloads')
  // Revoked (or expired): the page's next request (its lists poll) is refused.
  clusters.demo.setUser(PEOPLE.bob.token, undefined)
  await expect(notice(page, ENDED)).toBeVisible({ timeout: 20_000 })
  // Signing in again comes back to where it was.
  clusters.demo.setUser(PEOPLE.bob.token, PEOPLE.bob.user)
  await page.getByPlaceholder('Paste a token').fill(PEOPLE.bob.token)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workloads')
})

test('signing in when the cluster can’t say whose a token is, and signing out failing', async ({
  page,
  serve,
}) => {
  const offline = await serve({ env: { KUBESTACKS_CONTEXT: 'offline' } })
  await page.goto(offline.url)
  await page.getByPlaceholder('Paste a token').fill('any-token')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('ECONNREFUSED')
  // It can be tried again.
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled()

  const served = await serve()
  await signIn(page, served.url, PEOPLE.alice.token)
  await page.route('**/api/session', (route) =>
    route.request().method() === 'DELETE' ? route.abort() : route.fallback(),
  )
  await page.getByRole('button', { name: 'Signed in as alice@example.com' }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    'Couldn’t sign out',
  )
  // Still signed in, and it can try again.
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeEnabled()
})

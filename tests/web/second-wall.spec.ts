/**
 * The second wall: a session signed in from a browser that says where its requests come from
 * (Sec-Fetch-Site) is held to it from then on, and only Lumovi's own page acts as its person. One
 * whose browser said nothing as it signed in is an old browser's, and isn't held (nor, when the
 * door hands plugins' code over, is it ever given any).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserContext } from '@playwright/test'
import { DEMO_TOKEN, expect, FROM_LUMOVI, refusedConfig, signIn, test } from './fixtures.ts'

const UNSAID =
  'This request didn’t say it came from Lumovi’s own page (Sec-Fetch-Site), so Lumovi didn’t act on it.'

/** The session cookie a browser holds. */
const sessionCookie = async (context: BrowserContext) =>
  (await context.cookies()).find((cookie) => cookie.name === 'lumovi-session')!.value

test('a session signed in from a page is believed only from Lumovi’s own page, and a refusal changes nothing', async ({
  serve,
  page,
}) => {
  const served = await serve()
  const session = `${served.url}api/session`
  await signIn(page, `${served.url}cluster/demo/pods`, DEMO_TOKEN)
  // As Lumovi's own page asks: signed in.
  expect((await page.request.get(session, { headers: FROM_LUMOVI })).status()).toBe(200)
  // Anything else, or nothing at all: nobody's signed in, and the sign-in page says why.
  for (const site of [undefined, 'same-site', 'cross-site', 'none', 'Same-Origin']) {
    const asked = await page.request.get(session, {
      headers: site === undefined ? {} : { 'Sec-Fetch-Site': site },
    })
    expect(asked.status(), String(site)).toBe(401)
    expect(await asked.json()).toEqual({ auth: 'token', problem: 'browser' })
    expect(asked.headers()['set-cookie'], String(site)).toBeUndefined()
  }
  // Any other request of it is refused, naming the header and nothing else of it.
  const copy = await page.request.get(`${served.url}api/files/${'A'.repeat(43)}`, {
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  })
  expect(copy.status()).toBe(403)
  expect(await copy.json()).toEqual({ error: UNSAID })
  // Not even to sign out: no page elsewhere can sign anyone out, nor clear their cookie.
  const out = await page.request.delete(session, {
    headers: { Origin: new URL(served.url).origin, 'Sec-Fetch-Site': 'same-site' },
  })
  expect(out.status()).toBe(403)
  expect(await out.json()).toEqual({ error: UNSAID })
  expect(out.headers()['set-cookie']).toBeUndefined()
  expect(served.log()).not.toContain('signed out')
  // The session is as it was, and its page goes on.
  expect((await page.request.get(session, { headers: FROM_LUMOVI })).status()).toBe(200)
  await page.reload()
  await expect(page.getByRole('button', { name: /^Signed in as/ })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  // Its browser said where its sign-in came from and then stopped (what a gateway that takes the
  // header out looks like): said once for the session, not for each request.
  await page.request.get(session)
  expect(served.log().match(/sent Sec-Fetch-Site as it signed in and has stopped/g)).toHaveLength(1)
})

test('a session whose sign-in said nothing of where it came from is an old browser’s: not held', async ({
  serve,
  page,
}) => {
  const served = await serve()
  // Signed in as a browser that sends no Sec-Fetch-Site would (its cookie in the page's jar).
  const signedIn = await page.request.post(`${served.url}api/session`, {
    headers: { Origin: new URL(served.url).origin },
    data: { token: DEMO_TOKEN },
  })
  expect(signedIn.status()).toBe(200)
  expect((await page.request.get(`${served.url}api/session`)).status()).toBe(200)
})

test('switched off, no session is held by it', async ({ serve, page }) => {
  const served = await serve({ env: { LUMOVI_SEC_FETCH_SITE: 'off' } })
  await signIn(page, `${served.url}cluster/demo/pods`, DEMO_TOKEN)
  expect((await page.request.get(`${served.url}api/session`)).status()).toBe(200)
})

test('what a session’s sign-in said is kept with it: a restart doesn’t change it', async ({
  serve,
  page,
  context,
}) => {
  const env = { LUMOVI_DATA_DIR: mkdtempSync(join(tmpdir(), 'lumovi-data-')) }
  const served = await serve({ env })
  await signIn(page, `${served.url}cluster/demo/pods`, DEMO_TOKEN)
  const cookie = await sessionCookie(context)
  await expect.poll(() => served.log()).toContain('signed in with a token')
  await served.stop()
  const again = await serve({ env, port: served.port })
  const asked = (headers: Record<string, string>) =>
    fetch(`${again.url}api/session`, {
      headers: { Cookie: `lumovi-session=${cookie}`, ...headers },
    })
  const unsaid = await asked({})
  expect(unsaid.status).toBe(401)
  expect(await unsaid.json()).toEqual({ auth: 'token', problem: 'browser' })
  expect((await asked(FROM_LUMOVI)).status).toBe(200)
})

test('behind a sign-in proxy said to pass Sec-Fetch-Site through, every request is held to it; behind one not said to, nobody is', async ({
  serve,
  page,
  context,
  clusters,
}) => {
  const alice = { 'X-Forwarded-User': 'alice@example.com' }
  const held = await serve({ env: { LUMOVI_AUTH: 'proxy', LUMOVI_PROXY_SEC_FETCH_SITE: 'on' } })
  const session = `${held.url}api/session`
  // As Lumovi's own page asks: who they are.
  expect(
    (await page.request.get(session, { headers: { ...alice, ...FROM_LUMOVI } })).status(),
  ).toBe(200)
  // Anything else, or nothing at all (a browser too old to send it): refused, never let through.
  for (const site of [undefined, 'same-site', 'cross-site', 'none', 'Same-Origin']) {
    const asked = await page.request.get(session, {
      headers: { ...alice, ...(site === undefined ? {} : { 'Sec-Fetch-Site': site }) },
    })
    expect(asked.status(), String(site)).toBe(401)
    expect(await asked.json()).toEqual({ auth: 'proxy', problem: 'browser' })
  }
  const copy = await page.request.get(`${held.url}api/files/${'A'.repeat(43)}`, {
    headers: alice,
  })
  expect(copy.status()).toBe(403)
  expect(await copy.json()).toEqual({ error: UNSAID })
  // Said once for the person, not for each request.
  expect(
    held.log().match(/A request of alice@example.com’s came through the sign-in proxy without/g),
  ).toHaveLength(1)
  // The page, through a proxy that drops the header (fetched again, a request goes without it):
  // one card says so, in the proxy's place, and nothing of who they are.
  await context.setExtraHTTPHeaders(alice)
  await page.route(`${held.url}api/**`, async (route) =>
    route.fulfill({ response: await route.fetch() }),
  )
  await page.goto(held.url)
  const refused = page.getByRole('alert')
  await expect(refused).toContainText('Lumovi refused a request from this browser')
  await expect(refused).toContainText(
    'It didn’t say it came from Lumovi’s own page (the Sec-Fetch-Site header): this browser may be too old to send it, or the sign-in proxy may not pass it on. If trying again doesn’t help, ask whoever runs Lumovi.',
  )
  await expect(refused.getByRole('button', { name: 'Try again' })).toBeVisible()
  await expect(page.getByText('Lumovi doesn’t know who you are')).toHaveCount(0)
  await page.unroute(`${held.url}api/**`)

  // Not said to (the default): nobody is held, and a request that says nothing is theirs.
  const unheld = await serve({ env: { LUMOVI_AUTH: 'proxy' } })
  expect((await page.request.get(`${unheld.url}api/session`, { headers: alice })).status()).toBe(
    200,
  )
  expect(unheld.log()).toContain(
    'Plugins that run code aren’t offered: this server’s proxy isn’t said to pass Sec-Fetch-Site through (LUMOVI_PROXY_SEC_FETCH_SITE).',
  )

  // Where it would mean nothing, Lumovi doesn't start.
  expect(await refusedConfig(clusters, { LUMOVI_PROXY_SEC_FETCH_SITE: 'on' })).toContain(
    'LUMOVI_PROXY_SEC_FETCH_SITE is for auth.mode proxy; with token the header is always checked.',
  )
  expect(
    await refusedConfig(clusters, {
      LUMOVI_AUTH: 'proxy',
      LUMOVI_PROXY_SEC_FETCH_SITE: 'on',
      LUMOVI_SEC_FETCH_SITE: 'off',
    }),
  ).toContain(
    'LUMOVI_PROXY_SEC_FETCH_SITE is on but LUMOVI_SEC_FETCH_SITE is off: nothing is checked. Turn one off or both on.',
  )
  expect(
    await refusedConfig(clusters, { LUMOVI_AUTH: 'proxy', LUMOVI_PROXY_SEC_FETCH_SITE: 'yes' }),
  ).toContain('LUMOVI_PROXY_SEC_FETCH_SITE must be on or off, not "yes".')
})

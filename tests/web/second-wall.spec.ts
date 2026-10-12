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
import { DEMO_TOKEN, expect, FROM_LUMOVI, signIn, test } from './fixtures.ts'

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

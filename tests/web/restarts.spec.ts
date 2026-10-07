/**
 * A restart signs nobody out: sessions and the AI assistants people allowed are kept (in a
 * file under LUMOVI_DATA_DIR, or a Secret of the cluster Lumovi runs in). What's kept says
 * nothing to whoever reads it, can't be made, changed or moved by whoever writes it (each entry
 * sealed with a key kept apart from it), and holds no credential anyone could use: cookies and
 * tokens by their hash, and a person's own token sealed again with a key only their cookie gives.
 * What mustn't be lost (a sign-out, an assistant let go) is kept before it's answered.
 */
import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Page, BrowserContext } from '@playwright/test'
import { call, connect, type Assistant } from './assistant-client.ts'
import {
  DEMO,
  expect,
  inCluster,
  PEOPLE,
  refusedConfig,
  signIn,
  test,
  type Served,
} from './fixtures.ts'

const SIGNED_IN = /^Signed in as/
const signedIn = (page: Page) => page.getByRole('button', { name: SIGNED_IN })
const signInPage = (page: Page) => page.getByPlaceholder('Paste a token')

/** What a server kept in its folder. */
const kept = (dir: string) => readFileSync(join(dir, 'state.json'), 'utf8')
const entries = (dir: string): Record<string, string> => {
  try {
    return JSON.parse(kept(dir)).entries
  } catch {
    return {}
  }
}
const count = (dir: string) => Object.keys(entries(dir)).length

/**
 * Once what's kept has this many entries: it's written a little after a change, and a server
 * stopped on Windows (no SIGTERM to finish on) writes nothing more.
 */
const written = (dir: string, entries: number) => expect.poll(() => count(dir)).toBe(entries)

/** The session cookie a browser holds. */
async function sessionCookie(context: BrowserContext): Promise<string> {
  return (await context.cookies()).find((cookie) => cookie.name === 'lumovi-session')!.value
}

/** An assistant's next connection, with what it signed in with before. */
async function reconnect(served: Served, assistant: Assistant): Promise<Client> {
  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('mcp', served.url), { authProvider: assistant }),
  )
  return client
}

/** A sign-in with a token, as the page makes one: its cookie. */
async function tokenSignIn(served: Served, token: string): Promise<string> {
  const response = await fetch(new URL('api/session', served.url), {
    method: 'POST',
    headers: { Origin: new URL(served.url).origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  expect(response.status).toBe(200)
  return /lumovi-session=([^;]+)/.exec(response.headers.get('set-cookie')!)![1]!
}

/** Whether a cookie is signed in. */
const signedInWith = (served: Served, cookie: string) =>
  fetch(new URL('api/session', served.url), {
    headers: { Cookie: `lumovi-session=${cookie}` },
  }).then((response) => response.status === 200)

test('a restart signs nobody out, and what’s kept says nothing of who', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const env = { LUMOVI_DATA_DIR: dir }
  const served = await serve({ env })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const cookie = await sessionCookie(context)
  await written(dir, 1)
  await served.stop()
  // Neither her token, nor her cookie, nor even her name is there; its key is beside it, its
  // folder's alone.
  const text = kept(dir)
  for (const secret of [PEOPLE.alice.token, cookie, 'alice@example.com', 'developers']) {
    expect(text).not.toContain(secret)
  }
  if (process.platform !== 'win32') {
    expect(statSync(join(dir, 'state.key')).mode & 0o777).toBe(0o600)
  }

  // The next server: she's still signed in, and acts with her own token, unsealed by her cookie.
  const again = await serve({ env, port: served.port })
  await page.goto(`${again.url}cluster/demo/pods`)
  await expect(signedIn(page)).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  await expect
    .poll(() => clusters.demo.requests.findLast((r) => r.path.includes('/pods'))?.user)
    .toBe('alice@example.com')
  // A cookie that isn't hers is nobody's.
  await context.clearCookies()
  await context.addCookies([{ name: 'lumovi-session', value: 'forged', url: again.url }])
  await page.goto(`${again.url}cluster/demo`)
  await expect(signInPage(page)).toBeVisible()

  // Signed in again, then out: kept so before it's answered, so even a server stopped at once
  // (as on Windows) doesn't bring it back.
  await signIn(page, `${again.url}cluster/demo`, PEOPLE.alice.token)
  await written(dir, 2)
  await page.getByRole('button', { name: SIGNED_IN }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(signInPage(page)).toBeVisible()
  expect(count(dir)).toBe(1)
  await again.stop()
  const third = await serve({ env, port: served.port })
  await page.goto(`${third.url}cluster/demo`)
  await expect(signInPage(page)).toBeVisible()
  await third.stop()
})

test('a sign-out that can’t be kept says so, and signs out all the same', async ({
  page,
  serve,
}) => {
  test.skip(process.platform === 'win32', 'a folder that can’t be written to, as POSIX has it')
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const served = await serve({ env: { LUMOVI_DATA_DIR: dir } })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  await written(dir, 1)
  // Where it's kept can't be written now.
  chmodSync(dir, 0o500)
  // The answer comes after the connection ends with the session, as it can on a slow
  // computer: the page waits for it, to say what wasn't kept.
  await page.route('**/api/session', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue()
    const response = await route.fetch()
    await new Promise((done) => setTimeout(done, 1_500))
    await route.fulfill({ response })
  })
  try {
    await page.getByRole('button', { name: SIGNED_IN }).click()
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(signInPage(page)).toBeVisible()
    await expect(page.getByRole('alert')).toContainText('Lumovi couldn’t keep that you signed out')
    expect(served.log()).toContain('Lumovi can’t keep who’s signed in')
  } finally {
    chmodSync(dir, 0o700)
  }
  await served.stop()
})

test('whoever can write what’s kept can’t make, change or move an entry in it', async ({
  serve,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const env = { LUMOVI_DATA_DIR: dir }
  const served = await serve({ env })
  const alice = await tokenSignIn(served, PEOPLE.alice.token)
  const bob = await tokenSignIn(served, PEOPLE.bob.token)
  await written(dir, 2)
  await served.stop()
  // Which is whose, nobody can tell: one is changed, the other moved.
  const pair = Object.entries(entries(dir))
  const [oneName, oneSealed] = pair[0]!
  const [otherName, otherSealed] = pair[1]!

  // Made: a session as Ana, for a cookie of one's own, sealed as Lumovi seals, with any key
  // but its own.
  const mine = randomBytes(32).toString('base64url')
  const key = randomBytes(32)
  const id = createHash('sha256').update(mine).digest('base64url')
  const name = createHmac(
    'sha256',
    Buffer.from(hkdfSync('sha256', key, 'lumovi', 'state names', 32)),
  )
    .update(`sessions\0${id}`)
    .digest('base64url')
  const nonce = randomBytes(12)
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(hkdfSync('sha256', key, 'lumovi', 'state seal', 32)),
    nonce,
  )
  cipher.setAAD(Buffer.from(name))
  const value = {
    section: 'sessions',
    key: id,
    value: {
      user: { name: 'ana@example.com', groups: ['platform-admins'] },
      expires: Date.now() + 3_600_000,
    },
  }
  const sealed = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  const forged = Buffer.concat([nonce, cipher.getAuthTag(), sealed]).toString('base64url')
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      entries: {
        [name]: forged,
        // Changed: a character off.
        [oneName]: `${oneSealed.slice(0, 40)}${oneSealed[40] === 'A' ? 'B' : 'A'}${oneSealed.slice(41)}`,
        // Moved: under another name.
        [`${otherName.slice(0, -1)}${otherName.endsWith('x') ? 'y' : 'x'}`]: otherSealed,
      },
    }),
  )
  const again = await serve({ env, port: served.port })
  expect(again.log()).toContain('3 of what Lumovi kept doesn’t open with its key')
  // Nobody's signed in: not Ana, nor Alice, nor Bob.
  for (const cookie of [mine, alice, bob]) expect(await signedInWith(again, cookie)).toBe(false)
  await again.stop()
})

test('past what it may hold, the sessions that end soonest make way, never a sign-out', async ({
  serve,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const env = { LUMOVI_DATA_DIR: dir, LUMOVI_STATE_MAX_BYTES: '3000' }
  const served = await serve({ env })
  const cookies: string[] = []
  for (let i = 0; i < 16; i++) cookies.push(await tokenSignIn(served, PEOPLE.bob.token))
  await expect.poll(() => served.log()).toMatch(/the \d+ sessions that end soonest aren’t kept/)
  await expect.poll(() => kept(dir).length).toBeLessThanOrEqual(3000)
  // A sign-out is kept, before it's answered, all the same.
  const newest = cookies.at(-1)!
  const before = count(dir)
  const out = await fetch(new URL('api/session', served.url), {
    method: 'DELETE',
    headers: { Origin: new URL(served.url).origin, Cookie: `lumovi-session=${newest}` },
  })
  expect(out.status).toBe(204)
  expect(count(dir)).toBe(before - 1)
  await served.stop()
  // After a restart: the oldest sign in again, the newest still kept is signed in, and the one
  // signed out isn't.
  const again = await serve({ env, port: served.port })
  expect(await signedInWith(again, cookies[0]!)).toBe(false)
  expect(await signedInWith(again, cookies.at(-2)!)).toBe(true)
  expect(await signedInWith(again, newest)).toBe(false)
  await again.stop()
})

test('behind a proxy, assistants carry on across a restart, and what their person made read-only holds', async ({
  page,
  context,
  serve,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const env = { LUMOVI_AUTH: 'proxy', LUMOVI_DATA_DIR: dir }
  const served = await serve({ env })
  await context.setExtraHTTPHeaders({ 'X-Forwarded-User': 'frank@example.com' })
  await page.goto(`${served.url}cluster/demo`)
  const { client, assistant } = await connect(page, served)
  expect((await call(client, 'list_resources', { cluster: 'demo', kind: 'ns' })).error).toBe(false)
  // He makes demo read-only for himself (and his assistants).
  await page.goto(`${served.url}cluster/demo`)
  await page.getByRole('button', { name: 'Cluster', exact: true }).click()
  await page.getByRole('switch', { name: 'Read-only' }).click()
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await call(client, 'list_clusters')).text).toMatch(/read-only/)
  await page.close()
  // Its grant, its refresh token, its access token, and what he made read-only.
  await written(dir, 4)
  await served.stop()
  const tokens = assistant.tokens()!
  for (const secret of [tokens.access_token, tokens.refresh_token!, 'frank@example.com']) {
    expect(kept(dir)).not.toContain(secret)
  }

  // The next server: its session there is new, but it's still allowed (nobody's asked again),
  // and demo is still read-only for it, before Frank opens a page.
  const again = await serve({ env, port: served.port })
  await expect(call(client, 'list_clusters')).rejects.toThrow('That session has ended')
  const next = await reconnect(again, assistant)
  expect((await call(next, 'list_resources', { cluster: 'demo', kind: 'ns' })).error).toBe(false)
  const scale = {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    replicas: 3,
    reason: 'Busy.',
  }
  expect((await call(next, 'scale', scale)).text).toMatch(/demo is read-only in Lumovi/)
  // Its refresh token still renews it, once.
  const token = (refresh: string) =>
    fetch(new URL('oauth/token', again.url), {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }),
    })
  const renewed = (await (await token(tokens.refresh_token!)).json()) as { refresh_token: string }
  expect((await token(tokens.refresh_token!)).status).toBe(400)
  // Revoked (it signs out): kept so before it's answered, so a restart doesn't bring it back.
  const revoked = await fetch(new URL('oauth/revoke', again.url), {
    method: 'POST',
    body: new URLSearchParams({ token: renewed.refresh_token }),
  })
  expect(revoked.status).toBe(200)
  expect(count(dir)).toBe(1)
  await again.stop()
  const third = await serve({ env, port: served.port })
  expect((await token(renewed.refresh_token)).status).toBe(400)
  await third.stop()
})

test('an assistant that passes its person’s own token on waits for them after a restart', async ({
  page,
  serve,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const env = { LUMOVI_DATA_DIR: dir }
  const served = await serve({ env })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const { assistant } = await connect(page, served)
  // Her session, and its grant, refresh token and access token.
  await written(dir, 4)
  await served.stop()

  // Her token is sealed with her cookie: until her browser's back, it can't act as her.
  const again = await serve({ env, port: served.port })
  await expect(reconnect(again, assistant)).rejects.toThrow(
    /Lumovi restarted since alice@example\.com last used it: open Lumovi in your browser/,
  )
  // Still allowed, all the same: her page lists it.
  await page.goto(`${again.url}cluster/demo`)
  await expect(signedIn(page)).toBeVisible()
  const next = await reconnect(again, assistant)
  expect((await call(next, 'list_resources', { cluster: 'demo', kind: 'ns' })).error).toBe(false)
  // She lets it go: kept so before her page hears it's done.
  await page.getByRole('button', { name: 'AI assistants (1 connected)' }).click()
  await page.getByRole('link', { name: /^Your assistants/ }).click()
  const yours = page.getByRole('region', { name: 'Your assistants' })
  await yours.getByRole('button', { name: 'Disconnect' }).click()
  await expect(yours).toContainText('None yet')
  expect(count(dir)).toBe(1)
  await again.stop()
})

test('in the cluster Lumovi runs in: kept in its Secret, sealed with a key apart from it', async ({
  page,
  serve,
  clusters,
}) => {
  const sa = inCluster(clusters)
  const key = randomBytes(32).toString('base64url')
  const env = { ...sa.env, LUMOVI_STATE_SECRET: 'lumovi-state', LUMOVI_STATE_KEY: key }
  // As the chart makes it: empty.
  const secret = () => clusters.demo.object('Secret', 'lumovi', 'lumovi-state')
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: 'lumovi-state', namespace: 'lumovi' },
  })
  const served = await serve({ env })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const state = () => {
    const data = (secret() as { data?: Record<string, string> }).data?.['state.json']
    return data ? Buffer.from(data, 'base64').toString('utf8') : '{"entries":{}}'
  }
  await expect.poll(() => Object.keys(JSON.parse(state()).entries)).toHaveLength(1)
  for (const secret of [PEOPLE.alice.token, 'alice@example.com', key]) {
    expect(state()).not.toContain(secret)
  }
  await served.stop()
  const again = await serve({ env, port: served.port })
  await page.goto(`${again.url}cluster/demo`)
  await expect(signedIn(page)).toBeVisible()
  await again.stop()

  // One that isn't there, or isn't a name, or outside a cluster, or without its key, or with
  // one too short: it doesn't start, and says why.
  expect(await refusedConfig(clusters, { ...env, LUMOVI_STATE_SECRET: 'lumovi-gone' })).toContain(
    'Lumovi can’t read Secret lumovi/lumovi-gone, where it keeps who’s signed in and the AI assistants they allowed',
  )
  expect(await refusedConfig(clusters, { LUMOVI_STATE_SECRET: 'Not_Valid' })).toContain(
    'LUMOVI_STATE_SECRET must name a Secret, like lumovi-state, not "Not_Valid".',
  )
  expect(await refusedConfig(clusters, { LUMOVI_STATE_SECRET: 'lumovi-state' })).toContain(
    'LUMOVI_STATE_SECRET keeps who’s signed in in the cluster Lumovi runs in, and it isn’t running in one',
  )
  expect(await refusedConfig(clusters, { ...env, LUMOVI_STATE_KEY: undefined })).toContain(
    'LUMOVI_STATE_SECRET needs LUMOVI_STATE_KEY',
  )
  expect(await refusedConfig(clusters, { ...env, LUMOVI_STATE_KEY: 'short' })).toContain(
    'LUMOVI_STATE_KEY must be at least 32 characters',
  )
})

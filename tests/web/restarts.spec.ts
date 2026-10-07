/**
 * A restart signs nobody out: sessions and the AI assistants people allowed are kept (in a
 * file under LUMOVI_DATA_DIR, or a Secret of the cluster Lumovi runs in), and nothing kept is
 * a credential anyone could use: cookies and tokens by their hash, and a person's own token
 * sealed with a key only their cookie gives.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
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

/** What a server kept in its folder. */
const kept = (dir: string) => readFileSync(join(dir, 'state.json'), 'utf8')

/**
 * Once what's kept has this many in a section: it's written a little after a change, and a
 * server stopped on Windows (no SIGTERM to finish on) writes nothing more.
 */
const written = (dir: string, section: string, count: number) =>
  expect
    .poll(() => {
      try {
        return Object.keys(JSON.parse(kept(dir))[section]).length
      } catch {
        return 0
      }
    })
    .toBe(count)

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

const signedIn = (page: Page) => page.getByRole('button', { name: SIGNED_IN })

test('a restart signs nobody out, and keeps no one’s token or cookie as it is', async ({
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
  await written(dir, 'sessions', 1)
  await served.stop()
  // Her session is kept, its token sealed: neither her token nor her cookie is there.
  const text = kept(dir)
  expect(text).not.toContain(PEOPLE.alice.token)
  expect(text).not.toContain(cookie)
  const sessions = Object.values(JSON.parse(text).sessions) as { user: unknown; sealed?: string }[]
  expect(sessions).toEqual([
    {
      user: {
        name: 'alice@example.com',
        groups: ['developers', 'on-call', 'system:authenticated'],
      },
      expires: expect.any(Number),
      sealed: expect.any(String),
    },
  ])

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
  await expect(page.getByPlaceholder('Paste a token')).toBeVisible()

  // Signed in again, then out: she stays signed out across the next restart.
  await signIn(page, `${again.url}cluster/demo`, PEOPLE.alice.token)
  await page.getByRole('button', { name: SIGNED_IN }).click()
  await written(dir, 'sessions', 2)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await written(dir, 'sessions', 1)
  await again.stop()
  const third = await serve({ env, port: served.port })
  await page.goto(`${third.url}cluster/demo`)
  await expect(page.getByPlaceholder('Paste a token')).toBeVisible()
  await third.stop()
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
  await written(dir, 'grants', 1)
  await written(dir, 'readOnly', 1)
  await served.stop()
  // Its tokens are kept by their hash alone.
  const text = kept(dir)
  const tokens = assistant.tokens()!
  expect(text).not.toContain(tokens.access_token)
  expect(text).not.toContain(tokens.refresh_token!)

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
  const renew = () =>
    fetch(new URL('oauth/token', again.url), {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token!,
      }),
    })
  expect((await renew()).status).toBe(200)
  expect((await renew()).status).toBe(400)
  await again.stop()
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
  await written(dir, 'grants', 1)
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
  await again.stop()
})

test('in the cluster Lumovi runs in: kept in its Secret', async ({ page, serve, clusters }) => {
  const sa = inCluster(clusters)
  const env = { ...sa.env, LUMOVI_STATE_SECRET: 'lumovi-state' }
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
    return data ? Buffer.from(data, 'base64').toString('utf8') : ''
  }
  await expect
    .poll(() => Object.keys(JSON.parse(state() || '{"sessions":{}}').sessions))
    .toHaveLength(1)
  expect(state()).not.toContain(PEOPLE.alice.token)
  await served.stop()
  const again = await serve({ env, port: served.port })
  await page.goto(`${again.url}cluster/demo`)
  await expect(signedIn(page)).toBeVisible()
  await again.stop()

  // One that isn't there, or isn't a name, or outside a cluster: it doesn't start, and says why.
  expect(
    await refusedConfig(clusters, { ...sa.env, LUMOVI_STATE_SECRET: 'lumovi-gone' }),
  ).toContain(
    'Lumovi can’t read Secret lumovi/lumovi-gone, where it keeps who’s signed in and the AI assistants they allowed',
  )
  expect(await refusedConfig(clusters, { LUMOVI_STATE_SECRET: 'Not_Valid' })).toContain(
    'LUMOVI_STATE_SECRET must name a Secret, like lumovi-state, not "Not_Valid".',
  )
  expect(await refusedConfig(clusters, { LUMOVI_STATE_SECRET: 'lumovi-state' })).toContain(
    'LUMOVI_STATE_SECRET keeps who’s signed in in the cluster Lumovi runs in, and it isn’t running in one',
  )
})

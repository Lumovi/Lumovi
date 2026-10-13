/**
 * Lumovi's check of a plugin's box, by the calls and requests that reach the server outside a
 * check as Lumovi's own page runs it: a nonce that isn't text, a hand-back that isn't the boxes'
 * reports, a nonce judged already, a catcher's address with nothing in it, a socket to it, the
 * box's files asked for their headers alone, and a session the second wall doesn't hold. Each is
 * answered with nothing, or fails closed, and nothing hands code over.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import WebSocket from 'ws'
import { BOX_CHECK_WAYS } from '../../src/shared/box-check.ts'
import type { NotHanded, PluginCode } from '../../src/shared/plugin-hand-over.ts'
import { audited, DEMO_TOKEN, expect, freePort, signIn, test, type Served } from './fixtures.ts'

const TOYS = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
  pages: [{ id: overview, title: Overview }]
`

type Serve = (options?: { env?: Record<string, string>; port?: number }) => Promise<Served>

/** A server with plugins (it knows its own address), and a stand-in of Lumovi's own with code. */
async function served(serve: Serve, env: Record<string, string> = {}) {
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'toys.yaml'), TOYS)
  writeFileSync(join(included, 'toys.js'), 'box.then(() => {})\n')
  const port = await freePort()
  return serve({
    port,
    env: {
      LUMOVI_URL: `http://127.0.0.1:${port}`,
      LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included,
      ...env,
    },
  })
}

type Kube = {
  boxCheckStart(): Promise<{ nonce: string; code: Record<string, string> } | undefined>
  boxCheckEnd(nonce: unknown, reports: unknown, heard: unknown): Promise<string | undefined>
  pluginHandOver(plugin: string): Promise<true | NotHanded>
  pluginCode(plugin: string): Promise<PluginCode>
}
/** The page's own calls of the check, made as any script on the page could make them. */
const calls = (page: Page) => ({
  start: () =>
    page.evaluate(() =>
      (window as unknown as { lumovi: { kube: Kube } }).lumovi.kube.boxCheckStart(),
    ),
  end: (nonce: unknown, reports: unknown, heard: unknown) =>
    page.evaluate(
      ([nonce, reports, heard]) =>
        (window as unknown as { lumovi: { kube: Kube } }).lumovi.kube.boxCheckEnd(
          nonce,
          reports,
          heard,
        ),
      [nonce, reports, heard] as const,
    ),
  handOver: () =>
    page.evaluate(() =>
      (window as unknown as { lumovi: { kube: Kube } }).lumovi.kube.pluginHandOver('toys'),
    ),
})

test('a check’s calls that aren’t a check fail closed: nothing passes, and once failed it stays so', async ({
  serve,
  page,
}) => {
  const server = await served(serve)
  await signIn(page, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
  const check = calls(page)
  // A nonce that isn't text: nothing, and no check is judged.
  expect(await check.end(5, {}, [])).toBeUndefined()
  expect(await check.handOver()).toBe('not-checked')
  // What's handed back isn't the boxes' reports, and what was heard isn't a list: failed.
  const first = (await check.start())!
  expect(Object.keys(first.code).sort()).toEqual(['first', 'later', 'second'])
  expect(await check.end(first.nonce, 'reports', 'heard')).toBe('failed')
  // Judged once: the same nonce again is answered with nothing.
  expect(await check.end(first.nonce, null, [])).toBeUndefined()
  // Something of it still reaching the catcher changes nothing that's said: it failed already.
  expect((await fetch(`${server.url}box-check/${first.nonce}/fetch`)).status).toBe(204)
  // A later check, however it ends, doesn't undo a failure: one that didn't finish is answered as
  // the failure it was.
  const second = (await check.start())!
  expect(await check.end(second.nonce, null, [])).toBe('failed')
  expect(await check.handOver()).toBe('check-failed')
  expect(audited(server, 'plugin.box-check').map((event) => event.outcome)).toEqual(['failure'])
  expect(audited(server, 'plugin.code')).toEqual([])
})

/** Every box's report, whole, every way refused and nothing found: what a box that held sends. */
const held = (nonce: string) => ({
  first: JSON.stringify({
    check: nonce,
    role: 'first',
    ways: Object.fromEntries(BOX_CHECK_WAYS.map((way) => [way, 'refused'])),
    found: [],
    unlooked: [],
  }),
  second: JSON.stringify({
    check: nonce,
    role: 'second',
    ways: Object.fromEntries(BOX_CHECK_WAYS.map((way) => [way, 'refused'])),
    found: [],
    unlooked: [],
  }),
  later: JSON.stringify({ check: nonce, role: 'later', found: [], unlooked: [] }),
})

test('a hand-back that isn’t a whole report fails its check, whichever way it falls short', async ({
  serve,
  browser,
}) => {
  const server = await served(serve)
  // Each in a session of its own, so no failure before it stands in for its own.
  const whole = (nonce: string) => JSON.parse(held(nonce).first) as Record<string, unknown>
  const { fetch: _, ...leftOut } = whole('NONCE').ways as Record<string, string>
  const shapes: Record<string, (nonce: string) => unknown> = {
    'not an object': () => [],
    'another check’s': (nonce) => ({ ...whole(nonce), check: `${nonce}-other` }),
    'a find that isn’t a list': (nonce) => ({ ...whole(nonce), found: 'caches' }),
    'ways that aren’t a list of ways': (nonce) => ({ ...whole(nonce), ways: [] }),
    'a way left out': (nonce) => ({ ...whole(nonce), ways: leftOut }),
  }
  for (const [shape, first] of Object.entries(shapes)) {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await signIn(page, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
      const check = calls(page)
      const { nonce } = (await check.start())!
      const reports = { ...held(nonce), first: JSON.stringify(first(nonce)) }
      expect(await check.end(nonce, reports, []), shape).toBe('failed')
      expect(await check.handOver(), shape).toBe('check-failed')
    } finally {
      await context.close()
    }
  }
  // (And a whole one, in a session of its own, passes: it's the shape that failed each.)
  const context = await browser.newContext()
  const page = await context.newPage()
  await signIn(page, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
  const { nonce } = (await calls(page).start())!
  expect(await calls(page).end(nonce, held(nonce), [])).toBe('passed')
  await context.close()
  // Each said as a report Lumovi couldn't read, and whose: nothing is said to have got out.
  const said = audited(server, 'plugin.box-check')
  expect(said.map((event) => event.outcome)).toEqual([
    ...Object.keys(shapes).map(() => 'failure'),
    'success',
  ])
  for (const event of said.slice(0, -1)) {
    expect(event.summary).toBe(
      'Lumovi’s check of this browser failed: a box’s report came back in a form it couldn’t read',
    )
    expect(event.details).toEqual({ browser: expect.any(String), unreadable: ['first'] })
  }
  expect(server.log()).toContain(
    'failed: a box’s report came back in a form Lumovi couldn’t read. This browser isn’t handed any plugin’s code.',
  )
  expect(server.log()).not.toContain('lets a plugin’s code out of its box: .')
})

test('what reaches the catcher under a name that’s no way’s is kept, as “other”, and fails the check', async ({
  serve,
  page,
}) => {
  const server = await served(serve)
  await signIn(page, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
  const check = calls(page)
  const { nonce } = (await check.start())!
  expect((await fetch(`${server.url}box-check/${nonce}/made-up`)).status).toBe(204)
  // Whatever the boxes say, what reached the catcher got out: named "other", not dropped.
  expect(await check.end(nonce, held(nonce), [])).toBe('failed')
  const [failed] = audited(server, 'plugin.box-check')
  expect(failed?.outcome).toBe('failure')
  expect(failed?.details?.ways).toEqual(['other'])
  expect(server.log()).toContain('lets a plugin’s code out of its box: other.')
  expect(await check.handOver()).toBe('check-failed')
})

test('the catcher’s address with nothing in it, a socket to it, and the box’s files asked for their headers', async ({
  serve,
}) => {
  const server = await served(serve)
  // No nonce, no way: let go, as any address of it is.
  for (const path of ['box-check/', 'box-check/abc']) {
    expect((await fetch(`${server.url}${path}`)).status, path).toBe(204)
  }
  // A socket to it is ended at once, whatever it names.
  const ended = await new Promise<string>((done) => {
    const socket = new WebSocket(`${server.url.replace(/^http/, 'ws')}box-check/`)
    socket.on('open', () => done('opened'))
    socket.on('error', () => done('ended'))
    socket.on('close', () => done('ended'))
  })
  expect(ended).toBe('ended')
  // The box's two files, asked for their headers alone: the walls, and no body.
  for (const path of ['plugin-box/box.html', 'plugin-box/box.js']) {
    const asked = await fetch(`${server.url}${path}`, { method: 'HEAD' })
    expect(asked.status, path).toBe(200)
    expect(await asked.text(), path).toBe('')
  }
})

test('an old browser’s session, where the second wall holds, starts no check and is handed no code', async ({
  serve,
  page,
  browser,
}) => {
  const server = await served(serve)
  // (The same server, to a browser that says where its sign-in came from: held, and checked.)
  const said = await browser.newContext()
  const saidPage = await said.newPage()
  await signIn(saidPage, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
  expect(await calls(saidPage).handOver()).toBe('not-checked')
  expect(await calls(saidPage).start()).toMatchObject({ nonce: expect.any(String) })
  await said.close()
  // Signed in as a browser that sends no Sec-Fetch-Site would (its cookie in the page's jar).
  const signedIn = await page.request.post(`${server.url}api/session`, {
    headers: { Origin: new URL(server.url).origin },
    data: { token: DEMO_TOKEN },
  })
  expect(signedIn.status()).toBe(200)
  // Its page, whose own requests do say they come from it: the session stays as it signed in.
  await page.goto(`${server.url}cluster/demo/pods`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  const check = calls(page)
  expect(await check.start()).toBeUndefined()
  expect(await check.end('made-up', null, [])).toBeUndefined()
  expect(await check.handOver()).toBe('not-held')
  expect(
    await page.evaluate(() =>
      (window as unknown as { lumovi: { kube: Kube } }).lumovi.kube.pluginCode('toys'),
    ),
  ).toEqual({ ok: false, refused: 'not-held' })
  expect(audited(server, 'plugin.code')).toEqual([])
})

test('where the second wall doesn’t hold, no check is started, and none is judged', async ({
  serve,
  page,
}) => {
  const server = await served(serve, { LUMOVI_SEC_FETCH_SITE: 'off' })
  await signIn(page, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
  const check = calls(page)
  expect(await check.start()).toBeUndefined()
  expect(await check.end('made-up', null, [])).toBeUndefined()
  expect(await check.handOver()).toBe('not-held')
})

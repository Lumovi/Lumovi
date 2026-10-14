/**
 * A hostile plugin against a team's server, where only the plugins in its image run: the server
 * has no call that would install, update, take back, remove or agree to a plugin, and refuses
 * each by name, writing nothing. And a box's code that gets past the box's own wall still asks
 * Lumovi's API as nobody.
 */
import { mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import WebSocket from 'ws'
import { IPC } from '../../src/shared/api.ts'
import type { PluginCode } from '../../src/shared/plugin-hand-over.ts'
import { DEMO_TOKEN, expect, freePort, FROM_LUMOVI, signIn, test } from './fixtures.ts'
import { recording } from './recording.ts'

/** Every call of the desktop's store: what a server must not answer. */
const STORE = [IPC.pluginStore, IPC.pluginInstall, IPC.pluginGoBack, IPC.pluginRemove]

test('a server installs no plugin: every call of the store is refused by name, and nothing is written', async ({
  page,
  serve,
}) => {
  const data = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const served = await serve({ env: { LUMOVI_DATA_DIR: data } })
  await signIn(page, `${served.url}cluster/demo/pods`, DEMO_TOKEN)
  // The page's own API has none of them.
  expect(
    await page.evaluate(() =>
      Object.keys(window.lumovi!).filter((key) => /store|install/i.test(key)),
    ),
  ).toEqual([])
  // Asked straight over the page's own socket, as a page would: each refused, by name.
  const answers = await page.evaluate(
    async ({ url, channels }) => {
      const socket = new WebSocket(url)
      await new Promise((opened, failed) => {
        socket.onopen = opened
        socket.onerror = failed
      })
      // (By the number each was asked under: a Map, so nothing the server says names a property.)
      const replies = new Map<number, unknown>()
      socket.onmessage = (event) => {
        const said = JSON.parse(event.data as string) as {
          type: string
          id?: number
          error?: string
        }
        if (said.type === 'result' && said.id !== undefined)
          replies.set(said.id, said.error ?? 'answered')
      }
      channels.forEach((channel, i) =>
        socket.send(
          JSON.stringify({ type: 'invoke', id: i + 1, channel, args: ['toys', '9.9.9', 'agreed'] }),
        ),
      )
      for (let tries = 0; tries < 100 && replies.size < channels.length; tries++) {
        await new Promise((wait) => setTimeout(wait, 50))
      }
      socket.close()
      return channels.map((_, i) => replies.get(i + 1))
    },
    { url: `${served.url.replace(/^http/, 'ws')}api/socket`, channels: STORE },
  )
  expect(answers).toEqual(STORE.map((channel) => `There’s no ${channel} to call`))
  // Nothing was written where a store would keep plugins.
  expect(readdirSync(data).filter((name) => /plugin/i.test(name))).toEqual([])
})

/** What a request to the server carried, as it arrived, and how it was answered. */
const COPY = `api/files/${'A'.repeat(43)}`

/**
 * A box's code with the box's own wall taken away (the tests' build can): what it asks of
 * Lumovi's own API, as a page's script could, and what it saw of each.
 */
const asksLumovi = (server: string) => `box.then(async ({ post }) => {
  const saw = {}
  const ask = (name, path, init) =>
    fetch(${JSON.stringify(server)} + path, init).then(
      (answer) => (saw[name] = 'answered ' + answer.type + ' ' + answer.status),
      (error) => (saw[name] = 'failed ' + error.name),
    )
  await ask('session', 'api/session?from=box', { credentials: 'include' })
  await ask('sessionUnread', 'api/session?from=box', { credentials: 'include', mode: 'no-cors' })
  await ask('signOut', 'api/session?from=box', { method: 'DELETE', credentials: 'include' })
  await ask('copy', '${COPY}?from=box', { credentials: 'include', mode: 'no-cors' })
  await ask('send', '${COPY}?from=box', { method: 'POST', credentials: 'include', mode: 'no-cors', body: 'x' })
  saw.socket = await new Promise((done) => {
    const socket = new WebSocket(${JSON.stringify(server.replace(/^http/, 'ws'))} + 'api/socket?from=box')
    socket.onopen = () => done('opened')
    socket.onclose = () => done('closed')
    setTimeout(() => done('no word'), 4000)
  })
  post(JSON.stringify(saw))
})`

test('with its own wall taken away, a box’s code asks Lumovi’s API as nobody: no cookie goes with its asks, and with one, each is still refused for where it comes from', async ({
  serve,
  page,
}) => {
  // Lumovi behind a proxy that keeps what arrives: the server is told the proxy's address is its own.
  const port = await freePort()
  const served = await serve({
    env: { LUMOVI_URL: `http://127.0.0.1:${port}`, LUMOVI_TEST_BOX_WALL_OFF: 'connect-src' },
  })
  const front = await recording(port, new URL(served.url))
  try {
    await signIn(page, `${front.url}cluster/demo/pods`, DEMO_TOKEN)
    // (The person's own page is answered at the same address, with their cookie, as Lumovi's.)
    const mine = () =>
      page.evaluate((url) => fetch(url).then((answer) => answer.status), `${front.url}api/session`)
    expect(await mine()).toBe(200)
    expect(front.arrived.at(-1)).toMatchObject({ cookie: true, site: 'same-origin', status: 200 })
    await page.waitForFunction(() => '__lumoviBox' in window)
    const saw = await page.evaluate(
      (code) =>
        new Promise<string>((done) => {
          ;(
            window as unknown as { __lumoviBox: { openBox(options: object): unknown } }
          ).__lumoviBox.openBox({
            plugin: 'ways',
            code,
            heard: done,
            ended: (end: unknown) => done(`ended ${JSON.stringify(end)}`),
          })
        }),
      asksLumovi(front.url),
    )
    // What its code saw: no answer it could read, and no socket.
    expect(JSON.parse(saw)).toEqual({
      session: 'failed TypeError',
      sessionUnread: 'failed TypeError',
      signOut: 'failed TypeError',
      copy: 'failed TypeError',
      send: 'failed TypeError',
      socket: 'closed',
    })
    // What reached the server for it: every ask without the person's cookie, from another site
    // (or, a socket's start, from no origin Lumovi knows), and none answered as anyone.
    const forBox = front.arrived.filter((each) => each.how.includes('from=box'))
    const short = (how: string) => how.replace(/A{43}/, '…').replace('?from=box', '')
    expect(forBox.map((each) => `${short(each.how)} → ${each.status}`)).toEqual([
      'GET /api/session → 401',
      'GET /api/session → 401',
      // (The sign-out itself was never sent: the browser asks first whether it may, and Lumovi
      // has no such answer for anyone.)
      'OPTIONS /api/session → 404',
      'GET /api/files/… → 404',
      'POST /api/files/… → 404',
      'GET /api/socket → 403',
    ])
    for (const each of forBox) {
      expect(each.cookie, each.how).toBe(false)
      if (each.how.includes('/api/socket')) expect(each.origin, each.how).toBe('null')
      else expect(each.site, each.how).toBe('cross-site')
    }
    // And were a browser to send the person's cookie with them (one that keeps no cookie to its
    // own site): each says it isn't from Lumovi's page, and is refused for that.
    const cookie = (await page.context().cookies())
      .filter((each) => each.name === 'lumovi-session')
      .map((each) => `${each.name}=${each.value}`)[0]!
    const withCookie = (path: string, method = 'GET') =>
      fetch(`${front.url}${path}`, {
        method,
        headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site', Origin: 'null' },
        ...(method === 'POST' ? { body: 'x' } : {}),
      }).then((answer) => answer.status)
    expect([
      await withCookie('api/session'),
      await withCookie('api/session', 'DELETE'),
      await withCookie(COPY),
      await withCookie(COPY, 'POST'),
    ]).toEqual([401, 403, 403, 403])
    const socket = await new Promise<string>((done) => {
      const ws = new WebSocket(`${front.url.replace(/^http/, 'ws')}api/socket`, {
        headers: { Cookie: cookie, Origin: 'null' },
      })
      ws.on('open', () => done('opened'))
      ws.on('unexpected-response', (_request, answer) => done(`refused ${answer.statusCode}`))
      ws.on('error', (error) => done(`failed ${error.message}`))
    })
    expect(socket).toBe('refused 403')
    // Nobody was signed out, and the person's page is answered still.
    expect(await mine()).toBe(200)
    expect(served.log()).not.toContain('signed out')
  } finally {
    await front.close()
  }
})

test('a plugin’s code is served at no address, only handed to Lumovi’s own page; and nothing the server serves is another site’s to load', async ({
  serve,
  page,
}) => {
  test.slow()
  const port = await freePort()
  const served = await serve({ port, env: { LUMOVI_URL: `http://127.0.0.1:${port}` } })
  await signIn(page, `${served.url}cluster/demo/pods`, DEMO_TOKEN)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  // A plugin of Lumovi's own, as it's handed to the page once this browser's box is checked.
  const handed = await page.evaluate(() =>
    (
      window as unknown as { __lumoviDoor: { codeOf(plugin: string): Promise<PluginCode> } }
    ).__lumoviDoor.codeOf('karpenter'),
  )
  if (!handed.ok) throw new Error(`Karpenter’s code wasn’t handed over: ${handed.refused}`)
  // A stretch of it that's nothing else's.
  const stretch = handed.code.slice(handed.code.length >> 1, (handed.code.length >> 1) + 120)
  expect(stretch).toHaveLength(120)
  const cookie = (await page.context().cookies())
    .filter((each) => each.name === 'lumovi-session')
    .map((each) => `${each.name}=${each.value}`)[0]!
  const ask = (path: string, as: 'nobody' | 'the person') =>
    fetch(`${served.url}${path}`, {
      redirect: 'manual',
      headers: as === 'nobody' ? {} : { Cookie: cookie, ...FROM_LUMOVI },
    })
  const odd: string[] = []
  // Every file the server's pages are made of: none is another site's to load, and none holds it.
  const pages = resolve('out', 'renderer')
  const files = readdirSync(pages, { recursive: true, encoding: 'utf8' }).filter((file) =>
    statSync(join(pages, file)).isFile(),
  )
  expect(files.length).toBeGreaterThan(5)
  for (const file of files) {
    const answer = await ask(file.split(sep).join('/'), 'nobody')
    const text = await answer.text()
    if (answer.headers.get('cross-origin-resource-policy') === 'cross-origin')
      odd.push(`${file}: cross-origin`)
    if (answer.headers.get('x-content-type-options') !== 'nosniff')
      odd.push(`${file}: may be sniffed`)
    if (text.includes(stretch)) odd.push(`${file}: holds a plugin’s code`)
  }
  // And every address that might name a plugin's file, asked as nobody and as the person: never
  // a script, never its code.
  for (const path of [
    'karpenter.js',
    'plugin.js',
    'plugins/karpenter.js',
    'plugins/karpenter/plugin.js',
    'plugins/karpenter/plugin.yaml',
    'plugin-box/karpenter.js',
    'plugin-box/plugin.js',
    'assets/karpenter.js',
    'api/plugins/karpenter',
    'api/plugins/karpenter/code',
    'api/plugin-code/karpenter',
    'plugin-code/karpenter',
  ]) {
    for (const as of ['nobody', 'the person'] as const) {
      const answer = await ask(path, as)
      const type = answer.headers.get('content-type') ?? ''
      const text = await answer.text()
      if (/javascript|ecmascript|yaml/.test(type)) odd.push(`${path} as ${as}: ${type}`)
      if (answer.headers.get('cross-origin-resource-policy') === 'cross-origin')
        odd.push(`${path} as ${as}: cross-origin`)
      if (text.includes(stretch)) odd.push(`${path} as ${as}: its code`)
    }
  }
  expect(odd).toEqual([])
  // Not the box's own script either, which is Lumovi's: it's in the box's document, and at no
  // address of its own.
  expect((await ask('plugin-box/box.js', 'nobody')).status).toBe(404)
  const box = await ask('plugin-box/box.html', 'nobody')
  expect(box.headers.get('cross-origin-resource-policy')).toBeNull()
  expect(await box.text()).not.toContain(stretch)
})

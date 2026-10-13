/**
 * A hostile plugin against a team's server, where only the plugins in its image run: the server
 * has no call that would install, update, take back, remove or agree to a plugin, and refuses
 * each by name, writing nothing. And a box's code that gets past the box's own wall still asks
 * Lumovi's API as nobody.
 */
import { mkdtempSync, readdirSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { IPC } from '../../src/shared/api.ts'
import { DEMO_TOKEN, expect, freePort, signIn, test } from './fixtures.ts'

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
interface Arrived {
  how: string
  cookie: boolean
  site: string | undefined
  origin: string | undefined
  status?: number
}

/**
 * A plain proxy in front of a Lumovi server, at the address the server is told is its own: it
 * keeps what each request carried and how the server answered it, sockets among them, and
 * changes nothing.
 */
async function recording(port: number, server: URL) {
  const arrived: Arrived[] = []
  /** Sockets handed on: a server's close doesn't end them. */
  const open = new Set<net.Socket>()
  const noted = (request: http.IncomingMessage): Arrived => {
    const entry: Arrived = {
      how: `${request.method} ${request.url}`,
      cookie: request.headers.cookie !== undefined,
      site: request.headers['sec-fetch-site'] as string | undefined,
      origin: request.headers.origin,
    }
    arrived.push(entry)
    return entry
  }
  const proxy = http.createServer((request, answer) => {
    const entry = noted(request)
    const onward = http.request(
      {
        host: server.hostname,
        port: server.port,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (answered) => {
        entry.status = answered.statusCode
        answer.writeHead(answered.statusCode!, answered.headers)
        answered.pipe(answer)
      },
    )
    onward.on('error', () => answer.destroy())
    request.pipe(onward)
  })
  proxy.on('upgrade', (request, socket, head) => {
    const entry = noted(request)
    const onward = net.connect(Number(server.port), server.hostname, () => {
      for (const each of [socket as net.Socket, onward]) {
        open.add(each)
        each.on('close', () => open.delete(each))
      }
      const headers = Object.entries(request.headers)
        .map(([name, value]) => `${name}: ${String(value)}\r\n`)
        .join('')
      onward.write(`${request.method} ${request.url} HTTP/1.1\r\n${headers}\r\n`)
      onward.write(head)
      onward.once('data', (first: Buffer) => {
        entry.status = Number(/^HTTP\/1\.1 (\d+)/.exec(first.toString())?.[1])
      })
      onward.pipe(socket)
      socket.pipe(onward)
    })
    onward.on('error', () => socket.destroy())
    socket.on('error', () => onward.destroy())
  })
  await new Promise<void>((listening) => proxy.listen(port, '127.0.0.1', listening))
  return {
    url: `http://127.0.0.1:${port}/`,
    arrived,
    close: () =>
      new Promise<void>((closed) => {
        for (const each of open) each.destroy()
        proxy.closeAllConnections()
        proxy.close(() => closed())
      }),
  }
}

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

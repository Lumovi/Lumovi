/**
 * Lumovi's check of a plugin's box in the person's own browser, in each browser engine: it passes
 * where the box holds (no box reaching out, nor finding another's things, side by side or after),
 * and code is handed over; with one of the box's walls taken away on purpose (the tests' build
 * alone can), it fails and no code is; and a check that never answers doesn't pass either. What
 * reached the server is what it judges by, even once it has judged: a page already handed code
 * then ends. Behind a sign-in proxy, a pass is the page's alone. And the check's own request (the
 * control): where what stands in front of Lumovi doesn't pass its catcher on, nothing can be
 * told of a box, and no browser passes, least of all one whose box lets requests out.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, firefox, webkit, type Page } from '@playwright/test'
import type { NotHanded, PluginCode } from '../../src/shared/plugin-hand-over.ts'
import { scriptsIn } from '../e2e/plugin-box/sealed.ts'
import { audited, DEMO_TOKEN, expect, freePort, signIn, test, type Served } from './fixtures.ts'
import { as } from './fleet.ts'
import { PHONE, signInNarrow } from './phone.ts'

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

/** What reaches a gateway for the check's catcher: how it came, the way it named, what it said. */
interface Asked {
  by: 'http' | 'socket'
  way: string
  origin: string | undefined
  site: string | undefined
}
/** What a gateway cuts off, of what's asked of the catcher. */
type Cuts = (asked: Asked) => boolean
const NOTHING: Cuts = () => false
const EVERYTHING: Cuts = () => true
const REQUESTS: Cuts = (asked) => asked.by === 'http'
const SOCKETS: Cuts = (asked) => asked.by === 'socket'
/**
 * What doesn't come from Lumovi's own page: an origin that is nobody's, or another site. A rule
 * a gateway may well have, and exactly what every request of a box's is.
 */
const NOT_LUMOVIS_OWN: Cuts = (asked) => asked.origin === 'null' || asked.site === 'cross-site'

/**
 * Something in front of Lumovi, as a gateway or a proxy stands in front of a server: it passes
 * everything on to `to` but what `cuts` says of the check's catcher (`box-check/`), which it
 * cuts off (until it's set right). What was asked of the catcher is kept, with whether it was
 * cut: those left the browser, whatever the browser then saw of them.
 */
async function gateway(to: number, cutting: Cuts) {
  const port = await freePort()
  const asked: (Asked & { cut: boolean })[] = []
  let cuts = cutting
  /** Whether it's for the catcher, and cut: noted either way. */
  const cut = (by: Asked['by'], req: http.IncomingMessage): boolean => {
    const way = /\/box-check\/[^/]+\/([^/?]*)/.exec(req.url ?? '')?.[1]
    if (way === undefined) return false
    const site = req.headers['sec-fetch-site']
    const of: Asked = { by, way, origin: req.headers.origin, site: site as string | undefined }
    asked.push({ ...of, cut: cuts(of) })
    return asked.at(-1)!.cut
  }
  const front = http.createServer((req, res) => {
    if (cut('http', req)) return void req.socket.destroy()
    const forward = http.request(
      { host: '127.0.0.1', port: to, path: req.url, method: req.method, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      },
    )
    forward.on('error', () => res.destroy())
    req.pipe(forward)
  })
  front.on('upgrade', (req, socket, head) => {
    if (cut('socket', req)) return void socket.destroy()
    const upstream = net.connect(to, '127.0.0.1', () => {
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n` +
          Object.entries(req.headers)
            .map(([name, value]) => `${name}: ${String(value)}`)
            .join('\r\n') +
          '\r\n\r\n',
      )
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  await new Promise<void>((done) => front.listen(port, '127.0.0.1', done))
  return {
    url: `http://127.0.0.1:${port}/`,
    asked,
    /** What it cut off, each as how it came and the way it named. */
    dropped: () => asked.filter((each) => each.cut).map((each) => `${each.by} ${each.way}`),
    /** Set right: it passes the catcher on from now. */
    passAll: () => void (cuts = NOTHING),
    close: () => front.close(),
  }
}

/** A server with plugins behind such a gateway, which is the address it knows as its own. */
async function behind(serve: Serve, cuts: Cuts, env: Record<string, string> = {}) {
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'toys.yaml'), TOYS)
  writeFileSync(join(included, 'toys.js'), 'box.then(() => {})\n')
  const port = await freePort()
  const front = await gateway(port, cuts)
  const server = await serve({
    port,
    env: {
      LUMOVI_URL: front.url.slice(0, -1),
      LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included,
      ...env,
    },
  })
  return { server, front }
}

/** Toys' code, as the page asks for it: this browser's box checked first, if it's due. */
const codeOf = (page: Page) =>
  page.evaluate(async () => {
    const door = (
      window as unknown as { __lumoviDoor: { codeOf(plugin: string): Promise<PluginCode> } }
    ).__lumoviDoor
    const answer = await door.codeOf('toys')
    return answer.ok ? 'handed' : answer.refused
  })

/** Whether toys' code would be handed to the page, asked without checking anything. */
const handOver = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        lumovi: { kube: { pluginHandOver(plugin: string): Promise<true | NotHanded> } }
      }
    ).lumovi.kube.pluginHandOver('toys'),
  )

/** What the page says to the server of its checks, as it says it: each call's arguments. */
function checksSaid(page: Page) {
  const said: { start: unknown[]; end: unknown[][] } = { start: [], end: [] }
  const calls = new Map<number, string>()
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      const message = JSON.parse(String(payload)) as {
        id: number
        channel: string
        args: unknown[]
      }
      calls.set(message.id, message.channel)
      if (message.channel === 'kube:box-check-end') said.end.push(message.args)
    })
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(String(payload)) as { type: string; id: number; value: unknown }
      if (message.type === 'result' && calls.get(message.id) === 'kube:box-check-start') {
        said.start.push(message.value)
      }
    })
  })
  return said
}

/** Toys' page, shown by the tests' stage. */
const showToys = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __lumoviDoor: { show(shown: object): void } }).__lumoviDoor.show({
      plugin: 'toys',
      name: 'Toys',
      version: '1.2.0',
      context: 'demo',
    }),
  )

for (const [name, engine] of [
  ['Chromium', chromium],
  ['Firefox', firefox],
  ['WebKit', webkit],
] as const) {
  test.describe(`Lumovi’s check of a plugin’s box in ${name}`, () => {
    test.setTimeout(120_000)

    /** Lumovi's page in that browser, signed in; nothing if the browser isn't here. */
    async function pageIn(server: Served) {
      // Chromium is every run's; the other two are CI's Browsers job's, which says so.
      const must = name === 'Chromium' || process.env.LUMOVI_E2E_BROWSERS === 'all'
      test.skip(!must && Boolean(process.env.CI), 'CI’s Browsers job runs it')
      const browser = await engine.launch().catch((error: unknown) => {
        if (must) throw error
        return undefined
      })
      test.skip(!browser, `${name} doesn’t start on this computer`)
      const page = await browser!.newPage()
      const said = checksSaid(page)
      await signIn(page, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
      await page.waitForFunction(() => '__lumoviDoor' in window)
      return { page, said, done: () => browser!.close() }
    }

    test('where the box holds, the check passes and the code is handed over', async ({ serve }) => {
      const server = await served(serve)
      const { page, said, done } = await pageIn(server)
      try {
        expect(await codeOf(page)).toBe('handed')
        expect(audited(server, 'plugin.box-check').map((event) => event.outcome)).toEqual([
          'success',
        ])
        // Three boxes reported: the two side by side found nothing of each other's, and the
        // later one nothing they kept. (Kept with the run: what each way did in this browser.)
        const [[, reports, heard]] = said.end as [[string, Record<string, string>, string[]]]
        const read = Object.fromEntries(
          Object.entries(reports).map(([role, text]) => [role, JSON.parse(text) as object]),
        )
        expect(read).toEqual({
          first: expect.objectContaining({ role: 'first', found: [] }),
          second: expect.objectContaining({ role: 'second', found: [] }),
          later: expect.objectContaining({ role: 'later', found: [] }),
        })
        expect(heard).toEqual([])
        await test.info().attach(`${name}’s boxes`, {
          body: JSON.stringify(
            { browser: await page.evaluate(() => navigator.userAgent), ...read },
            null,
            2,
          ),
          contentType: 'application/json',
        })
      } finally {
        await done()
      }
    })

    test('with one of the box’s walls taken away, the check fails and no code is handed over', async ({
      serve,
    }) => {
      // (The tests' build alone has this switch: a release build has none of it.)
      const server = await served(serve, { LUMOVI_TEST_BOX_WALL_OFF: 'connect-src' })
      const { page, done } = await pageIn(server)
      try {
        expect(await codeOf(page)).toBe('check-failed')
        const [failed] = audited(server, 'plugin.box-check')
        expect(failed?.outcome).toBe('failure')
        // What got out is what reached the server, whatever the box said: each way the wall
        // held, a socket's upgrade among them.
        expect(failed?.details?.ways).toEqual(
          expect.arrayContaining(['fetch', 'xhr', 'event-source', 'web-socket']),
        )
        expect(failed?.summary).toMatch(
          /^Lumovi’s check found this browser lets a plugin’s code out: /,
        )
        // Asked again, it's the same: the check isn't run again for a browser that failed it.
        expect(await codeOf(page)).toBe('check-failed')
        expect(audited(server, 'plugin.box-check')).toHaveLength(1)
        expect(audited(server, 'plugin.code')).toEqual([])
      } finally {
        await done()
      }
    })
  })
}

test('a check whose worker never answers doesn’t pass: it didn’t finish, and can be run again', async ({
  serve,
  page,
}) => {
  test.slow()
  // (The tests' build alone can make the check's code one that never answers.)
  const server = await served(serve, { LUMOVI_TEST_BOX_CHECK: 'silent' })
  await signIn(page, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  expect(await codeOf(page)).toBe('check-unfinished')
  // Nothing in the history for a check that didn't finish; and no code.
  expect(audited(server, 'plugin.box-check')).toEqual([])
  expect(audited(server, 'plugin.code')).toEqual([])
  // Its page says so, and offers to open it again (which checks again).
  await page.evaluate(() =>
    (window as unknown as { __lumoviDoor: { show(shown: object): void } }).__lumoviDoor.show({
      plugin: 'toys',
      name: 'Toys',
      version: '1.2.0',
      context: 'demo',
    }),
  )
  const ended = page.getByTestId('plugin-ended')
  await expect(ended).toContainText(
    'Lumovi’s check of this browser didn’t finish in time, so it doesn’t run plugins’ code here yet.',
    { timeout: 40_000 },
  )
  await expect(ended.getByRole('button', { name: 'Open it again' })).toBeVisible()
  // And the Plugins page says it in toys' entry: not yet.
  await page.goto(`${server.url}cluster/demo/plugins?plugin=toys`)
  await expect(page.getByTestId('plugin-not-handed')).toHaveText(
    'Its pages don’t run here yet: Lumovi’s check of this browser didn’t finish in time.',
  )
})

test('what a box could only keep, found in Lumovi’s own page’s stores, fails the check: it got out', async ({
  serve,
  page,
}) => {
  const server = await served(serve)
  // As if the boxes' stores had landed in Lumovi's own origin: its page finds them there, by the
  // names the check gives them (a database's by the check's own channel's name, as it's made).
  await page.addInitScript(() => {
    let channel = ''
    const Broadcast = window.BroadcastChannel
    window.BroadcastChannel = class extends Broadcast {
      constructor(name: string) {
        super(name)
        if (name.startsWith('lumovi-box-check-')) channel = name
      }
    }
    const has = caches.has.bind(caches)
    caches.has = (name: string) =>
      name.startsWith('lumovi-box-check-') ? Promise.resolve(true) : has(name)
    const databases = indexedDB.databases.bind(indexedDB)
    indexedDB.databases = async () => [
      ...(await databases()),
      ...(channel ? [{ name: `${channel}-first`, version: 1 }] : []),
    ]
  })
  await signIn(page, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  expect(await codeOf(page)).toBe('check-failed')
  const [failed] = audited(server, 'plugin.box-check')
  expect(failed?.outcome).toBe('failure')
  expect(failed?.details?.ways).toEqual(expect.arrayContaining(['caches', 'indexed-db']))
  expect(audited(server, 'plugin.code')).toEqual([])
})

test('a page that can’t look where a box might leave word is unfinished, and the audit names caches, indexed-db, broadcast-channel', async ({
  serve,
  page,
}) => {
  const server = await served(serve)
  // (Lumovi's own page without them, as a browser that blocks this site's storage has it, until
  // the person allows it: the boxes, each in a worker of its own, are as they were.)
  await page.addInitScript(() => {
    if (sessionStorage.getItem('allowed')) return
    for (const name of ['BroadcastChannel', 'caches', 'indexedDB']) {
      Object.defineProperty(window, name, { value: undefined, configurable: true })
    }
  })
  await signIn(page, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  expect(await codeOf(page)).toBe('check-unlooked')
  const [unlooked] = audited(server, 'plugin.box-check')
  expect(unlooked?.outcome).toBe('failure')
  expect(unlooked?.details?.unlooked).toEqual(['broadcast-channel', 'caches', 'indexed-db'])
  expect(unlooked?.summary).toBe(
    'Lumovi couldn’t check this browser: it can’t look in its Cache Storage, IndexedDB or broadcast channels',
  )
  expect(audited(server, 'plugin.code')).toEqual([])
  // Asked again, it isn't checked again: this browser can't look, as it is.
  expect(await codeOf(page)).toBe('check-unlooked')
  expect(audited(server, 'plugin.box-check')).toHaveLength(1)
  // Its page says why in Lumovi's words, and what the person can change; it offers no "Open it
  // again", which would look again where it can't.
  await showToys(page)
  const ended = page.getByTestId('plugin-ended')
  await expect(ended).toContainText('Lumovi couldn’t check this browser.')
  await expect(ended).toContainText(
    'Here it can’t look in the places a box might keep things, so no plugin’s code runs in this browser.',
  )
  await expect(ended).toContainText(
    'If this browser blocks storage for this site, allowing it and reloading lets Lumovi check.',
  )
  await expect(ended.getByRole('button', { name: 'Open it again' })).toHaveCount(0)
  // The Plugins page says it in toys' entry, and checks nothing itself.
  await page.goto(`${server.url}cluster/demo/plugins?plugin=toys`)
  await expect(page.getByTestId('plugin-not-handed')).toHaveText(
    'Its pages don’t run here: Lumovi couldn’t check this browser.',
  )
  expect(audited(server, 'plugin.box-check')).toHaveLength(1)
  // Allowed, and the page loaded again: Lumovi checks again, and this time it passes.
  await page.evaluate(() => sessionStorage.setItem('allowed', 'yes'))
  await page.reload()
  await page.waitForFunction(() => '__lumoviDoor' in window)
  expect(await codeOf(page)).toBe('handed')
  expect(audited(server, 'plugin.box-check').map((event) => event.outcome)).toEqual([
    'failure',
    'success',
  ])
})

test('a look the page has but that throws is no look either: unfinished, and said where', async ({
  serve,
  page,
}) => {
  const server = await served(serve)
  // Lumovi's own page has its stores, but looking in them throws (as storage that's refused can).
  await page.addInitScript(() => {
    caches.has = () => Promise.reject(new DOMException('refused', 'SecurityError'))
    indexedDB.databases = () => Promise.reject(new DOMException('refused', 'SecurityError'))
  })
  await signIn(page, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  expect(await codeOf(page)).toBe('check-unlooked')
  const [unlooked] = audited(server, 'plugin.box-check')
  expect(unlooked?.details?.unlooked).toEqual(['caches', 'indexed-db'])
  expect(server.log()).toContain(
    'it can’t look in this browser’s Cache Storage or IndexedDB. This browser isn’t handed any plugin’s code.',
  )
  expect(audited(server, 'plugin.code')).toEqual([])
})

test('a channel the page can’t open is a look not made: unfinished, and said where', async ({
  serve,
  page,
}) => {
  const server = await served(serve)
  await page.addInitScript(() => {
    window.BroadcastChannel = class {
      constructor() {
        throw new DOMException('refused', 'SecurityError')
      }
    } as unknown as typeof BroadcastChannel
  })
  await signIn(page, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  expect(await codeOf(page)).toBe('check-unlooked')
  const [unlooked] = audited(server, 'plugin.box-check')
  expect(unlooked?.details?.unlooked).toEqual(['broadcast-channel'])
  expect(unlooked?.summary).toBe(
    'Lumovi couldn’t check this browser: it can’t look in its broadcast channels',
  )
})

test('where the check’s own request can’t reach the server, a box that lets requests out is handed no code: the check can’t be judged, and whoever runs Lumovi is told what to pass on', async ({
  serve,
  page,
}) => {
  // A box with a wall taken away, behind a gateway that passes everything but the check's
  // catcher: the box's requests leave the browser, and the server sees none of them.
  const { server, front } = await behind(serve, EVERYTHING, {
    LUMOVI_TEST_BOX_WALL_OFF: 'connect-src',
  })
  try {
    await signIn(page, `${front.url}cluster/demo/pods`, DEMO_TOKEN)
    await page.waitForFunction(() => '__lumoviDoor' in window)
    expect(await codeOf(page)).toBe('check-unreached')
    // (They did leave: the gateway cut them off. Lumovi's own three among them.)
    expect(front.dropped()).toEqual(
      expect.arrayContaining([
        'http fetch',
        'http xhr',
        'http event-source',
        'socket web-socket',
        'http origin',
        'http no-origin',
        'socket socket',
      ]),
    )
    expect(audited(server, 'plugin.code')).toEqual([])
    const [unreached, ...more] = audited(server, 'plugin.box-check')
    expect(more).toEqual([])
    expect(unreached).toMatchObject({
      outcome: 'failure',
      summary: 'Lumovi couldn’t check this browser: its own request didn’t reach the server',
      error: 'The check’s own request didn’t reach the server (either way).',
      details: { unreached: ['http-with-origin', 'http-without-origin', 'socket'] },
    })
    expect(server.log()).toMatch(
      /Lumovi’s check of a plugin’s box in Chrome \d+ couldn’t be judged: its own request didn’t arrive either way\. What’s in front of Lumovi must pass everything under \/box-check\/ on, as it passes the rest\./,
    )
    // Asked again from the same page, it isn't checked again: nothing in front of it has changed.
    expect(await codeOf(page)).toBe('check-unreached')
    expect(audited(server, 'plugin.box-check')).toHaveLength(1)
    // Its page says why, in Lumovi's words, and offers no "Open it again".
    await showToys(page)
    const ended = page.getByTestId('plugin-ended')
    await expect(ended).toContainText('Toys’ page couldn’t start.')
    await expect(ended).toContainText(
      'Lumovi couldn’t check this browser: its own test request didn’t reach this server, so it can’t tell what a plugin’s box lets out here. Something in front of Lumovi may not pass it on. Whoever runs Lumovi can see which in its log.',
    )
    await expect(ended.getByRole('button', { name: 'Open it again' })).toHaveCount(0)
    // The Plugins page says it in toys' entry, and checks nothing itself.
    await page.goto(`${front.url}cluster/demo/plugins?plugin=toys`)
    await expect(page.getByTestId('plugin-not-handed')).toHaveText(
      'Its pages don’t run here: Lumovi’s check of this browser couldn’t reach this server.',
    )
    expect(audited(server, 'plugin.box-check')).toHaveLength(1)
  } finally {
    front.close()
  }
})

test('a gateway that passes Lumovi’s own page on and cuts off what a box’s request looks like: the control is cut off with them, and a box that lets requests out is handed no code', async ({
  serve,
  page,
}) => {
  // The case the control has a box's shape for. Whatever asks the catcher from Lumovi's own
  // page would be passed on here; every request of a box's, with its wall taken away, is cut.
  const { server, front } = await behind(serve, NOT_LUMOVIS_OWN, {
    LUMOVI_TEST_BOX_WALL_OFF: 'connect-src',
  })
  try {
    await signIn(page, `${front.url}cluster/demo/pods`, DEMO_TOKEN)
    await page.waitForFunction(() => '__lumoviDoor' in window)
    expect(await codeOf(page)).toBe('check-unreached')
    expect(audited(server, 'plugin.code')).toEqual([])
    // The control came as a box's requests come, and was cut off as they were: nothing of
    // either reached the server, and so nothing is said of the box.
    const control = front.asked.filter((each) =>
      ['origin', 'no-origin', 'socket'].includes(each.way),
    )
    expect(control.map(({ by, way, origin, cut }) => ({ by, way, origin, cut }))).toEqual([
      { by: 'http', way: 'origin', origin: 'null', cut: true },
      { by: 'http', way: 'no-origin', origin: undefined, cut: true },
      { by: 'socket', way: 'socket', origin: 'null', cut: true },
    ])
    for (const each of control.filter((one) => one.by === 'http')) {
      expect(each.site, each.way).toBe('cross-site')
    }
    expect(front.dropped()).toEqual(
      expect.arrayContaining(['http fetch', 'http xhr', 'http event-source', 'socket web-socket']),
    )
    expect(front.asked.filter((each) => !each.cut)).toEqual([])
    expect(audited(server, 'plugin.box-check')).toMatchObject([
      {
        outcome: 'failure',
        error: 'The check’s own request didn’t reach the server (either way).',
        details: { unreached: ['http-with-origin', 'http-without-origin', 'socket'] },
      },
    ])
  } finally {
    front.close()
  }
})

test('one shape passed on and not another is no check either, and the log says which; with all of them, a box behind a gateway is judged as any', async ({
  serve,
  browser,
}) => {
  // A box that holds, each time: what's in front of the server is all that differs.
  for (const [cuts, how, unreached] of [
    [SOCKETS, 'as a WebSocket', ['socket']],
    [REQUESTS, 'over HTTP', ['http-with-origin', 'http-without-origin']],
    // (Only what says `Origin: null`: a request that says no origin still gets by.)
    [
      ((asked) => asked.origin === 'null') satisfies Cuts,
      'either way',
      ['http-with-origin', 'socket'],
    ],
  ] as const) {
    const { server, front } = await behind(serve, cuts)
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await signIn(page, `${front.url}cluster/demo/pods`, DEMO_TOKEN)
      await page.waitForFunction(() => '__lumoviDoor' in window)
      expect(await codeOf(page), how).toBe('check-unreached')
      expect(audited(server, 'plugin.box-check')).toMatchObject([
        {
          outcome: 'failure',
          error: `The check’s own request didn’t reach the server (${how}).`,
          details: { unreached: [...unreached] },
        },
      ])
      expect(server.log()).toContain(`its own request didn’t arrive ${how}.`)
      // Passed on again (the gateway set right) and the page loaded again: checked anew, and
      // this time judged.
      front.passAll()
      await page.reload()
      await page.waitForFunction(() => '__lumoviDoor' in window)
      expect(await codeOf(page), how).toBe('handed')
    } finally {
      await context.close()
      front.close()
    }
  }
  // Behind a gateway that passes the catcher on, a box with a wall taken away fails as it does
  // with nothing in front: what the server saw arrive is what it judges by.
  const { server, front } = await behind(serve, NOTHING, {
    LUMOVI_TEST_BOX_WALL_OFF: 'connect-src',
  })
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await signIn(page, `${front.url}cluster/demo/pods`, DEMO_TOKEN)
    await page.waitForFunction(() => '__lumoviDoor' in window)
    expect(await codeOf(page)).toBe('check-failed')
    expect(audited(server, 'plugin.box-check')[0]?.details?.ways).toEqual(
      expect.arrayContaining(['fetch', 'xhr', 'event-source', 'web-socket']),
    )
  } finally {
    await context.close()
    front.close()
  }
})

test('the check’s own frame is sealed as a box is: a box’s policy but for what it may ask, the check’s catcher alone, and Lumovi’s lines in it and nothing else', async ({
  serve,
}) => {
  const server = await served(serve)
  const url = server.url
  const ask = (path: string, init: RequestInit = {}) =>
    fetch(`${url}${path}`, { redirect: 'manual', ...init })
  const [frame, box] = [await ask('plugin-box/check.html'), await ask('plugin-box/box.html')]
  expect([frame.status, box.status]).toEqual([200, 200])
  // Every header a box has, and the same, but its policy.
  const but = (headers: Headers) =>
    Object.fromEntries(
      [...headers].filter(
        ([name]) => !['content-security-policy', 'date', 'content-length', 'etag'].includes(name),
      ),
    )
  expect(but(frame.headers)).toEqual(but(box.headers))
  expect(frame.headers.get('permissions-policy')).toBe(box.headers.get('permissions-policy'))
  expect(frame.headers.get('set-cookie')).toBeNull()
  // Its policy: a box's, directive for directive, but for the script it names (its own, by its
  // hash, where a box's is the box's) and what it may ask.
  const directives = (headers: Headers) =>
    headers
      .get('content-security-policy')!
      .split('; ')
      .map((directive) => {
        const [name, ...values] = directive.split(' ')
        return [name!, values.join(' ')] as const
      })
  const [its, boxes] = [directives(frame.headers), directives(box.headers)]
  expect(its.map(([name]) => name)).toEqual(boxes.map(([name]) => name))
  const differs = its.filter(([, value], i) => boxes[i]![1] !== value).map(([name]) => name)
  expect(differs).toEqual(['script-src', 'connect-src'])
  const policy = Object.fromEntries(its)
  expect(Object.fromEntries(boxes)['connect-src']).toBe("'none'")
  // The catcher's folder, as a request and as a socket, and nothing else.
  expect(policy['connect-src']).toBe(`${url}box-check/ ${url.replace(/^http/, 'ws')}box-check/`)
  expect(policy.sandbox).toBe('allow-scripts')
  expect(policy['frame-ancestors']).toBe(new URL(url).origin)
  // Its one script is in it, whole, named by its hash and by no address.
  const body = await frame.text()
  const scripts = scriptsIn(body)
  expect(scripts.map(({ said }) => said)).toEqual([''])
  const script = scripts[0]!.text
  expect(body).toBe(
    `<!doctype html><meta charset="utf-8"><title>plugin</title><body><script>${script}</script>`,
  )
  expect(policy['script-src']).toBe(
    `'sha256-${createHash('sha256').update(script).digest('base64')}'`,
  )
  // Lumovi's lines, and nothing of a plugin's can come into them: no worker, no text made into
  // code, one listener, and one word up.
  for (const never of ['Worker', 'importScripts', 'eval', 'Function(', 'import(', 'innerHTML']) {
    expect(script, never).not.toContain(never)
  }
  expect(script.match(/addEventListener\(/g)).toHaveLength(1)
  expect(script.match(/postMessage\(/g)).toHaveLength(1)
  expect(script).toContain("parent.postMessage('done', '*')")
  expect(script).toContain('event.source !== parent')
  // The same for whoever asks, whatever is added to the address; only asked for, never sent to.
  for (const [path, init] of [
    ['plugin-box/check.html', { headers: { Cookie: 'lumovi-session=anything' } }],
    ['plugin-box/check.html?at=https://elsewhere.example', {}],
    ['plugin-box/check.html', { headers: { Origin: 'https://elsewhere.example' } }],
  ] as const) {
    const again = await ask(path, init)
    expect(again.status, path).toBe(200)
    expect(again.headers.get('content-security-policy'), path).toBe(
      frame.headers.get('content-security-policy'),
    )
    expect(again.headers.get('set-cookie'), path).toBeNull()
    expect(await again.text(), path).toBe(body)
  }
  expect((await ask('plugin-box/check.html', { method: 'POST' })).status).toBe(405)
  expect((await ask('plugin-box/check.html/')).status).toBe(404)
  expect((await ask('plugin-box/check.js')).status).toBe(404)
  // Lumovi's page may show those two addresses in a frame, and nothing else.
  expect((await ask('')).headers.get('content-security-policy')).toContain(
    `frame-src ${url}plugin-box/box.html ${url}plugin-box/check.html`,
  )
  expect((await ask('')).headers.get('content-security-policy')).toMatch(
    /frame-src [^;]*check\.html$/,
  )
})

for (const [name, engine] of [
  ['Chromium', chromium],
  ['Firefox', firefox],
  ['WebKit', webkit],
] as const) {
  test.describe(`Lumovi’s check of a plugin’s box in ${name}`, () => {
    test('its own frame asks nothing until its parent says where, once, and what it’s handed is held to the catcher’s folder; told the catcher, it asks in each shape a box’s request has', async ({
      serve,
    }) => {
      const must = name === 'Chromium' || process.env.LUMOVI_E2E_BROWSERS === 'all'
      test.skip(!must && Boolean(process.env.CI), 'CI’s Browsers job runs it')
      const { front } = await behind(serve, NOTHING)
      // (Somewhere else a frame might be sent: a server of the test's own, which counts.)
      let elsewhere = 0
      const other = http.createServer((_req, res) => {
        elsewhere++
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }).end()
      })
      other.on('upgrade', (_req, socket) => {
        elsewhere++
        socket.destroy()
      })
      const otherPort = await freePort()
      await new Promise<void>((done) => other.listen(otherPort, '127.0.0.1', done))
      const browser = await engine.launch().catch((error: unknown) => {
        if (must) throw error
        return undefined
      })
      test.skip(!browser, `${name} doesn’t start on this computer`)
      try {
        const page = await browser!.newPage()
        await signIn(page, `${front.url}cluster/demo/pods`, DEMO_TOKEN)
        /** The frame, opened in Lumovi's page as the check opens it; told `tells`, each in turn. */
        const framed = (tells: string[], waits: number) =>
          page.evaluate(
            async ([address, tells, waits]) => {
              const frame = document.createElement('iframe')
              frame.hidden = true
              frame.setAttribute('sandbox', 'allow-scripts')
              frame.src = address
              const said: unknown[] = []
              const hear = (event: MessageEvent) => {
                if (event.source === frame.contentWindow) said.push(event.data)
              }
              addEventListener('message', hear)
              await new Promise((loaded) => {
                frame.addEventListener('load', loaded, { once: true })
                document.body.append(frame)
              })
              for (const tell of tells) frame.contentWindow!.postMessage(tell, '*')
              await new Promise((done) => setTimeout(done, waits))
              removeEventListener('message', hear)
              frame.remove()
              return said
            },
            [`${front.url}plugin-box/check.html`, tells, waits] as const,
          )
        const catcher = `${front.url}box-check/a-nonce-of-the-tests`
        // Told nothing, it asks nothing, and says nothing.
        expect(await framed([], 1500)).toEqual([])
        expect(front.asked).toEqual([])
        // Told somewhere that isn't the catcher's folder (another server; Lumovi's own API; the
        // catcher's name under another folder): its policy lets none of it out. It says it's
        // done, and that's all it says. And it took its one message: the catcher, told after,
        // isn't asked.
        for (const away of [
          `http://127.0.0.1:${otherPort}/box-check/x`,
          `${front.url}api/session`,
          `${front.url}box-check-other/x`,
        ]) {
          expect(await framed([away, catcher], 2500), away).toEqual(['done'])
        }
        expect(elsewhere).toBe(0)
        expect(front.asked).toEqual([])
        // What isn't an address as text is no message of its: the one after it is its one.
        // Told the catcher: asked in each shape a box's request has, once each, and "done".
        expect(await framed([{ at: catcher } as unknown as string, catcher], 2500)).toEqual([
          'done',
        ])
        expect(
          front.asked
            .map(({ by, way, origin }) => ({ by, way, origin }))
            .sort((a, b) => a.way.localeCompare(b.way)),
        ).toEqual([
          { by: 'http', way: 'no-origin', origin: undefined },
          { by: 'http', way: 'origin', origin: 'null' },
          { by: 'socket', way: 'socket', origin: 'null' },
        ])
        // None says it comes from Lumovi's own site: each is as a box's.
        for (const each of front.asked) expect(each.site, each.way).not.toBe('same-origin')
      } finally {
        await browser!.close()
        front.close()
        other.close()
      }
    })
  })
}

test('where no check is asked for, no code is handed: the answer stands as it was', async ({
  serve,
  page,
}) => {
  const server = await served(serve)
  await signIn(page, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  // A server that starts no check (as one with no box would answer).
  await page.evaluate(() => {
    const api = (window as unknown as { lumovi: { kube: { boxCheckStart: () => unknown } } }).lumovi
    api.kube.boxCheckStart = () => Promise.resolve(undefined)
  })
  expect(await codeOf(page)).toBe('not-checked')
  expect(audited(server, 'plugin.box-check')).toEqual([])
  expect(audited(server, 'plugin.code')).toEqual([])
})

test('what reaches the server of a check after it passed fails it: a page already handed code ends', async ({
  serve,
  page,
}) => {
  const server = await served(serve)
  const said = checksSaid(page)
  await signIn(page, `${server.url}cluster/demo/pods`, DEMO_TOKEN)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  await showToys(page)
  await expect
    .poll(() => audited(server, 'plugin.code').map((event) => event.summary))
    .toEqual(['Handed the plugin toys’ code to this browser'])
  await expect(page.getByTestId('plugin-ended')).toHaveCount(0)
  // A beacon the browser sends on only now, while the check's nonce still lives.
  const [{ nonce }] = said.start as [{ nonce: string }]
  expect((await page.request.get(`${server.url}box-check/${nonce}/beacon`)).status()).toBe(204)
  const ended = page.getByTestId('plugin-ended')
  await expect(ended).toContainText('Lumovi stopped Toys’ page.')
  await expect(ended).toContainText(
    'Lumovi checked this browser and it didn’t pass, so it doesn’t run plugins’ code in this browser.',
  )
  await expect(ended.getByRole('button', { name: 'Open it again' })).toHaveCount(0)
  expect(
    audited(server, 'plugin.box-check').map((event) => [event.outcome, event.details?.ways]),
  ).toEqual([
    ['success', undefined],
    ['failure', ['beacon']],
  ])
  expect(server.log()).toContain('lets a plugin’s code out of its box: beacon.')
  expect(await handOver(page)).toBe('check-failed')
})

test('behind a sign-in proxy, a pass is its page’s alone: another browser, or the page loaded again, is checked anew', async ({
  serve,
  page,
  context,
  browser,
}) => {
  const server = await served(serve, { LUMOVI_AUTH: 'proxy', LUMOVI_PROXY_SEC_FETCH_SITE: 'on' })
  await as(context, 'alice@example.com')
  await page.goto(`${server.url}cluster/demo/pods`)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  expect(await codeOf(page)).toBe('handed')
  // The same person, in another browser: the proxy says only who they are, so nothing of the
  // first page's pass is theirs here.
  const elsewhere = await browser.newContext()
  try {
    await as(elsewhere, 'alice@example.com')
    const other = await elsewhere.newPage()
    await other.goto(`${server.url}cluster/demo/pods`)
    await other.waitForFunction(() => '__lumoviDoor' in window)
    expect(await handOver(other)).toBe('not-checked')
  } finally {
    await elsewhere.close()
  }
  // And the first page, loaded again, is checked again.
  await page.reload()
  await page.waitForFunction(() => '__lumoviDoor' in window)
  expect(await handOver(page)).toBe('not-checked')
  expect(audited(server, 'plugin.box-check').map((event) => event.outcome)).toEqual(['success'])
})

test('on a phone the box is checked as in any browser: one that passes is handed code, one that fails isn’t', async ({
  serve,
  page,
}) => {
  // (A phone's page changes nothing through a plugin, but runs its code: the hand-over decides,
  // after the same check.)
  await page.setViewportSize(PHONE)
  const held = await served(serve)
  await signInNarrow(page, `${held.url}cluster/demo/pods`, DEMO_TOKEN)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  expect(await codeOf(page)).toBe('handed')
  expect(audited(held, 'plugin.box-check').map((event) => event.outcome)).toEqual(['success'])
  // With one of the box's walls taken away on purpose: it fails, and no code is handed.
  const open = await served(serve, { LUMOVI_TEST_BOX_WALL_OFF: 'connect-src' })
  await signInNarrow(page, `${open.url}cluster/demo/pods`, DEMO_TOKEN)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  expect(await codeOf(page)).toBe('check-failed')
  expect(audited(open, 'plugin.code')).toEqual([])
})

test('where this browser’s check failed, Lumovi’s own overview of Karpenter stands in for its code’s page', async ({
  serve,
  page,
}) => {
  test.slow()
  const server = await served(serve, { LUMOVI_TEST_BOX_WALL_OFF: 'connect-src' })
  await signIn(page, `${server.url}cluster/demo/plugins/karpenter`, DEMO_TOKEN)
  // Its node pools as Lumovi lists them: nothing of the plugin's, and no page that says it ended.
  await expect(page.getByRole('list', { name: 'Node pools' }).getByRole('listitem')).toHaveCount(3)
  await expect(page.getByTestId('plugin-whose')).toHaveCount(0)
  await expect(page.getByTestId('plugin-ended')).toHaveCount(0)
  // (The check ran, once, as the page would have run it, and it failed: no code was handed.)
  expect(audited(server, 'plugin.box-check').map((event) => event.outcome)).toEqual(['failure'])
  expect(audited(server, 'plugin.code')).toEqual([])
  // The Plugins page says why, and what's shown instead.
  await page.goto(`${server.url}cluster/demo/plugins?plugin=karpenter`)
  await expect(page.getByTestId('plugin-not-handed')).toHaveText(
    'Its pages don’t run here: Lumovi’s check of this browser didn’t pass. Lumovi shows its own overview of Karpenter instead.',
  )
})

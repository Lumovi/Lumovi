/**
 * A plugin's sealed box on a server: its two files at one address, the same for whoever asks;
 * and the box in each browser a person may have, where the box's own policy is the wall (a
 * server has no request filter, and no process of its own for a plugin). Only test plugins of
 * Lumovi's own run here; nothing in Lumovi opens a box yet.
 */
import { readFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { chromium, firefox, webkit, type Frame, type Page } from '@playwright/test'
import { BOX_LIMITS } from '../../src/shared/plugin-box.ts'
import { gotOut, startCatchers, type Catchers } from '../e2e/plugin-box/catchers.ts'
import { DEMO_TOKEN, expect, refusedConfig, signIn, test, type Served } from './fixtures.ts'

const WAYS = readFileSync(resolve('tests/e2e/plugin-box/ways-out.js'), 'utf8')

interface Way {
  id: string
  group: string
  needsDom: boolean
}
const ALL: Way[] = (() => {
  const self: { ATTEMPT_IDS?: Way[] } = {}
  runInNewContext(WAYS, { self, setTimeout })
  return self.ATTEMPT_IDS!
})()

/** A port nothing listens on (for now): a server is told its own address before it starts. */
const freePort = () =>
  new Promise<number>((found) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => found(port))
    })
  })

/** A server that knows its own address, as one with plugins has to. */
async function served(
  serve: (options?: { env?: Record<string, string>; port?: number }) => Promise<Served>,
  env: Record<string, string> = {},
) {
  const port = await freePort()
  return serve({ port, env: { LUMOVI_URL: `http://127.0.0.1:${port}`, ...env } })
}

test('the box’s two files are the same for whoever asks, never redirect, and are all there is under its folder', async ({
  serve,
}) => {
  const { url } = await served(serve)
  const origin = new URL(url).origin
  const ask = (path: string, init: RequestInit = {}) =>
    fetch(`${url}${path}`, { redirect: 'manual', ...init })
  const page = await ask('plugin-box/box.html')
  expect(page.status).toBe(200)
  const policy = page.headers.get('content-security-policy')!
  // Sealed by its own answer, wherever it's opened; shown by Lumovi's own page and no other.
  expect(policy).toContain('sandbox allow-scripts')
  expect(policy).toContain("default-src 'none'")
  expect(policy).toContain("connect-src 'none'")
  expect(policy).toContain(`script-src ${url}plugin-box/box.js;`)
  expect(policy).toContain(`frame-ancestors ${origin}`)
  // Never kept by a browser, so a changed policy reaches every one at once; and no cookie.
  expect(page.headers.get('cache-control')).toBe('no-store')
  expect(page.headers.get('set-cookie')).toBeNull()
  const body = await page.text()
  expect(body).toContain(`<script src="${url}plugin-box/box.js"></script>`)

  // The same with a cookie, and with anything added to the address.
  for (const [path, init] of [
    ['plugin-box/box.html', { headers: { Cookie: 'lumovi-session=anything; other=1' } }],
    ['plugin-box/box.html?plugin=x&d=SECRET', {}],
    ['plugin-box/box.html?', { headers: { Origin: 'https://elsewhere.example' } }],
  ] as const) {
    const again = await ask(path, init)
    expect(again.status, path).toBe(200)
    expect(again.headers.get('content-security-policy'), path).toBe(policy)
    expect(again.headers.get('set-cookie'), path).toBeNull()
    expect(await again.text(), path).toBe(body)
  }
  // Its script, which a sealed frame (another origin, even to its own server) may load.
  const script = await ask('plugin-box/box.js')
  expect(script.status).toBe(200)
  expect(script.headers.get('content-type')).toContain('text/javascript')
  expect(script.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
  expect(script.headers.get('set-cookie')).toBeNull()
  // Only asked for, never sent to; and nothing else is there: not the page, not a folder.
  expect((await ask('plugin-box/box.html', { method: 'POST' })).status).toBe(405)
  for (const path of [
    'plugin-box',
    'plugin-box/',
    'plugin-box/box.html/',
    'plugin-box/index.html',
    'plugin-box/other',
    'plugin-box/..%2Fapi%2Fsession',
  ]) {
    const other = await ask(path)
    expect(other.status, path).toBe(404)
    expect(other.headers.get('location'), path).toBeNull()
  }
  // Lumovi's page may show that one address in a frame, and nothing else.
  const lumovi = await ask('')
  expect(lumovi.headers.get('content-security-policy')).toContain(
    `frame-src ${url}plugin-box/box.html`,
  )
})

test('a server’s address has to name one host, or it doesn’t start', async ({ clusters }) => {
  // What's written into the pages' policies as "this address exactly" can't be a pattern, or
  // two addresses, or carry anyone's password.
  for (const address of ['https://*.example.com', 'https://a.example,https://evil.example']) {
    expect(await refusedConfig(clusters, { LUMOVI_URL: address }), address).toContain(
      `LUMOVI_URL must name one host (letters, digits, hyphens and dots, or an address), not "${address}".`,
    )
  }
  // (And what it carried isn't said back: a server's log is no place for it.)
  const said = await refusedConfig(clusters, {
    LUMOVI_URL: 'https://someone:secret@lumovi.example',
  })
  expect(said).toContain('LUMOVI_URL can’t carry a user and password.')
  expect(said).not.toContain('secret')
})

test('a box that the browser won’t show ends, and says its box never came', async ({
  serve,
  page,
}) => {
  // A server told it's at one address and reached at another: its pages' policy names the
  // first, so the box at the second is refused by the browser.
  test.setTimeout(60_000)
  const port = await freePort()
  const { url } = await serve({ port, env: { LUMOVI_URL: `http://localhost:${port}` } })
  await signIn(page, `${url}cluster/demo/pods`, DEMO_TOKEN)
  await page.waitForFunction(() => '__lumoviBox' in window)
  await page.evaluate(() => {
    const w = window as unknown as {
      __lumoviBox: { openBox(options: object): unknown }
      __never?: unknown
    }
    w.__lumoviBox.openBox({
      plugin: 'echo',
      code: '',
      heard: () => undefined,
      ended: (end: unknown) => (w.__never = end),
    })
  })
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __never?: unknown }).__never), {
      timeout: BOX_LIMITS.readyWithinMs + 10_000,
    })
    .toEqual({ why: 'no-box' })
  await expect(page.locator('iframe')).toHaveCount(0)
})

test('a plugin’s page whose box never came says the page couldn’t start', async ({
  serve,
  page,
}) => {
  // Reached at another address than its own, as above: the box is refused, and the page's place
  // says so.
  test.setTimeout(60_000)
  const port = await freePort()
  const { url } = await serve({ port, env: { LUMOVI_URL: `http://localhost:${port}` } })
  await signIn(page, `${url}cluster/demo/pods`, DEMO_TOKEN)
  await page.waitForFunction(() => '__lumoviDoor' in window)
  await page.evaluate(() =>
    (window as unknown as { __lumoviDoor: { show(shown: object): void } }).__lumoviDoor.show({
      plugin: 'karpenter',
      name: 'Karpenter',
      version: '1.0.0',
      code: '',
    }),
  )
  const ended = page.getByTestId('plugin-ended')
  await expect(ended).toHaveAttribute('data-why', 'no-box', {
    timeout: BOX_LIMITS.readyWithinMs + 10_000,
  })
  await expect(ended.getByRole('heading')).toHaveText('Karpenter’s page couldn’t start.')
  await expect(ended).toContainText('Lumovi couldn’t open the place a plugin’s code runs in.')
  await expect(ended.getByRole('button', { name: 'Open it again' })).toHaveCount(0)
})

test('a server that isn’t told its own address has no box at all', async ({ serve }) => {
  const { url } = await serve()
  for (const path of ['plugin-box/box.html', 'plugin-box/box.js']) {
    expect((await fetch(`${url}${path}`, { redirect: 'manual' })).status, path).toBe(404)
  }
  expect((await fetch(url)).headers.get('content-security-policy')).toContain("frame-src 'none'")
})

interface Kept {
  heard: string[]
  ended?: unknown
  box: { post(message: unknown): void; close(): void }
}
type OnPage = { __boxes: Record<string, Kept> }

/** Opens a test plugin's box on the page and waits until its worker says it's ready. */
async function open(page: Page, as: string, code: string) {
  await page.waitForFunction(() => '__lumoviBox' in window)
  await page.evaluate(
    ({ as, code }) => {
      const w = window as unknown as {
        __lumoviBox: { openBox(options: object): Kept['box'] }
        __boxes?: Record<string, Kept>
      }
      const kept = { heard: [] as string[], ended: undefined as unknown }
      const box = w.__lumoviBox.openBox({
        plugin: 'ways',
        code,
        heard: (text: string) => kept.heard.push(text),
        ended: (end: unknown) => (kept.ended = end),
      })
      ;(w.__boxes ??= {})[as] = Object.assign(kept, { box })
    },
    { as, code },
  )
  await expect
    .poll(() => page.evaluate((as) => (window as unknown as OnPage).__boxes[as]!.heard[0], as), {
      timeout: 15_000,
    })
    .toBe('ready')
}
const close = (page: Page, as: string) =>
  page.evaluate((as) => (window as unknown as OnPage).__boxes[as]?.box.close(), as)
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))

const TRIER = `${WAYS}
box.then(({ post, listen }) => {
  listen(async (told) => {
    if (!told || !told.attempt) return
    told.context.post = (message) => post(message)
    post(JSON.stringify({ saw: await self.runAttempt(told.attempt, told.context) }))
  })
  post('ready')
})`
const IDLE = `box.then(({ post }) => post('ready'))`

/** One way, tried in a box's worker: what the plugin's code saw of it. */
async function inWorker(page: Page, as: string, id: string, context: object): Promise<string> {
  await open(page, as, TRIER)
  await page.evaluate(
    ({ as, id, context }) =>
      (window as unknown as OnPage).__boxes[as]!.box.post({ attempt: id, context }),
    { as, id, context },
  )
  const until = Date.now() + 3200
  for (;;) {
    const { said, ended } = await page.evaluate((as) => {
      const { heard, ended } = (window as unknown as OnPage).__boxes[as]!
      return { said: heard.find((text) => text.startsWith('{"saw"')), ended }
    }, as)
    if (said) return (JSON.parse(said) as { saw: string }).saw
    if (ended) return `ended: ${JSON.stringify(ended)}`
    if (Date.now() > until) return 'no word back'
    await pause(50)
  }
}

/** The box's frame that was opened last. */
const lastBox = (page: Page): Frame | undefined =>
  page
    .frames()
    .filter((frame) => frame.url().includes('/plugin-box/box.html'))
    .at(-1)

/** One way, tried on a box's own page (by the test's hand: no plugin's code ever runs there). */
async function onPage(page: Page, as: string, id: string, context: object): Promise<string> {
  await open(page, as, IDLE)
  const frame = lastBox(page)
  if (!frame) return 'no such frame'
  return Promise.race([
    frame
      .evaluate(
        `${WAYS}\n;(() => { const c = ${JSON.stringify(context)}; c.post = () => undefined; return self.runAttempt(${JSON.stringify(id)}, c) })()`,
      )
      .then(String, (error: Error) => `the frame went: ${error.message.slice(0, 80)}`),
    pause(3200).then(() => 'no word back'),
  ])
}

const GROUPS = [...new Set(ALL.map((way) => way.group))].filter((group) => group !== 'pair')

/** Every way of `where` (of one group, if given), one after another: which got something out. */
async function tryAll(where: 'worker' | 'page', page: Page, catchers: Catchers, only?: string) {
  const ways = ALL.filter(
    (way) =>
      way.group !== 'pair' &&
      (only === undefined || way.group === only) &&
      (where === 'page' || !way.needsDom),
  )
  // (A way that asks the person something is answered no, at once.)
  page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined))
  const out: Record<string, string> = {}
  const saw: Record<string, string> = {}
  for (const [n, { id, group }] of ways.entries()) {
    catchers.reset()
    // (No way has longer than this, whatever it does to its frame.)
    saw[id] = await Promise.race([
      where === 'worker'
        ? inWorker(page, `${where}-${n}`, id, catchers.context(id))
        : onPage(page, `${where}-${n}`, id, catchers.context(id)),
      pause(20_000).then(() => 'took too long'),
    ]).catch((error: Error) => `failed: ${error.message.slice(0, 80)}`)
    await pause(group === 'port' ? 600 : 350)
    const got = gotOut(id, catchers.caught())
    if (got) out[id] = got
    await close(page, `${where}-${n}`).catch(() => undefined)
    // (A way that took the page itself somewhere has ended this run: said, not hidden.)
    if (page.isClosed()) break
  }
  return { tried: ways.length, out, saw }
}

/**
 * What a browser doesn't hold from a box's own page (never from its worker), by engine. No
 * plugin's code ever runs on a box's page, only in its worker, so none can be reached. A server
 * has no request filter behind the policy, and WebRTC is the browser's own to send.
 */
const NOT_HELD_ON_THE_PAGE: Record<string, string[]> = {
  Chromium: ['webrtc-stun', 'webrtc-turn-tcp'],
  Firefox: ['webrtc-stun', 'webrtc-turn-tcp'],
  // (WebKit's two more: for a link that asks for a connection to be made ready, and for a link
  // to a new window that's clicked, it opens a connection to the other host and sends nothing
  // on it. No request is made and no window opens; what leaves is that a connection was made.)
  WebKit: ['webrtc-stun', 'webrtc-turn-tcp', 'link-preconnect', 'link-click-blank'],
}

let catchers: Catchers
test.beforeAll(async () => {
  catchers = await startCatchers()
})
test.afterAll(async () => {
  await catchers.close()
})

for (const [name, browsers] of [
  ['Chromium', chromium],
  ['Firefox', firefox],
  ['WebKit', webkit],
] as const) {
  test.describe(`a plugin’s box in ${name}`, () => {
    // (Every way is tried one after another, each in a box of its own.)
    test.setTimeout(420_000)

    /** Lumovi's page in that browser, signed in; nothing if the browser isn't here. */
    async function pageIn(
      serve: (options?: { env?: Record<string, string>; port?: number }) => Promise<Served>,
    ) {
      // Chromium is every run's. The other two are CI's Browsers job's, which says so
      // (LUMOVI_E2E_BROWSERS=all): there, one that isn't installed or doesn't start fails the
      // test. Elsewhere they run where they can, and are skipped where they can't.
      const must = name === 'Chromium' || process.env.LUMOVI_E2E_BROWSERS === 'all'
      test.skip(!must && Boolean(process.env.CI), 'CI’s Browsers job runs it')
      const { url } = await served(serve)
      const browser = await browsers.launch().catch((error: unknown) => {
        if (must) throw error
        return undefined
      })
      test.skip(!browser, `${name} doesn’t start on this computer`)
      const page = await browser!.newPage()
      await signIn(page, `${url}cluster/demo/pods`, DEMO_TOKEN)
      return { page, url, done: () => browser!.close() }
    }

    test('its code runs in a worker and answers in text; too much, or silence, ends it', async ({
      serve,
    }) => {
      const { page, done } = await pageIn(serve)
      try {
        await open(
          page,
          'echo',
          `box.then(({ post, listen }) => { post('ready'); listen((m) => post('heard ' + JSON.stringify(m))) })`,
        )
        await page.evaluate(() => (window as unknown as OnPage).__boxes.echo!.box.post({ ask: 1 }))
        await expect
          .poll(() => page.evaluate(() => (window as unknown as OnPage).__boxes.echo!.heard))
          .toEqual(['ready', 'heard {"ask":1}'])
        // Where the browser put the box's frame: with Lumovi's page, or apart from it. Nothing
        // of Lumovi's depends on the answer (a browser decides, and decides differently on a
        // phone or a computer short of memory): it's said, as far as it can be seen. Chromium
        // can be asked; the other two can't from here.
        const frame = lastBox(page)!
        const apart =
          name === 'Chromium'
            ? await page
                .context()
                .newCDPSession(frame)
                .then(
                  () => 'in a process apart from the page’s',
                  () => 'in the page’s own process',
                )
            : 'not something a test can see in this browser'
        console.log(`${name}: the box’s frame is ${apart}`)
        await test.info().attach('where the frame is', { body: apart })
        // What was seen, held: the Chromium these tests run puts the box's frame in the page's
        // own process. The day one puts it apart this says so, and what's said of a server can
        // be made better; nothing is promised on it either way.
        if (name === 'Chromium') expect(apart).toBe('in the page’s own process')
        // The channel's ceiling: ended at the first message over a second's worth, the second
        // counted from the plugin's first message as the box takes them in. In Chromium and
        // WebKit a loop's 2,001st comes well inside it, so exactly a second's worth gets through.
        // In Firefox on a small machine the box takes them in slower than that while the loop
        // holds a processor: a second can end under the limit and its count start again, so
        // more gets through before one second holds too many. Never less than a second's worth.
        await open(
          page,
          'flood',
          `box.then(({ post }) => { post('ready'); for (let i = 0; i < 100000; i++) post('x') })`,
        )
        await expect
          .poll(() => page.evaluate(() => (window as unknown as OnPage).__boxes.flood!.ended))
          .toEqual({ why: 'over', over: 'messages' })
        const heard = await page.evaluate(
          () => (window as unknown as OnPage).__boxes.flood!.heard.length,
        )
        if (name === 'Firefox') expect(heard).toBeGreaterThanOrEqual(BOX_LIMITS.messagesASecond)
        else expect(heard).toBe(BOX_LIMITS.messagesASecond)
        // Only text comes up.
        await open(
          page,
          'object',
          `box.then(({ post }) => { post('ready'); post({ not: 'text' }) })`,
        )
        await expect
          .poll(() => page.evaluate(() => (window as unknown as OnPage).__boxes.object!.ended))
          .toEqual({ why: 'over', over: 'not-text' })
        // Silence: on a server it's what ends a plugin that holds its thread (nothing there
        // measures its memory or its use of the processor).
        await open(page, 'stuck', `box.then(({ post }) => { post('ready'); for (;;) {} })`)
        await expect
          .poll(() => page.evaluate(() => (window as unknown as OnPage).__boxes.stuck!.ended), {
            timeout: BOX_LIMITS.pingEveryMs * (BOX_LIMITS.missedPings + 6),
          })
          .toEqual({ why: 'silent' })
      } finally {
        await done()
      }
    })

    test('from the worker, nothing gets out', async ({ serve }) => {
      const { page, done } = await pageIn(serve)
      try {
        const { tried, out, saw } = await tryAll('worker', page, catchers)
        await test.info().attach('saw', { body: JSON.stringify({ out, saw }, null, 2) })
        expect(tried).toBeGreaterThan(40)
        expect(out).toEqual({})
      } finally {
        await done()
      }
    })

    test('the catchers are within this browser’s reach: the tests can tell', async ({ serve }) => {
      // (That nothing reaches them from a box means something only if something can. With the
      // box's policy taken away, what leaves is shown where each wall can be taken away by
      // itself: the desktop's tests. Here: the same addresses, asked from a page that's free to.)
      const { page, done } = await pageIn(serve)
      try {
        const context = catchers.context('fetch-other') as { leak: string; other: string }
        const free = await page.context().browser()!.newPage()
        await free.goto(`${context.other}/a-free-page`)
        catchers.reset()
        await free.evaluate((leak) => fetch(leak, { mode: 'no-cors' }), context.leak)
        expect(gotOut('fetch-other', catchers.caught())).toContain('a request to another host')
        await free.context().close()
      } finally {
        await done()
      }
    })

    for (const group of GROUPS) {
      test(`on the box’s own page, only what’s named gets out: ${group}`, async ({ serve }) => {
        const { page, done } = await pageIn(serve)
        try {
          const { out, saw } = await tryAll('page', page, catchers, group)
          await test.info().attach('saw', { body: JSON.stringify({ out, saw }, null, 2) })
          if (Object.keys(out).length) {
            console.log(`${name}, on the box’s own page, got out: ${JSON.stringify(out)}`)
          }
          expect(
            Object.keys(out).filter((id) => !NOT_HELD_ON_THE_PAGE[name]!.includes(id)),
          ).toEqual([])
        } finally {
          await done()
        }
      })
    }
  })
}

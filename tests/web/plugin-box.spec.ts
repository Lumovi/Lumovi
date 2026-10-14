/**
 * A plugin's sealed box on a server: its two files at one address, the same for whoever asks;
 * and the box in each browser a person may have, where the box's own policy is the wall (a
 * server has no request filter, and no process of its own for a plugin). Only test plugins of
 * Lumovi's own run here; nothing in Lumovi opens a box yet.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import {
  chromium,
  firefox,
  webkit,
  type BrowserContext,
  type Frame,
  type Page,
} from '@playwright/test'
import { BOX_LIMITS, workerText } from '../../src/shared/plugin-box.ts'
import { gotOut, nameFor, startCatchers, type Catchers } from '../e2e/plugin-box/catchers.ts'
import { namedIn } from '../e2e/plugin-box/net-log.ts'
import { featuresOf, unsealed } from '../e2e/plugin-box/sealed.ts'
import { notRefused } from '../e2e/plugin-box/worked.ts'
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
  // Sealed by its own answer, wherever it's opened; shown by Lumovi's own page and no other;
  // never kept by a browser, so a changed policy reaches every one at once; and no cookie.
  expect(unsealed(page.headers, `${url}plugin-box/box.js`, origin)).toEqual([])
  expect(policy).toContain("connect-src 'none'")
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

interface Hand {
  frame: HTMLIFrameElement
  port?: MessagePort
  got: { kind: string; data: string; ports: number }[]
  second: string[]
  /** What its frame posted to the page's own window, from the first. */
  window: string[]
}
type HandOnPage = { __hand: Hand }

/**
 * A box made by the test's own hand on Lumovi's page, as Lumovi's page makes one, and not yet
 * handed its text: what reaches the page from the box's script is seen whole, each message's
 * data and the ports it came with, on its channel and on the page's own window.
 */
async function handMade(page: Page, address: string) {
  await page.evaluate(async (address) => {
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.name = 'hand'
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.src = address
    const posted: string[] = []
    addEventListener('message', (event) => {
      if (event.source === frame.contentWindow) posted.push(JSON.stringify(event.data))
    })
    const ready = new Promise<void>((done) => {
      const on = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow) return
        if ((event.data as { box?: unknown } | null)?.box !== 'ready') return
        removeEventListener('message', on)
        done()
      }
      addEventListener('message', on)
    })
    document.body.append(frame)
    await ready
    ;(window as unknown as HandOnPage).__hand = { frame, got: [], second: [], window: posted }
  }, address)
}
/** Hands the hand-made box a worker's text, with a channel of its own: what it says is kept. */
const handIt = (page: Page, text: string, into: 'got' | 'second') =>
  page.evaluate(
    ({ text, into }) => {
      const hand = (window as unknown as HandOnPage).__hand
      const channel = new MessageChannel()
      channel.port1.onmessage = (event) => {
        const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data)
        if (into === 'second') hand.second.push(data)
        else hand.got.push({ kind: typeof event.data, data, ports: event.ports.length })
      }
      if (into === 'got') hand.port = channel.port1
      hand.frame.contentWindow!.postMessage({ text }, '*', [channel.port2])
    },
    { text, into },
  )
const handOf = (page: Page) => page.evaluate(() => (window as unknown as HandOnPage).__hand.got)

/** A worker's text that, were a worker made of it, would say so on the channel it was handed. */
const ANOTHERS = `self.onmessage = (event) => event.data.port.postMessage('made from another’s text')`
/**
 * A plugin's code that takes the channel itself, before Lumovi's first lines can, and sends up
 * what isn't text alone: straight to the box's page, a port, a buffer, and a Blob.
 */
const SENDER = `let raw
const theirs = self.onmessage
self.onmessage = (event) => { raw = event.data.port; theirs.call(self, event) }
box.then(({ post, listen }) => {
  post('ready')
  listen((told) => {
    if (told !== 'go') return
    self.postMessage('straight to the box’s page')
    raw.postMessage('with a port', [new MessageChannel().port2])
    raw.postMessage('with a buffer', [new ArrayBuffer(8)])
    raw.postMessage(new Blob(['a blob']))
  })
})`

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

/**
 * The document of the box that was opened last, as it stands: every element and attribute of
 * it, in its own frame's words. Gone, if its box was ended.
 */
const documentOf = (page: Page): Promise<string> => {
  const frame = lastBox(page)
  if (!frame) return Promise.resolve('gone')
  return Promise.race([
    frame.evaluate(() => new XMLSerializer().serializeToString(document)).catch(() => 'gone'),
    pause(3000).then(() => 'no word back'),
  ])
}

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

/**
 * Every way of `where` (of one group, if `only` is given), one after another: which got
 * something out, and, from the worker, after which of them the box's own document was no longer
 * as Lumovi serves it. `named`, the other host goes by each try's own name: for a browser whose
 * log of its network is read after. `awaited` is what's known to get out, by way: waited for,
 * so that it's seen with its own try and never with the next.
 */
async function tryAll(
  where: 'worker' | 'page',
  page: Page,
  catchers: Catchers,
  {
    only,
    named = false,
    awaited = {},
  }: { only?: string; named?: boolean; awaited?: Record<string, string> } = {},
) {
  // (Two frames of one plugin's at once, on the page, for what one can leave for the other: in
  // the worker only; the box's own page is no plugin's.)
  const ways = ALL.filter(
    (way) =>
      (way.group !== 'pair' || where === 'worker') &&
      (only === undefined || way.group === only) &&
      (where === 'page' || !way.needsDom),
  )
  // (A way that asks the person something is answered no, at once.)
  page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined))
  const out: Record<string, string> = {}
  const saw: Record<string, string> = {}
  const changed: Record<string, string> = {}
  // A box's own document as Lumovi serves it, its worker running: read from one that tries
  // nothing. A plugin's code is in the worker, and no way it tries may leave a mark on it.
  let served = ''
  if (where === 'worker') {
    await open(page, 'served', IDLE)
    served = await documentOf(page)
    expect(served).toContain('<script src=')
    // (And a mark would be seen: one made by the test's own hand is.)
    await lastBox(page)!.evaluate(() => document.body.setAttribute('data-marked', ''))
    expect(await documentOf(page)).toBe(served.replace('<body', '<body data-marked=""'))
    await close(page, 'served')
  }
  for (const [n, { id, group }] of ways.entries()) {
    catchers.reset()
    // (No way has longer than this, whatever it does to its frame.)
    const within = (tried: Promise<string>) =>
      Promise.race([tried, pause(20_000).then(() => 'took too long')]).catch(
        (error: Error) => `failed: ${error.message.slice(0, 80)}`,
      )
    if (group === 'pair') {
      // Two boxes of one plugin alive together: what one can leave for the other.
      const first = within(
        inWorker(page, `${where}-${n}-first`, id, catchers.context(id, 'first', named)),
      )
      await pause(300)
      const second = await within(
        inWorker(page, `${where}-${n}-second`, id, catchers.context(id, 'second', named)),
      )
      saw[id] = `first: ${await first} / second: ${second}`
      await close(page, `${where}-${n}-first`).catch(() => undefined)
      await close(page, `${where}-${n}-second`).catch(() => undefined)
    } else {
      saw[id] = await within(
        where === 'worker'
          ? inWorker(page, `${where}-${n}`, id, catchers.context(id, undefined, named))
          : onPage(page, `${where}-${n}`, id, catchers.context(id, undefined, named)),
      )
    }
    if (awaited[id]) {
      await expect
        .poll(() => gotOut(id, catchers.caught()), { timeout: 5_000 })
        .toBe(awaited[id])
        .catch(() => undefined)
    }
    await pause(group === 'port' ? 600 : 350)
    const got = gotOut(id, catchers.caught())
    if (got) out[id] = got
    if (where === 'worker') {
      const now = await documentOf(page)
      // (A box that was ended has no document left to read.)
      if (now.startsWith('<') && now !== served) changed[id] = now.slice(0, 400)
    }
    await close(page, `${where}-${n}`).catch(() => undefined)
    // (A way that took the page itself somewhere has ended this run: said, not hidden.)
    if (page.isClosed()) break
  }
  return { tried: ways.length, out, saw, changed }
}

/**
 * What Chromium, as a person has it, doesn't hold from a box's own page on a server: each way,
 * what a catcher sees of it, and what Chromium's own log of its network has of the way's name
 * (looked up by its resolver; named by a connection alone; or nothing, as with WebRTC, whose
 * look-ups aren't in that log). A name the log has by a connection alone is looked up all the
 * same: the log holds no event of its resolver's for it, and a name server is still asked. The
 * whole of it, and exactly: a way more fails the tests, and so does one of these that no longer
 * gets out (it's taken off this list then).
 *
 * Nothing a server sends holds these. The box's policy has no word for what a browser does
 * ahead of a request, and `X-DNS-Prefetch-Control: off` is heeded only for the links a browser
 * guesses at. What holds is that no plugin's code ever runs on a box's page: only in its
 * worker, from which none of this can be reached, and nothing at all gets out.
 */
const ON_THE_PAGE_IN_CHROMIUM: Record<
  string,
  { out: string; log: 'looked up' | 'named' | 'nothing' }
> = {
  'webrtc-stun': { out: 'a UDP packet', log: 'nothing' },
  'webrtc-turn-tcp': { out: 'a connection to another host', log: 'nothing' },
  // A link that asks for a name ahead of a request: looked up, and nothing more.
  'link-dns-prefetch': { out: '', log: 'looked up' },
  // A link that asks for a connection to be made ready: made, and nothing sent on it.
  'link-preconnect': { out: 'a connection to another host', log: 'looked up' },
  // A link that asks for a page ahead: asked for, with its path and query. The one of these
  // that carries what it's given.
  'link-prerender': { out: 'a request to another host (GET)', log: 'looked up' },
  // A navigation of the box's own frame, or a frame in it, that's then refused: a connection
  // to its host is made ahead of it, and nothing is sent on it.
  'navigate-self-other': { out: 'a connection to another host', log: 'named' },
  'navigate-self-replace': { out: 'a connection to another host', log: 'named' },
  'meta-refresh': { out: 'a connection to another host', log: 'named' },
  'link-click-self': { out: 'a connection to another host', log: 'named' },
  'link-download': { out: 'a connection to another host', log: 'named' },
  'frame-other': { out: 'a connection to another host', log: 'named' },
}

/**
 * And Firefox, as a person has it: each way, and what a catcher sees of it. Exactly, as
 * Chromium's: a way more fails the tests, and so does one of these that no longer gets out.
 * (Firefox keeps no log of its network that a test can read: which names it asks for isn't
 * judged here.)
 */
const ON_THE_PAGE_IN_FIREFOX: Record<string, { out: string }> = {
  'webrtc-turn-tcp': { out: 'a connection to another host' },
  // A link that asks for a connection to be made ready: made, and nothing sent on it.
  'link-preconnect': { out: 'a connection to another host' },
}

/** The engines whose list is exact, and what a catcher sees of each way in it. */
const EXACTLY_ON_THE_PAGE: Record<string, Record<string, { out: string }> | undefined> = {
  Chromium: ON_THE_PAGE_IN_CHROMIUM,
  Firefox: ON_THE_PAGE_IN_FIREFOX,
}

/**
 * What Playwright's Firefox has off that a person's has on: connections made ahead of a
 * request, here back at Firefox's own default. (Its other acts ahead, looking a name up for a
 * link and fetching one, Playwright leaves as Firefox has them.)
 */
const FIREFOX_AS_A_PERSON = { 'network.http.speculative-parallel-limit': 20 }

/**
 * What a browser doesn't hold from a box's own page (never from its worker), by engine. No
 * plugin's code ever runs on a box's page, only in its worker, so none can be reached. A server
 * has no request filter behind the policy; WebRTC is the browser's own to send, and so is what
 * a browser does ahead of a request, which a policy has no word for.
 */
const NOT_HELD_ON_THE_PAGE: Record<string, string[]> = {
  Chromium: Object.keys(ON_THE_PAGE_IN_CHROMIUM),
  Firefox: Object.keys(ON_THE_PAGE_IN_FIREFOX),
  // (WebKit's two more: for a link that asks for a connection to be made ready, and for a link
  // to a new window that's clicked, it opens a connection to the other host and sends nothing
  // on it. No request is made and no window opens; what leaves is that a connection was made.)
  WebKit: ['webrtc-stun', 'webrtc-turn-tcp', 'link-preconnect', 'link-click-blank'],
}

/** The name a test itself asks for, which a log that was kept holds. */
const ASKED = 'asked-by-the-test'

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

    /**
     * Lumovi's page in that browser, signed in; nothing if the browser isn't here. `free()` is
     * another page of the same browser, for what a page that's held by nothing does.
     *
     * Chromium is started as a person has it, the full build with a profile of its own. The
     * tests' usual build, and any window without a profile, has nothing that acts ahead of a
     * request: no name looked up for a link that asks to, no connection made ready, no page
     * fetched ahead. Tried there, those ways say nothing of a person's browser. And it keeps
     * its own log of its network (net-log.ts): `named()` asks for a name of the test's own from
     * a free page, closes the browser, and reads which names the log holds: the test's (a log
     * without it wasn't kept), and those of the tries that were looked up.
     *
     * Firefox is started as a person has it too: a profile of its own, and the connections
     * ahead of a request that Playwright's build turns off (FIREFOX_AS_A_PERSON).
     */
    async function pageIn(
      serve: (options?: { env?: Record<string, string>; port?: number }) => Promise<Served>,
      env: Record<string, string> = {},
    ) {
      // Chromium is every run's. The other two are CI's Browsers job's, which says so
      // (LUMOVI_E2E_BROWSERS=all): there, one that isn't installed or doesn't start fails the
      // test. Elsewhere they run where they can, and are skipped where they can't.
      const must = name === 'Chromium' || process.env.LUMOVI_E2E_BROWSERS === 'all'
      test.skip(!must && Boolean(process.env.CI), 'CI’s Browsers job runs it')
      const { url } = await served(serve, env)
      const log =
        name === 'Chromium'
          ? join(mkdtempSync(join(tmpdir(), 'lumovi-net-log-')), 'net-log.json')
          : undefined
      const profile = () => mkdtempSync(join(tmpdir(), 'lumovi-profile-'))
      const own = (context: BrowserContext) => ({
        newPage: () => context.newPage(),
        close: () => context.close(),
      })
      const missing = (error: unknown) => {
        if (must) throw error
        return undefined
      }
      const browser = log
        ? await chromium
            .launchPersistentContext(profile(), {
              channel: 'chromium',
              args: [`--log-net-log=${log}`],
            })
            .then(own)
        : name === 'Firefox'
          ? await firefox
              .launchPersistentContext(profile(), { firefoxUserPrefs: FIREFOX_AS_A_PERSON })
              .then(own, missing)
          : await browsers
              .launch()
              .then(
                (whole) => ({ newPage: () => whole.newPage(), close: () => whole.close() }),
                missing,
              )
      test.skip(!browser, `${name} doesn’t start on this computer`)
      const page = await browser!.newPage()
      await signIn(page, `${url}cluster/demo/pods`, DEMO_TOKEN)
      const free = () => browser!.newPage()
      const named = async () => {
        const asking = await free()
        await asking.goto(`${String(catchers.context(ASKED, undefined, true).other)}/asked`)
        await browser!.close()
        const { events, lookedUp, anywhere } = namedIn(log!)
        expect(events).toBeGreaterThan(0)
        expect(lookedUp).toContain(ASKED)
        const tries = (names: string[]) => names.filter((id) => id !== ASKED)
        return { lookedUp: tries(lookedUp), anywhere: tries(anywhere) }
      }
      return { page, url, free, done: () => browser!.close(), named: log ? named : undefined }
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
        // Sealed by Lumovi's page too; and in Chromium, which can say, its page is given nothing.
        expect(await (await frame.frameElement()).getAttribute('sandbox')).toBe('allow-scripts')
        if (name === 'Chromium') {
          expect(await featuresOf(frame)).toEqual({ given: [], unnamed: [] })
        }
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
        // What was seen, held: Chromium as a person has it puts the box's frame in a process
        // apart from the page's (the tests' usual build, which no person runs, keeps it in the
        // page's own). The day it doesn't this says so; nothing is promised on it either way.
        if (name === 'Chromium') expect(apart).toBe('in a process apart from the page’s')
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

    test('its script makes one worker, from the page that holds it, and hands up nothing but text', async ({
      serve,
    }) => {
      const { page, url, done } = await pageIn(serve)
      try {
        await handMade(page, `${url}plugin-box/box.html`)
        // Another frame on the page, a box too, hands the hand-made one a text first: it arrives,
        // and no worker is made of it.
        await page.frame({ name: 'hand' })!.evaluate(() => {
          const counted = self as unknown as { arrived: number }
          counted.arrived = 0
          addEventListener('message', () => counted.arrived++)
        })
        await open(page, 'other', IDLE)
        const other = page
          .frames()
          .find((frame) => frame.url().includes('/plugin-box/box.html') && frame.name() !== 'hand')!
        const heardByOther = await other.evaluate(
          (text) =>
            new Promise<string[]>((done) => {
              const heard: string[] = []
              for (let at = 0; at < parent.length; at++) {
                if (parent[at] === self) continue
                const channel = new MessageChannel()
                channel.port1.onmessage = (event) => heard.push(String(event.data))
                parent[at]!.postMessage({ text }, '*', [channel.port2])
              }
              setTimeout(() => done(heard), 1500)
            }),
          ANOTHERS,
        )
        expect(heardByOther).toEqual([])
        expect(
          await page
            .frame({ name: 'hand' })!
            .evaluate(() => (self as unknown as { arrived: number }).arrived),
        ).toBe(1)
        // The page that holds it hands it the plugin's text: that one is made.
        await handIt(page, workerText(SENDER), 'got')
        await expect.poll(() => handOf(page)).toEqual([{ kind: 'string', data: 'ready', ports: 0 }])
        // A second text, even from that page, makes nothing.
        await handIt(page, ANOTHERS, 'second')
        await pause(1500)
        expect(await page.evaluate(() => (window as unknown as HandOnPage).__hand.second)).toEqual(
          [],
        )
        // What the worker sends up past Lumovi's first lines: text arrives as text alone; the
        // rest never comes, and what isn't text ends it.
        await page.evaluate(() => (window as unknown as HandOnPage).__hand.port!.postMessage('go'))
        await expect.poll(() => handOf(page).then((got) => got.length)).toBe(4)
        await pause(500)
        expect(await handOf(page)).toEqual([
          { kind: 'string', data: 'ready', ports: 0 },
          { kind: 'string', data: 'with a port', ports: 0 },
          { kind: 'string', data: 'with a buffer', ports: 0 },
          { kind: 'object', data: '{"box":"ended","over":"not-text"}', ports: 0 },
        ])
        // And nothing on the page's own window but that the box was there.
        expect(await page.evaluate(() => (window as unknown as HandOnPage).__hand.window)).toEqual([
          '{"box":"ready"}',
        ])
      } finally {
        await done()
      }
    })

    test('its code has random numbers of the browser’s making, and nothing else of its crypto', async ({
      serve,
    }) => {
      const { page, done } = await pageIn(serve)
      try {
        await open(
          page,
          'random',
          `box.then(({ post }) => {
            const made = crypto.getRandomValues(new Uint8Array(16))
            post('ready')
            post(JSON.stringify({ bytes: made.length, random: made.some((byte) => byte !== 0), subtle: typeof crypto.subtle }))
          })`,
        )
        await expect
          .poll(() => page.evaluate(() => (window as unknown as OnPage).__boxes.random!.heard))
          .toEqual(['ready', '{"bytes":16,"random":true,"subtle":"undefined"}'])
      } finally {
        await done()
      }
    })

    test('from the worker, nothing gets out', async ({ serve }) => {
      const { page, done, named } = await pageIn(serve)
      try {
        const { tried, out, saw, changed } = await tryAll('worker', page, catchers, {
          named: !!named,
        })
        await test.info().attach('saw', { body: JSON.stringify({ out, changed, saw }, null, 2) })
        expect(tried).toBeGreaterThan(40)
        expect(out).toEqual({})
        // Nor did any of them leave a mark on the box's own page: after each, its document
        // was as Lumovi serves it, every element and attribute. On a server that page is held
        // by one thing alone, that no plugin's code runs on it.
        expect(changed).toEqual({})
        // And each way judged by what it saw was refused: none worked, whatever reached a catcher,
        // and none said something that's neither.
        expect(notRefused(saw)).toEqual([])
        // In Chromium, whose own log of its network says so: what's refused is refused before
        // its host's name is asked for. The log holds no try's name, in a resolver's event or
        // any other.
        if (named) expect(await named()).toEqual({ lookedUp: [], anywhere: [] })
      } finally {
        await done()
      }
    })

    test('with the box’s wall taken away, what its code asks for leaves, and is caught: the tests can tell', async ({
      serve,
    }) => {
      // In every engine: the same ways, from the same worker, with the one wall a server has
      // taken away in the tests' build (`connect-src`). What gets out then is caught, so a list
      // that's empty with the wall in place is the wall's doing and not the catchers' miss.
      // It is the control for the ways that wall holds, the requests. The ways judged by what
      // the code saw of them (text made into code, a way back to what was taken away) have no
      // run without their wall on a server: they rest on that judging alone.
      const { page, done, named } = await pageIn(serve, {
        LUMOVI_TEST_BOX_WALL_OFF: 'connect-src',
      })
      try {
        const { out, saw } = await tryAll('worker', page, catchers, {
          only: 'request',
          named: !!named,
        })
        await test.info().attach('saw', { body: JSON.stringify({ out, saw }, null, 2) })
        console.log(`${name}, with the wall taken away, got out: ${JSON.stringify(out)}`)
        expect(out['fetch-other']).toContain('a request to another host')
        expect(Object.keys(out).length).toBeGreaterThan(3)
        // (In Chromium its own log names what it asked for, too: each host that got out.)
        if (named) expect((await named()).lookedUp).toContain('fetch-other')
      } finally {
        await done()
      }
    })

    test('the catchers are within this browser’s reach: the tests can tell', async ({ serve }) => {
      // (That nothing reaches them from a box means something only if something can: shown
      // above with the box's wall taken away, and on the desktop with each of its walls taken
      // away by itself. Here: the same addresses, asked from a page that's free to.)
      const { free, done, named } = await pageIn(serve)
      try {
        const context = catchers.context('fetch-other', undefined, !!named) as {
          leak: string
          other: string
          otherPort: number
        }
        const page = await free()
        await page.goto(`${context.other}/a-free-page`)
        catchers.reset()
        await page.evaluate((leak) => fetch(leak, { mode: 'no-cors' }), context.leak)
        expect(gotOut('fetch-other', catchers.caught())).toContain('a request to another host')
        if (named) {
          // And in Chromium a name is within its log's reach: the request's, and the names two
          // links ask for ahead of any request, which this browser looks up from a free page.
          const links = (['dns-prefetch', 'preconnect'] as const).map(
            (rel) => [rel, `http://${nameFor(`free-${rel}`)}:${context.otherPort}`] as const,
          )
          await page.evaluate((links) => {
            for (const [rel, href] of links) {
              document.head.append(Object.assign(document.createElement('link'), { rel, href }))
            }
          }, links)
          await pause(1500)
          expect((await named()).lookedUp.sort()).toEqual([
            'fetch-other',
            'free-dns-prefetch',
            'free-preconnect',
          ])
        }
        if (name === 'Firefox') {
          // And this Firefox acts ahead of a request, as a person's does: from a page that's
          // free to, a link that asks for a connection to another host gets one. (One that
          // didn't would have nothing for a box's page to hold, and its list would say nothing.)
          catchers.reset()
          await page.evaluate(
            (href) =>
              document.head.append(
                Object.assign(document.createElement('link'), { rel: 'preconnect', href }),
              ),
            `http://127.0.0.1:${context.otherPort}`,
          )
          await expect
            .poll(() => catchers.caught().connections, { timeout: 10_000 })
            .toBeGreaterThan(0)
          // (A connection made ready, and nothing else: nothing is asked on it. A request of
          // the page's own would be one, and would say nothing of acting ahead.)
          expect(catchers.caught().http).toEqual([])
        }
        await page.close().catch(() => undefined)
      } finally {
        await done()
      }
    })

    for (const group of GROUPS) {
      test(`on the box’s own page, only what’s named gets out: ${group}`, async ({ serve }) => {
        const { page, done, named } = await pageIn(serve)
        try {
          // (Where an engine's list is exact, what's known to get out is waited for.)
          const exactly = Object.entries(EXACTLY_ON_THE_PAGE[name] ?? {})
          const { out, saw } = await tryAll('page', page, catchers, {
            only: group,
            named: !!named,
            awaited: Object.fromEntries(exactly.map(([id, { out }]) => [id, out])),
          })
          const log = named ? await named() : undefined
          await test.info().attach('saw', { body: JSON.stringify({ out, log, saw }, null, 2) })
          if (Object.keys(out).length) {
            console.log(`${name}, on the box’s own page, got out: ${JSON.stringify(out)}`)
          }
          expect(
            Object.keys(out).filter((id) => !NOT_HELD_ON_THE_PAGE[name]!.includes(id)),
          ).toEqual([])
          if (log) {
            // In Chromium, whose log says what else a way did: exactly what's known of this
            // group's ways, no way more and none fewer.
            const seen = Object.fromEntries(
              [...new Set([...Object.keys(out), ...log.anywhere])].map((id) => [
                id,
                {
                  out: out[id] ?? '',
                  log: log.lookedUp.includes(id)
                    ? 'looked up'
                    : log.anywhere.includes(id)
                      ? 'named'
                      : 'nothing',
                },
              ]),
            )
            const known = Object.fromEntries(
              Object.entries(ON_THE_PAGE_IN_CHROMIUM).filter(
                ([id]) => ALL.find((way) => way.id === id)?.group === group,
              ),
            )
            expect(seen).toEqual(known)
          } else if (EXACTLY_ON_THE_PAGE[name]) {
            // In Firefox, at what a catcher sees: exactly what's known of this group's ways.
            expect(out).toEqual(
              Object.fromEntries(
                exactly
                  .filter(([id]) => ALL.find((way) => way.id === id)?.group === group)
                  .map(([id, { out }]) => [id, out]),
              ),
            )
          }
        } finally {
          await done()
        }
      })
    }
  })
}

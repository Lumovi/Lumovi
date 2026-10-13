/**
 * The ways out of a plugin's sealed box, each tried as a plugin's code would try it
 * (`plugin-box/ways-out.js`), with catchers that see whatever leaves (`plugin-box/catchers.ts`).
 *
 * From the worker, where a plugin's code runs: as shipped, and with one wall taken away at a
 * time, to show each is a wall by itself. On the box's own page, where no plugin's code ever
 * runs: as shipped, to know what the walls hold there without the worker's.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import type { ElectronApplication, Page } from '@playwright/test'
import { BOX_SCRIPT } from '../../src/shared/plugin-box.ts'
import { expect, test, type LaunchOptions, type Lumovi } from './fixtures.ts'
import { gotOut, nameFor, startCatchers, type Catchers } from './plugin-box/catchers.ts'
import { namedIn } from './plugin-box/net-log.ts'
import { JUDGED, notRefused } from './plugin-box/worked.ts'

const WAYS = readFileSync(resolve('tests/e2e/plugin-box/ways-out.js'), 'utf8')

interface Way {
  id: string
  group: string
  /** It needs a page: a worker has none to try it on. */
  needsDom: boolean
}

/** Every way, read from the list itself. */
const ALL: Way[] = (() => {
  const self: { ATTEMPT_IDS?: Way[] } = {}
  runInNewContext(WAYS, { self, setTimeout })
  return self.ATTEMPT_IDS!
})()
const GROUPS = [...new Set(ALL.map((way) => way.group))]

/** A test plugin that tries whichever way it's told to, and says what it saw of it. */
const TRIER = `${WAYS}
box.then(({ post, listen }) => {
  listen(async (told) => {
    if (!told || !told.attempt) return
    told.context.post = (message) => post(message)
    post(JSON.stringify({ saw: await self.runAttempt(told.attempt, told.context) }))
  })
  post('ready')
})`

/** A test plugin that only sits there: for trying things on its box's own page. */
const IDLE = `box.then(({ post }) => post('ready'))`

interface Kept {
  heard: string[]
  ended?: unknown
  box: { post(message: unknown): void; close(): void }
  /** Its frame on the page. */
  frame?: Element
}
/** (Said in full wherever it's used: what runs on the page takes nothing of this file with it.) */
type OnPage = { __boxes: Record<string, Kept> }

/** Opens a test plugin's box and waits until its worker says it's ready. */
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
      // (Its frame is the one just added.)
      const frame = [...document.querySelectorAll('iframe')].at(-1)
      ;(w.__boxes ??= {})[as] = Object.assign(kept, { box, frame })
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
  page
    .evaluate((as) => (window as unknown as OnPage).__boxes[as]?.box.close(), as)
    .catch(() => undefined)

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** Tries one way in a box's worker: what the plugin's code saw of it. */
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

/** Tries one way on a box's own page, where Lumovi's few lines run and no plugin's code. */
async function onPage(
  page: Page,
  app: ElectronApplication,
  as: string,
  id: string,
  context: object,
): Promise<string> {
  await open(page, as, IDLE)
  // Which of the page's frames it is, in the page's order (the main process's is the same).
  const index = await page.evaluate(
    (as) =>
      [...document.querySelectorAll('iframe')].indexOf(
        (window as unknown as OnPage).__boxes[as]!.frame as never,
      ),
    as,
  )
  return app
    .evaluate(
      async ({ BrowserWindow }, { ways, id, context, index }) => {
        const [win] = BrowserWindow.getAllWindows()
        const frames = win!.webContents.mainFrame.framesInSubtree.filter((frame) => {
          try {
            return frame.url.startsWith('lumovi-plugin:')
          } catch {
            return false
          }
        })
        const frame = frames.at(index)
        if (!frame) return 'no such frame'
        const run = `${ways}\n;(() => { const c = ${JSON.stringify(context)}; c.post = () => undefined; return self.runAttempt(${JSON.stringify(id)}, c) })()`
        try {
          return String(
            await Promise.race([
              frame.executeJavaScript(run),
              new Promise((done) => setTimeout(() => done('no word back'), 3200)),
            ]),
          )
        } catch (error) {
          return `the frame went: ${(error as Error).message.slice(0, 80)}`
        }
      },
      { ways: WAYS, id, context, index },
    )
    .catch((error: Error) => `the frame went: ${error.message.slice(0, 80)}`)
}

/** Every way of a group, tried one after another: which of them got something out, and what. */
async function tryGroup(
  where: 'worker' | 'page',
  group: string,
  page: Page,
  app: ElectronApplication,
  catchers: Catchers,
  /** The other host goes by each try's own name: for a run whose log of the network is read. */
  named = false,
): Promise<{ tried: number; out: Record<string, string>; saw: Record<string, string> }> {
  const ways = ALL.filter((way) => way.group === group && (where === 'page' || !way.needsDom))
  const out: Record<string, string> = {}
  const saw: Record<string, string> = {}
  const tryIt = (as: string, id: string, role?: 'first' | 'second') =>
    where === 'worker'
      ? inWorker(page, as, id, catchers.context(id, role, named))
      : onPage(page, app, as, id, catchers.context(id, role, named))
  for (const [n, { id }] of ways.entries()) {
    catchers.reset()
    if (group === 'pair') {
      // Two boxes of one plugin alive together: what one can leave for the other.
      const first = tryIt(`${n}-first`, id, 'first')
      await pause(300)
      const second = await tryIt(`${n}-second`, id, 'second')
      saw[id] = `first: ${await first} / second: ${second}`
      await close(page, `${n}-second`)
    } else {
      saw[id] = await tryIt(`${n}-first`, id)
    }
    // (What's on its way has the time to arrive.)
    await pause(group === 'port' ? 600 : 350)
    const got = gotOut(id, catchers.caught())
    if (got) out[id] = got
    await close(page, `${n}-first`)
  }
  return { tried: ways.length, out, saw }
}

/** Takes one of the desktop's walls away, in the app's main process, for a test. */
async function without(app: ElectronApplication, wall: 'the box’s policy' | 'the request filter') {
  await app.evaluate(
    ({ protocol, session }, { wall, script }) => {
      if (wall === 'the request filter') {
        session.defaultSession.webRequest.onBeforeRequest(null)
        return
      }
      // The box as it is, sandboxed and nothing more: no policy of its own.
      protocol.unhandle('lumovi-plugin')
      protocol.handle('lumovi-plugin', (request) => {
        const { hostname, pathname } = new URL(request.url)
        if (pathname === '/box.js') {
          return new Response(script, {
            headers: {
              'content-type': 'text/javascript',
              'cross-origin-resource-policy': 'cross-origin',
            },
          })
        }
        return new Response(
          `<!doctype html><meta charset="utf-8"><body><script src="lumovi-plugin://${hostname}/box.js"></script>`,
          {
            headers: {
              'content-type': 'text/html',
              'content-security-policy': 'sandbox allow-scripts',
            },
          },
        )
      })
    },
    { wall, script: BOX_SCRIPT },
  )
}

/** The name the test itself asks for, which a log that's whole holds. */
const ASKED = 'asked-by-the-test'

/**
 * Lumovi keeping Chromium's own log of its network. `named()` has the app ask for a name of the
 * test's own, closes it, and reads which names the log holds: the test's (a log without it
 * wasn't kept), and those of the tries that were looked up.
 */
async function logged(launch: (options?: LaunchOptions) => Promise<Lumovi>) {
  const file = join(mkdtempSync(join(tmpdir(), 'lumovi-net-log-')), 'net-log.json')
  const lumovi = await launch({ args: [`--log-net-log=${file}`] })
  return {
    ...lumovi,
    async named() {
      await lumovi.app.evaluate(
        ({ session }, name) => session.defaultSession.resolveHost(name).catch(() => undefined),
        nameFor(ASKED),
      )
      await lumovi.close()
      const { events, lookedUp, anywhere } = namedIn(file)
      expect(events).toBeGreaterThan(0)
      expect(lookedUp).toContain(ASKED)
      const tries = (names: string[]) => names.filter((id) => id !== ASKED)
      return { lookedUp: tries(lookedUp), anywhere: tries(anywhere) }
    },
  }
}

let catchers: Catchers
test.beforeAll(async () => {
  catchers = await startCatchers()
})
test.afterAll(async () => {
  await catchers.close()
})
// (A group is tried one way after another, each in a box of its own.)
test.setTimeout(240_000)

test('the list holds every way that was ever tried', () => {
  expect(ALL).toHaveLength(167)
  expect(new Set(ALL.map((way) => way.id)).size).toBe(167)
  // Each of them judged: by the catchers alone, or by what it saw too (worked.ts). A way added
  // here fails until someone says how it's judged.
  expect(Object.keys(JUDGED).sort()).toEqual(ALL.map((way) => way.id).sort())
})

test('with both walls taken away the catchers see what leaves, and Chromium’s log names the hosts looked up: the tests can tell', async ({
  launch,
}) => {
  const { page, app, named } = await logged(launch)
  await without(app, 'the box’s policy')
  await without(app, 'the request filter')
  const { out, saw } = await tryGroup('worker', 'request', page, app, catchers, true)
  await test.info().attach('saw', { body: JSON.stringify({ out, saw }, null, 2) })
  expect(out['fetch-other']).toContain('a request to another host')
  expect(out['fetch-same-api']).toContain('a request to Lumovi’s own API')
  expect(Object.keys(out).length).toBeGreaterThan(3)
  // What got out to the other host asked for its name first, and the log says so by name.
  const { lookedUp } = await named()
  await test.info().attach('looked up', { body: JSON.stringify(lookedUp) })
  expect(lookedUp).toContain('fetch-other')
  expect(lookedUp.length).toBeGreaterThan(3)
})

for (const group of GROUPS) {
  if (ALL.some((way) => way.group === group && !way.needsDom)) {
    test(`from the worker, nothing gets out, and no name is looked up: ${group}`, async ({
      launch,
    }) => {
      const { page, app, named } = await logged(launch)
      const { tried, out, saw } = await tryGroup('worker', group, page, app, catchers, true)
      await test.info().attach('saw', { body: JSON.stringify(saw, null, 2) })
      expect(tried).toBeGreaterThan(0)
      expect(out).toEqual({})
      // And each way judged by what it saw was refused: none worked, whatever reached a catcher,
      // and none said something that's neither.
      expect(notRefused(saw)).toEqual([])
      // What's refused is refused before its host's name is asked for: Chromium's own log of
      // its network holds no try's name, in a resolver's event or any other.
      expect(await named()).toEqual({ lookedUp: [], anywhere: [] })
    })

    for (const wall of ['the box’s policy', 'the request filter'] as const) {
      test(`from the worker without ${wall}, still nothing gets out: ${group}`, async ({
        lumovi: { page, app },
      }) => {
        await without(app, wall)
        const { out, saw } = await tryGroup('worker', group, page, app, catchers)
        await test.info().attach('saw', { body: JSON.stringify(saw, null, 2) })
        expect(out).toEqual({})
      })
    }
  }

  test(`on the box’s own page, only what’s named gets out or is looked up: ${group}`, async ({
    launch,
  }) => {
    const { page, app, named } = await logged(launch)
    const { out, saw } = await tryGroup('page', group, page, app, catchers, true)
    await test.info().attach('saw', { body: JSON.stringify({ out, saw }, null, 2) })
    expect(Object.keys(out).filter((id) => !NOT_HELD_ON_THE_PAGE.includes(id))).toEqual([])
    const { lookedUp, anywhere } = await named()
    await test.info().attach('looked up', { body: JSON.stringify({ lookedUp, anywhere }) })
    expect(lookedUp.filter((id) => !NOT_HELD_ON_THE_PAGE.includes(id))).toEqual([])
  })
}

test('on the box’s own page without its policy, the request filter alone still holds every request', async ({
  lumovi: { page, app },
}) => {
  await without(app, 'the box’s policy')
  const { out, saw } = await tryGroup('page', 'request', page, app, catchers)
  await test.info().attach('saw', { body: JSON.stringify({ out, saw }, null, 2) })
  expect(out).toEqual({})
  // A packet by WebTransport would be one the filter never sees. A box's page has no
  // WebTransport to send it with: its address isn't a secure one, on purpose.
  expect(saw.webtransport).toBe('no such API')
})

/**
 * The one thing the desktop doesn't hold from a box's own page (never from its worker): WebRTC
 * with a TURN address over TCP opens a connection to any host. The request filter doesn't see
 * it, and WebRTC is kept from its own UDP only. It can't be reached: no plugin's code ever runs
 * on a box's page, only in its worker, which has no WebRTC.
 */
const NOT_HELD_ON_THE_PAGE = ['webrtc-turn-tcp']

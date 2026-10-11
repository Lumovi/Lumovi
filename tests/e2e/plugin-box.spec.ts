/**
 * A plugin's sealed box on the desktop: where a plugin's code runs, what it's kept from, and
 * when it's ended. Only test plugins of Lumovi's own run here; nothing in the app shows a
 * plugin's page yet, and the tests reach the box through the tests' build alone.
 */
import { createServer, type AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { BOX_LIMITS, takeOffScript } from '../../src/shared/plugin-box.ts'
import { CONTEXTS, DEMO, expect, openCluster, test } from './fixtures.ts'

/** What a test's box has heard and how it ended, kept on the page. */
interface Kept {
  heard: string[]
  ended?: { why: string; over?: string; said?: string }
}

/** Opens a test plugin's box on the page, under `as`. */
async function open(page: Page, plugin: string, code: string, as = plugin) {
  await page.waitForFunction(() => '__lumoviBox' in window)
  await page.evaluate(
    ({ plugin, code, as }) => {
      const w = window as unknown as {
        __lumoviBox: {
          openBox(options: object): { post(message: unknown): void; close(): void }
        }
        __boxes?: Record<string, Kept & { box: { post(m: unknown): void; close(): void } }>
      }
      const kept: Kept = { heard: [] }
      const box = w.__lumoviBox.openBox({
        plugin,
        code,
        heard: (text: string) => kept.heard.push(text),
        ended: (end: Kept['ended']) => (kept.ended = end),
      })
      ;(w.__boxes ??= {})[as] = Object.assign(kept, { box })
    },
    { plugin, code, as },
  )
}

const kept = (page: Page, as: string) =>
  page.evaluate((as) => {
    const { heard, ended } = (window as unknown as { __boxes: Record<string, Kept> }).__boxes[as]!
    return { heard: heard.slice(-20), count: heard.length, ended }
  }, as)

const close = (page: Page, as: string) =>
  page.evaluate(
    (as) =>
      (window as unknown as { __boxes: Record<string, { box: { close(): void } }> }).__boxes[
        as
      ]!.box.close(),
    as,
  )

/** The frames of the window that are a plugin's box, and the process each is in. */
const boxFrames = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const [win] = BrowserWindow.getAllWindows()
    const main = win!.webContents.mainFrame
    return {
      page: main.osProcessId,
      boxes: main.framesInSubtree
        .filter((frame) => frame.url.startsWith('lumovi-plugin:'))
        .map((frame) => ({ url: frame.url, pid: frame.osProcessId })),
    }
  })

/** Whether a process is still there. */
const alive = (app: ElectronApplication, pid: number) =>
  app.evaluate((_electron, pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }, pid)

/** A test plugin that says hello, then says back whatever Lumovi sends it. */
const ECHO = `box.then(({ post, listen }) => {
  post('hello from ' + self.location.protocol)
  listen((message) => post('heard ' + JSON.stringify(message)))
})`

test('a plugin’s code runs in a worker of a box, hears Lumovi and answers in text', async ({
  lumovi: { page, app },
}) => {
  await open(page, 'echo', ECHO)
  // Its worker is made from text: it has no address of the box's to ask anything of.
  await expect.poll(async () => (await kept(page, 'echo')).heard).toEqual(['hello from blob:'])
  await page.evaluate(() =>
    (
      window as unknown as { __boxes: Record<string, { box: { post(m: unknown): void } }> }
    ).__boxes.echo!.box.post({ ask: 1 }),
  )
  await expect
    .poll(async () => (await kept(page, 'echo')).heard)
    .toEqual(['hello from blob:', 'heard {"ask":1}'])
  // One frame, at the plugin's own address, in a process that isn't the page's.
  const frames = await boxFrames(app)
  expect(frames.boxes.map((box) => box.url)).toEqual(['lumovi-plugin://echo/box.html'])
  expect(frames.boxes[0]!.pid).not.toBe(frames.page)
  expect((await kept(page, 'echo')).ended).toBeUndefined()
})

test('two plugins are never in one process; two pages of one plugin share theirs', async ({
  lumovi: { page, app },
}) => {
  await open(page, 'first', ECHO)
  await open(page, 'second', ECHO)
  await open(page, 'first', ECHO, 'first-again')
  for (const as of ['first', 'second', 'first-again']) {
    await expect.poll(async () => (await kept(page, as)).count).toBe(1)
  }
  const { page: pagePid, boxes } = await boxFrames(app)
  const pids = (plugin: string) =>
    boxes.filter((box) => box.url === `lumovi-plugin://${plugin}/box.html`).map((box) => box.pid)
  expect(pids('first')).toHaveLength(2)
  expect(pids('second')).toHaveLength(1)
  // A plugin's pages are together, each in a worker of its own...
  expect(new Set(pids('first')).size).toBe(1)
  // ...and no plugin is with another, nor with Lumovi's page.
  expect(pids('second')[0]).not.toBe(pids('first')[0])
  expect([...pids('first'), ...pids('second')]).not.toContain(pagePid)
})

test('none runs unseen: a box closed is gone at once, and its process is given back', async ({
  lumovi: { page, app },
}) => {
  // A plugin that was never shown has nothing running.
  expect((await boxFrames(app)).boxes).toEqual([])
  // One that counts for as long as it lives.
  await open(
    page,
    'ticker',
    `box.then(({ post }) => { let n = 0; setInterval(() => post(String(++n)), 20) })`,
  )
  await expect.poll(async () => (await kept(page, 'ticker')).count).toBeGreaterThan(3)
  const { pid } = (await boxFrames(app)).boxes[0]!
  await close(page, 'ticker')
  // At once: no frame, and not one more word from it.
  expect((await boxFrames(app)).boxes).toEqual([])
  const { count } = await kept(page, 'ticker')
  await page.waitForTimeout(300)
  expect((await kept(page, 'ticker')).count).toBe(count)
  // Closing isn't an ending to tell anyone of.
  expect((await kept(page, 'ticker')).ended).toBeUndefined()
  // And its process is given back (the browser keeps one a little while, in case it's wanted).
  await expect.poll(() => alive(app, pid), { timeout: 30_000 }).toBe(false)
})

test('a worker that sends more than a plugin may is ended: messages, text, what isn’t text', async ({
  lumovi: { page },
}) => {
  // A flood: ended at the first message over, and the page got no more than the limit.
  await open(
    page,
    'flood',
    `box.then(({ post }) => { for (let i = 0; i < 100000; i++) post('x') })`,
  )
  await expect
    .poll(async () => (await kept(page, 'flood')).ended)
    .toEqual({ why: 'over', over: 'messages' })
  expect((await kept(page, 'flood')).count).toBe(BOX_LIMITS.messagesASecond)
  // One message too long, and many that add up.
  await open(
    page,
    'long',
    `box.then(({ post }) => post('x'.repeat(${BOX_LIMITS.textAMessage + 1})))`,
  )
  await expect
    .poll(async () => (await kept(page, 'long')).ended)
    .toEqual({ why: 'over', over: 'text' })
  expect((await kept(page, 'long')).count).toBe(0)
  await open(
    page,
    'much',
    `box.then(({ post }) => { const text = 'x'.repeat(1024 * 1024); for (let i = 0; i < 64; i++) post(text) })`,
  )
  await expect
    .poll(async () => (await kept(page, 'much')).ended)
    .toEqual({ why: 'over', over: 'text' })
  expect((await kept(page, 'much')).count).toBe(BOX_LIMITS.textASecond / (1024 * 1024))
  // Only text comes up: anything else ends it, and never reaches the page.
  await open(page, 'object', `box.then(({ post }) => post({ not: 'text' }))`)
  await expect
    .poll(async () => (await kept(page, 'object')).ended)
    .toEqual({ why: 'over', over: 'not-text' })
  expect((await kept(page, 'object')).count).toBe(0)
})

test('a plugin that fails says so in its own words, as text; one that goes silent is ended', async ({
  lumovi: { page },
}) => {
  await open(page, 'thrower', `throw new Error('<b>mine</b>')`)
  await expect.poll(async () => (await kept(page, 'thrower')).ended?.why).toBe('failed')
  expect((await kept(page, 'thrower')).ended?.said).toContain('<b>mine</b>')
  // Silent: it holds its thread, so not even Lumovi's first lines can answer a ping.
  await open(page, 'stuck', `box.then(() => { for (;;) {} })`)
  await expect
    .poll(async () => (await kept(page, 'stuck')).ended, {
      timeout: BOX_LIMITS.pingEveryMs * (BOX_LIMITS.missedPings + 4),
    })
    .toEqual({ why: 'silent' })
})

/** What the app's main process has written to its log so far. */
function logOf(app: ElectronApplication): () => string {
  let log = ''
  app.process().stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()))
  app.process().stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()))
  return () => log
}

test('a plugin that takes memory without end is ended with its process, and Lumovi’s page stays', async ({
  lumovi: { page, app },
}) => {
  const log = logOf(app)
  // Something of the page's own, to see that it's the same page afterwards.
  await page.evaluate(() => ((window as unknown as { __same: number }).__same = 1))
  await open(page, 'echo', ECHO)
  await open(
    page,
    'hog',
    `box.then(() => { const kept = []; setInterval(() => kept.push(new Uint8Array(48 * 1024 * 1024).fill(1)), 50) })`,
  )
  await expect.poll(async () => (await boxFrames(app)).boxes.length).toBe(2)
  const hog = (await boxFrames(app)).boxes.find((box) => box.url.includes('//hog/'))!
  await expect
    .poll(log, { timeout: 30_000 })
    .toContain('Lumovi ended the plugin hog: it was over its memory')
  await expect.poll(() => alive(app, hog.pid)).toBe(false)
  // Its page hears nothing more of it, and says so once its pings go unanswered.
  await expect
    .poll(async () => (await kept(page, 'hog')).ended, {
      timeout: BOX_LIMITS.pingEveryMs * (BOX_LIMITS.missedPings + 4),
    })
    .toEqual({ why: 'silent' })
  // Lumovi's own page wasn't reloaded for it, and another plugin goes on.
  expect(await page.evaluate(() => (window as unknown as { __same?: number }).__same)).toBe(1)
  await page.evaluate(() =>
    (
      window as unknown as { __boxes: Record<string, { box: { post(m: unknown): void } }> }
    ).__boxes.echo!.box.post('still there?'),
  )
  await expect
    .poll(async () => (await kept(page, 'echo')).heard.at(-1))
    .toBe('heard "still there?"')
  expect(log()).not.toContain('The page’s process ended')
  expect(log()).not.toContain("The page's process ended")
})

test('a busy plugin’s use of the processor is seen, and a quiet one’s isn’t taken for it', async ({
  lumovi: { page, app },
}) => {
  // Busy nearly all the time, in pieces short enough to answer Lumovi between them; and one
  // that only waits.
  await open(
    page,
    'busy',
    `box.then(() => { setInterval(() => { const until = Date.now() + 97; while (Date.now() < until); }, 100) })`,
  )
  await open(page, 'quiet', ECHO)
  await expect.poll(async () => (await boxFrames(app)).boxes.length).toBe(2)
  const { boxes } = await boxFrames(app)
  const pidOf = (plugin: string) => boxes.find((box) => box.url.includes(`//${plugin}/`))!.pid
  // What the system says each uses, as the app reads it: a share of one core, a second apart.
  const read = { busy: [] as number[], quiet: [] as number[] }
  for (let n = 0; n < 8; n++) {
    await new Promise((soon) => setTimeout(soon, 1000))
    const shares = await app.evaluate(
      ({ app }, pids) => {
        const cores = process.getBuiltinModule('node:os').cpus().length
        const metrics = app.getAppMetrics()
        return pids.map(
          (pid) =>
            ((metrics.find((metric) => metric.pid === pid)?.cpu.percentCPUUsage ?? 0) / 100) *
            cores,
        )
      },
      [pidOf('busy'), pidOf('quiet')],
    )
    read.busy.push(shares[0]!)
    read.quiet.push(shares[1]!)
  }
  await test.info().attach('shares of a core', { body: JSON.stringify(read) })
  // (Said in the run's own output too: what a busy plugin is given differs by computer.)
  console.log(`shares of a core, a second apart: ${JSON.stringify(read)}`)
  // (How much of a core a busy one is given depends on what else the computer is doing: a
  // third of one is seen even where four copies of the app share four cores.)
  const typical = (shares: number[]) => [...shares].sort((a, b) => a - b)[shares.length >> 1]!
  expect(typical(read.busy)).toBeGreaterThan(0.33)
  expect(typical(read.busy)).toBeLessThan(1.5)
  expect(typical(read.quiet)).toBeLessThan(0.2)
})

test('a plugin read as near a whole core for half a minute is ended, though it answers every ping', async ({
  lumovi: { page, app },
}) => {
  test.setTimeout(BOX_LIMITS.processorForMs + 90_000)
  const log = logOf(app)
  await open(page, 'steady', ECHO)
  await expect.poll(async () => (await boxFrames(app)).boxes.length).toBe(1)
  const { pid } = (await boxFrames(app)).boxes[0]!
  // What the system says of this one process, made to say a whole core from here on: the
  // same on a computer with a core to spare and on one without. (By the test's own hand in the
  // main process; nothing in Lumovi can be told what a process uses.)
  await app.evaluate(({ app }, pid) => {
    const cores = process.getBuiltinModule('node:os').cpus().length
    const real = app.getAppMetrics.bind(app)
    app.getAppMetrics = () =>
      real().map((metric) =>
        metric.pid === pid
          ? { ...metric, cpu: { ...metric.cpu, percentCPUUsage: 100 / cores } }
          : metric,
      )
  }, pid)
  const since = Date.now()
  const ENDED = 'Lumovi ended the plugin steady: it was over its time on the processor'
  // Not before its half a minute is nearly up: nothing is ended for the processor until it
  // has been measured for the whole of that time...
  await new Promise((later) => setTimeout(later, BOX_LIMITS.processorForMs * 0.6))
  expect(log()).not.toContain(ENDED)
  expect(await alive(app, pid)).toBe(true)
  // ...and then it is: for the processor, with its pings all answered.
  await expect.poll(log, { timeout: BOX_LIMITS.processorForMs + 30_000 }).toContain(ENDED)
  // (Once it has its thirty measures, half of them or more a whole core: it had two or three
  // before the reading was changed, so that's nearly the whole half minute later.)
  expect(Date.now() - since).toBeGreaterThan(BOX_LIMITS.processorForMs * 0.8)
  // And the page hears nothing more of it.
  await expect
    .poll(async () => (await kept(page, 'steady')).ended, {
      timeout: BOX_LIMITS.pingEveryMs * (BOX_LIMITS.missedPings + 4),
    })
    .toEqual({ why: 'silent' })
  await expect.poll(() => alive(app, pid)).toBe(false)
  expect(log()).not.toContain('over its memory')
})

/** What each of an assistant's tools is asked, to hear all it would say. */
const ASKED_OF_EACH_TOOL: Record<string, Record<string, unknown>> = {
  list_clusters: {},
  list_kinds: { cluster: CONTEXTS.demo },
  list_resources: { cluster: CONTEXTS.demo, kind: 'pods' },
  get_resource: {
    cluster: CONTEXTS.demo,
    kind: 'deployment',
    namespace: 'shop',
    name: DEMO.deployments.cart,
  },
  get_events: { cluster: CONTEXTS.demo },
  get_logs: { cluster: CONTEXTS.demo, namespace: 'shop', pod: DEMO.pods.cart },
  find_problems: { cluster: CONTEXTS.demo },
  apply_manifest: {
    cluster: CONTEXTS.demo,
    manifest:
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: from-a-test\n  namespace: shop\n',
    reason: 'A test.',
  },
  scale: {
    cluster: CONTEXTS.demo,
    kind: 'deployment',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    replicas: 3,
    reason: 'A test.',
  },
  restart: {
    cluster: CONTEXTS.demo,
    kind: 'deployment',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    reason: 'A test.',
  },
  delete_resource: {
    cluster: CONTEXTS.demo,
    kind: 'configmap',
    namespace: 'shop',
    name: 'never-made',
    reason: 'A test.',
  },
  wait_for_change: { id: 'none' },
}

test('nothing of a plugin’s page reaches an AI assistant’s tools', async ({ lumovi: { page } }) => {
  test.setTimeout(120_000)
  await openCluster(page)
  // A plugin with a text of its own and a value it works out, both sent up to Lumovi's page
  // and put on it, as a page of a plugin's would be.
  const TEXT = 'a-plugin-wrote-this-7f3a'
  await open(
    page,
    'marker',
    `box.then(({ post }) => post('${TEXT} and worked out ' + (6151 * 7919)))`,
  )
  await expect.poll(async () => (await kept(page, 'marker')).count).toBe(1)
  const VALUE = String(6151 * 7919)
  await page.evaluate(() => {
    const shown = document.createElement('p')
    shown.textContent = (
      window as unknown as { __boxes: Record<string, Kept> }
    ).__boxes.marker!.heard[0]!
    document.body.append(shown)
  })
  await expect(page.getByText(TEXT)).toBeVisible()

  // An assistant, as any connects; every tool it's offered is asked.
  const port = await new Promise<number>((found) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      server.close(() => found(port))
    })
  })
  const status = await page.evaluate(
    (port) => window.lumovi!.assistants!.configure({ enabled: true, port }),
    port,
  )
  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(status.url!), {
      requestInit: { headers: { Authorization: `Bearer ${status.token}` } },
    }),
  )
  const { tools } = await client.listTools()
  // (A tool this test doesn't ask is a tool nobody has looked at for this.)
  expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(ASKED_OF_EACH_TOOL).sort())
  const said: string[] = [JSON.stringify(tools)]
  for (const tool of tools) {
    // (One that waits for the person says nothing in time: nothing is what it gave.)
    const answer = await client
      .callTool({ name: tool.name, arguments: ASKED_OF_EACH_TOOL[tool.name] }, undefined, {
        timeout: 4000,
      })
      .then(
        (result) => JSON.stringify(result),
        (error: Error) => `(${error.message})`,
      )
    said.push(answer)
  }
  await client.close()
  expect(said.join('\n').length).toBeGreaterThan(2000)
  for (const answer of said) {
    expect(answer).not.toContain(TEXT)
    expect(answer).not.toContain(VALUE)
  }
})

test('a plugin’s boxes can be taken off the page by Lumovi itself, and only that plugin’s', async ({
  lumovi: { page, app },
}) => {
  // What the app does for a plugin found in the page's own process, which it can't end: tried
  // here on a real page, by the very words the app would hand it.
  await open(page, 'first', ECHO)
  await open(page, 'first', ECHO, 'first-again')
  await open(page, 'second', ECHO)
  await expect.poll(async () => (await boxFrames(app)).boxes.length).toBe(3)
  const gone = await app.evaluate(
    ({ BrowserWindow }, script) => {
      const [win] = BrowserWindow.getAllWindows()
      return win!.webContents.mainFrame.executeJavaScript(script) as Promise<number>
    },
    takeOffScript(['first']),
  )
  expect(gone).toBe(2)
  expect((await boxFrames(app)).boxes.map((box) => box.url)).toEqual([
    'lumovi-plugin://second/box.html',
  ])
  // The other goes on.
  await page.evaluate(() =>
    (
      window as unknown as { __boxes: Record<string, { box: { post(m: unknown): void } }> }
    ).__boxes.second!.box.post('still there?'),
  )
  await expect
    .poll(async () => (await kept(page, 'second')).heard.at(-1))
    .toBe('heard "still there?"')
  // A name that's no plugin's takes nothing off, and none that isn't one can be asked for.
  expect(
    await app.evaluate(
      ({ BrowserWindow }, script) => {
        const [win] = BrowserWindow.getAllWindows()
        return win!.webContents.mainFrame.executeJavaScript(script) as Promise<number>
      },
      takeOffScript(['nobody']),
    ),
  ).toBe(0)
  expect(() => takeOffScript(['"); alert(1); ("'])).toThrow()
})

test('the box’s protocol serves its two files and nothing else, however it’s asked', async ({
  lumovi: { app },
}) => {
  // Asked from the main process, as nothing of a page may.
  const ask = (url: string, method = 'GET') =>
    app.evaluate(
      async ({ net }, { url, method }) => {
        const answer = await net.fetch(url, { method, bypassCustomProtocolHandlers: false })
        return { status: answer.status, type: answer.headers.get('content-type') ?? '' }
      },
      { url, method },
    )
  // With the request filter on, even that is cancelled: it's nobody's frame that asks.
  await expect(ask('lumovi-plugin://echo/box.html')).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/)
  // (Taken away, to hear the protocol itself.)
  await app.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest(null))
  expect(await ask('lumovi-plugin://echo/box.html')).toMatchObject({ status: 200 })
  expect((await ask('lumovi-plugin://echo/box.js')).type).toContain('text/javascript')
  for (const [url, method] of [
    ['lumovi-plugin://echo/other.html', 'GET'],
    ['lumovi-plugin://echo/', 'GET'],
    // Anything added to its address isn't its address.
    ['lumovi-plugin://echo/box.html?d=SECRET', 'GET'],
    // A name no plugin can have.
    ['lumovi-plugin://lumovi/box.html', 'GET'],
    ['lumovi-plugin://Not_A_Name/box.html', 'GET'],
    // Only asked for, never sent to.
    ['lumovi-plugin://echo/box.html', 'POST'],
  ] as const) {
    expect((await ask(url, method)).status, `${method} ${url}`).toBe(404)
  }
})

test('a frame of the window goes nowhere but to a box’s own document', async ({
  lumovi: { page, app },
}) => {
  await open(page, 'echo', ECHO)
  await expect.poll(async () => (await kept(page, 'echo')).count).toBe(1)
  // By the test's hand on the box's page (no plugin's code runs there): to the box's own
  // script as if it were a page, which the page's policy lets through and the app's own guard
  // doesn't.
  const went = await app.evaluate(async ({ BrowserWindow }) => {
    const [win] = BrowserWindow.getAllWindows()
    const frame = win!.webContents.mainFrame.framesInSubtree.find((at) =>
      at.url.startsWith('lumovi-plugin:'),
    )!
    await frame
      .executeJavaScript(`location.href = 'lumovi-plugin://echo/box.js'`)
      .catch(() => undefined)
    await new Promise((later) => setTimeout(later, 500))
    return win!.webContents.mainFrame.framesInSubtree
      .map((at) => at.url)
      .filter((url) => url.startsWith('lumovi-plugin:'))
  })
  expect(went).toEqual(['lumovi-plugin://echo/box.html'])
  // And it's the same box still: its worker answers.
  await page.evaluate(() =>
    (
      window as unknown as { __boxes: Record<string, { box: { post(m: unknown): void } }> }
    ).__boxes.echo!.box.post('still there?'),
  )
  await expect
    .poll(async () => (await kept(page, 'echo')).heard.at(-1))
    .toBe('heard "still there?"')
})

test('a window that isn’t showing doesn’t count a plugin’s silence against it', async ({
  lumovi: { page },
}) => {
  test.setTimeout(90_000)
  // The page as it is while its window is hidden or behind another: the system may hold its
  // timers and a plugin's back then, and an unanswered ping says nothing.
  await page.evaluate(() =>
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }),
  )
  // One that's silent from its first moment without holding a processor (which is ended on a
  // clock of its own): what goes back for a ping of Lumovi's isn't an answer to it. (Nothing
  // but Lumovi's own words answers for Lumovi: a worker that breaks its first lines is silent.)
  await open(page, 'stuck', `JSON.stringify = () => 'not an answer'`)
  await new Promise((later) =>
    setTimeout(later, BOX_LIMITS.pingEveryMs * (BOX_LIMITS.missedPings + 3)),
  )
  expect((await kept(page, 'stuck')).ended).toBeUndefined()
  // Showing again, its silence counts from then, from the start.
  await page.evaluate(() =>
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    }),
  )
  await new Promise((later) => setTimeout(later, BOX_LIMITS.pingEveryMs * 2))
  expect((await kept(page, 'stuck')).ended).toBeUndefined()
  await expect
    .poll(async () => (await kept(page, 'stuck')).ended, {
      // (Unhurried: a busy computer spaces the pings out, and a long gap starts the count over.)
      timeout: BOX_LIMITS.pingEveryMs * (BOX_LIMITS.missedPings + 4) + 30_000,
    })
    .toEqual({ why: 'silent' })
})

test('a box closed is closed once, and only a plugin’s name opens one', async ({
  lumovi: { page, app },
}) => {
  await open(page, 'echo', ECHO)
  await expect.poll(async () => (await kept(page, 'echo')).count).toBe(1)
  // Closed again, as a page leaving twice would: nothing more happens, and nothing is said.
  await close(page, 'echo')
  await close(page, 'echo')
  expect((await boxFrames(app)).boxes).toEqual([])
  expect((await kept(page, 'echo')).ended).toBeUndefined()
  // A name that isn't a plugin's has no address, so no box: refused before a frame is made.
  for (const name of ['Not A Name', 'lumovi', 'lumovi-own', 'kubernetes', 'a/../b', '']) {
    const refused = await page.evaluate((name) => {
      const w = window as unknown as { __lumoviBox: { openBox(options: object): unknown } }
      try {
        w.__lumoviBox.openBox({ plugin: name, code: '', heard() {}, ended() {} })
        return 'opened'
      } catch (error) {
        return (error as Error).message
      }
    }, name)
    expect(refused, name).toBe(`${name} isn’t a plugin’s name`)
  }
  expect(await page.locator('iframe').count()).toBe(0)
})

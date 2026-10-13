/**
 * Lumovi's check of a plugin's box in the person's own browser, in each browser engine: it passes
 * where the box holds (no box reaching out, nor finding another's things, side by side or after),
 * and code is handed over; with one of the box's walls taken away on purpose (the tests' build
 * alone can), it fails and no code is; and a check that never answers doesn't pass either. What
 * reached the server is what it judges by, even once it has judged: a page already handed code
 * then ends. Behind a sign-in proxy, a pass is the page's alone.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, firefox, webkit, type Page } from '@playwright/test'
import type { NotHanded, PluginCode } from '../../src/shared/plugin-hand-over.ts'
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

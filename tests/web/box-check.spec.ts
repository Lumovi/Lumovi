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
        // What got out is what reached the server: at least a request, whatever the box said.
        expect(failed?.details?.ways).toEqual(expect.arrayContaining(['fetch']))
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
    'Lumovi checked this browser and found that a plugin’s code could get out of its box here',
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

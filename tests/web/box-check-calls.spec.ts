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
  // (And what reaches the catcher under a name that's no way's is kept as one "other".)
  const third = (await check.start())!
  expect((await fetch(`${server.url}box-check/${third.nonce}/made-up`)).status).toBe(204)
  expect(await check.end(third.nonce, null, [])).toBe('failed')
  expect(await check.handOver()).toBe('check-failed')
  expect(audited(server, 'plugin.box-check').map((event) => event.outcome)).toEqual(['failure'])
  expect(audited(server, 'plugin.code')).toEqual([])
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

/**
 * A hostile plugin against a team's server, where only the plugins in its image run: the server
 * has no call that would install, update, take back, remove or agree to a plugin, and refuses
 * each by name, writing nothing.
 */
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC } from '../../src/shared/api.ts'
import { DEMO_TOKEN, expect, signIn, test } from './fixtures.ts'

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

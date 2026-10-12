/**
 * Lumovi's check of a plugin's box in this browser, from the page's side: a server asks for it
 * before it hands this browser any plugin's code. The check's code runs in a box made exactly as
 * a plugin's; this page waits for what it reports, listens where it shouldn't be heard, and hands
 * both to the server, which judges. Silence is a check that didn't finish.
 */
import { BOX_CHECK_LIMITS, boxCheckChannel } from '@shared/box-check'
import type { PluginCode } from '@shared/plugin-hand-over'
import { api } from '@renderer/lib/api'
import { openBox, type Box } from './box'

/** Runs a check of this browser's box, if the server asks for one: how it came out. */
export async function checkBox(): Promise<'passed' | 'failed' | 'unfinished' | undefined> {
  const start = await api.kube.boxCheckStart?.()
  if (!start) return undefined
  const name = boxCheckChannel(start.nonce)
  // Where the check's worker sends: Lumovi's own page hearing it means it got out of its box.
  const heard = new Set<string>()
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(name)
  if (channel) channel.onmessage = () => void heard.add('broadcast-channel')
  const report = await new Promise<string | null>((done) => {
    let box: Box | undefined = undefined
    const timer = setTimeout(() => {
      box?.close()
      done(null)
    }, BOX_CHECK_LIMITS.answerWithinMs)
    box = openBox({
      // (Lumovi's own: no plugin's name, and no plugin's box on the desktop, which never asks.)
      plugin: 'lumovi-box-check',
      code: start.code,
      heard(text) {
        clearTimeout(timer)
        box?.close()
        done(text)
      },
      ended() {
        clearTimeout(timer)
        done(null)
      },
    })
  })
  channel?.close()
  // And what it could only keep: its own origin's, never Lumovi's (a browser may give a box a
  // store of its own, which is no way out). Found in Lumovi's own, it got out.
  for (const way of await landed(name)) heard.add(way)
  return api.kube.boxCheckEnd?.(start.nonce, report, [...heard])
}

/** Which of Lumovi's own page's stores hold what a check put under `name`; each then let go. */
async function landed(name: string): Promise<string[]> {
  const found: string[] = []
  try {
    if (typeof caches !== 'undefined' && (await caches.has(name))) {
      found.push('caches')
      await caches.delete(name)
    }
  } catch {
    // (No storage of Lumovi's own here, so nothing could land in it.)
  }
  try {
    const databases = typeof indexedDB === 'undefined' ? [] : await indexedDB.databases()
    if (databases.some((database) => database.name === name)) {
      found.push('indexed-db')
      indexedDB.deleteDatabase(name)
    }
  } catch {
    // (As above.)
  }
  return found
}

/**
 * A plugin's code, as Lumovi hands it over: where a server hasn't checked this browser's box yet
 * (or its check didn't finish), the check first, once, and then asked again.
 */
export async function codeOf(plugin: string): Promise<PluginCode> {
  const answer = await api.kube.pluginCode(plugin)
  if (answer.ok || (answer.refused !== 'not-checked' && answer.refused !== 'check-unfinished')) {
    return answer
  }
  if ((await checkBox()) === undefined) return answer
  return api.kube.pluginCode(plugin)
}

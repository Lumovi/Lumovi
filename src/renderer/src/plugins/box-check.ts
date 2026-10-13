/**
 * Lumovi's check of a plugin's box in this browser, from the page's side: a server asks for it
 * before it hands this browser any plugin's code. The check's code runs in boxes made exactly as
 * a plugin's: two side by side, then, once they're closed, a third. This page waits for what each
 * reports, listens where none should be heard, and hands it all to the server, which judges.
 * Silence is a check that didn't finish.
 */
import {
  BOX_CHECK_LIMITS,
  BOX_CHECK_LOOK,
  boxCheckChannel,
  boxCheckKept,
  boxCheckStore,
  type BoxCheckRole,
} from '@shared/box-check'
import type { PluginCode } from '@shared/plugin-hand-over'
import { api } from '@renderer/lib/api'
import { openBox, type Box } from './box'

/**
 * Whether this page has run a check: one that couldn't look is run again only once the page is
 * loaded again (the person may have let this site keep things since).
 */
let checkedHere = false

/** Runs a check of this browser's box, if the server asks for one: how it came out. */
export async function checkBox(): Promise<'passed' | 'failed' | 'unfinished' | undefined> {
  const start = await api.kube.boxCheckStart?.()
  if (!start) return undefined
  checkedHere = true
  const { nonce, code } = start
  // Where the check's boxes send: Lumovi's own page hearing it means it got out of its box. And
  // where this page couldn't look or listen: no pass rests on a look that wasn't made, whatever
  // the reason (what this page lacks, a box in its frame may still have).
  const heard = new Set<string>()
  const unlooked = new Set<string>()
  let channel: BroadcastChannel | undefined
  try {
    channel = new BroadcastChannel(boxCheckChannel(nonce))
    channel.onmessage = () => void heard.add('broadcast-channel')
  } catch {
    unlooked.add('broadcast-channel')
  }
  const until = Date.now() + BOX_CHECK_LIMITS.answerWithinMs
  const reports: Record<BoxCheckRole, string | null> = { first: null, second: null, later: null }
  Object.assign(reports, await opened(nonce, { first: code.first, second: code.second }, until))
  // (The later box looks for what the first two left: only once they've both answered, and gone.)
  if (reports.first !== null && reports.second !== null) {
    Object.assign(reports, await opened(nonce, { later: code.later }, until))
  }
  channel?.close()
  // And what they could only keep: their own origin's, never Lumovi's (a browser may give a box
  // a store of its own, which is no way out, unless another box sees it). Found in Lumovi's own,
  // it got out.
  for (const role of ['first', 'second'] as const) {
    for (const way of await landed(boxCheckStore(nonce, role), unlooked)) heard.add(way)
  }
  return api.kube.boxCheckEnd?.(nonce, reports, [...heard], [...unlooked])
}

/**
 * Opens a check's boxes, each with its code, side by side: what each reported, or nothing for one
 * that didn't by `until`. They're all closed when it's over. A side-by-side box says when it has
 * kept what it can; once every one has, each is told to look for the others'.
 */
async function opened(
  nonce: string,
  code: Partial<Record<BoxCheckRole, string>>,
  until: number,
): Promise<Partial<Record<BoxCheckRole, string | null>>> {
  const roles = Object.keys(code) as BoxCheckRole[]
  const boxes = new Map<BoxCheckRole, Box>()
  const kept = new Set<BoxCheckRole>()
  const reports: Partial<Record<BoxCheckRole, string | null>> = {}
  await new Promise<void>((done) => {
    const timer = setTimeout(done, Math.max(0, until - Date.now()))
    const answered = (role: BoxCheckRole, report: string | null) => {
      if (Object.hasOwn(reports, role)) return
      reports[role] = report
      if (roles.every((each) => Object.hasOwn(reports, each))) {
        clearTimeout(timer)
        done()
      }
    }
    for (const role of roles) {
      boxes.set(
        role,
        openBox({
          // (Lumovi's own: no plugin's name, and no plugin's box on the desktop, which never asks.)
          plugin: 'lumovi-box-check',
          code: code[role]!,
          heard(text) {
            if (role !== 'later' && text === boxCheckKept(nonce, role)) {
              kept.add(role)
              if (kept.size === roles.length)
                for (const box of boxes.values()) box.post(BOX_CHECK_LOOK)
            } else answered(role, text)
          },
          ended: () => answered(role, null),
        }),
      )
    }
  })
  for (const box of boxes.values()) box.close()
  return Object.fromEntries(roles.map((role) => [role, reports[role] ?? null]))
}

/**
 * Which of Lumovi's own page's stores hold what a check put under `name`; each then let go. A
 * store this page can't look in (it hasn't got it, or the look throws) goes into `unlooked`:
 * never "nothing landed".
 */
async function landed(name: string, unlooked: Set<string>): Promise<string[]> {
  const found: string[] = []
  try {
    if (await caches.has(name)) {
      found.push('caches')
      await caches.delete(name)
    }
  } catch {
    unlooked.add('caches')
  }
  try {
    // (Older engines have no list of databases: that's a look that can't be made, too.)
    const databases = await indexedDB.databases()
    if (databases.some((database) => database.name === name)) {
      found.push('indexed-db')
      indexedDB.deleteDatabase(name)
    }
  } catch {
    unlooked.add('indexed-db')
  }
  return found
}

/**
 * A plugin's code, as Lumovi hands it over: where a server hasn't checked this browser's box yet
 * (or its check didn't finish), the check first, once, and then asked again. One that couldn't
 * look is checked again only on a page loaded since.
 */
export async function codeOf(plugin: string): Promise<PluginCode> {
  const answer = await api.kube.pluginCode(plugin)
  const due =
    !answer.ok &&
    (answer.refused === 'not-checked' ||
      answer.refused === 'check-unfinished' ||
      (answer.refused === 'check-unlooked' && !checkedHere))
  if (!due) return answer
  // (A server that has no box, so no check, refuses the call: the answer stands as it was.)
  const checked = await checkBox().catch(() => undefined)
  if (checked === undefined) return answer
  return api.kube.pluginCode(plugin)
}

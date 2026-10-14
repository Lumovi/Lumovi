/**
 * Lumovi's check of a plugin's box in this browser, from the page's side: a server asks for it
 * before it hands this browser any plugin's code. The check's code runs in boxes made exactly as
 * a plugin's: two side by side, then, once they're closed, a third. This page waits for what each
 * reports, listens where none should be heard, and hands it all to the server, which judges.
 * Silence is a check that didn't finish. And this page opens one more frame, Lumovi's own, sealed
 * as a box is and with no plugin's code in it, which asks the server's catcher in every shape a
 * box's request has (the control): only a catcher that such a request reached can say that
 * nothing of a box's did.
 */
import {
  BOX_CHECK_LIMITS,
  BOX_CHECK_LOOK,
  boxCheckChannel,
  boxCheckKept,
  boxCheckStore,
  type BoxCheckRole,
} from '@shared/box-check'
import { CHECK_FRAME_DONE, CHECK_FRAME_WAIT_MS } from '@shared/plugin-box'
import type { NotHanded, PluginCode } from '@shared/plugin-hand-over'
import { PATHS } from '@shared/server'
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
  // The control, asked as the boxes start: whether it arrived is the server's to say.
  const controlled = control(start.control)
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
  // (Judged only once the control's frame has asked, and been answered, refused or given up on.)
  await controlled
  return api.kube.boxCheckEnd?.(nonce, reports, [...heard], [...unlooked])
}

/**
 * The control: Lumovi's own sealed frame, opened here, handed the address to ask (`at`, the
 * check's catcher with a nonce no box is told), and waited for until it says it's done, or for
 * as long as it may take. It's then taken away. Nothing of what it asked is known here: the
 * server knows which of its asks arrived, and in what shape. A frame that doesn't load, or says
 * nothing, is a control that didn't arrive.
 */
async function control(at: string): Promise<void> {
  const frame = document.createElement('iframe')
  frame.hidden = true
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  frame.src = new URL(PATHS.boxCheckFrame, document.baseURI).href
  await new Promise<void>((done) => {
    const over = () => {
      clearTimeout(waiting)
      removeEventListener('message', said)
      frame.remove()
      done()
    }
    // (Its asks' own time, and as long again for the frame to load.)
    const waiting = setTimeout(over, CHECK_FRAME_WAIT_MS * 2)
    const said = (event: MessageEvent) => {
      if (event.source === frame.contentWindow && event.data === CHECK_FRAME_DONE) over()
    }
    addEventListener('message', said)
    // (Sealed, its origin is nobody's, so there's none to name: what's handed is only where to
    // ask, and its policy holds it to the catcher whatever it's handed.)
    frame.addEventListener('load', () => frame.contentWindow?.postMessage(at, '*'), { once: true })
    document.body.append(frame)
  })
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
 * Whether a refusal is one a check of this browser's box, run now, may change: none yet, or one
 * that didn't finish. One that couldn't look, or whose own request didn't reach the server, is
 * checked again only on a page loaded since.
 */
const checkDue = (refused: NotHanded) =>
  refused === 'not-checked' ||
  refused === 'check-unfinished' ||
  ((refused === 'check-unlooked' || refused === 'check-unreached') && !checkedHere)

/**
 * A plugin's code, as Lumovi hands it over: where a server hasn't checked this browser's box yet
 * (or its check didn't finish), the check first, once, and then asked again.
 */
export async function codeOf(plugin: string): Promise<PluginCode> {
  const answer = await api.kube.pluginCode(plugin)
  if (answer.ok || !checkDue(answer.refused)) return answer
  // (A server that has no box, so no check, refuses the call: the answer stands as it was.)
  const checked = await checkBox().catch(() => undefined)
  if (checked === undefined) return answer
  return api.kube.pluginCode(plugin)
}

/**
 * Whether a plugin's code would be handed over, or why not, as `codeOf` would find it (the check
 * first, where it's due), without handing any: for a page that only needs to know.
 */
export async function handOverOf(plugin: string): Promise<true | NotHanded> {
  const answer = await api.kube.pluginHandOver(plugin)
  if (answer === true || !checkDue(answer)) return answer
  const checked = await checkBox().catch(() => undefined)
  if (checked === undefined) return answer
  return api.kube.pluginHandOver(plugin)
}

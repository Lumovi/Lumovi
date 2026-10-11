/**
 * A plugin's sealed box, from the page's side: the frame is made when a page of a plugin shows
 * and taken away when it no longer does, so none of a plugin's code runs unseen. The page hands
 * the box the text its worker is made from, hears what the worker sends up (text, counted by the
 * box's own script), and pings it: a worker that leaves too many pings unanswered while the
 * window shows is ended.
 *
 * In the tests' build only, so far (`main.tsx`): nothing in Lumovi shows a plugin's page yet, and
 * a release build has none of this.
 */
import { BOX_LIMITS, boxAddress, workerText, type BoxNotice } from '@shared/plugin-box'

/**
 * Why a box's worker is no more: the plugin's own failure, or Lumovi ending it. `said` is the
 * plugin's own text, as it wrote it: whatever shows it shows it as plain text, cleaned as any
 * text of a plugin's is, and marked as the plugin's.
 */
export type BoxEnd =
  | { why: 'failed'; said: string }
  | { why: 'over'; over: 'messages' | 'text' | 'not-text' }
  | { why: 'silent' }

export interface Box {
  /** Sends the worker something of Lumovi's. */
  post(message: unknown): void
  /** Takes the box away: its worker with it, at once. */
  close(): void
}

export interface BoxOptions {
  /** The plugin's name: its box's address, and so its process. */
  plugin: string
  /** The plugin's own code, as text. */
  code: string
  /** What the worker sent up: text, never anything else. */
  heard(text: string): void
  /** The worker is gone, and why. Said once; the frame is taken away with it. */
  ended(end: BoxEnd): void
  /** Where the frame goes (it shows nothing: a plugin's page is drawn by Lumovi). */
  into?: HTMLElement
}

/** Opens a plugin's box and starts its worker. */
export function openBox({ plugin, code, heard, ended, into = document.body }: BoxOptions): Box {
  const { document: address } = boxAddress(plugin)
  const frame = document.createElement('iframe')
  frame.hidden = true
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  frame.src = address
  const channel = new MessageChannel()
  let over = false
  let pings: ReturnType<typeof setInterval> | undefined
  const close = () => {
    if (over) return
    over = true
    clearInterval(pings)
    removeEventListener('message', ready)
    channel.port1.close()
    frame.remove()
  }
  const end = (how: BoxEnd) => {
    if (over) return
    close()
    ended(how)
  }

  // Its pings: asked, and the answers counted, only while the window shows; and from the start
  // again after a gap longer than any tick should be (the computer slept).
  let asked = 0
  let answered = 0
  let last = Date.now()
  const ping = () => {
    const now = Date.now()
    const slept = now - last > BOX_LIMITS.pingEveryMs * 3
    last = now
    if (document.visibilityState !== 'visible' || slept) {
      asked = answered
      return
    }
    if (asked - answered >= BOX_LIMITS.missedPings) return end({ why: 'silent' })
    channel.port1.postMessage({ box: 'ping', n: ++asked })
  }

  channel.port1.onmessage = ({ data }: MessageEvent<string | BoxNotice>) => {
    if (typeof data !== 'string') {
      // The box's own script, about the worker.
      if (data.box === 'failed') end({ why: 'failed', said: data.said })
      else end({ why: 'over', over: data.over })
      return
    }
    // (A pong is the worker's first lines answering; anything else is the plugin's.)
    const pong = PONG.exec(data)
    if (pong) answered = Math.max(answered, Math.min(asked, Number(pong[1])))
    else heard(data)
  }

  // The box's script says when it can take the text; only then, and only to that frame.
  function ready(event: MessageEvent) {
    if (event.source !== frame.contentWindow || event.origin !== 'null') return
    if ((event.data as { box?: unknown } | null)?.box !== 'ready') return
    removeEventListener('message', ready)
    frame.contentWindow!.postMessage({ text: workerText(code) }, '*', [channel.port2])
    pings = setInterval(ping, BOX_LIMITS.pingEveryMs)
  }
  addEventListener('message', ready)
  into.append(frame)
  return { post: (message) => channel.port1.postMessage(message), close }
}

/** The first lines' answer to a ping, exactly as they write it. */
const PONG = /^\{"box":"pong","n":(\d+)\}$/

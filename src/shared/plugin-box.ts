/**
 * The sealed box a plugin's code runs in: a frame from an address of its own, sealed by its
 * policy, holding one worker. A plugin's code runs only in that worker; the frame's own page runs
 * a few lines of Lumovi's, which make the worker and count what it sends up.
 *
 * Here: the box's document, its script, the headers that seal it, the worker's first lines, and
 * the limits a plugin is ended at. The desktop serves these from a protocol of its own
 * (`src/main/plugin-box.ts`); a server will from a path of its own.
 */
import { PLUGIN_NAME } from './plugins'

/** The protocol the desktop serves a box from: another site than Lumovi's page, to the browser. */
export const BOX_SCHEME = 'lumovi-plugin'

/**
 * What a plugin is ended at. A limit measured on its process ends every page of that plugin at
 * once; one counted on a worker ends that page alone.
 */
export const BOX_LIMITS = {
  /** Of its process's memory, in bytes (a box with a page in it takes about a quarter of this). */
  memory: 400 * 1024 * 1024,
  /**
   * How often its process is measured. Between two measures nothing of Lumovi's stands in the
   * way: what does is the engine's own ceiling for a process.
   */
  measureEveryMs: 1000,
  /**
   * Of a processor, as a share of one core on average, and over how long, before it's ended.
   * Half a core is a first line, not a measured one: what settles it is the average over thirty
   * seconds of a real plugin's page at its heaviest (a first load on a large cluster), once
   * there is one; if that comes near this, the line moves then, by that measure.
   *
   * It bounds what a plugin costs, not what it wants: one that would take a whole core and is
   * given less than this by a busy computer isn't over it, and is ended when the computer has
   * the core to give, or never.
   */
  processor: 0.5,
  processorForMs: 30_000,
  /**
   * Lumovi's pings a worker may leave unanswered, and how far apart they're sent. Counted only
   * while the window shows, and from the start again after the computer has slept. An answer
   * says the worker is alive, nothing about what it does.
   */
  missedPings: 5,
  pingEveryMs: 2000,
  /** How long a box has to say it's there, once it's asked for. */
  readyWithinMs: 10_000,
  /**
   * What a worker may send up in each second counted from its first message (a window that
   * starts again, not a sliding one: a flood guard, not an exact rate, so at most twice this
   * across the edge of two seconds), and at once: messages, and characters of text.
   */
  messagesASecond: 2000,
  textAMessage: 8 * 1024 * 1024,
  textASecond: 16 * 1024 * 1024,
} as const

/**
 * Whether a name can be a box's host: a plugin's name as its file may give it (the format's own
 * pattern), and none of the names no plugin can have.
 */
const isBoxName = (name: string): boolean =>
  PLUGIN_NAME.test(name) &&
  name !== 'lumovi' &&
  name !== 'kubernetes' &&
  !name.startsWith('lumovi-')

/**
 * Where a plugin's box is, on the desktop: a host for each plugin, so a process for each plugin
 * and a worker for each page of it. Two pages of one plugin share its process, which is fine
 * while they are the same code under the same grants: it holds for as long as a plugin's grant
 * is one for the whole installation. If a grant ever differs between two pages of one plugin,
 * this is to be looked at again.
 */
export function boxAddress(plugin: string): { origin: string; document: string; script: string } {
  if (!isBoxName(plugin)) throw new Error(`${plugin} isn’t a plugin’s name`)
  const origin = `${BOX_SCHEME}://${plugin}`
  return { origin, document: `${origin}/box.html`, script: `${origin}/box.js` }
}

/** The plugin a box's address is for, if it is a box's document or its script. */
export function boxOf(url: string): { plugin: string; file: 'document' | 'script' } | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== `${BOX_SCHEME}:` || !isBoxName(parsed.hostname)) return undefined
  if (parsed.search || parsed.hash || parsed.username || parsed.password || parsed.port) {
    return undefined
  }
  if (parsed.pathname === '/box.html') return { plugin: parsed.hostname, file: 'document' }
  if (parsed.pathname === '/box.js') return { plugin: parsed.hostname, file: 'script' }
  return undefined
}

/**
 * The box's policy: its own script and the one worker made from text; no network at all, no
 * frame, nothing else of a page's. `page` is what may show it (Lumovi's own page).
 *
 * The policy is the wall. The worker's first lines (below) are hardening behind it; only a
 * worker made by a worker rests on them alone.
 */
export function boxHeaders(script: string, page: string): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': [
      'sandbox allow-scripts',
      "default-src 'none'",
      `script-src ${script}`,
      'worker-src blob:',
      "connect-src 'none'",
      "img-src 'none'",
      "style-src 'none'",
      "font-src 'none'",
      "media-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "child-src 'none'",
      "manifest-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      `frame-ancestors ${page}`,
    ].join('; '),
    'Permissions-Policy': BOX_FEATURES_OFF.map((feature) => `${feature}=()`).join(', '),
    'X-DNS-Prefetch-Control': 'off',
  }
}

export const boxDocument = (script: string): string =>
  `<!doctype html><meta charset="utf-8"><title>plugin</title><body><script src="${script}"></script>`

/** Sent with the box's script: a sealed frame is another origin, even to what serves it. */
export const BOX_SCRIPT_HEADERS: Record<string, string> = {
  'Content-Type': 'text/javascript; charset=utf-8',
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

/**
 * Every feature a page can be given, switched off for a box: each that Chromium knows, in
 * Lumovi's desktop and in the tests' browser (the tests hold that: one a new Chromium knows fails
 * them until it's named here), and those only another browser knows. Off because Lumovi says so,
 * never because a browser leaves one off in a frame by default.
 */
export const BOX_FEATURES_OFF = [
  'accelerometer',
  'ambient-light-sensor',
  'aria-notify',
  'autoplay',
  'bluetooth',
  'browsing-topics',
  'camera',
  'captured-surface-control',
  'ch-device-memory',
  'ch-downlink',
  'ch-dpr',
  'ch-ect',
  'ch-prefers-color-scheme',
  'ch-prefers-reduced-motion',
  'ch-prefers-reduced-transparency',
  'ch-rtt',
  'ch-save-data',
  'ch-ua',
  'ch-ua-arch',
  'ch-ua-bitness',
  'ch-ua-form-factors',
  'ch-ua-full-version',
  'ch-ua-full-version-list',
  'ch-ua-high-entropy-values',
  'ch-ua-mobile',
  'ch-ua-model',
  'ch-ua-platform',
  'ch-ua-platform-version',
  'ch-ua-wow64',
  'ch-viewport-height',
  'ch-viewport-width',
  'ch-width',
  'clipboard-read',
  'clipboard-write',
  'compute-pressure',
  'cross-origin-isolated',
  'deferred-fetch',
  'deferred-fetch-minimal',
  'digital-credentials-get',
  'display-capture',
  'encrypted-media',
  'fullscreen',
  'gamepad',
  'geolocation',
  'gyroscope',
  'hid',
  'identity-credentials-get',
  'idle-detection',
  'interest-cohort',
  'join-ad-interest-group',
  'keyboard-map',
  'language-detector',
  'language-model',
  'local-fonts',
  'local-network',
  'local-network-access',
  'loopback-network',
  'magnetometer',
  'microphone',
  'midi',
  'on-device-speech-recognition',
  'otp-credentials',
  'payment',
  'picture-in-picture',
  'private-aggregation',
  'private-state-token-issuance',
  'private-state-token-redemption',
  'publickey-credentials-create',
  'publickey-credentials-get',
  'run-ad-auction',
  'screen-wake-lock',
  'serial',
  'shared-storage',
  'shared-storage-select-url',
  'storage-access',
  'summarizer',
  'sync-xhr',
  'translator',
  'unload',
  'usb',
  'window-management',
  'xr-spatial-tracking',
] as const

/** What the box's script tells Lumovi's page, beside handing on what the worker sends. */
export type BoxNotice =
  /** The worker failed; `said` is the plugin's own text, to be shown as that and nothing more. */
  | { box: 'failed'; said: string }
  /** Lumovi's lines ended the worker: it sent more than a plugin may, or something that isn't text. */
  | { box: 'ended'; over: 'messages' | 'text' | 'not-text' }

/**
 * The box's own script: Lumovi's, never a plugin's. It makes the one worker from the text
 * Lumovi's page hands it (once: a second text is ignored), takes that text's address away again,
 * and stands between the worker and the page. Only text comes up from a worker; it's counted,
 * and a worker that's over is ended. It sets no `onmessage` on the worker itself: all it hears
 * of a plugin comes up the one channel it counts.
 */
export const BOX_SCRIPT = `'use strict'
const MOST_MESSAGES_A_SECOND = ${BOX_LIMITS.messagesASecond}
const MOST_TEXT_A_MESSAGE = ${BOX_LIMITS.textAMessage}
const MOST_TEXT_A_SECOND = ${BOX_LIMITS.textASecond}
let made = false
addEventListener('message', (event) => {
  if (made || event.source !== parent || typeof event.data?.text !== 'string') return
  const [port] = event.ports
  if (!port) return
  made = true
  const address = URL.createObjectURL(new Blob([event.data.text], { type: 'text/javascript' }))
  const worker = new Worker(address)
  URL.revokeObjectURL(address)
  const own = new MessageChannel()
  const end = (notice) => {
    worker.terminate()
    own.port1.close()
    port.postMessage(notice)
  }
  worker.onerror = (error) => {
    error.preventDefault()
    end({ box: 'failed', said: String(error.message ?? '').slice(0, 200) })
  }
  // A second is the plugin's: each counted from its first message, not from when this script
  // began (a worker that's slow to start would otherwise have part of its first second taken
  // from it, and the ceiling loosened by however slow that was). A window that starts again,
  // not a sliding one: a flood guard, not an exact rate.
  let since
  let messages = 0
  let text = 0
  own.port1.onmessage = (message) => {
    if (typeof message.data !== 'string') return end({ box: 'ended', over: 'not-text' })
    const now = performance.now()
    if (since === undefined || now - since > 1000) {
      since = now
      messages = 0
      text = 0
    }
    messages++
    text += message.data.length
    if (messages > MOST_MESSAGES_A_SECOND) return end({ box: 'ended', over: 'messages' })
    if (message.data.length > MOST_TEXT_A_MESSAGE || text > MOST_TEXT_A_SECOND) {
      return end({ box: 'ended', over: 'text' })
    }
    port.postMessage(message.data)
  }
  port.onmessage = (message) => own.port1.postMessage(message.data)
  worker.postMessage({ port: own.port2 }, [own.port2])
})
parent.postMessage({ box: 'ready' }, '*')
`

/**
 * Lumovi's first lines in a worker, before a plugin's own: what makes more code is taken away
 * (a worker, a shared one, a script by address, an address for text), and the channel is made
 * ready as `box`: `box.then(({ post, listen }) => …)`, text up and whatever Lumovi sends down.
 * A ping of Lumovi's is answered here.
 *
 * Hardening, not a wall: a plugin's code runs in the same scope after these lines and can undo
 * what they set up for itself. The box's policy is what holds; and an answered ping says a
 * worker is alive, never that it behaves.
 */
export const WORKER_FIRST_LINES = `for (const name of ['Worker', 'SharedWorker', 'importScripts']) {
  for (let at = self; at; at = Object.getPrototypeOf(at)) { try { delete at[name] } catch {} }
}
try { Object.defineProperty(URL, 'createObjectURL', { value: undefined, configurable: false, writable: false }) } catch {}
self.box = new Promise((ready) => {
  self.onmessage = (event) => {
    const port = event.data && event.data.port
    if (!port) return
    self.onmessage = null
    const heard = []
    port.onmessage = (message) => {
      const data = message.data
      if (data && data.box === 'ping') return port.postMessage(JSON.stringify({ box: 'pong', n: data.n }))
      for (const hear of heard) hear(data)
    }
    ready(Object.freeze({ post: (text) => port.postMessage(text), listen: (hear) => { heard.push(hear) } }))
  }
});
`

/**
 * The text a worker is made from: Lumovi's first lines, then the plugin's own. (Each of Lumovi's
 * statements ends with its semicolon, and the plugin's code starts on a statement of its own:
 * code that starts with a parenthesis, as a bundler's does, is never read as a call of the line
 * before it.)
 */
export const workerText = (plugin: string): string => `${WORKER_FIRST_LINES};\n${plugin}`

/** A box as it's placed: its plugin, and the process its frame is in. */
export interface BoxPlace {
  plugin: string
  pid: number
}

/**
 * What the boxes' places ask for. Each plugin is to be in processes of its own: a process that
 * holds two plugins is to be ended, both with it; and a plugin with a box in the page's own
 * process, which can't be ended, is to have its boxes taken off the page. For the rest, whose
 * each process is.
 */
export function placed(
  boxes: BoxPlace[],
  page: number,
): { endProcesses: Map<number, string[]>; takeOff: string[]; pluginOf: Map<number, string> } {
  const inProcess = new Map<number, Set<string>>()
  for (const { plugin, pid } of boxes) {
    inProcess.set(pid, (inProcess.get(pid) ?? new Set()).add(plugin))
  }
  const endProcesses = new Map<number, string[]>()
  const takeOff: string[] = []
  const pluginOf = new Map<number, string>()
  for (const [pid, plugins] of inProcess) {
    if (pid === page) takeOff.push(...plugins)
    else if (plugins.size > 1) endProcesses.set(pid, [...plugins])
    else pluginOf.set(pid, [...plugins][0]!)
  }
  return { endProcesses, takeOff, pluginOf }
}

/**
 * What Lumovi's page runs to take every box of `plugins` off itself: how many frames went. (The
 * one case where a plugin's process can't be ended, since it's the page's own.)
 */
export function takeOffScript(plugins: string[]): string {
  const starts = plugins.map((plugin) => `${boxAddress(plugin).origin}/`)
  return `(() => {
  const starts = ${JSON.stringify(starts)}
  let gone = 0
  for (const frame of [...document.querySelectorAll('iframe')]) {
    if (starts.some((start) => frame.src.startsWith(start))) {
      frame.remove()
      gone++
    }
  }
  return gone
})()`
}

/**
 * Whether a process has been near a whole core over the last while: its share of a core at each
 * of the last `measures` measures, on average. (Not "without a break": an idle second now and
 * then would undo that.)
 */
export function overProcessor(lately: number[], measures: number): boolean {
  if (lately.length < measures) return false
  const recent = lately.slice(-measures)
  return recent.reduce((sum, share) => sum + share, 0) / measures >= BOX_LIMITS.processor
}

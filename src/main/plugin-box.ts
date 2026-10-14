/**
 * The sealed box on the desktop (`@shared/plugin-box`): served from a protocol of Lumovi's own
 * with a host for each plugin, so each plugin's frames are another site to the browser and in a
 * process of their own. And what only the desktop has, each a wall behind the box's policy:
 *
 * - whatever a plugin's frame, or a worker of it, asks the network for is cancelled, by whose
 *   request it is, and so is a request that can't be tied to a frame at all;
 * - a frame's navigation anywhere but to a box's own document is cancelled;
 * - nothing in the window reaches the network by WebRTC's own UDP;
 * - no page of the app looks a name up ahead of a request, which a link on a page may ask for
 *   and neither the policy nor the filter has a say in;
 * - a plugin's process is measured, and ended when it's over its memory or its processor time.
 *
 * One thing isn't held here, from a box's own page only (never from its worker): WebRTC with a
 * TURN address over TCP opens a connection the filter doesn't see. It can't be reached: no
 * plugin's code ever runs on a box's page, only in its worker.
 */
import { cpus } from 'node:os'
import { app, protocol, type BrowserWindow, type Session, type WebFrameMain } from 'electron'
import {
  BOX_LIMITS,
  BOX_SCHEME,
  boxDocument,
  boxHeaders,
  boxOf,
  overProcessor,
  placed,
  takeOffScript,
  type BoxPlace,
} from '@shared/plugin-box'
import { BOX_SCRIPT_SOURCE } from '@backend/plugin-box-script'

/**
 * Before the app is ready: the protocol is a standard one (it has hosts, so each plugin is a
 * site of its own), and nothing more. Not a secure one: a box needs nothing that only a secure
 * context has, and without it a box's page has less (no WebTransport, for one).
 */
export function registerBoxScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: BOX_SCHEME, privileges: { standard: true } }])
}

/**
 * Before the app is ready: no page looks a name up ahead of a request. A link that asks for it
 * (`<link rel="dns-prefetch">`) on a box's own page would be looked up whatever the box says:
 * its policy has no word for it, the request filter never sees it, and Chromium heeds the box's
 * `X-DNS-Prefetch-Control: off` only for the links it guesses at, never for one that asks. No
 * plugin's code runs on that page; a name doesn't leave it all the same.
 *
 * It's for every page of the app, Lumovi's own too: none of them asks for a name ahead, and
 * nothing of Lumovi's is slower or different without it.
 *
 * This is the one place `blink-settings` is set. A second `appendSwitch` of it anywhere would
 * replace this value, not add to it: another setting goes into this string, after a comma.
 */
export function noNamesAhead(): void {
  app.commandLine.appendSwitch('blink-settings', 'dnsPrefetchingEnabled=false')
}

/**
 * What may show a box: Lumovi's own page (a file of the app's; under `npm run dev`, the
 * development server's).
 */
export function pageSource(pageUrl: string): string {
  const { protocol: scheme, origin } = new URL(pageUrl)
  return scheme === 'file:' ? 'file:' : origin
}

/** Once it's ready: a box's one document, the same whoever asks, and nothing else. */
export function serveBoxes(pageUrl: string): void {
  const headers = boxHeaders(BOX_SCRIPT_SOURCE, pageSource(pageUrl))
  protocol.handle(BOX_SCHEME, (request) =>
    request.method === 'GET' && boxOf(request.url)
      ? new Response(boxDocument(), { headers })
      : new Response('Not found', { status: 404 }),
  )
}

/** The plugin whose box a frame is, or is inside of. */
function pluginOf(frame: WebFrameMain | null | undefined): string | undefined {
  for (let at = frame; at; at = at.parent) {
    const box = boxOf(at.url)
    if (box) return box.plugin
    if (at.url.startsWith(`${BOX_SCHEME}:`)) return ''
  }
  return undefined
}

/**
 * Whether a request is let through. A plugin's frame and its workers get their box's own
 * document and nothing else; a request whose frame can't be told (it's gone, or there never
 * was one) is cancelled unless it's a window's own page arriving.
 */
export function letThrough(details: {
  url: string
  resourceType: string
  frame?: WebFrameMain | null
}): boolean {
  let plugin: string | undefined
  try {
    // (A frame that's gone, or whose process is, throws when it's asked anything.)
    const frame = details.frame
    if (!frame) return details.resourceType === 'mainFrame'
    plugin = pluginOf(frame)
  } catch {
    return details.resourceType === 'mainFrame'
  }
  if (plugin === undefined) return true
  const asked = boxOf(details.url)
  return asked !== undefined && asked.plugin === plugin
}

/** The filter, for a session's every request. */
export function filterRequests(session: Session): void {
  session.webRequest.onBeforeRequest((details, respond) => {
    respond({ cancel: !letThrough(details) })
  })
}

/** For a window: no frame of it goes anywhere but to a box's own document, and no WebRTC UDP. */
export function guardFrames(win: BrowserWindow): void {
  win.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && !boxOf(event.url)) event.preventDefault()
  })
  win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
}

/** Why Lumovi ended a plugin's process. */
export type BoxOver = 'memory' | 'processor' | 'shared'

/** A plugin's process as it was last measured. */
export interface BoxProcess {
  plugin: string
  pid: number
  /** Bytes: what's the process's own where the system says (Windows), else all it holds. */
  memory: number
  /** Of one core, since the last measure. */
  processor: number
}

/** A window's boxes now: each one's plugin and the process it's in; and the page's own process. */
export function boxProcesses(win: BrowserWindow): { page: number; boxes: BoxPlace[] } {
  if (win.isDestroyed()) return { page: 0, boxes: [] }
  const main = win.webContents.mainFrame
  const boxes: BoxPlace[] = []
  for (const frame of main.framesInSubtree) {
    try {
      const box = boxOf(frame.url)
      if (box && frame.osProcessId > 0) boxes.push({ plugin: box.plugin, pid: frame.osProcessId })
    } catch {
      // A frame whose process has just gone (ended here, or by itself) can't be asked: it has
      // nothing running to measure.
    }
  }
  return { page: main.osProcessId, boxes }
}

/**
 * Takes every box of `plugins` off a window's page: how many frames went. Throws if the page
 * couldn't be asked, or if a frame of theirs is still there afterwards.
 */
export async function takeBoxesOff(win: BrowserWindow, plugins: string[]): Promise<number> {
  const gone = (await win.webContents.mainFrame.executeJavaScript(takeOffScript(plugins))) as number
  // (That a frame has gone reaches here by another way than the page's answer: looked for a
  // few times, a moment apart, before it's taken for still there.)
  for (let again = 5; ; again--) {
    const left = boxProcesses(win).boxes.filter((box) => plugins.includes(box.plugin))
    if (left.length === 0) return gone
    if (again === 0) throw new Error(`${left.length} of its frames are still on the page`)
    await new Promise((soon) => setTimeout(soon, 50))
  }
}

/** Ends a plugin's process, now: there's nothing for it to tidy, and a limit doesn't wait. */
function end(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Gone by itself meanwhile.
  }
}

/**
 * Measures the plugins' processes of a window, and ends one that's over its memory, or near a
 * whole core over the last while. And holds, while the app runs, what the box rests on: a
 * plugin found in a process with another plugin has that process ended, and one found in the
 * page's own process (which can't be ended) has its boxes taken off the page. `ended` is told
 * which plugin and why; every page of it went. Returns how to stop measuring.
 */
export function watchBoxes(
  win: BrowserWindow,
  ended: (plugin: string, over: BoxOver) => void,
  /** A plugin in the page's own process couldn't be taken off the page: it's still there. */
  stillThere: (plugin: string, why: string) => void,
  measured?: (processes: BoxProcess[]) => void,
): () => void {
  /** What each process used of a core at each of the last measures: as many as the limit looks at. */
  const used = new Map<number, number[]>()
  const WINDOW = Math.round(BOX_LIMITS.processorForMs / BOX_LIMITS.measureEveryMs)
  /** The plugins being taken off the page just now: asked once, not at every measure. */
  const leaving = new Set<string>()
  const timer = setInterval(() => {
    const { page, boxes } = boxProcesses(win)
    const { endProcesses, takeOff, pluginOf: whose } = placed(boxes, page)
    for (const pid of used.keys()) if (!whose.has(pid)) used.delete(pid)
    if (boxes.length === 0) return
    for (const [pid, plugins] of endProcesses) {
      end(pid)
      used.delete(pid)
      for (const plugin of plugins) ended(plugin, 'shared')
    }
    // (The page is Lumovi's own: its boxes are taken off it by Lumovi's own hand. Said as
    // ended only once they are; and if they can't be, that's what's said.)
    const toTakeOff = takeOff.filter((plugin) => !leaving.has(plugin))
    if (toTakeOff.length) {
      for (const plugin of toTakeOff) leaving.add(plugin)
      void takeBoxesOff(win, toTakeOff)
        .then(
          () => toTakeOff.forEach((plugin) => ended(plugin, 'shared')),
          (error: Error) => toTakeOff.forEach((plugin) => stillThere(plugin, error.message)),
        )
        .finally(() => toTakeOff.forEach((plugin) => leaving.delete(plugin)))
    }
    const seen: BoxProcess[] = []
    for (const metric of app.getAppMetrics()) {
      const plugin = whose.get(metric.pid)
      // (Never the page's own process, nor one already ended above.)
      if (plugin === undefined || metric.pid === page || endProcesses.has(metric.pid)) continue
      // (Kilobytes. Only Windows says what's the process's own.)
      const memory = (metric.memory.privateBytes ?? metric.memory.workingSetSize) * 1024
      // (Said as a share of all the computer's processors: of one core, it's that many times more.)
      const processor = (metric.cpu.percentCPUUsage / 100) * cpus().length
      seen.push({ plugin, pid: metric.pid, memory, processor })
      const lately = [...(used.get(metric.pid) ?? []), processor].slice(-WINDOW)
      used.set(metric.pid, lately)
      const over: BoxOver | undefined =
        memory > BOX_LIMITS.memory
          ? 'memory'
          : overProcessor(lately, WINDOW)
            ? 'processor'
            : undefined
      if (!over) continue
      used.delete(metric.pid)
      end(metric.pid)
      ended(plugin, over)
    }
    measured?.(seen)
  }, BOX_LIMITS.measureEveryMs)
  timer.unref()
  return () => clearInterval(timer)
}

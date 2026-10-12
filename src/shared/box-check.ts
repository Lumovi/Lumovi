/**
 * Lumovi's check of a plugin's box in the person's own browser, before that browser is handed
 * any plugin's code: a worker of Lumovi's own, in a box made exactly as a plugin's, tries every
 * way out a plugin's code could, each at a catcher of the server's own. What reached the
 * catcher, the server saw; what the worker saw of each, it reports. It passes only if nothing
 * reached the catcher, the report came in time, and it names every way here, each refused.
 */

/**
 * Every way out the check tries, from a worker. Fixed here: a report that leaves one out
 * fails. One the browser doesn't have is said as `absent`, never left out.
 */
export const BOX_CHECK_WAYS = [
  'fetch',
  'fetch-credentials',
  'fetch-keepalive',
  'xhr',
  'event-source',
  'web-socket',
  'web-socket-stream',
  'web-transport',
  'beacon',
  'import',
  'import-scripts',
  'worker',
  'blob-worker',
  'shared-worker',
  'caches',
  'indexed-db',
  'broadcast-channel',
] as const

export type BoxCheckWay = (typeof BOX_CHECK_WAYS)[number]

/**
 * What the worker saw of a way: it was refused (it threw, or failed); the browser hasn't it;
 * it was only sent (one way, with nothing to see back: whether it arrived is the catcher's or
 * the page's to say); or it reached what it aimed at.
 */
export type WaySaw = 'refused' | 'absent' | 'sent' | 'reached'

/** How long the check may take: the worker's answer, and how long a check's nonce lives. */
export const BOX_CHECK_LIMITS = {
  /** Each way's own try, in the worker. */
  aWayMs: 1500,
  /** The page waits this long for the worker's report: past it, the check didn't finish. */
  answerWithinMs: 15_000,
  /** A nonce lives this long from its check's start: the answer's time, and a little. */
  nonceLiveMs: 20_000,
  /** What the catcher records for one nonce, at most. */
  hitsANonce: 50,
} as const

/**
 * The name a check sends under where it can only send (a broadcast channel, a cache, a database):
 * Lumovi's own page listens and looks under it while the check runs. What it finds there got out.
 */
export const boxCheckChannel = (nonce: string) => `lumovi-box-check-${nonce}`

/**
 * The ways whose arrival Lumovi's own page, not the server, can see: what the box's worker can
 * only send to its own origin's channel or storage, which must never be Lumovi's.
 */
export const PAGE_SEES: readonly BoxCheckWay[] = ['broadcast-channel', 'caches', 'indexed-db']

/**
 * The check's code, as a plugin's is run (after the box's first lines): it tries each way at
 * `catcher` (the server's own address for this check, `…/box-check/<nonce>`) and sends up what
 * it saw, as text, in one message.
 */
export function boxCheckCode(catcher: string, nonce: string): string {
  const http = JSON.stringify(catcher)
  const ws = JSON.stringify(catcher.replace(/^http/, 'ws'))
  const channel = JSON.stringify(boxCheckChannel(nonce))
  return `box.then(async ({ post }) => {
  const at = (way) => ${http} + '/' + way
  const within = (promise) => Promise.race([promise, new Promise((done) => setTimeout(() => done('refused'), ${BOX_CHECK_LIMITS.aWayMs}))])
  const has = (name) => typeof self[name] !== 'undefined'
  const event = (open) => new Promise((done) => { try { open(() => done('reached'), () => done('refused')) } catch { done('refused') } })
  const tries = {
    fetch: () => has('fetch') ? fetch(at('fetch'), { mode: 'no-cors' }).then(() => 'reached', () => 'refused') : 'absent',
    'fetch-credentials': () => has('fetch') ? fetch(at('fetch-credentials'), { mode: 'no-cors', credentials: 'include' }).then(() => 'reached', () => 'refused') : 'absent',
    'fetch-keepalive': () => has('fetch') ? fetch(at('fetch-keepalive'), { mode: 'no-cors', keepalive: true }).then(() => 'reached', () => 'refused') : 'absent',
    xhr: () => has('XMLHttpRequest') ? event((yes, no) => { const x = new XMLHttpRequest(); x.onload = yes; x.onerror = no; x.open('GET', at('xhr')); x.send() }) : 'absent',
    'event-source': () => has('EventSource') ? event((yes, no) => { const e = new EventSource(at('event-source')); e.onopen = () => { e.close(); yes() }; e.onerror = () => { e.close(); no() } }) : 'absent',
    'web-socket': () => has('WebSocket') ? event((yes, no) => { const s = new WebSocket(${ws} + '/web-socket'); s.onopen = () => { s.close(); yes() }; s.onerror = no }) : 'absent',
    'web-socket-stream': () => has('WebSocketStream') ? new WebSocketStream(${ws} + '/web-socket-stream').opened.then(() => 'reached', () => 'refused') : 'absent',
    'web-transport': () => has('WebTransport') ? new WebTransport(at('web-transport').replace(/^http:/, 'https:')).ready.then(() => 'reached', () => 'refused') : 'absent',
    beacon: () => self.navigator && typeof self.navigator.sendBeacon === 'function' ? (self.navigator.sendBeacon(at('beacon'), 'x') ? 'sent' : 'refused') : 'absent',
    import: () => import(at('import') + '.js').then(() => 'reached', () => 'refused'),
    'import-scripts': () => typeof self.importScripts === 'function' ? (() => { try { self.importScripts(at('import-scripts') + '.js'); return 'reached' } catch { return 'refused' } })() : 'absent',
    worker: () => has('Worker') ? event((yes, no) => { const w = new Worker(at('worker') + '.js'); w.onmessage = yes; w.onerror = no }) : 'absent',
    'blob-worker': () => has('Worker') && has('Blob') && typeof URL.createObjectURL === 'function' ? event((yes, no) => { const w = new Worker(URL.createObjectURL(new Blob(['fetch(' + JSON.stringify(at('blob-worker')) + ', { mode: "no-cors" }).then(() => postMessage(1), () => {})']))); w.onmessage = yes; w.onerror = no }) : 'absent',
    'shared-worker': () => has('SharedWorker') ? event((yes, no) => { const w = new SharedWorker(at('shared-worker') + '.js'); w.onerror = no; w.port.onmessage = yes }) : 'absent',
    caches: () => has('caches') ? caches.open(${channel}).then((c) => c.put(new Request(at('caches')), new Response('out'))).then(() => 'sent', () => 'refused') : 'absent',
    'indexed-db': () => has('indexedDB') ? new Promise((done) => { try { const r = indexedDB.open(${channel}); r.onsuccess = () => { r.result.close(); done('sent') }; r.onerror = () => done('refused') } catch { done('refused') } }) : 'absent',
    'broadcast-channel': () => has('BroadcastChannel') ? (() => { try { new BroadcastChannel(${channel}).postMessage('out'); return 'sent' } catch { return 'refused' } })() : 'absent',
  }
  const ways = {}
  for (const [way, attempt] of Object.entries(tries)) {
    try { ways[way] = await within(Promise.resolve().then(attempt)) } catch { ways[way] = 'refused' }
  }
  post(JSON.stringify({ check: ${JSON.stringify(nonce)}, ways }))
})`
}

/**
 * What the worker reported, judged: every way named, each with what it saw, none of them having
 * reached anything. Its ways in the order they're listed; or why it isn't a report at all.
 */
export function judgeReport(
  text: unknown,
  nonce: string,
): { ways: Record<BoxCheckWay, WaySaw>; reached: BoxCheckWay[] } | undefined {
  if (typeof text !== 'string' || text.length > 4096) return undefined
  let read: unknown
  try {
    read = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof read !== 'object' || read === null || Array.isArray(read)) return undefined
  const { check, ways } = read as { check?: unknown; ways?: unknown }
  if (check !== nonce || typeof ways !== 'object' || ways === null || Array.isArray(ways)) {
    return undefined
  }
  const said = ways as Record<string, unknown>
  const SAW: readonly unknown[] = ['refused', 'absent', 'sent', 'reached']
  // Every way, each said as one of the four: a report that leaves one out isn't one.
  if (!BOX_CHECK_WAYS.every((way) => Object.hasOwn(said, way) && SAW.includes(said[way]))) {
    return undefined
  }
  const out = Object.fromEntries(BOX_CHECK_WAYS.map((way) => [way, said[way] as WaySaw])) as Record<
    BoxCheckWay,
    WaySaw
  >
  return { ways: out, reached: BOX_CHECK_WAYS.filter((way) => out[way] === 'reached') }
}

/** Browsers by what they say of themselves, most particular first. */
const BROWSERS: readonly [RegExp, string][] = [
  [/Edg\/(\d+)/, 'Edge'],
  [/Firefox\/(\d+)/, 'Firefox'],
  [/Chrome\/(\d+)/, 'Chrome'],
  [/Version\/(\d+(?:\.\d+)?).*Safari\//, 'Safari'],
]

/**
 * The browser, as a person names it, from what it says of itself: "Firefox 131", say. Only a
 * name of these and its number: nothing a browser says reaches a log or the history as it is.
 */
export function browserOf(userAgent: string | undefined): string {
  for (const [said, name] of BROWSERS) {
    const found = said.exec(userAgent ?? '')
    if (found) return `${name} ${found[1]}`
  }
  return 'a browser Lumovi doesn’t know'
}

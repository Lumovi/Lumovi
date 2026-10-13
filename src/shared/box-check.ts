/**
 * Lumovi's check of a plugin's box in the person's own browser, before that browser is handed
 * any plugin's code: a worker of Lumovi's own, in a box made exactly as a plugin's, tries every
 * way out a plugin's code could, each at a catcher of the server's own. What reached the
 * catcher, the server saw; what the worker saw of each, it reports. Two such boxes run side by
 * side, each looking for what the other kept, and a third, once they're closed, for what they
 * left. It passes only if nothing reached the catcher, no box found another's, every report came
 * in time, and each names every way here, each refused.
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
  // (The server speaks no HTTP/3, so a WebTransport to it fails whatever the walls: its
  // `refused` proves nothing of them. It's held by the same `connect-src` fetch is checked against.)
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

/** How long the check may take: the boxes' answers, and how long a check's nonce lives. */
export const BOX_CHECK_LIMITS = {
  /** Each way's own try, in the worker. */
  aWayMs: 1500,
  /** The page waits this long for all the boxes' reports: past it, the check didn't finish. */
  answerWithinMs: 20_000,
  /**
   * A nonce lives this long from its check's start: the answers' time, and a little. What reaches
   * the catcher after the check is judged, but in this time, still fails it.
   */
  nonceLiveMs: 30_000,
} as const

/**
 * The boxes a check opens: two side by side (`first`, `second`), each trying every way out and
 * keeping what it can under its own name, then looking for the other's; and one opened once both
 * have closed (`later`), looking for what they kept. A box's store that another box, or a later
 * opening, can see is one a plugin could talk or remember through: that fails the check.
 */
export const BOX_CHECK_ROLES = ['first', 'second', 'later'] as const
export type BoxCheckRole = (typeof BOX_CHECK_ROLES)[number]

/** What a look for another box's things can find there. */
export const LOOKS = ['broadcast-channel', 'caches', 'indexed-db'] as const
export type Look = (typeof LOOKS)[number]

/**
 * The name a check sends under where it can only send (a broadcast channel): Lumovi's own page
 * listens on it while the check runs, as each box does. What's heard there got out.
 */
export const boxCheckChannel = (nonce: string) => `lumovi-box-check-${nonce}`

/** Where one of the two side-by-side boxes keeps what it can (a cache, a database). */
export const boxCheckStore = (nonce: string, role: 'first' | 'second') =>
  `${boxCheckChannel(nonce)}-${role}`

/**
 * What a side-by-side box sends up once it has tried every way (and so kept what it could), and
 * what the page sends both once both have: only then does either look for the other's.
 */
export const boxCheckKept = (nonce: string, role: 'first' | 'second') =>
  JSON.stringify({ check: nonce, role, kept: true })
export const BOX_CHECK_LOOK = 'look'

/**
 * The ways whose arrival Lumovi's own page, not the server, can see: what the box's worker can
 * only send to its own origin's channel or storage, which must never be Lumovi's.
 */
export const PAGE_SEES: readonly BoxCheckWay[] = ['broadcast-channel', 'caches', 'indexed-db']

/**
 * The worker's helpers, in both kinds of box: a global's there, and a look under a store's name:
 * what's found there, and where the box couldn't look (the store, or the look, threw or refused):
 * a look that couldn't be made is never "nothing found". The server weighs it against what the
 * other boxes kept. (A store the box hasn't got at all is nothing to find: nothing of it can be
 * kept either.)
 */
const HELPERS = `const has = (name) => typeof self[name] !== 'undefined'
  const unlooked = new Set()
  const look = async (name) => {
    const found = []
    try {
      if (has('caches') && (await caches.keys()).includes(name)) found.push('caches')
    } catch { unlooked.add('caches') }
    try {
      // (Opened, a database that isn't there is made: the making is stopped, so nothing is left.)
      if (has('indexedDB') && await new Promise((done, fail) => { const r = indexedDB.open(name); r.onupgradeneeded = () => { r.transaction.abort(); done(false) }; r.onsuccess = () => { r.result.close(); done(true) }; r.onerror = () => fail(r.error) })) found.push('indexed-db')
    } catch { unlooked.add('indexed-db') }
    return found
  }`

/**
 * The code of one of a check's boxes, as a plugin's is run (after the box's first lines). One of
 * the two side by side tries each way at `catcher` (the server's own address for this check,
 * `…/box-check/<nonce>`), keeping what it can under its own name and listening for the other box;
 * says when it has; once the page says both have, looks for what the other kept; and sends up
 * what it saw. The later one only looks.
 */
export function boxCheckCode(catcher: string, nonce: string, role: BoxCheckRole): string {
  const channel = JSON.stringify(boxCheckChannel(nonce))
  const check = JSON.stringify(nonce)
  if (role === 'later') {
    const first = JSON.stringify(boxCheckStore(nonce, 'first'))
    const second = JSON.stringify(boxCheckStore(nonce, 'second'))
    return `box.then(async ({ post }) => {
  ${HELPERS}
  const found = [...new Set([...(await look(${first})), ...(await look(${second}))])]
  post(JSON.stringify({ check: ${check}, role: 'later', found, unlooked: [...unlooked] }))
})`
  }
  const http = JSON.stringify(catcher)
  const ws = JSON.stringify(catcher.replace(/^http/, 'ws'))
  const mine = JSON.stringify(boxCheckStore(nonce, role))
  const other = JSON.stringify(boxCheckStore(nonce, role === 'first' ? 'second' : 'first'))
  const me = JSON.stringify(role)
  const kept = JSON.stringify(boxCheckKept(nonce, role))
  return `box.then(async ({ post, listen }) => {
  ${HELPERS}
  const at = (way) => ${http} + '/' + way
  const within = (promise) => Promise.race([promise, new Promise((done) => setTimeout(() => done('refused'), ${BOX_CHECK_LIMITS.aWayMs}))])
  const event = (open) => new Promise((done) => { try { open(() => done('reached'), () => done('refused')) } catch { done('refused') } })
  // The other box, heard: on the channel every box of this check, and Lumovi's own page, listen on.
  const found = new Set()
  let channel
  try { if (has('BroadcastChannel')) { channel = new BroadcastChannel(${channel}); channel.onmessage = (event) => { if (event.data !== ${me}) found.add('broadcast-channel') } } } catch { unlooked.add('broadcast-channel') }
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
    // (Once it's opened, the cache is kept, whether or not what's put in it is: so it's sent.)
    caches: () => has('caches') ? caches.open(${mine}).then(async (c) => { try { await c.put(new Request(at('caches')), new Response('out')) } catch {} return 'sent' }, () => 'refused') : 'absent',
    'indexed-db': () => has('indexedDB') ? new Promise((done) => { try { const r = indexedDB.open(${mine}); r.onsuccess = () => { r.result.close(); done('sent') }; r.onerror = () => done('refused') } catch { done('refused') } }) : 'absent',
    'broadcast-channel': () => channel ? (() => { try { channel.postMessage(${me}); return 'sent' } catch { return 'refused' } })() : 'absent',
  }
  const ways = {}
  // (What's kept is waited for as long as it takes, never cut short: a box says it has kept what
  // it can only once it has. The check as a whole is bounded by the page.)
  const stores = ['caches', 'indexed-db']
  for (const [way, attempt] of Object.entries(tries)) {
    try { ways[way] = await (stores.includes(way) ? Promise.resolve().then(attempt) : within(Promise.resolve().then(attempt))) } catch { ways[way] = 'refused' }
  }
  // Once both boxes have kept, and said, what they can: what of the other's is seen here?
  const both = new Promise((done) => listen((data) => { if (data === ${JSON.stringify(BOX_CHECK_LOOK)}) done() }))
  post(${kept})
  await both
  try { channel && channel.postMessage(${me}) } catch {}
  await new Promise((done) => setTimeout(done, 300))
  for (const what of await look(${other})) found.add(what)
  post(JSON.stringify({ check: ${check}, role: ${me}, ways, found: [...found], unlooked: [...unlooked] }))
})`
}

/** One box's report, judged: whole, of its role and this check, and what it found of others. */
export interface Reported {
  /** What each way did (the side-by-side boxes' only). */
  ways?: Record<BoxCheckWay, WaySaw>
  /** The ways the worker saw reach what they aimed at. */
  reached: BoxCheckWay[]
  /** What of another box it found: the other's, or (the later one) what the first two kept. */
  found: Look[]
  /** Where it couldn't look (a store it has that threw or refused): no pass can rest on those. */
  unlooked: Look[]
}

/**
 * What one of a check's boxes reported, judged: the side-by-side boxes' every way named, each
 * with what it saw, and what each found of the other; the later one's, what it found. Or
 * nothing, where it isn't a whole report of this check and this box.
 */
export function judgeReport(
  text: unknown,
  nonce: string,
  role: BoxCheckRole,
): Reported | undefined {
  if (typeof text !== 'string' || text.length > 4096) return undefined
  let read: unknown
  try {
    read = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof read !== 'object' || read === null || Array.isArray(read)) return undefined
  const said = read as {
    check?: unknown
    role?: unknown
    ways?: unknown
    found?: unknown
    unlooked?: unknown
  }
  if (said.check !== nonce || said.role !== role) return undefined
  // Looks, each one of LOOKS and once: what it found, and where it couldn't look.
  const looks = (value: unknown): value is Look[] =>
    Array.isArray(value) &&
    value.every((look) => (LOOKS as readonly unknown[]).includes(look)) &&
    new Set(value).size === value.length
  const { found, unlooked } = said
  if (!looks(found) || !looks(unlooked)) return undefined
  if (role === 'later') return { reached: [], found, unlooked }
  const { ways } = said
  if (typeof ways !== 'object' || ways === null || Array.isArray(ways)) return undefined
  const all = ways as Record<string, unknown>
  const SAW: readonly unknown[] = ['refused', 'absent', 'sent', 'reached']
  // Every way, each said as one of the four: a report that leaves one out isn't one.
  if (!BOX_CHECK_WAYS.every((way) => Object.hasOwn(all, way) && SAW.includes(all[way]))) {
    return undefined
  }
  const out = Object.fromEntries(BOX_CHECK_WAYS.map((way) => [way, all[way] as WaySaw])) as Record<
    BoxCheckWay,
    WaySaw
  >
  return {
    ways: out,
    reached: BOX_CHECK_WAYS.filter((way) => out[way] === 'reached'),
    found,
    unlooked,
  }
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

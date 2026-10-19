/**
 * Lumovi's check of a plugin's box, as the server keeps and judges it: a nonce good once, for
 * its session, for a while; what reaches the catcher with any other let go, and of its own only
 * a way's name; what arrives after judgment still failing it; a box that finds another's failing
 * it; silence and a report that isn't whole not a pass; a result for the box's walls as they
 * are. And the control: Lumovi's own request, with a nonce no box is told, which must have
 * arrived as a request and as a socket's upgrade for a check to be judged at all. Plain functions.
 */
import { expect, test } from '../temp-folders.ts'
import {
  BOX_CHECK_CONTROLS,
  BOX_CHECK_LIMITS,
  BOX_CHECK_LOOK,
  BOX_CHECK_WAYS,
  boxCheckCode,
  boxCheckKept,
  boxCheckStore,
  browserOf,
  judgeReport,
} from '../../src/shared/box-check.ts'

/**
 * The server's checks, with a clock the test turns. `made` is them as most tests here need them:
 * a check started with its control already arrived in every shape (what Lumovi's own sealed
 * frame asks, where nothing stands in its way), known by its nonce; and what reaches the catcher
 * of a box's. `real` is them as they are, for what the control is tried on.
 */
async function checks(policy = 'walls-1') {
  ;(globalThis as { LUMOVI_TEST_BUILD?: boolean }).LUMOVI_TEST_BUILD = true
  const { BoxChecks } = await import('../../src/server/box-check.ts')
  let now = 1_000_000
  const real = new BoxChecks(policy, () => now)
  const made = {
    start(key: string): string {
      const { nonce, control } = real.start(key)
      for (const shape of BOX_CHECK_CONTROLS) real.caught(control, shape, shape)
      return nonce
    },
    caught: (nonce: string, way: string) => real.caught(nonce, way),
    end: real.end.bind(real),
    result: real.result.bind(real),
    unlooked: real.unlooked.bind(real),
    unreached: real.unreached.bind(real),
    watch: real.watch.bind(real),
    forget: real.forget.bind(real),
  }
  return { made, real, BoxChecks, tick: (ms: number) => (now += ms), now: () => now }
}
/** A side-by-side box's whole report: every way refused but those said otherwise. */
const report = (
  nonce: string,
  role: 'first' | 'second',
  said: Partial<Record<string, string>> = {},
  found: string[] = [],
  unlooked: string[] = [],
) =>
  JSON.stringify({
    check: nonce,
    role,
    ways: Object.fromEntries(BOX_CHECK_WAYS.map((way) => [way, said[way] ?? 'refused'])),
    found,
    unlooked,
  })
/** All three boxes' reports, whole, each having found nothing but what's said. */
const reports = (
  nonce: string,
  said: Partial<Record<string, string>> = {},
  found: { first?: string[]; second?: string[]; later?: string[] } = {},
) => ({
  first: report(nonce, 'first', said, found.first),
  second: report(nonce, 'second', said, found.second),
  later: JSON.stringify({ check: nonce, role: 'later', found: found.later ?? [], unlooked: [] }),
})

test('a check passes when nothing got out, no box found another’s, and every report is whole and in time', async () => {
  const { made } = await checks()
  const nonce = made.start('session-a')
  expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/)
  expect(made.result('session-a')).toBeUndefined()
  expect(
    made.end(
      'session-a',
      nonce,
      // (Sent where only its own origin is: what the page didn't find there didn't get out.)
      reports(nonce, { beacon: 'absent', 'broadcast-channel': 'sent', caches: 'sent' }),
      [],
    ),
  ).toEqual({ result: 'passed', out: [], first: true, unlooked: [], unreached: [] })
  expect(made.result('session-a')).toBe('passed')
  // Judged once: the nonce isn't judged again.
  expect(made.end('session-a', nonce, reports(nonce), [])).toBeUndefined()
})

test('what reaches the catcher with the check’s nonce fails it, whatever the reports say', async () => {
  const { made } = await checks()
  const nonce = made.start('s')
  made.caught(nonce, 'fetch')
  made.caught(nonce, 'web-socket')
  expect(made.end('s', nonce, reports(nonce), [])).toEqual({
    result: 'failed',
    out: ['fetch', 'web-socket'],
    first: true,
    unlooked: [],
    unreached: [],
  })
  expect(made.result('s')).toBe('failed')
  // And what a box says reached, or the page heard, fails it too.
  const second = made.start('t')
  expect(made.end('t', second, reports(second, { xhr: 'reached' }), [])?.out).toEqual(['xhr'])
  const third = made.start('u')
  expect(
    made.end('u', third, reports(third), ['broadcast-channel', 'caches', 'made-up'])?.out,
  ).toEqual(['broadcast-channel', 'caches'])
})

test('of what reaches the catcher only a way’s name is kept: anything else is one “other”', async () => {
  const { made } = await checks()
  const nonce = made.start('s')
  for (let i = 0; i < 10_000; i++) made.caught(nonce, `way-${i}`)
  made.caught(nonce, 'fetch\nLumovi passed the check')
  made.caught(nonce, 'beacon')
  expect(made.end('s', nonce, reports(nonce), [])?.out).toEqual(['other', 'beacon'])
})

test('a box that finds another’s things, side by side or after it closed, fails the check', async () => {
  const { made } = await checks()
  const outOf = (found: { first?: string[]; second?: string[]; later?: string[] }) => {
    const nonce = made.start('s')
    return made.end('s', nonce, reports(nonce, {}, found), [])
  }
  expect(outOf({ second: ['caches'] })).toMatchObject({
    result: 'failed',
    out: ['caches shared between boxes'],
  })
  expect(outOf({ first: ['broadcast-channel'], second: ['broadcast-channel'] })?.out).toEqual([
    'broadcast-channel shared between boxes',
  ])
  expect(outOf({ later: ['indexed-db', 'caches'] })).toMatchObject({
    result: 'failed',
    out: ['indexed-db kept after its box closed', 'caches kept after its box closed'],
  })
})

test('what arrives after the check is judged, while its nonce lives, still fails it, and is told', async () => {
  const { made, tick } = await checks()
  const nonce = made.start('s')
  const told: { result: string; out: string[] }[] = []
  let pages = 0
  const unwatch = made.watch('s', () => pages++)
  expect(
    made.end('s', nonce, reports(nonce, { beacon: 'sent' }), [], [], (late) => told.push(late)),
  ).toMatchObject({ result: 'passed' })
  // A beacon the browser sent on after the report: the pass is a failure now, told once.
  tick(5_000)
  made.caught(nonce, 'beacon')
  expect(made.result('s')).toBe('failed')
  expect(told).toEqual([
    { result: 'failed', out: ['beacon'], first: true, unlooked: [], unreached: [] },
  ])
  expect(pages).toBe(1)
  // More of it changes nothing that's said: it's failed already.
  made.caught(nonce, 'fetch-keepalive')
  expect(told).toHaveLength(1)
  expect(pages).toBe(1)
  unwatch()
  // Past the nonce's life, what reaches the catcher is let go: the pass holds.
  const again = made.start('u')
  made.end('u', again, reports(again), [], [], (late) => told.push(late))
  expect(made.result('u')).toBe('passed')
  tick(BOX_CHECK_LIMITS.nonceLiveMs + 1)
  made.caught(again, 'beacon')
  expect(made.result('u')).toBe('passed')
  expect(told).toHaveLength(1)
  // And a check that didn't finish fails, too, on what reaches the catcher after.
  const silent = made.start('t')
  expect(made.end('t', silent, null, [])?.result).toBe('unfinished')
  made.caught(silent, 'fetch')
  expect(made.result('t')).toBe('failed')
})

test('a browser that let something out stays failed for its session: no later pass undoes it', async () => {
  const { made } = await checks()
  // Two tabs of one session: the first's check passes, the second's starts.
  const first = made.start('s')
  made.end('s', first, reports(first), [])
  const second = made.start('s')
  // A beacon of the first's arrives late: failed. The second, which began before, then passes.
  made.caught(first, 'beacon')
  expect(made.result('s')).toBe('failed')
  expect(made.end('s', second, reports(second), [])).toEqual({
    result: 'failed',
    out: ['beacon'],
    first: false,
    unlooked: [],
    unreached: [],
  })
  expect(made.result('s')).toBe('failed')
  // And a check after it, too.
  const third = made.start('s')
  expect(made.end('s', third, reports(third), [])?.result).toBe('failed')
  expect(made.result('s')).toBe('failed')
})

test('a nonce is the session’s, live a while, and nothing else counts or fills anything', async () => {
  const { made, tick } = await checks()
  const mine = made.start('mine')
  const theirs = made.start('theirs')
  // Someone else's nonce, a made-up one, or one gone stale: let go, not counted.
  made.caught('made-up', 'fetch')
  made.caught(theirs, 'fetch')
  expect(made.end('mine', theirs, reports(theirs), [])).toBeUndefined()
  expect(made.end('mine', mine, reports(mine), [])?.result).toBe('passed')
  // (Their check, failed by what reached it with their nonce, is theirs alone.)
  expect(made.end('theirs', theirs, reports(theirs), [])?.result).toBe('failed')
  expect(made.result('mine')).toBe('passed')
  // Stale: past its life, what reaches the catcher isn't counted, nor is it judged.
  const old = made.start('old')
  tick(BOX_CHECK_LIMITS.nonceLiveMs + 1)
  made.caught(old, 'fetch')
  made.start('another')
  expect(made.end('old', old, reports(old), [])).toBeUndefined()
  // A session's page in two tabs checks in both; past a few checks at once, the oldest ends.
  const tabs = [1, 2, 3, 4, 5].map(() => made.start('tabs'))
  expect(made.end('tabs', tabs[0]!, reports(tabs[0]!), [])).toBeUndefined()
  for (const tab of tabs.slice(1)) {
    expect(made.end('tabs', tab, reports(tab), [])?.result).toBe('passed')
  }
})

test('silence, a late report, or one that isn’t whole, is no pass', async () => {
  const { made, tick } = await checks()
  // Boxes that never answer: the page says so with nothing.
  const silent = made.start('silent')
  expect(made.end('silent', silent, null, [])?.result).toBe('unfinished')
  expect(made.result('silent')).toBe('unfinished')
  // One box that never answered is as much: the check didn't finish.
  const one = made.start('one')
  expect(made.end('one', one, { ...reports(one), later: null }, [])?.result).toBe('unfinished')
  // Late.
  const late = made.start('late')
  tick(BOX_CHECK_LIMITS.answerWithinMs + 1)
  expect(made.end('late', late, reports(late), [])?.result).toBe('unfinished')
  // A way left out, an unknown word, another check's nonce or box, a made-up find, or not a
  // report at all: failed.
  const partial = (said: unknown) => {
    const nonce = made.start('partial')
    const text = JSON.stringify(said).replaceAll('NONCE', nonce)
    return made.end('partial', nonce, JSON.parse(text), [])?.result
  }
  const whole = reports('NONCE')
  const ways = (JSON.parse(whole.first) as { ways: Record<string, string> }).ways
  const { fetch: _, ...leftOut } = ways
  const first = (said: object) =>
    JSON.stringify({ check: 'NONCE', role: 'first', found: [], unlooked: [], ...said })
  for (const said of [
    { ...whole, first: first({ ways: leftOut }) },
    { ...whole, first: first({ ways: { ...ways, xhr: 'fine' } }) },
    { ...whole, first: first({ ways, found: ['cookies'] }) },
    { ...whole, first: first({ ways, found: ['caches', 'caches'] }) },
    { ...whole, first: first({ ways, unlooked: undefined }) },
    { ...whole, first: first({ ways, unlooked: ['cookies'] }) },
    { ...whole, first: first({ ways, unlooked: 'caches' }) },
    { ...whole, first: whole.second },
    { ...whole, later: JSON.stringify({ check: 'NONCE', role: 'later' }) },
    { ...whole, second: report('another', 'second') },
    { ...whole, later: 'not json' },
    [],
    'reports',
  ]) {
    expect(partial(said), JSON.stringify(said).slice(0, 80)).toBe('failed')
  }
  // Failed on what it couldn't read, it says whose: nothing is said to have got out.
  const unread = made.start('unread')
  expect(made.end('unread', unread, { ...reports(unread), later: 'not json' }, [])).toEqual({
    result: 'failed',
    out: [],
    first: true,
    unlooked: [],
    unreached: [],
    unreadable: ['later'],
  })
  const none = made.start('none')
  expect(made.end('none', none, 'reports', [])?.unreadable).toEqual(['first', 'second', 'later'])
  // (What got out is said as that, with no word of reading.)
  const out = made.start('out')
  expect(made.end('out', out, reports(out, { xhr: 'reached' }), [])).not.toHaveProperty(
    'unreadable',
  )
})

test('a look that couldn’t be made, the page’s or a box’s, is no pass: unfinished, and said where', async () => {
  const { made } = await checks()
  // Lumovi's own page couldn't look in its caches or its databases, or listen on the channel.
  const page = made.start('page')
  expect(
    made.end('page', page, reports(page), [], ['caches', 'indexed-db', 'broadcast-channel']),
  ).toEqual({
    result: 'unfinished',
    out: [],
    first: true,
    unlooked: ['broadcast-channel', 'caches', 'indexed-db'],
    unreached: [],
  })
  expect(made.result('page')).toBe('unfinished')
  expect(made.unlooked('page')).toBe(true)
  // (Only the ways the page looks for are its: anything else it hands up is let go.)
  const other = made.start('other')
  expect(made.end('other', other, reports(other), [], ['fetch', 'made-up'])).toMatchObject({
    result: 'passed',
    unlooked: [],
    unreached: [],
  })
  expect(made.unlooked('other')).toBe(false)
  // A box that couldn't look where the other kept something: side by side, or after they closed.
  const box = made.start('box')
  const side = reports(box)
  side.first = report(box, 'first', { 'indexed-db': 'sent', caches: 'sent' })
  side.second = report(box, 'second', {}, [], ['indexed-db'])
  side.later = JSON.stringify({ check: box, role: 'later', found: [], unlooked: ['caches'] })
  expect(made.end('box', box, side, [])).toMatchObject({
    result: 'unfinished',
    unlooked: ['indexed-db', 'caches'],
    unreached: [],
  })
  // Where nothing was kept (each box's store refused, as its walls refuse it), there was nothing
  // to find: a box that couldn't look there is no gap.
  const walls = made.start('walls')
  const refused = reports(walls)
  for (const role of ['first', 'second'] as const) {
    refused[role] = report(walls, role, {}, [], ['caches', 'indexed-db', 'broadcast-channel'])
  }
  refused.later = JSON.stringify({
    check: walls,
    role: 'later',
    found: [],
    unlooked: ['caches', 'indexed-db'],
    unreached: [],
  })
  expect(made.end('walls', walls, refused, [])).toMatchObject({ result: 'passed', unlooked: [] })
  // What got out still fails it: a look that wasn't made doesn't hide what was found.
  const out = made.start('out')
  expect(made.end('out', out, reports(out, { xhr: 'reached' }), [], ['caches'])).toEqual({
    result: 'failed',
    out: ['xhr'],
    first: true,
    unlooked: [],
    unreached: [],
  })
  expect(made.unlooked('out')).toBe(false)
  // And one that's unfinished for silence alone isn't one that couldn't look: it's asked again.
  const silent = made.start('silent')
  expect(made.end('silent', silent, null, [])).toMatchObject({ result: 'unfinished', unlooked: [] })
  expect(made.unlooked('silent')).toBe(false)
  // Silent, then couldn't look: that's said, once; the same again isn't said again.
  const then = made.start('silent')
  expect(made.end('silent', then, reports(then), [], ['caches'])).toMatchObject({
    result: 'unfinished',
    first: true,
  })
  const same = made.start('silent')
  expect(made.end('silent', same, reports(same), [], ['caches'])?.first).toBe(false)
  // (A session that's never been checked, or for other walls, has nothing that couldn't look.)
  expect(made.unlooked('never')).toBe(false)
})

test('a result holds for the box’s walls as they were: other walls, and every browser is asked again', async () => {
  const { made, BoxChecks } = await checks('walls-1')
  const nonce = made.start('s')
  made.end('s', nonce, reports(nonce), [])
  expect(made.result('s')).toBe('passed')
  // (A server's results are its own: one started with other walls holds none of them.)
  expect(new BoxChecks('walls-2').result('s')).toBeUndefined()
  // Said once a session: the same result again isn't a first.
  const again = made.start('s')
  expect(made.end('s', again, reports(again), [])?.first).toBe(false)
  // Forgotten (its page gone): no result, and nobody's told of it.
  let told = 0
  made.watch('s', () => told++)
  const last = made.start('s')
  made.end('s', last, reports(last), [])
  made.forget('s')
  expect(made.result('s')).toBeUndefined()
  made.caught(last, 'fetch')
  expect(told).toBe(0)
})

test('the boxes’ code tries every way at the catcher, and only there, and looks only where it should', () => {
  const catcher = 'https://lumovi.example/box-check/abc'
  for (const role of ['first', 'second'] as const) {
    const code = boxCheckCode(catcher, 'abc', role)
    for (const way of BOX_CHECK_WAYS) expect(code, way).toContain(`'${way}'`)
    expect(code).toContain('"https://lumovi.example/box-check/abc"')
    expect(code).toContain('"wss://lumovi.example/box-check/abc"')
    expect(code).not.toMatch(/https?:\/\/(?!lumovi\.example)/)
    // It keeps under its own name, says so, looks once told to, and looks for the other's.
    const other = role === 'first' ? 'second' : 'first'
    expect(code).toContain(JSON.stringify(boxCheckStore('abc', role)))
    expect(code).toContain(JSON.stringify(boxCheckStore('abc', other)))
    expect(code).toContain(JSON.stringify(boxCheckKept('abc', role)))
    expect(code).toContain(JSON.stringify(BOX_CHECK_LOOK))
    expect(judgeReport(report('abc', role), 'abc', role)?.reached).toEqual([])
  }
  // The later box tries nothing: it only looks for what the first two kept.
  const later = boxCheckCode(catcher, 'abc', 'later')
  // (Each is code a worker can run: it parses.)
  for (const role of ['first', 'second', 'later'] as const) {
    expect(() => new Function(boxCheckCode(catcher, 'abc', role)), role).not.toThrow()
  }
  expect(later).not.toContain('lumovi.example')
  expect(later).toContain(JSON.stringify(boxCheckStore('abc', 'first')))
  expect(later).toContain(JSON.stringify(boxCheckStore('abc', 'second')))
  expect(
    judgeReport(
      JSON.stringify({ check: 'abc', role: 'later', found: [], unlooked: [] }),
      'abc',
      'later',
    ),
  ).toEqual({ reached: [], found: [], unlooked: [] })
})

/**
 * A box's code, run as its worker would with only the globals in `self` (as a box's walls leave
 * them): its report, as it sends it up.
 */
async function ran(nonce: string, role: 'first' | 'second' | 'later', self: object) {
  const posted: string[] = []
  let heard: (data: string) => void = () => {}
  const box = Promise.resolve({
    post(text: string) {
      // (Once it says it has kept what it can, it's told to look, as the page tells both.)
      if (role !== 'later' && text === boxCheckKept(nonce, role)) heard(BOX_CHECK_LOOK)
      else posted.push(text)
    },
    listen: (on: (data: string) => void) => void (heard = on),
  })
  // The globals it names, as its worker's: what `self` has, and nothing else.
  const names = ['caches', 'indexedDB', 'BroadcastChannel'] as const
  const value = (name: string) => Object.getOwnPropertyDescriptor(self, name)?.value
  const code = boxCheckCode('https://lumovi.example/box-check/' + nonce, nonce, role)
  await new Function('box', 'self', ...names, `return ${code}`)(box, self, ...names.map(value))
  expect(posted).toHaveLength(1)
  return posted[0]!
}
/** A store a box's walls refuse, as an opaque origin's does: even asking for it throws. */
const refusing = (name: string) => ({
  get() {
    throw new DOMException(`${name} is refused here`, 'SecurityError')
  },
})
/** A box's caches, each part as said: what it holds, and whether opening, putting or looking fails. */
const cachesOf = (said: { open?: 'fails'; put?: 'fails'; keys?: 'fails'; holds?: string[] }) => ({
  open: async () => {
    if (said.open) throw new DOMException('no', 'SecurityError')
    return {
      put: async () => {
        if (said.put) throw new DOMException('no', 'QuotaExceededError')
      },
    }
  },
  keys: async () => {
    if (said.keys) throw new DOMException('no', 'SecurityError')
    return said.holds ?? []
  },
})
/** A channel that opens, and is heard by no one. */
class Channel {
  onmessage: unknown = null
  postMessage() {}
  close() {}
}
const ways = (text: string) => (JSON.parse(text) as { ways: Record<string, string> }).ways
const unlookedIn = (text: string) => (JSON.parse(text) as { unlooked: string[] }).unlooked

test('where a box’s walls refuse every store, its looks can’t be made, and nothing could be kept: it passes', async () => {
  const { made } = await checks()
  const nonce = made.start('walls')
  const walled = {}
  for (const name of ['caches', 'indexedDB', 'BroadcastChannel']) {
    Object.defineProperty(walled, name, refusing(name))
  }
  const said = {
    first: await ran(nonce, 'first', walled),
    second: await ran(nonce, 'second', walled),
    later: await ran(nonce, 'later', walled),
  }
  // Each box couldn't keep, and says so; and couldn't look, and says so too.
  expect(ways(said.first)).toMatchObject({
    caches: 'refused',
    'indexed-db': 'refused',
    'broadcast-channel': 'absent',
  })
  expect(unlookedIn(said.first)).toEqual(['broadcast-channel', 'caches', 'indexed-db'])
  expect(unlookedIn(said.later)).toEqual(['caches', 'indexed-db'])
  // Nothing was kept where a look couldn't be made: the check passes.
  expect(made.end('walls', nonce, said, [])).toMatchObject({ result: 'passed', unlooked: [] })
})

test('a cache that opened is kept, whether or not what’s put in it is: one the other box finds fails the check', async () => {
  const { made } = await checks()
  expect(ways(await ran('abc', 'first', { caches: cachesOf({ put: 'fails' }) })).caches).toBe(
    'sent',
  )
  expect(ways(await ran('abc', 'first', { caches: cachesOf({ open: 'fails' }) })).caches).toBe(
    'refused',
  )
  // The first's cache, opened though its put failed, seen by the second: shared, so failed.
  const nonce = made.start('shared')
  const said = {
    first: await ran(nonce, 'first', { caches: cachesOf({ put: 'fails' }) }),
    second: await ran(nonce, 'second', {
      caches: cachesOf({ holds: [boxCheckStore(nonce, 'first')] }),
    }),
    later: await ran(nonce, 'later', { caches: cachesOf({}) }),
  }
  expect(made.end('shared', nonce, said, [])).toMatchObject({
    result: 'failed',
    out: ['caches shared between boxes'],
  })
})

test('a box’s look that throws where the other box kept something is no pass: unfinished', async () => {
  const { made } = await checks()
  // The first keeps in its caches; the second's look in its own throws.
  const nonce = made.start('looked')
  const said = {
    first: await ran(nonce, 'first', { caches: cachesOf({}) }),
    second: await ran(nonce, 'second', { caches: cachesOf({ keys: 'fails' }) }),
    later: await ran(nonce, 'later', { caches: cachesOf({}) }),
  }
  expect(ways(said.first).caches).toBe('sent')
  expect(unlookedIn(said.second)).toEqual(['caches'])
  expect(made.end('looked', nonce, said, [])).toMatchObject({
    result: 'unfinished',
    unlooked: ['caches'],
    unreached: [],
  })
  // A listening box whose channel won't open, while the other's sent on its own: unfinished too.
  const heard = made.start('heard')
  const refused = {}
  Object.defineProperty(refused, 'BroadcastChannel', {
    value: class {
      constructor() {
        throw new DOMException('no', 'SecurityError')
      }
    },
  })
  const channel = {
    first: await ran(heard, 'first', refused),
    second: await ran(heard, 'second', { BroadcastChannel: Channel }),
    later: await ran(heard, 'later', {}),
  }
  expect(ways(channel.first)['broadcast-channel']).toBe('absent')
  expect(ways(channel.second)['broadcast-channel']).toBe('sent')
  expect(made.end('heard', heard, channel, [])).toMatchObject({
    result: 'unfinished',
    unlooked: ['broadcast-channel'],
    unreached: [],
  })
})

test('a check whose own request didn’t arrive in every shape can’t be judged: unfinished, and said which, whatever its boxes report', async () => {
  const { real } = await checks()
  const ALL = [...BOX_CHECK_CONTROLS]
  // Nothing of Lumovi's own reached the catcher: that nothing of a box's did says nothing.
  const none = real.start('none')
  expect(real.end('none', none.nonce, reports(none.nonce), [])).toEqual({
    result: 'unfinished',
    out: [],
    first: true,
    unlooked: [],
    unreached: ALL,
  })
  expect(real.result('none')).toBe('unfinished')
  expect(real.unreached('none')).toBe(true)
  // Each shape alone missing is no better: a box's ways come in all three.
  for (const missing of ALL) {
    const one = real.start(`without ${missing}`)
    for (const shape of ALL) if (shape !== missing) real.caught(one.control, 'x', shape)
    expect(
      real.end(`without ${missing}`, one.nonce, reports(one.nonce), []),
      missing,
    ).toMatchObject({ result: 'unfinished', unreached: [missing] })
  }
  // The shape is what the server read off the request, never what its address says; and one
  // with no box's shape (Lumovi's own page asking, say) counts for none.
  const named = real.start('named')
  real.caught(named.control, 'socket', 'http-with-origin')
  real.caught(named.control, 'http-without-origin', 'http-with-origin')
  real.caught(named.control, 'socket')
  expect(real.end('named', named.nonce, reports(named.nonce), [])).toMatchObject({
    result: 'unfinished',
    unreached: ['http-without-origin', 'socket'],
  })
  // Every shape, and nothing of a box's: only then is an empty catcher a pass.
  const all = real.start('all')
  for (const shape of ALL) real.caught(all.control, 'x', shape)
  expect(real.end('all', all.nonce, reports(all.nonce), [])).toEqual({
    result: 'passed',
    out: [],
    first: true,
    unlooked: [],
    unreached: [],
  })
  expect(real.unreached('all')).toBe(false)
  // What got out fails it, with or without the control: that much is known.
  const out = real.start('out')
  real.caught(out.nonce, 'fetch')
  expect(real.end('out', out.nonce, reports(out.nonce), [])).toMatchObject({
    result: 'failed',
    out: ['fetch'],
    unreached: [],
  })
  // Said once a session, and again where it's missing in another shape.
  const again = real.start('none')
  expect(real.end('none', again.nonce, reports(again.nonce), [])).toMatchObject({
    result: 'unfinished',
    first: false,
  })
  const other = real.start('none')
  real.caught(other.control, 'x', 'http-with-origin')
  expect(real.end('none', other.nonce, reports(other.nonce), [])).toMatchObject({
    result: 'unfinished',
    first: true,
    unreached: ['http-without-origin', 'socket'],
  })
})

test('a request has a box’s shape by what it carries: no origin of its own, and never Lumovi’s own site', async () => {
  ;(globalThis as { LUMOVI_TEST_BUILD?: boolean }).LUMOVI_TEST_BUILD = true
  const { controlShape } = await import('../../src/server/box-check.ts')
  // As a box's requests arrive, measured in the three engines: a request that says `Origin:
  // null`, one that says no origin, a socket that says `Origin: null` (with or without what
  // site it's from: one engine leaves that off a socket).
  expect(controlShape({ origin: 'null', 'sec-fetch-site': 'cross-site' }, false)).toBe(
    'http-with-origin',
  )
  expect(controlShape({ 'sec-fetch-site': 'cross-site' }, false)).toBe('http-without-origin')
  expect(controlShape({ origin: 'null' }, true)).toBe('socket')
  expect(controlShape({ origin: 'null', 'sec-fetch-site': 'cross-site' }, true)).toBe('socket')
  // (A browser that says nothing of sites: by its origin alone.)
  expect(controlShape({}, false)).toBe('http-without-origin')
  // Lumovi's own page asking is no box: it says so itself, or by its origin. Nor is anything
  // that says it's from the same site, or from no site (an address typed, a program's own).
  for (const site of ['same-origin', 'same-site', 'none']) {
    expect(controlShape({ 'sec-fetch-site': site }, false), site).toBeUndefined()
    expect(controlShape({ origin: 'null', 'sec-fetch-site': site }, false), site).toBeUndefined()
    expect(controlShape({ origin: 'null', 'sec-fetch-site': site }, true), site).toBeUndefined()
  }
  expect(controlShape({ origin: 'null', 'sec-fetch-site': 'same-origin' }, false)).toBeUndefined()
  expect(controlShape({ origin: 'https://lumovi.example' }, false)).toBeUndefined()
  expect(controlShape({ origin: 'https://lumovi.example' }, true)).toBeUndefined()
  expect(
    controlShape({ origin: 'https://lumovi.example', 'sec-fetch-site': 'same-origin' }, true),
  ).toBeUndefined()
  // A socket with no origin said is no browser's, and no box's.
  expect(controlShape({}, true)).toBeUndefined()
})

test('the control’s nonce is its own: nothing of a box’s stands in for it, and it’s no way out', async () => {
  const { real, tick } = await checks()
  const ALL = [...BOX_CHECK_CONTROLS]
  // A box knows its check's nonce and not its control's: what it sends under any name, the
  // control's own among them, is a box's request, and fails the check as any is.
  const { nonce, control } = real.start('s')
  expect(control).toMatch(/^[A-Za-z0-9_-]{22}$/)
  expect(control).not.toBe(nonce)
  for (const role of ['first', 'second', 'later'] as const) {
    expect(boxCheckCode(`https://lumovi.example/box-check/${nonce}`, nonce, role)).not.toContain(
      control,
    )
  }
  real.caught(nonce, 'origin', 'http-with-origin')
  real.caught(nonce, 'socket', 'socket')
  expect(real.end('s', nonce, reports(nonce), [])).toMatchObject({
    result: 'failed',
    out: ['other'],
  })
  // The control's own, under a way's name: Lumovi's frame's, never a box's. It's not out.
  const named = real.start('named')
  real.caught(named.control, 'fetch', 'http-with-origin')
  real.caught(named.control, 'xhr', 'http-without-origin')
  real.caught(named.control, 'web-socket', 'socket')
  expect(real.end('named', named.nonce, reports(named.nonce), [])).toMatchObject({
    result: 'passed',
    out: [],
  })
  // Another check's control is no control of this one, nor one made up.
  const mine = real.start('mine')
  const theirs = real.start('theirs')
  for (const shape of ALL) real.caught(theirs.control, 'x', shape)
  for (const shape of ALL) real.caught('made-up', 'x', shape)
  expect(real.end('mine', mine.nonce, reports(mine.nonce), [])).toMatchObject({
    result: 'unfinished',
    unreached: ALL,
  })
  // One that arrives once its check's time is over isn't counted; nor after the check was judged.
  const late = real.start('late')
  tick(BOX_CHECK_LIMITS.nonceLiveMs + 1)
  for (const shape of ALL) real.caught(late.control, 'x', shape)
  expect(real.end('late', late.nonce, reports(late.nonce), [])).toMatchObject({
    result: 'unfinished',
    unreached: ALL,
  })
  const after = real.start('after')
  expect(real.end('after', after.nonce, reports(after.nonce), [])).toMatchObject({
    result: 'unfinished',
  })
  for (const shape of ALL) real.caught(after.control, 'x', shape)
  expect(real.result('after')).toBe('unfinished')
  // A session's checks let go take their controls with them.
  real.forget('named')
  real.caught(named.control, 'x', 'socket')
  expect(real.result('named')).toBeUndefined()
})

test('the check’s own frame is a server’s alone: on the desktop its address is no box’s', async () => {
  const { boxOf, boxAddress } = await import('../../src/shared/plugin-box.ts')
  const { PATHS } = await import('../../src/shared/server.ts')
  // (The desktop has no check: its protocol answers a box's own files, and its filter lets a
  // frame be only where a box's document is. An address for the check's frame is neither.)
  const { origin } = boxAddress('toys')
  expect(boxOf(`${origin}/box.html`)).toMatchObject({ plugin: 'toys' })
  expect(boxOf(`${origin}/check.html`)).toBeUndefined()
  expect(boxOf(`${origin}/${PATHS.boxCheckFrame}`)).toBeUndefined()
  expect(PATHS.boxCheckFrame).toBe('plugin-box/check.html')
  // (And its lines can be put in a sealed document whole: nothing in them ends a script.)
  const { CHECK_FRAME_SCRIPT, sealedDocument } = await import('../../src/shared/plugin-box.ts')
  expect(sealedDocument(CHECK_FRAME_SCRIPT)).toContain(`<script>${CHECK_FRAME_SCRIPT}</script>`)
  expect(() => sealedDocument('1 </SCRIPT> 2')).toThrow()
})

test('text made into code is a way of its own: where it runs, the box says so, and that fails the check', async () => {
  const { made } = await checks()
  // A box whose scope makes text into code (no policy held it): each of the three ran.
  const scope = () => {
    const self: Record<string, unknown> = {
      eval: (text: string) => (text === '1 + 1' ? 2 : undefined),
      Function: function (this: unknown, text: string) {
        return () => (text === 'return 1 + 1' ? 2 : undefined)
      },
      setTimeout: (text: unknown) => {
        if (typeof text === 'string') self.__lumoviCheckTimer = true
      },
    }
    return self
  }
  const nonce = made.start('runs')
  const said = {
    first: await ran(nonce, 'first', scope()),
    second: await ran(nonce, 'second', scope()),
    later: await ran(nonce, 'later', {}),
  }
  expect(ways(said.first)).toMatchObject({
    eval: 'reached',
    'new-function': 'reached',
    'text-timer': 'reached',
  })
  expect(made.end('runs', nonce, said, [])).toMatchObject({
    result: 'failed',
    out: ['eval', 'new-function', 'text-timer'],
  })
  // One whose policy refuses them, by throwing or by never running the text: refused, each.
  const refuses = () => ({
    eval: () => {
      throw new EvalError('refused')
    },
    Function: function () {
      throw new EvalError('refused')
    },
    setTimeout: () => {},
  })
  const held = made.start('held')
  const holds = {
    first: await ran(held, 'first', refuses()),
    second: await ran(held, 'second', refuses()),
    later: await ran(held, 'later', {}),
  }
  expect(ways(holds.first)).toMatchObject({
    eval: 'refused',
    'new-function': 'refused',
    'text-timer': 'refused',
  })
  expect(made.end('held', held, holds, [])).toMatchObject({ result: 'passed', out: [] })
})

test('a browser is named by what it says of itself, and nothing else of it', () => {
  expect(browserOf('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe(
    'Firefox 131',
  )
  expect(
    browserOf(
      'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    ),
  ).toBe('Safari 18.1')
  expect(browserOf('Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0')).toBe('Edge 141')
  expect(browserOf('Mozilla/5.0 Chrome/141.0.7390.54 Safari/537.36')).toBe('Chrome 141')
  expect(browserOf('<script>evil</script>\n2026')).toBe('a browser Lumovi doesn’t know')
  expect(browserOf(undefined)).toBe('a browser Lumovi doesn’t know')
})

test('in the tests’ build alone, one wall of the box can be taken away, for the check to fail on', async () => {
  ;(globalThis as { LUMOVI_TEST_BUILD?: boolean }).LUMOVI_TEST_BUILD = true
  const { boxWalls } = await import('../../src/server/box-check.ts')
  const headers = { 'Content-Security-Policy': "default-src 'none'; connect-src 'none'" }
  expect(boxWalls(headers, {})).toBe(headers)
  expect(boxWalls(headers, { LUMOVI_TEST_BOX_WALL_OFF: 'everything' })).toBe(headers)
  expect(
    boxWalls(headers, { LUMOVI_TEST_BOX_WALL_OFF: 'connect-src' })['Content-Security-Policy'],
  ).toBe("default-src 'none'; connect-src *")
  ;(globalThis as { LUMOVI_TEST_BUILD?: boolean }).LUMOVI_TEST_BUILD = false
  expect(boxWalls(headers, { LUMOVI_TEST_BOX_WALL_OFF: 'connect-src' })).toBe(headers)
})

test('in the tests’ build alone, the check’s boxes can be made to never answer', async () => {
  ;(globalThis as { LUMOVI_TEST_BUILD?: boolean }).LUMOVI_TEST_BUILD = true
  const { checkCode } = await import('../../src/server/box-check.ts')
  const catcher = 'https://lumovi.example/box-check/abc'
  expect(checkCode(catcher, 'abc', { LUMOVI_TEST_BOX_CHECK: 'silent' })).toEqual({
    first: 'box.then(() => {})',
    second: 'box.then(() => {})',
    later: 'box.then(() => {})',
  })
  const real = {
    first: boxCheckCode(catcher, 'abc', 'first'),
    second: boxCheckCode(catcher, 'abc', 'second'),
    later: boxCheckCode(catcher, 'abc', 'later'),
  }
  expect(checkCode(catcher, 'abc', {})).toEqual(real)
  ;(globalThis as { LUMOVI_TEST_BUILD?: boolean }).LUMOVI_TEST_BUILD = false
  expect(checkCode(catcher, 'abc', { LUMOVI_TEST_BOX_CHECK: 'silent' })).toEqual(real)
})

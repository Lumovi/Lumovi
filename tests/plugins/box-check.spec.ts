/**
 * Lumovi's check of a plugin's box, as the server keeps and judges it: a nonce good once, for
 * its session, for a while; what reaches the catcher with any other let go, and of its own only
 * a way's name; what arrives after judgment still failing it; a box that finds another's failing
 * it; silence and a report that isn't whole not a pass; a result for the box's walls as they
 * are. Plain functions.
 */
import { expect, test } from '@playwright/test'
import {
  BOX_CHECK_LIMITS,
  BOX_CHECK_LOOK,
  BOX_CHECK_WAYS,
  boxCheckCode,
  boxCheckKept,
  boxCheckStore,
  browserOf,
  judgeReport,
} from '../../src/shared/box-check.ts'

/** The server's checks, with a clock the test turns. */
async function checks(policy = 'walls-1') {
  ;(globalThis as { LUMOVI_TEST_BUILD?: boolean }).LUMOVI_TEST_BUILD = true
  const { BoxChecks } = await import('../../src/server/box-check.ts')
  let now = 1_000_000
  const made = new BoxChecks(policy, () => now)
  return { made, BoxChecks, tick: (ms: number) => (now += ms), now: () => now }
}
/** A side-by-side box's whole report: every way refused but those said otherwise. */
const report = (
  nonce: string,
  role: 'first' | 'second',
  said: Partial<Record<string, string>> = {},
  found: string[] = [],
) =>
  JSON.stringify({
    check: nonce,
    role,
    ways: Object.fromEntries(BOX_CHECK_WAYS.map((way) => [way, said[way] ?? 'refused'])),
    found,
  })
/** All three boxes' reports, whole, each having found nothing but what's said. */
const reports = (
  nonce: string,
  said: Partial<Record<string, string>> = {},
  found: { first?: string[]; second?: string[]; later?: string[] } = {},
) => ({
  first: report(nonce, 'first', said, found.first),
  second: report(nonce, 'second', said, found.second),
  later: JSON.stringify({ check: nonce, role: 'later', found: found.later ?? [] }),
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
  ).toEqual({ result: 'passed', out: [], first: true })
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
    made.end('s', nonce, reports(nonce, { beacon: 'sent' }), [], (late) => told.push(late)),
  ).toMatchObject({ result: 'passed' })
  // A beacon the browser sent on after the report: the pass is a failure now, told once.
  tick(5_000)
  made.caught(nonce, 'beacon')
  expect(made.result('s')).toBe('failed')
  expect(told).toEqual([{ result: 'failed', out: ['beacon'], first: true }])
  expect(pages).toBe(1)
  // More of it changes nothing that's said: it's failed already.
  made.caught(nonce, 'fetch-keepalive')
  expect(told).toHaveLength(1)
  expect(pages).toBe(1)
  unwatch()
  // Past the nonce's life, what reaches the catcher is let go: the pass holds.
  const again = made.start('u')
  made.end('u', again, reports(again), [], (late) => told.push(late))
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
    JSON.stringify({ check: 'NONCE', role: 'first', found: [], ...said })
  for (const said of [
    { ...whole, first: first({ ways: leftOut }) },
    { ...whole, first: first({ ways: { ...ways, xhr: 'fine' } }) },
    { ...whole, first: first({ ways, found: ['cookies'] }) },
    { ...whole, first: first({ ways, found: ['caches', 'caches'] }) },
    { ...whole, first: whole.second },
    { ...whole, later: JSON.stringify({ check: 'NONCE', role: 'later' }) },
    { ...whole, second: report('another', 'second') },
    { ...whole, later: 'not json' },
    [],
    'reports',
  ]) {
    expect(partial(said), JSON.stringify(said).slice(0, 80)).toBe('failed')
  }
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
    judgeReport(JSON.stringify({ check: 'abc', role: 'later', found: [] }), 'abc', 'later'),
  ).toEqual({ reached: [], found: [] })
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

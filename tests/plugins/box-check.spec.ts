/**
 * Lumovi's check of a plugin's box, as the server keeps and judges it: a nonce good once, for
 * its session, for a while; what reaches the catcher with any other let go; silence and a report
 * that isn't whole not a pass; a result for the box's walls as they are. Plain functions.
 */
import { expect, test } from '@playwright/test'
import {
  BOX_CHECK_LIMITS,
  BOX_CHECK_WAYS,
  boxCheckCode,
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
/** A worker's whole report: every way refused but those said otherwise. */
const report = (nonce: string, said: Partial<Record<string, string>> = {}) =>
  JSON.stringify({
    check: nonce,
    ways: Object.fromEntries(BOX_CHECK_WAYS.map((way) => [way, said[way] ?? 'refused'])),
  })

test('a check passes when nothing got out, the report is whole and in time', async () => {
  const { made } = await checks()
  const nonce = made.start('session-a')
  expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/)
  expect(made.result('session-a')).toBeUndefined()
  expect(
    made.end(
      'session-a',
      nonce,
      // (Sent where only its own origin is: what the page didn't find there didn't get out.)
      report(nonce, { beacon: 'absent', 'broadcast-channel': 'sent', caches: 'sent' }),
      [],
    ),
  ).toEqual({ result: 'passed', out: [], first: true })
  expect(made.result('session-a')).toBe('passed')
  // Judged once: the nonce is taken back.
  expect(made.end('session-a', nonce, report(nonce), [])).toBeUndefined()
})

test('what reaches the catcher with the check’s nonce fails it, whatever the report says', async () => {
  const { made } = await checks()
  const nonce = made.start('s')
  made.caught(nonce, 'fetch')
  made.caught(nonce, 'web-socket')
  expect(made.end('s', nonce, report(nonce), [])).toEqual({
    result: 'failed',
    out: ['fetch', 'web-socket'],
    first: true,
  })
  expect(made.result('s')).toBe('failed')
  // And what the worker says reached, or the page heard, fails it too.
  const second = made.start('t')
  expect(made.end('t', second, report(second, { xhr: 'reached' }), [])?.out).toEqual(['xhr'])
  const third = made.start('u')
  expect(
    made.end('u', third, report(third), ['broadcast-channel', 'caches', 'made-up'])?.out,
  ).toEqual(['broadcast-channel', 'caches'])
})

test('a nonce is the session’s, live a while, and nothing else counts or fills anything', async () => {
  const { made, tick } = await checks()
  const mine = made.start('mine')
  const theirs = made.start('theirs')
  // Someone else's nonce, a made-up one, one already judged or gone stale: let go, not counted.
  made.caught('made-up', 'fetch')
  made.caught(theirs, 'fetch')
  expect(made.end('mine', theirs, report(theirs), [])).toBeUndefined()
  expect(made.end('mine', mine, report(mine), [])?.result).toBe('passed')
  made.caught(mine, 'fetch')
  expect(made.result('mine')).toBe('passed')
  // (Their check, failed by what reached it with their nonce, is theirs alone.)
  expect(made.end('theirs', theirs, report(theirs), [])?.result).toBe('failed')
  // Stale: past its life, what reaches the catcher isn't counted.
  const old = made.start('old')
  tick(BOX_CHECK_LIMITS.nonceLiveMs + 1)
  made.caught(old, 'fetch')
  // A new check of a session ends the one before.
  const first = made.start('again')
  const second = made.start('again')
  expect(made.end('again', first, report(first), [])).toBeUndefined()
  expect(made.end('again', second, report(second), [])?.result).toBe('passed')
  // Bounded: however much reaches the catcher, a check holds so many.
  const many = made.start('many')
  for (let i = 0; i < 10_000; i++) made.caught(many, `way-${i}`)
  expect(made.end('many', many, report(many), [])?.out).toHaveLength(BOX_CHECK_LIMITS.hitsANonce)
})

test('silence, a late report, or one that isn’t whole, is no pass', async () => {
  const { made, tick } = await checks()
  // A worker that never answers: the page says so with nothing.
  const silent = made.start('silent')
  expect(made.end('silent', silent, null, [])?.result).toBe('unfinished')
  expect(made.result('silent')).toBe('unfinished')
  // Late.
  const late = made.start('late')
  tick(BOX_CHECK_LIMITS.answerWithinMs + 1)
  expect(made.end('late', late, report(late), [])?.result).toBe('unfinished')
  // A way left out, an unknown word, another check's nonce, or not a report at all: failed.
  const partial = (text: string) => {
    const nonce = made.start('partial')
    return made.end('partial', nonce, text.replaceAll('NONCE', nonce), [])?.result
  }
  const whole = JSON.parse(report('NONCE')) as { ways: Record<string, string> }
  const { fetch: _, ...leftOut } = whole.ways
  for (const text of [
    JSON.stringify({ check: 'NONCE', ways: leftOut }),
    JSON.stringify({ check: 'NONCE', ways: { ...whole.ways, xhr: 'fine' } }),
    report('another'),
    'not json',
    JSON.stringify([]),
  ]) {
    expect(partial(text), text.slice(0, 60)).toBe('failed')
  }
})

test('a result holds for the box’s walls as they were: other walls, and every browser is asked again', async () => {
  const { made, BoxChecks } = await checks('walls-1')
  const nonce = made.start('s')
  made.end('s', nonce, report(nonce), [])
  expect(made.result('s')).toBe('passed')
  // (A server's results are its own: one started with other walls holds none of them.)
  expect(new BoxChecks('walls-2').result('s')).toBeUndefined()
  // Said once a session: the same result again isn't a first.
  const again = made.start('s')
  expect(made.end('s', again, report(again), [])?.first).toBe(false)
  made.forget('s')
  expect(made.result('s')).toBeUndefined()
})

test('the check’s code tries every way at the catcher, and only there', () => {
  const code = boxCheckCode('https://lumovi.example/box-check/abc', 'abc')
  for (const way of BOX_CHECK_WAYS) expect(code, way).toContain(`'${way}'`)
  expect(code).toContain('"https://lumovi.example/box-check/abc"')
  expect(code).toContain('"wss://lumovi.example/box-check/abc"')
  expect(code).not.toMatch(/https?:\/\/(?!lumovi\.example)/)
  expect(judgeReport(report('abc'), 'abc')?.reached).toEqual([])
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

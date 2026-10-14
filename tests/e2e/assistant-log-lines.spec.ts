/**
 * The lines get_logs answers with (src/backend/mcp/log-lines.ts): a line's level as a log says
 * it, the lines with a text or of a level, and never more than an answer holds, with what was
 * left out said and the line to ask from. Nothing is launched.
 */
import { expect, test } from '@playwright/test'
import { fitted, levelOf, linesOf } from '../../src/backend/mcp/log-lines.ts'

test('a line’s level is what the log says: a structured field, or a word of its own at its start', () => {
  for (const [line, level] of [
    ['{"level":"error","msg":"payments client not initialised"}', 'error'],
    ['{"severity":"WARNING","message":"slow"}', 'warn'],
    ['time=2026-10-14T03:00:00Z level=info msg="listening"', 'info'],
    ['ERROR 2026-10-14 could not open the data files', 'error'],
    ['[warn] retrying', 'warn'],
    ['panic: runtime error: invalid memory address or nil pointer dereference', 'error'],
    ['Traceback (most recent call last):', 'error'],
    ['  at main.go:42', undefined],
    ['listening on :8080', undefined],
  ] as const) {
    expect(levelOf(line), line).toBe(level)
  }
})

test('the lines with a text in them, and of a level and above: a line that says none goes with the one before', () => {
  const log = [
    '{"level":"info","msg":"starting"}',
    '{"level":"warn","msg":"database connection failed, retrying"}',
    '{"level":"error","msg":"payments client not initialised"}',
    'panic: runtime error',
    '[signal SIGSEGV: segmentation violation]',
    '{"level":"info","msg":"shutting down"}',
    '',
  ].join('\n')
  expect(linesOf(log)).toHaveLength(6)
  expect(linesOf(log, { level: 'error' })).toEqual([
    '{"level":"error","msg":"payments client not initialised"}',
    'panic: runtime error',
    '[signal SIGSEGV: segmentation violation]',
  ])
  expect(linesOf(log, { level: 'warn' })).toHaveLength(4)
  expect(linesOf(log, { match: 'PAYMENTS' })).toEqual([
    '{"level":"error","msg":"payments client not initialised"}',
  ])
  expect(linesOf(log, { match: 'retrying', level: 'error' })).toEqual([])
})

test('more lines than an answer holds: the first and the last, what was left out between, and the line to ask from', () => {
  const lines = Array.from({ length: 5_000 }, (_, n) => `line ${n + 1} ${'x'.repeat(90)}`)
  const answer = fitted(lines, 48_000)
  expect(answer.length).toBeLessThanOrEqual(48_000)
  const shown = answer.split('\n')
  expect(shown[0]).toMatch(/^line 1 /)
  expect(shown.at(-1)).toMatch(/^line 5000 /)
  const said = shown.find((line) => line.startsWith('… '))!
  const [, leftOut, first, last, of, askFrom] =
    /^… (\d+) lines left out here \(lines (\d+) to (\d+) of (\d+)\): ask again with from: (\d+) for them\.$/.exec(
      said,
    )!
  expect(Number(of)).toBe(5_000)
  expect(Number(last) - Number(first) + 1).toBe(Number(leftOut))
  expect(shown.length - 1 + Number(leftOut)).toBe(5_000)
  // Asked from there: the lines it left out come first.
  expect(fitted(lines, 48_000, Number(askFrom)).split('\n')[0]).toMatch(
    new RegExp(`^line ${askFrom} `),
  )
  // What fits is all there, with nothing said; and a line too long for anyone is cut, and said so.
  expect(fitted(lines.slice(0, 10), 48_000)).toBe(lines.slice(0, 10).join('\n'))
  expect(fitted(['y'.repeat(5_000)], 48_000)).toBe(`${'y'.repeat(2_000)}… (3000 more characters)`)
})

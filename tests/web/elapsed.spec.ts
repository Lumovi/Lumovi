/**
 * How long, as Lumovi writes and says it (src/renderer/src/lib/elapsed.ts): seconds, then
 * minutes, then hours and, from a day, days and hours. Plain functions: nothing is served.
 */
import { expect, test } from '../temp-folders.ts'
import { formatElapsed, spokenElapsed } from '../../src/renderer/src/lib/elapsed.ts'

const at = (h: number, m = 0, s = 0) => ((h * 60 + m) * 60 + s) * 1000

test('under a day, as it always was; from a day, days and hours', () => {
  const written: [number, string][] = [
    [-5000, '0s'],
    [at(0, 0, 45), '45s'],
    [at(0, 1, 5), '1m 05s'],
    [at(2, 5), '2h 05m'],
    [at(23, 59, 59), '23h 59m'],
    [at(24), '1d 0h'],
    [at(25, 30), '1d 1h'],
    [at(377, 53), '15d 17h'],
  ]
  for (const [ms, said] of written) expect(formatElapsed(ms), String(ms)).toBe(said)
})

test('spoken in whole minutes; from a day, days and hours, a unit at nought left out', () => {
  const spoken: [number, string][] = [
    [at(0, 0, 45), 'less than a minute'],
    [at(0, 1, 5), '1 minute'],
    [at(1), '1 hour'],
    [at(2, 5), '2 hours 5 minutes'],
    [at(23, 59, 59), '23 hours 59 minutes'],
    [at(24), '1 day'],
    [at(25, 30), '1 day 1 hour'],
    [at(49), '2 days 1 hour'],
    [at(377, 53), '15 days 17 hours'],
  ]
  for (const [ms, said] of spoken) expect(spokenElapsed(ms), String(ms)).toBe(said)
})

/**
 * A value written into code Lumovi makes as text: it reads back the same, and nothing in it can
 * end the script around it or a line inside it.
 */
import { expect, test } from '@playwright/test'
import { literal } from '../../src/shared/code-literal.ts'

/** The two characters that end a line in a script, though JSON leaves them as they are. */
const SEPARATORS = String.fromCharCode(0x2028, 0x2029)

test('a value written into code reads back the same, with nothing in it that ends a script or a line', () => {
  const values = [
    '</script><!--',
    `a${SEPARATORS}b`,
    { at: 'http://127.0.0.1:1/box-check/nonce', said: '<b>, & "quoted"' },
    ['first', 2, null, true],
    'plain',
  ]
  for (const value of values) {
    const written = literal(value)
    expect(JSON.parse(written)).toEqual(value)
    expect(written).not.toMatch(/[<>]/)
    expect([...SEPARATORS].filter((character) => written.includes(character))).toEqual([])
  }
  // What has nothing to escape is written as JSON writes it.
  expect(literal({ at: 'http://h/x', n: 1 })).toBe(JSON.stringify({ at: 'http://h/x', n: 1 }))
})

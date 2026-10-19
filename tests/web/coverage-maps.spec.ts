/** The renderer's counters a browser keeps, and the maps the coverage build writes for them. */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '../temp-folders.ts'
import { rendererMaps, withMaps } from './coverage.ts'

const counts = (path: string) => ({ [path]: { s: { 0: 2 }, f: {}, b: {} } })
const map = (path: string) => ({
  [path]: { path, statementMap: { 0: {} }, fnMap: {}, branchMap: {}, s: { 0: 0 }, f: {}, b: {} },
})

test('counters are merged with their maps, and counters without one fail the test by name', () => {
  expect(withMaps(counts('src/a.ts'), map('src/a.ts'))).toEqual({
    'src/a.ts': {
      path: 'src/a.ts',
      statementMap: { 0: {} },
      fnMap: {},
      branchMap: {},
      s: { 0: 2 },
      f: {},
      b: {},
    },
  })
  // A file the build wrote no maps for is never dropped quietly.
  expect(() => withMaps({ ...counts('src/a.ts'), ...counts('src/b.ts') }, map('src/a.ts'))).toThrow(
    /a page left counters for src\/b\.ts and the coverage build wrote no maps for them/,
  )
  // Where the build wrote none at all, every counter is said so.
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-maps-'))
  expect(rendererMaps(join(folder, 'none.json'))).toEqual({})
  writeFileSync(join(folder, 'maps.json'), JSON.stringify(map('src/a.ts')))
  expect(Object.keys(rendererMaps(join(folder, 'maps.json')))).toEqual(['src/a.ts'])
})

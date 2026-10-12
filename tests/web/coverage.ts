/**
 * The renderer's coverage in a browser: a page keeps its counters in its localStorage when it's
 * left (scripts/vite-coverage.ts), without the maps they count in, which the coverage build
 * writes for every file it instruments.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RENDERER_MAPS } from '../../scripts/vite-coverage.ts'

/** Istanbul's coverage: each file's maps and counters (only the counters change). */
export type Coverage = Record<string, Record<string, unknown>>

/** Every renderer file's maps, as the build wrote them (none, where it wrote nothing). */
export function rendererMaps(path = resolve(RENDERER_MAPS)): Coverage {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Coverage) : {}
}

/**
 * Counters with their files' maps, for a coverage report. Counters with no map can't be merged,
 * and dropping them would lower the coverage quietly: said by name, as what it is.
 */
export function withMaps(counts: Coverage, maps: Coverage): Coverage {
  const unmapped = Object.keys(counts).filter((path) => !(path in maps))
  if (unmapped.length > 0) {
    throw new Error(
      `The tests’ own coverage bookkeeping (tests/web/fixtures.ts), not what this test is about: a page left counters for ${unmapped.join(', ')} and the coverage build wrote no maps for them (${RENDERER_MAPS}).`,
    )
  }
  return Object.fromEntries(
    Object.entries(counts).map(([path, hits]) => [path, { ...maps[path], ...hits }]),
  )
}

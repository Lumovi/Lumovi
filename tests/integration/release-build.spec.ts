/**
 * The build these tests run against is made as a release's is (`npm run build`, no
 * LUMOVI_COVERAGE). What the tests' own build adds for itself must not be in it: the counters,
 * and the messages a test's server answers (to save its coverage; to stop, on Windows).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'

/** What scripts/vite-coverage.ts puts in a build, by the names only it uses. */
const TESTS_ONLY = [
  'lumovi:stop',
  'lumovi:coverage',
  '__coverage__',
  'LUMOVI_COVERAGE_DIR',
  '__lumoviSaveCoverage__',
]

test('a build made as a release’s carries nothing the tests’ build adds for itself', () => {
  const out = resolve('out')
  const found: string[] = []
  const built = readdirSync(out, { recursive: true, encoding: 'utf8' }).filter((file) =>
    /\.(js|mjs|cjs|html)$/.test(file),
  )
  // The server, the agent, the app's main process and its pages: all of them.
  for (const part of ['server', 'agent', 'main', 'preload', 'renderer']) {
    expect(
      built.some((file) => file.split(/[\\/]/)[0] === part),
      `out/${part} is built`,
    ).toBe(true)
  }
  for (const file of built) {
    const text = readFileSync(join(out, file), 'utf8')
    for (const name of TESTS_ONLY) if (text.includes(name)) found.push(`${file}: ${name}`)
  }
  expect(found).toEqual([])
})

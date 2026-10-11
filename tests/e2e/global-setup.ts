import { existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { COVERAGE_DIR } from './fixtures.ts'

/**
 * Starts every run with an empty coverage directory and fails fast without a build.
 *
 * And with Electron's binary in place. Its package fetches and unpacks it the first time it's
 * asked where the binary is, not when it's installed; left to the tests, the first of them in
 * each worker would ask at once, each unpacking over the others, and one would start a binary
 * another still had open to write ("spawn ETXTBSY", on Linux). Asked here, once, before any
 * worker starts.
 */
export default function globalSetup(): void {
  if (!existsSync('out/main/index.js') || !existsSync('out/server/index.js')) {
    throw new Error('No build found. Run `npm run build:coverage` (or `npm run test:e2e`) first.')
  }
  if (!process.env.LUMOVI_E2E_EXECUTABLE) createRequire(import.meta.url)('electron')
  rmSync(COVERAGE_DIR, { recursive: true, force: true })
}

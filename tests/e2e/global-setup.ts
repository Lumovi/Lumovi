import { existsSync, rmSync } from 'node:fs'
import { COVERAGE_DIR } from './fixtures.ts'

/** Starts every run with an empty coverage directory and fails fast without a build. */
export default function globalSetup(): void {
  if (!existsSync('out/main/index.js')) {
    throw new Error('No build found. Run `npm run build:coverage` (or `npm run test:e2e`) first.')
  }
  rmSync(COVERAGE_DIR, { recursive: true, force: true })
}

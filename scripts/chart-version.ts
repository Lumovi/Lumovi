/**
 * Keeps the Helm chart's version and appVersion at package.json's: they're
 * released together. `npm version` runs it (the "version" script); with
 * `--check`, it only fails when they differ (CI).
 */
import { readFileSync, writeFileSync } from 'node:fs'

const CHART = 'charts/kubestacks/Chart.yaml'
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
const chart = readFileSync(CHART, 'utf8')
const synced = chart
  .replace(/^version: .*$/m, `version: ${version}`)
  .replace(/^appVersion: .*$/m, `appVersion: ${version}`)

if (process.argv.includes('--check')) {
  if (synced !== chart) {
    console.error(`${CHART} isn't at ${version}: run node scripts/chart-version.ts`)
    process.exit(1)
  }
} else {
  writeFileSync(CHART, synced)
}

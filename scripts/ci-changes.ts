/**
 * What a CI run needs, from what a pull request changes (CI's "What changed" job), for
 * $GITHUB_OUTPUT:
 *
 * - `docs`: it changes only docs (Markdown, docs/, images outside the app): no E2E, packaging or
 *   integration tests, and "CI passed" all the same.
 * - `e2e`: the E2E shards. Linux and Windows always run them all. macOS too, where the change
 *   touches what macOS does differently (the main process, Electron, packaging, the lockfile, CI
 *   and the test harness, or a file that asks which platform it's on); otherwise a short smoke
 *   set (tests/e2e/smoke.txt), as macOS runners are few.
 *
 * Main, a release's pull request (`release-*`) and a run by hand run everything.
 *
 *   node scripts/ci-changes.ts [changed files...]   (by default, HEAD's against its first parent)
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const OSES = ['ubuntu-latest', 'macos-latest', 'windows-latest'] as const
const SHARDS = 4

/** What only explains the app: docs, Markdown, and images that aren't the app's. */
const isDocs = (path: string) =>
  path.startsWith('docs/') ||
  (path.endsWith('.md') && !path.startsWith('src/')) ||
  (/\.(png|jpe?g|gif|webp|svg)$/i.test(path) && !/^(src|build|packaging|charts|tests)\//.test(path))

/** What macOS does differently, or what decides how the app is built and tested. */
const MACOS = [
  /^src\/(main|preload|backend)\//,
  /^(build|packaging)\//,
  /^electron(-builder\.yml|\.vite\.config\.ts)$/,
  /^package(-lock)?\.json$/,
  /^\.nvmrc$/,
  /^\.github\/workflows\//,
  /^playwright\.config\.ts$/,
  /^tests\/e2e\/(fixtures|global-setup)\.ts$/,
  /^scripts\/(ci-changes|e2e-shard)\.ts$/,
]
const PLATFORM = /process\.platform|navigator\.(platform|userAgent)|\bdarwin\b|\bisMac\b/
const isMacos = (path: string) =>
  MACOS.some((pattern) => pattern.test(path)) ||
  (/^src\/.*\.tsx?$/.test(path) && existsSync(path) && PLATFORM.test(readFileSync(path, 'utf8')))

const event = process.env.GITHUB_EVENT_NAME
const branch = process.env.GITHUB_HEAD_REF ?? ''
const everything = event !== 'pull_request' || branch.startsWith('release-')
const changed =
  process.argv.length > 2
    ? process.argv.slice(2)
    : execFileSync('git', ['diff', '--name-only', 'HEAD^1', 'HEAD'], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)

const docs = !everything && changed.length > 0 && changed.every(isDocs)
const macos = everything || changed.some(isMacos)
const e2e = OSES.flatMap((os) =>
  os === 'macos-latest' && !macos
    ? [{ os, shard: 'smoke', part: 'smoke' }]
    : Array.from({ length: SHARDS }, (_, i) => ({
        os,
        shard: `${i + 1}/${SHARDS}`,
        part: String(i + 1),
      })),
)

const said = [
  everything
    ? `Everything runs (${event === 'pull_request' ? `a release's pull request` : event}).`
    : `${changed.length} ${changed.length === 1 ? 'file' : 'files'} changed.`,
  docs ? 'Docs only: no E2E, packaging or integration tests.' : '',
  !docs && !macos ? 'Nothing macOS does differently: macOS runs the smoke set.' : '',
]
  .filter(Boolean)
  .join(' ')
console.log(said)
const output = process.env.GITHUB_OUTPUT
if (output) {
  appendFileSync(output, `docs=${docs}\ne2e=${JSON.stringify({ include: e2e })}\n`)
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${said}\n`)

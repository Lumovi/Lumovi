/**
 * What a CI run needs, from what a pull request changes (CI's "What changed" job), for
 * $GITHUB_OUTPUT:
 *
 * - `docs`: it changes only docs (Markdown, docs/, images outside the app): no E2E, packaging or
 *   integration tests, and "CI passed" all the same.
 * - `e2e`: the E2E shards. Linux and Windows always run them all. macOS too, where the change
 *   touches what macOS does differently (the main process, Electron, packaging, the lockfile, CI
 *   and the test harness, or a file that asks which platform it's on), or takes away or changes
 *   lines of a test or a test's helper; otherwise a short smoke set (tests/e2e/smoke.txt), as
 *   macOS runners are few.
 *
 * - `macos`: `full` or `smoke`, for the coverage job: where macOS ran the smoke set, what only
 *   macOS reaches is borrowed from main (scripts/borrow-coverage.ts), so the gate judges like
 *   with like.
 *
 * Main, a release's pull request (`release-*`) and a run by hand run everything.
 *
 *   node scripts/ci-changes.ts [changed files...]   (by default, HEAD's against its first parent)
 *
 * tests/web/ci-changes.spec.ts tries it on changes of each kind.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const OSES = ['ubuntu-latest', 'macos-latest', 'windows-latest'] as const
/** How many machines a platform's tests are split over. */
export const SHARDS = 4

/** What only explains the app: Markdown, and images that aren't the app's (in docs/, say). */
const isDocs = (path: string) =>
  (path.endsWith('.md') && !/^(src|tests)\//.test(path)) ||
  (/\.(png|jpe?g|gif|webp|svg)$/i.test(path) && !/^(src|build|packaging|charts|tests)\//.test(path))

/** What macOS does differently, or what decides how the app is built and tested. */
const MACOS = [
  /^src\/(main|preload|backend|shared)\//,
  /^(build|packaging)\//,
  /^electron(-builder\.yml|\.vite\.config\.ts)$/,
  /^package(-lock)?\.json$/,
  /^\.nvmrc$/,
  /^\.github\/workflows\//,
  /^playwright\.config\.ts$/,
  /^tests\/e2e\/(fixtures|global-setup)\.ts$/,
  /^scripts\/(ci-changes|e2e-shard)\.ts$/,
]
/** Code that asks which platform it's on, or does differently there (⌘ for Ctrl, a draggable bar). */
const PLATFORM =
  /\.platform\b|navigator\.userAgent|userAgentData|\bdarwin\b|\bwin32\b|\bisMac\b|metaKey|MOD_KEY|CTRL_KEY|app-region/
/** A source file as it is now, and as it was (deleted or moved, it's only what it was). */
const versionsOf = (path: string): string[] => {
  const was = (() => {
    try {
      return execFileSync('git', ['show', `HEAD^1:${path}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      return ''
    }
  })()
  return [existsSync(path) ? readFileSync(path, 'utf8') : '', was]
}
/** Whether a file only gained lines: every line it had is still there, in its order. */
function onlyAdds([now = '', was = '']: string[]): boolean {
  const lines = now.split('\n')
  let at = 0
  for (const line of was.split('\n')) {
    at = lines.indexOf(line, at) + 1
    if (at === 0) return false
  }
  return true
}

/** What the run needs, from the event, the pull request's branch and what it changes. */
export function plan({
  event,
  branch = '',
  changed,
  versions = versionsOf,
}: {
  event: string | undefined
  branch?: string
  changed: string[]
  versions?: (path: string) => string[]
}) {
  const everything = event !== 'pull_request' || branch.startsWith('release-')
  const isMacos = (path: string) =>
    MACOS.some((pattern) => pattern.test(path)) ||
    (/^src\/.*\.(tsx?|css)$/.test(path) && versions(path).some((text) => PLATFORM.test(text))) ||
    // A test or a test's helper with lines taken away or changed: what it reached on macOS may
    // not be reached any more, and coverage borrowed from main (scripts/borrow-coverage.ts)
    // would go on counting it. One that only gains lines takes nothing away.
    (/^tests\//.test(path) && !onlyAdds(versions(path)))
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
  return { everything, docs, macos, e2e, said }
}

if (import.meta.main) {
  const changed =
    process.argv.length > 2
      ? process.argv.slice(2)
      : // A file moved is where it was and where it is: both count.
        execFileSync('git', ['diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD'], {
          encoding: 'utf8',
        })
          .split('\n')
          .filter(Boolean)
  const { docs, macos, e2e, said } = plan({
    event: process.env.GITHUB_EVENT_NAME,
    branch: process.env.GITHUB_HEAD_REF,
    changed,
  })
  console.log(said)
  const output = process.env.GITHUB_OUTPUT
  if (output) {
    appendFileSync(
      output,
      `docs=${docs}\nmacos=${macos ? 'full' : 'smoke'}\ne2e=${JSON.stringify({ include: e2e })}\n`,
    )
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${said}\n`)
  }
}

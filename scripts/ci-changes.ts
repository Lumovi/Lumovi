/**
 * What a CI run needs, from what a pull request changes (CI's "What changed" job), for
 * $GITHUB_OUTPUT:
 *
 * - `docs`: it changes only docs (Markdown, docs/, images outside the app): no E2E, packaging or
 *   integration tests, and "CI passed" all the same.
 * - `e2e`: the E2E shards. Linux and Windows always run them all. macOS too, where the change
 *   touches what macOS does differently (the main process, Electron, packaging, the lockfile, CI
 *   and the test harness, or a file that asks which platform it's on), or where someone asks
 *   for it with the label `macos-full`; otherwise a short smoke set (tests/e2e/smoke.txt). An
 *   account has five macOS machines at once, and a full run takes all five.
 *
 * - `macos`: `full` or `smoke`, for the coverage job: where macOS ran the smoke set, what main's
 *   macOS run reached and its Linux and Windows runs didn't is borrowed from main
 *   (scripts/borrow-coverage.ts), and nothing else: the rest is this run's own to reach.
 *
 * Main, a release's pull request (`release-*`) and a run by hand run everything. Main's own run,
 * after each merge, is the one that binds: what a pull request's can't see (something only macOS
 * reached that a change elsewhere stops being reached) shows there, and a red main is a warning
 * on every pull request (the workflow's "Whether main is red").
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
  // The app's own process and its bridge to the page: menus, windows, the keychain, the dock.
  /^src\/(main|preload)\//,
  // The backend's files that start other programs, or use the home and temp folders: where
  // macOS and Linux differ without being asked.
  /^src\/backend\/(helm\/service|kube\/(client|kubeconfig|files|streams)|network)\.ts$/,
  /^(build|packaging)\//,
  /^electron(-builder\.yml|\.vite\.config\.ts)$/,
  // Electron, or a module built for the machine, may have moved.
  /^package(-lock)?\.json$/,
  /^\.nvmrc$/,
  /^\.github\/workflows\//,
  /^playwright\.config\.ts$/,
  // What every desktop test stands on, and what decides or feeds this very choice.
  /^tests\/e2e\/(fixtures|global-setup)\.ts$/,
  /^tests\/e2e\/smoke\.txt$/,
  /^scripts\/(ci-changes|e2e-shard|borrow-coverage|vite-coverage)\.ts$/,
]
/** The label that asks for everything on macOS, whatever changed. */
export const MACOS_FULL = 'macos-full'
/** Code that asks which platform it's on, or does differently there (⌘ for Ctrl, a draggable bar). */
const PLATFORM =
  /\.platform\b|navigator\.userAgent|userAgentData|\bdarwin\b|\bwin32\b|\bisMac\b|metaKey|MOD_KEY|CTRL_KEY|app-region|\bchild_process\b|\btmpdir\b|\bhomedir\b/
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
/** What the run needs, from the event, the pull request's branch and what it changes. */
export function plan({
  event,
  branch = '',
  changed,
  labels = [],
  versions = versionsOf,
}: {
  event: string | undefined
  branch?: string
  changed: string[]
  /** The pull request's labels. */
  labels?: string[]
  versions?: (path: string) => string[]
}) {
  const everything = event !== 'pull_request' || branch.startsWith('release-')
  const isMacos = (path: string) =>
    MACOS.some((pattern) => pattern.test(path)) ||
    (/^src\/.*\.(tsx?|css)$/.test(path) && versions(path).some((text) => PLATFORM.test(text)))
  const asked = labels.includes(MACOS_FULL)
  const docs = !everything && changed.length > 0 && changed.every(isDocs)
  const macos = everything || asked || changed.some(isMacos)
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
    !everything && asked ? `Everything on macOS, as its label asks (${MACOS_FULL}).` : '',
  ]
    .filter(Boolean)
    .join(' ')
  return { everything, docs, macos, e2e, said }
}

/**
 * The pull request's labels as they are now, asked of GitHub (PR_NUMBER, GH_TOKEN,
 * GITHUB_REPOSITORY): a run started again after a label was put on must see it, and the event
 * the run was started by still says what was so then. None where it can't be asked.
 */
function labelsNow(): string[] {
  const { PR_NUMBER, GITHUB_REPOSITORY } = process.env
  if (!PR_NUMBER || !GITHUB_REPOSITORY) return []
  try {
    return execFileSync(
      'gh',
      ['api', `repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/labels`, '--jq', '.[].name'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    )
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
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
    labels: labelsNow(),
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

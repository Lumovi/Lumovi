/**
 * What a CI run needs, from what started it and what a pull request changes (CI's "What changed"
 * job), for $GITHUB_OUTPUT:
 *
 * - `docs`: a pull request that changes only docs (Markdown, docs/, images outside the app): no
 *   E2E, packaging or integration tests, and "CI passed" all the same. Likewise a nightly run on
 *   a head that's run macOS in full, green, already: there's nothing new for it to run.
 * - `e2e`: the E2E shards, each with the tests' projects it runs. Linux runs every test, the
 *   desktop app's (tests/e2e) and the browser's (tests/web). macOS and Windows run the desktop
 *   app's, less those whose logic is the same on every system (tests/e2e/linux-only.txt): those,
 *   and the browser's, run there only nightly, for a run by hand and for a release's pull
 *   request, since the server Lumovi ships runs on Linux. macOS, for now, runs only its smoke set
 *   (tests/e2e/smoke.txt) for a pull request and for main's merges, whatever they change: an
 *   account has five macOS machines at once, and a full run takes all five. Its full suite runs
 *   nightly on main's head (CI's schedule), for a release's pull request (`release-<version>`),
 *   for a run by hand, and for a pull request whose label (`macos-full`) asks.
 * - `release`: whether this is a release's own pull request, whose branch is named for its version
 *   (`release-1.22.0`): any other branch whose name starts the same is an ordinary one.
 * - `macos`: `full` or `smoke`, for the coverage job: where macOS ran the smoke set, what main's
 *   newest full macOS run reached and its Linux and Windows didn't is borrowed from it
 *   (scripts/borrow-coverage.ts), and nothing else: the rest is this run's own to reach.
 *
 * Main's nightly run is the one that counts for macOS: what a merge's run can't see (something
 * only macOS reaches that a change stops being reached) shows there, and a red nightly is a red
 * main, a warning on every pull request (the workflow's "Whether main is red").
 *
 *   node scripts/ci-changes.ts [changed files...]   (by default, HEAD's against its first parent)
 *
 * tests/web/ci-changes.spec.ts tries it on each kind of run.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const OSES = ['ubuntu-latest', 'macos-latest', 'windows-latest'] as const
/** How many machines a platform's tests are split over. */
export const SHARDS = 4

/** What only explains the app: Markdown, and images that aren't the app's (in docs/, say). */
const isDocs = (path: string) =>
  (path.endsWith('.md') && !/^(src|tests)\//.test(path)) ||
  (/\.(png|jpe?g|gif|webp|svg)$/i.test(path) && !/^(src|build|packaging|charts|tests)\//.test(path))

/** A release's own branch: `release-` and its version (`release-1.22.0`, `release-2.0.0-rc.1`). */
export const isRelease = (branch: string) =>
  /^release-\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(branch)

/** The label that asks for everything on macOS, whatever changed. */
export const MACOS_FULL = 'macos-full'

/**
 * Whether a run's artifacts (their names) hold macOS's coverage in full: every shard's, not the
 * smoke set's.
 */
export const ranMacosInFull = (names: string[]) =>
  Array.from({ length: SHARDS }, (_, i) => `coverage-macOS-${i + 1}`).every((name) =>
    names.includes(name),
  )

/** What the run needs, from the event, the pull request's branch, labels and what it changes. */
export function plan({
  event,
  branch = '',
  changed,
  labels = [],
  ranAlready = false,
}: {
  event: string | undefined
  branch?: string
  changed: string[]
  /** The pull request's labels. */
  labels?: string[]
  /** A nightly run's: its head has run macOS in full, green, already. */
  ranAlready?: boolean
}) {
  const pullRequest = event === 'pull_request'
  const release = pullRequest && isRelease(branch)
  const asked = pullRequest && labels.includes(MACOS_FULL)
  // A nightly run on a head that's run in full already has nothing new to run.
  const again = event === 'schedule' && ranAlready
  // macOS in full: main's nightly run, a run by hand, a release's pull request, or a label's ask.
  // (For now, a merge and any other pull request run its smoke set, whatever they change.)
  const macos =
    !again && (event === 'schedule' || event === 'workflow_dispatch' || release || asked)
  // Docs alone run no tests on a pull request; main runs its tests for every merge.
  const docs = again || (pullRequest && !release && changed.length > 0 && changed.every(isDocs))
  // The browser's tests on every system: the nightly run, a run by hand, a release's pull request.
  // Otherwise on Linux alone, where the server Lumovi ships runs.
  const everySystem = !again && (event === 'schedule' || event === 'workflow_dispatch' || release)
  const projectsOn = (os: (typeof OSES)[number]) =>
    os === 'ubuntu-latest' || everySystem ? 'desktop web' : 'desktop'
  // What a system's shards leave to Linux: the tests that are alike on every system.
  // (macOS in full, as its label asks, is all of the desktop app's tests there.)
  const onlyOn = (os: (typeof OSES)[number]) =>
    os === 'ubuntu-latest' || everySystem || (os === 'macos-latest' && asked) ? '' : 'system'
  const e2e = OSES.flatMap((os) =>
    os === 'macos-latest' && !macos
      ? [{ os, shard: 'smoke', part: 'smoke', projects: 'desktop', only: '' }]
      : Array.from({ length: SHARDS }, (_, i) => ({
          os,
          shard: `${i + 1}/${SHARDS}`,
          part: String(i + 1),
          projects: projectsOn(os),
          only: onlyOn(os),
        })),
  )
  const said = [
    again
      ? 'Main’s nightly run: its head has run macOS in full already, so nothing more runs.'
      : event === 'schedule'
        ? 'Main’s nightly run: everything, on every system, macOS in full.'
        : event === 'workflow_dispatch'
          ? 'A run by hand: everything, on every system, macOS in full.'
          : release
            ? 'A release’s pull request: everything, on every system, macOS in full.'
            : !pullRequest
              ? 'Main’s merge: every test on Linux, the desktop app’s on Windows, and macOS its smoke set (everything runs on every system nightly).'
              : `${changed.length} ${changed.length === 1 ? 'file' : 'files'} changed.`,
    docs && !again ? 'Docs only: no E2E, packaging or integration tests.' : '',
    pullRequest && !release && !docs
      ? asked
        ? `The desktop app’s tests in full on macOS, as its label asks (${MACOS_FULL}).`
        : `macOS runs its smoke set (its full suite runs nightly; the label ${MACOS_FULL} asks for it here).`
      : '',
    pullRequest && !release && !docs
      ? 'The browser’s tests run on Linux (on every system nightly).'
      : '',
  ]
    .filter(Boolean)
    .join(' ')
  return { docs, release, macos, e2e, said }
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

/**
 * Whether this commit (GITHUB_SHA) has a green run of CI whose macOS ran in full, its coverage
 * kept, asked of GitHub (GH_TOKEN, GITHUB_REPOSITORY). Where it can't be asked: no, and the
 * nightly runs.
 */
function ranInFullAlready(): boolean {
  const { GITHUB_SHA, GITHUB_REPOSITORY } = process.env
  if (!GITHUB_SHA || !GITHUB_REPOSITORY) return false
  const gh = (...args: string[]) =>
    execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    return gh(
      ...['run', 'list', '--repo', GITHUB_REPOSITORY, '--workflow', 'ci.yml'],
      ...['--commit', GITHUB_SHA, '--status', 'success', '--json', 'databaseId'],
      ...['--jq', '.[].databaseId'],
    )
      .split('\n')
      .filter(Boolean)
      .some((id) =>
        ranMacosInFull(
          gh(
            ...['api', `repos/${GITHUB_REPOSITORY}/actions/runs/${id}/artifacts?per_page=100`],
            ...['--jq', '.artifacts[] | select(.expired | not) | .name'],
          ).split('\n'),
        ),
      )
  } catch {
    return false
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
  const event = process.env.GITHUB_EVENT_NAME
  const { docs, release, macos, e2e, said } = plan({
    event,
    branch: process.env.GITHUB_HEAD_REF,
    changed,
    labels: labelsNow(),
    ranAlready: event === 'schedule' && ranInFullAlready(),
  })
  console.log(said)
  const output = process.env.GITHUB_OUTPUT
  if (output) {
    appendFileSync(
      output,
      `docs=${docs}\nrelease=${release}\nmacos=${macos ? 'full' : 'smoke'}\ne2e=${JSON.stringify({ include: e2e })}\n`,
    )
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${said}\n`)
  }
}

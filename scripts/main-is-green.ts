/**
 * A red main is a warning on every pull request, not a stop. A pull request's "CI passed" asks,
 * as it finishes, how CI's newest finished runs on main ended: a merge's, and the nightly run's
 * (the only run of main's with every test on every system, the browser's and linux-only.txt's
 * on macOS and Windows: so a red nightly is a red main too). While
 * either failed it says so as a warning: main's commit, the jobs that failed there, and where to
 * read them. It passes all the same; a pull request fails only for its own jobs.
 *
 * Everything but a pass is red, with one exception: a run somebody cancelled says nothing of the
 * code, and the newest before it is asked. A run whose job ran out of its time is not that,
 * though GitHub calls both "cancelled" (the job, what needs it, and the run alike; tried on a
 * branch, 2026-10-11): what tells them apart is the job's own annotation, "The job has exceeded
 * the maximum execution time", and a run with one is red. A hang on main must stop the line.
 *
 *   node scripts/main-is-green.ts     (GH_TOKEN, GITHUB_REPOSITORY)
 *
 * tests/web/ci-changes.spec.ts tries what it makes of main's runs.
 */
import { execFileSync } from 'node:child_process'

export interface Run {
  id: number
  sha: string
  conclusion: string | null
  url: string
  /** Of a cancelled run: whether a job of it ran out of its time (and wasn't cancelled by anyone). */
  ranOutOfTime?: boolean
}

/** What GitHub says of a job that ran out of its time, in its annotations. */
export const OUT_OF_TIME = 'exceeded the maximum execution time'

/** Whether a finished run says nothing of the code: somebody cancelled it. */
const saysNothing = (run: Run) => run.conclusion === 'cancelled' && !run.ranOutOfTime

/** The newest of main's finished runs (newest first) that says anything, if it didn't pass. */
export function redOf(runs: Run[]): Run | undefined {
  const newest = runs.find((run) => run.conclusion !== null && !saysNothing(run))
  return newest && newest.conclusion !== 'success' ? newest : undefined
}

/** Main's runs that count, by what starts them: each merge's, and the nightly one. */
export const MAIN_RUNS = [
  { event: 'push', what: 'main' },
  { event: 'schedule', what: 'main’s nightly run' },
] as const

/** What a pull request is told while main is red: `what` of main ran red (main, or its nightly run). */
export const sentence = (red: Run, failed: string[], what = 'main') =>
  `${what} is red at ${red.sha.slice(0, 7)} (${failed.join(', ') || `its run ended as ${red.conclusion}`}): a warning, not a stop. Check that this pull request isn’t why. ${red.url}`

/** What a pull request's "CI passed" says of main's newest runs: a warning while it's red, or nothing. */
export const warningOf = (runs: Run[], failed: string[], what = 'main'): string | undefined => {
  const red = redOf(runs)
  return red && sentence(red, failed, what)
}

/** Asks GitHub: `gh api <path> --jq <jq>`, its answer as text. */
export type Gh = (path: string, jq: string) => string

/**
 * What a pull request's "CI passed" says of main, asking GitHub with `gh`: a warning while main
 * is red, or that it's green. Never a failure: where GitHub doesn't answer (an outage, a limit),
 * that's a warning too, since it says nothing of the pull request either.
 */
export function told(gh: Gh, repository: string): string {
  try {
    const said = MAIN_RUNS.flatMap(({ event, what }) => {
      const warning = redIn(gh, repository, event, what)
      return warning ? [`::warning::${warning}`] : []
    })
    return said.length > 0 ? said.join('\n') : 'Main is green.'
  } catch (error) {
    // (Its first line: a workflow's command is one line.)
    const said = (error instanceof Error ? error.message : String(error)).split('\n')[0]
    return `::warning::Lumovi couldn’t read main’s runs: ${said}`
  }
}

/** What's said of main's newest finished runs that `event` started, while they're red; or nothing. */
function redIn(gh: Gh, repository: string, event: string, what: string): string | undefined {
  const runs = JSON.parse(
    gh(
      `repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=${event}&status=completed&per_page=20`,
      '[.workflow_runs[] | {id, sha: .head_sha, conclusion, url: .html_url}]',
    ),
  ) as Run[]
  const jobsOf = (run: Run, conclusion: string) =>
    JSON.parse(
      gh(
        `repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`,
        `[.jobs[] | select(.conclusion == "${conclusion}") | {id, name}]`,
      ),
    ) as { id: number; name: string }[]
  // A cancelled run: cancelled by somebody, or out of time? Asked of the newest runs only, down
  // to the first that says anything.
  let outOfTime: string[] = []
  for (const run of runs) {
    if (run.conclusion !== 'cancelled') break
    outOfTime = jobsOf(run, 'cancelled')
      .filter(({ id }) =>
        gh(`repos/${repository}/check-runs/${id}/annotations`, '.[].message').includes(OUT_OF_TIME),
      )
      .map(({ name }) => `${name} ran out of time`)
    run.ranOutOfTime = outOfTime.length > 0
    if (run.ranOutOfTime) break
  }
  const red = redOf(runs)
  if (!red) return undefined
  const failed = [
    ...outOfTime,
    // (Its own "CI passed" fails with whatever failed: that says nothing more.)
    ...jobsOf(red, 'failure')
      .map(({ name }) => name)
      .filter((name) => name !== 'CI passed'),
  ]
  return sentence(red, failed, what)
}

if (import.meta.main) {
  const gh: Gh = (path, jq) => execFileSync('gh', ['api', path, '--jq', jq], { encoding: 'utf8' })
  // (A warning, and never a failure: the pull request's own jobs are what it's judged by.)
  console.log(told(gh, process.env.GITHUB_REPOSITORY!))
}

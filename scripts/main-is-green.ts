/**
 * A red main stops every merge. A pull request's "CI passed" asks, as it finishes, how CI's
 * newest finished run on main ended, and fails while that one failed: with main's commit, the
 * job that failed there and where to read it. Once main is green again, running that one job
 * again passes it (seconds; .github/workflows/pull-request.yml can't know when, so someone
 * does: `gh run rerun <run> --failed`).
 *
 * The pull request that mends main carries the label `fixes-main` (and says how in its text):
 * it alone may merge while main is red.
 *
 * Everything but a pass is red, with one exception: a run somebody cancelled says nothing of the
 * code, and the newest before it is asked. A run whose job ran out of its time is not that,
 * though GitHub calls both "cancelled" (the job, what needs it, and the run alike; tried on a
 * branch, 2026-10-11): what tells them apart is the job's own annotation, "The job has exceeded
 * the maximum execution time", and a run with one is red. A hang on main must stop the line.
 *
 *   node scripts/main-is-green.ts     (GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER)
 *
 * tests/web/ci-changes.spec.ts tries what it makes of main's runs.
 */
import { execFileSync } from 'node:child_process'

/** The label of the pull request that mends a red main. */
export const FIXES_MAIN = 'fixes-main'

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

/** What a pull request is told while main is red. */
export const sentence = (red: Run, failed: string[]) =>
  `main is red at ${red.sha.slice(0, 7)} (${failed.join(', ') || `its run ended as ${red.conclusion}`}): nothing merges until it’s green again, or this pull request mends it and says so with the label ${FIXES_MAIN}. ${red.url}`

if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY!
  const gh = (path: string, jq: string) =>
    execFileSync('gh', ['api', path, '--jq', jq], { encoding: 'utf8' })
  const runs = JSON.parse(
    gh(
      `repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=20`,
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
  if (!red) {
    console.log('Main is green.')
    process.exit(0)
  }
  const failed = [
    ...outOfTime,
    // (Its own "CI passed" fails with whatever failed: that says nothing more.)
    ...jobsOf(red, 'failure')
      .map(({ name }) => name)
      .filter((name) => name !== 'CI passed'),
  ]
  const labels = process.env.PR_NUMBER
    ? gh(`repos/${repository}/issues/${process.env.PR_NUMBER}/labels`, '.[].name').split('\n')
    : []
  if (labels.includes(FIXES_MAIN)) {
    console.log(
      `Main is red at ${red.sha.slice(0, 7)}, and this pull request mends it (${FIXES_MAIN}).`,
    )
    process.exit(0)
  }
  console.error(`::error::${sentence(red, failed)}`)
  process.exit(1)
}

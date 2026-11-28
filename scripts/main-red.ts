/**
 * Whether main is red, said where it's seen: a GitHub issue labelled `main-red`, opened by the
 * first red run of main's (a merge's, the nightly one, or one by hand), commented on by each red
 * one after it with the jobs and tests that failed, and closed by the next green one. While a red
 * main was only a warning on pull requests (scripts/main-is-green.ts), it stood four weeks with no
 * one told: an issue is GitHub's own, mailed and listed.
 *
 * What passed only when tried again is said on the open `ci-flaky` issue, green run or red, so a
 * flake is counted where it's seen. A run somebody cancelled says nothing of the code, and is
 * left unsaid; one whose job ran out of its time is red (as main-is-green.ts judges it).
 *
 *   node scripts/main-red.ts   (GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT,
 *                               GITHUB_SHA, GITHUB_EVENT_NAME, GITHUB_SERVER_URL)
 *
 * tests/web/ci-changes.spec.ts tries what it says, and what it asks GitHub.
 */
import { execFileSync } from 'node:child_process'
import { OUT_OF_TIME } from './main-is-green.ts'

/** The labels of the two issues, and how they're named when there's none open. */
export const RED = { label: 'main-red', title: 'Main is red' } as const
export const FLAKY = {
  label: 'ci-flaky',
  title: 'Tests that passed only when tried again',
} as const

/** A job of this run, as GitHub lists it. */
export interface Job {
  id: number
  name: string
  conclusion: string | null
  html_url?: string
}

/** The jobs whose logs say which tests ran: those that run Playwright, where they ran. */
const ranTests = (job: Job) =>
  /^(E2E|Integration|Browsers|Package) \(/.test(job.name) &&
  (job.conclusion === 'success' || job.conclusion === 'failure')

/** A job log's line without the time GitHub puts in front of it. */
const untimed = (line: string) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '')

/**
 * The tests a job's log says failed (on every try), and those that passed only when tried again:
 * from Playwright's summary at its end, each as `[project] › path:line › title`, with `/` for a
 * path's separator whatever the system.
 */
export function testsOf(log: string): { failed: string[]; flaky: string[] } {
  const found = { failed: [] as string[], flaky: [] as string[] }
  let into: string[] | undefined
  for (const line of log.split('\n').map(untimed)) {
    const heading = /^ {2}\d+ (failed|flaky|skipped|passed|interrupted|did not run)\b/.exec(line)
    if (heading) {
      into =
        heading[1] === 'failed' ? found.failed : heading[1] === 'flaky' ? found.flaky : undefined
      continue
    }
    const test = /^ {4}\[([\w-]+)\] › (\S+?):(\d+):\d+ › (.+?)\s*─*\s*$/.exec(line)
    if (into && test) {
      const [, project, path, at, title] = test
      into.push(`[${project}] › ${path!.split('\\').join('/')}:${at} › ${title}`)
    } else if (line.trim() !== '') {
      into = undefined
    }
  }
  return found
}

/** What a run of main says, from its jobs' results: red, green, or nothing (somebody cancelled it). */
export function verdictOf(results: string[], ranOutOfTime: boolean): 'red' | 'green' | 'nothing' {
  if (results.includes('failure') || ranOutOfTime) return 'red'
  if (results.some((result) => result !== 'success' && result !== 'skipped')) return 'nothing'
  return 'green'
}

/** A run of main, as said on an issue. */
export interface Said {
  what: string
  sha: string
  url: string
  failedJobs: string[]
  failed: string[]
  flaky: string[]
  /** Where its coverage gate failed (coverageOf), if it did. */
  coverage?: string[]
}

/** How many of the files with what didn't run a failed gate names, the most first. */
const MOST_FILES = 10

/**
 * What the coverage gate's log says of a miss (scripts/check-coverage.ts): each file no test
 * loaded, each measure at or under the line, and the files with the most that didn't run, with
 * how much, the most first. So the fix starts where it fell. Nothing where it passed.
 */
export function coverageOf(log: string): string[] {
  const lines = log.split('\n').map(untimed)
  const unloaded = lines.filter((line) => / never loaded by any test$/.test(line))
  const low = lines.filter((line) =>
    /^ {2}(statements|branches|functions|lines): [\d.]+%, not more than /.test(line),
  )
  if (unloaded.length === 0 && low.length === 0) return []
  const notRun = new Map<string, number>()
  for (const line of lines) {
    const file = /^ {2}(?:statement|function|branch) +(\S+?):\d+ /.exec(line)?.[1]
    if (file) notRun.set(file, (notRun.get(file) ?? 0) + 1)
  }
  const most = [...notRun.entries()]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .slice(0, MOST_FILES)
    .map(([file, count]) => `${file}: ${count} not run`)
  return [...unloaded.map((line) => line.trim()), ...low.map((line) => line.trim()), ...most]
}

/** What a red run says on `main-red`: its commit, then each job and test that failed. */
export function redComment({ what, sha, url, failedJobs, failed, coverage = [] }: Said): string {
  return [
    `**${what} is red at ${sha.slice(0, 7)}:** ${url}`,
    '',
    ...failedJobs.map((job) => `- ${job}`),
    ...(failed.length > 0 ? ['', 'Failed on every try:', '', ...failed.map((t) => `- ${t}`)] : []),
    ...(coverage.length > 0
      ? ['', 'Coverage, where it fell:', '', ...coverage.map((line) => `- ${line}`)]
      : []),
  ].join('\n')
}

/** What a run says on `ci-flaky`: each test that passed only when tried again. */
export function flakyComment({ what, sha, url, flaky }: Said): string {
  return [
    `**${what} at ${sha.slice(0, 7)}**, passed only when tried again: ${url}`,
    '',
    ...flaky.map((t) => `- ${t}`),
  ].join('\n')
}

/** Asks GitHub's API: a method, a path, and the fields of a body to send, if any. */
export type Api = (method: string, path: string, body?: Record<string, unknown>) => unknown

/** The number of the open issue with `label`, if there's one. */
function openIssue(api: Api, repository: string, label: string): number | undefined {
  const issues = api('GET', `repos/${repository}/issues?labels=${label}&state=open&per_page=1`)
  return (issues as { number: number }[])[0]?.number
}

/**
 * How `head` stands to `base`, as GitHub compares them: `ahead` (after it), `identical`, `behind`
 * (before it), or `diverged`.
 */
const compared = (api: Api, repository: string, base: string, head: string) =>
  (api('GET', `repos/${repository}/compare/${base}...${head}`) as { status: string }).status

/** The issue's hidden note of the newest red commit it was told of (`RED_AT`). */
const RED_AT = /<!-- main-red at ([0-9a-f]{40}) -->/
const redAt = (sha: string) => `<!-- main-red at ${sha} -->`

/**
 * `text` said on the open issue with `label`, or on a new one of `title` where none is open (with
 * `note` at the end of its own text): what was done, and the issue.
 */
function sayOn(
  api: Api,
  repository: string,
  { label, title }: { label: string; title: string },
  text: string,
  note = '',
): { said: string; open: number; made: boolean } {
  const open = openIssue(api, repository, label)
  if (open !== undefined) {
    api('POST', `repos/${repository}/issues/${open}/comments`, { body: text })
    return { said: `said on #${open}`, open, made: false }
  }
  const made = api('POST', `repos/${repository}/issues`, {
    title,
    body: note ? `${text}\n\n${note}` : text,
    labels: [label],
  }) as {
    number: number
    labels?: { name: string }[]
  }
  // (GitHub drops a label it won't set, saying nothing: then no later run finds the issue.)
  const said = (made.labels ?? []).some(({ name }) => name === label)
    ? `opened #${made.number}`
    : `opened #${made.number}\n::warning::#${made.number} hasn’t the label ${label}: later runs won’t find it. Is the label there, and may this token set it?`
  return { said, open: made.number, made: true }
}

/**
 * What this run of main says, asked of GitHub and said there: red on `main-red` (opened where none
 * is), green closing it, and its flaky tests on `ci-flaky`. What was done, a line each.
 *
 * A red always says so, with its commit, whichever commit of main's it is; the issue keeps the
 * newest red commit it was told of, hidden in its text. Only a green run that ran everything
 * (`full`) closes it, and only of that commit or one after it: runs of two merges can end in
 * either order, and a run of an older commit, or one that ran less, can't speak for what the red
 * one found.
 */
export function tell(
  api: Api,
  {
    repository,
    run,
    attempt,
    sha,
    what,
    url,
  }: Record<'repository' | 'run' | 'attempt' | 'sha' | 'what' | 'url', string>,
  logOf: (job: Job) => string,
  full: boolean,
): string[] {
  const { jobs } = api(
    'GET',
    `repos/${repository}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`,
  ) as {
    jobs: Job[]
  }
  // (Its own job is still running, and "CI passed" says only what the others do.)
  const finished = jobs.filter((job) => job.conclusion !== null && job.name !== 'CI passed')
  const ranOutOfTime = finished
    .filter((job) => job.conclusion === 'cancelled')
    .some((job) =>
      (
        api('GET', `repos/${repository}/check-runs/${job.id}/annotations`) as { message: string }[]
      ).some(({ message }) => message.includes(OUT_OF_TIME)),
    )
  const verdict = verdictOf(
    finished.map((job) => job.conclusion!),
    ranOutOfTime,
  )
  const tests = finished.filter(ranTests).map((job) => testsOf(logOf(job)))
  const gate = finished.find(
    (job) => job.name === 'Coverage (all platforms)' && job.conclusion === 'failure',
  )
  const coverage = gate ? coverageOf(logOf(gate)) : []
  const said: Said = {
    what,
    sha,
    url,
    failedJobs: finished.filter((job) => job.conclusion === 'failure').map((job) => job.name),
    failed: tests.flatMap((each) => each.failed),
    flaky: tests.flatMap((each) => each.flaky),
    ...(coverage.length > 0 ? { coverage } : {}),
  }
  const done: string[] = []
  if (verdict === 'red') {
    const told = sayOn(api, repository, RED, redComment(said), redAt(sha))
    if (!told.made) {
      // (The newest red commit, kept in the issue's own text for the green that closes it: this
      // one, if it comes after the one kept. Runs end in either order, and an older commit's red
      // ending last mustn't put the issue back before a newer one's.)
      const { body } = api('GET', `repos/${repository}/issues/${told.open}`) as { body?: string }
      const text = body ?? ''
      const kept = RED_AT.exec(text)?.[1]
      if (kept === undefined) {
        api('PATCH', `repos/${repository}/issues/${told.open}`, {
          body: `${text}\n\n${redAt(sha)}`,
        })
      } else if (compared(api, repository, kept, sha) === 'ahead') {
        api('PATCH', `repos/${repository}/issues/${told.open}`, {
          body: text.replace(RED_AT, redAt(sha)),
        })
      }
    }
    done.push(`Red: ${told.said}`)
  } else if (verdict === 'green') {
    const open = openIssue(api, repository, RED.label)
    const { body } =
      open === undefined
        ? { body: undefined }
        : (api('GET', `repos/${repository}/issues/${open}`) as { body?: string })
    const red = RED_AT.exec(body ?? '')?.[1]
    // (Of the red commit, or after it.)
    const after =
      red !== undefined && ['identical', 'ahead'].includes(compared(api, repository, red, sha))
    if (open === undefined) {
      done.push('Green.')
    } else if (!full) {
      done.push(`Green, of what ran here only: #${open} left open for a run of everything.`)
    } else if (!after) {
      done.push(
        red === undefined
          ? `Green: #${open} names no red commit, so it’s left open.`
          : `Green, of a commit before #${open}’s newest red (${red.slice(0, 7)}): left open.`,
      )
    } else {
      api('POST', `repos/${repository}/issues/${open}/comments`, {
        body: `**Green again at ${sha.slice(0, 7)}:** ${url}`,
      })
      api('PATCH', `repos/${repository}/issues/${open}`, {
        state: 'closed',
        state_reason: 'completed',
      })
      done.push(`Green: closed #${open}`)
    }
  } else {
    done.push('Cancelled by somebody: nothing said.')
  }
  if (verdict !== 'nothing' && said.flaky.length > 0) {
    done.push(`Flaky: ${sayOn(api, repository, FLAKY, flakyComment(said)).said}`)
  }
  return done
}

/** What starts a run of main, as an issue names it. */
const WHAT: Record<string, string> = {
  push: 'Main',
  schedule: 'Main’s nightly run',
  workflow_dispatch: 'A run of main by hand',
}

if (import.meta.main) {
  const env = process.env
  const gh = (...args: string[]) =>
    execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const api: Api = (method, path, body) => {
    const answer = execFileSync(
      'gh',
      ['api', '--method', method, path, ...(body ? ['--input', '-'] : [])],
      {
        encoding: 'utf8',
        input: body ? JSON.stringify(body) : undefined,
        maxBuffer: 16 * 1024 * 1024,
      },
    )
    return answer.trim() === '' ? undefined : JSON.parse(answer)
  }
  const repository = env.GITHUB_REPOSITORY!
  const run = env.GITHUB_RUN_ID!
  const done = tell(
    api,
    {
      repository,
      run,
      attempt: env.GITHUB_RUN_ATTEMPT ?? '1',
      sha: env.GITHUB_SHA!,
      what: WHAT[env.GITHUB_EVENT_NAME ?? ''] ?? 'Main',
      url: `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository}/actions/runs/${run}`,
    },
    (job) => {
      try {
        return gh('api', `repos/${repository}/actions/jobs/${job.id}/logs`)
      } catch (error) {
        // (A log GitHub won't give says nothing of its tests: the job's own result still counts.)
        console.log(
          `::warning::${job.name}’s log couldn’t be read: ${String(error).split('\n')[0]}`,
        )
        return ''
      }
    },
    // (Whether this run ran everything: CI's own word, `macos=full` from "What changed".)
    env.FULL === 'true',
  )
  console.log(done.join('\n'))
}

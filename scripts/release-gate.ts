/**
 * Whether a commit may be released: a run of CI of that very commit ran everything, on every
 * system, and passed (LMV-405). A merge's run is only the smoke set and what the merge touches; a
 * release's pull request runs everything, of its own commit (its branch holds all of main, so
 * the merge it tests is that commit as main will have it), and that's the run that counts. So a
 * red run of everything, or none, never publishes: neither when CI's run on main starts the
 * release, nor when somebody starts it by hand. Nor while main is red: its `main-red` issue open
 * (scripts/main-red.ts), whatever this commit's own run said.
 *
 *   node scripts/release-gate.ts <commit>     (GH_TOKEN, GITHUB_REPOSITORY)
 *
 * tests/web/ci-changes.spec.ts tries what it takes.
 */
import { execFileSync } from 'node:child_process'
import { SHARDS } from './ci-changes.ts'

/** A run of CI, as GitHub lists it. */
export interface Run {
  id: number
  conclusion: string | null
  html_url: string
}

/**
 * The jobs a run of everything has, and must have passed: every shard of every system, the
 * integration tests, the other engines, and the coverage gate (which runs only in a full run).
 */
export const EVERYTHING = [
  ...Object.entries(SHARDS).flatMap(([os, shards]) =>
    Array.from({ length: shards }, (_, i) => `E2E (${os}, ${i + 1}/${shards})`),
  ),
  ...Array.from({ length: 6 }, (_, i) => `Integration (kind, ${i + 1}/6)`),
  'Browsers (Firefox, WebKit)',
  'Coverage (all platforms)',
  'CI passed',
]

/** Of a run's jobs (name and conclusion), the ones a run of everything needs that didn't pass. */
export function missing(jobs: { name: string; conclusion: string | null }[]): string[] {
  const passed = new Set(jobs.filter((job) => job.conclusion === 'success').map((job) => job.name))
  return EVERYTHING.filter((name) => !passed.has(name))
}

/** Asks GitHub: `gh api <path>`, its answer, read. */
export type Gh = (path: string) => unknown

/**
 * The run that lets `sha` be released, or why there's none: CI's passed runs of it, newest
 * first, until one ran everything.
 */
export function gate(gh: Gh, repository: string, sha: string): { run?: Run; why: string } {
  const red = (
    gh(`repos/${repository}/issues?labels=main-red&state=open&per_page=1`) as {
      number: number
    }[]
  )[0]
  if (red) {
    return {
      why: `Main is red (#${red.number}): a release waits until a run of everything of main is green, and closes it.`,
    }
  }
  const { workflow_runs: runs } = gh(
    `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=20`,
  ) as { workflow_runs: Run[] }
  const short = sha.slice(0, 7)
  for (const run of runs) {
    const { jobs } = gh(`repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`) as {
      jobs: { name: string; conclusion: string | null }[]
    }
    if (missing(jobs).length === 0) {
      return { run, why: `${short} ran everything, and passed: ${run.html_url}` }
    }
  }
  return {
    why:
      runs.length === 0
        ? `No run of CI of ${short} passed: a release’s pull request runs everything of its commit, and that run must pass.`
        : `No run of CI of ${short} that passed ran everything (${runs.length} passed with less): a release’s pull request’s must.`,
  }
}

if (import.meta.main) {
  const sha = process.argv[2]
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    console.error('Usage: node scripts/release-gate.ts <commit>')
    process.exit(1)
  }
  const gh: Gh = (path) =>
    JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
  const { run, why } = gate(gh, process.env.GITHUB_REPOSITORY!, sha)
  console.log(run ? why : `::error::${why}`)
  process.exit(run ? 0 : 1)
}

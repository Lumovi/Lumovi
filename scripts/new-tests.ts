/**
 * The tests a pull request adds, or retitles: each, as `--test-list` names it, for CI's "New
 * tests, 25 times" to run that often (LMV-405), so one a runner's timing could fail is seen to
 * before it's on main. Found by listing the tests at the merge commit and at main (its first
 * parent), never by reading the files: a test is new where its whole name is.
 *
 *   node scripts/new-tests.ts 2/3 > new.txt     (in a checkout of the merge, with its parent)
 *
 * The job runs in parts (`part/parts`), each a share of them; and with more of them than its time
 * holds (MOST_NEW, 25 times each), it says so and stops, never running out of time unsaid.
 *
 * tests/web/ci-changes.spec.ts tries what it keeps.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

interface Suite {
  title: string
  file: string
  specs?: { title: string; tests: { projectName: string }[] }[]
  suites?: Suite[]
}

/** Every test of a listing (`playwright test --list --reporter=json`), as `--test-list` names it. */
export function namesOf(listing: { suites: Suite[] }): string[] {
  const names: string[] = []
  const walk = (suite: Suite, titles: string[]) => {
    for (const spec of suite.specs ?? []) {
      for (const { projectName } of spec.tests) {
        const file = suite.file.split('\\').join('/')
        names.push(
          [projectName ? `[${projectName}]` : '', file, ...titles, spec.title]
            .filter(Boolean)
            .join(' › '),
        )
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title])
  }
  for (const file of listing.suites) walk(file, [])
  return names
}

/** How many new tests the job repeats at most, in all its parts: 25 times each in its time. */
export const MOST_NEW = 45

/**
 * Of `names`, part `part` of `parts` (every `parts`th, from the `part`th): or, where there are more
 * than `most`, none, and what's said instead (by the first part alone).
 */
export function share(
  names: string[],
  part: number,
  parts: number,
  most = MOST_NEW,
): { names: string[]; said?: string } {
  if (names.length > most) {
    return {
      names: [],
      ...(part === 1
        ? {
            said: `${names.length} tests are new or retitled: more than this job repeats in its time (${most}). Run them 25 times with Actions, Repeat a test, a few files at a time, and say so on the pull request.`,
          }
        : {}),
    }
  }
  return { names: names.filter((_, i) => i % parts === part - 1) }
}

/** What's in `now` and wasn't in `before`, in `now`'s order. */
export function added(now: string[], before: string[]): string[] {
  const was = new Set(before)
  return [...new Set(now)].filter((name) => !was.has(name))
}

/** The tests of the checkout at `dir`, listed by its own Playwright. */
function listed(dir: string): string[] {
  const out = mkdtempSync(join(tmpdir(), 'lumovi-new-tests-'))
  try {
    execFileSync(
      process.execPath,
      [join(dir, 'node_modules/@playwright/test/cli.js'), 'test', '--list', '--reporter=json'],
      {
        cwd: dir,
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: join(out, 'tests.json') },
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    )
    return namesOf(JSON.parse(readFileSync(join(out, 'tests.json'), 'utf8')))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const here = resolve('.')
  // Main as the merge has it, beside this checkout, with its packages: listed by its own config.
  const main = mkdtempSync(join(tmpdir(), 'lumovi-main-'))
  execFileSync('git', ['worktree', 'add', '--detach', main, 'HEAD^1'], { stdio: 'ignore' })
  try {
    symlinkSync(join(here, 'node_modules'), join(main, 'node_modules'))
    const found = added(listed(here), listed(main))
    const [part, parts] = (process.argv[2] ?? '1/1').split('/').map(Number) as [number, number]
    const { names, said } = share(found, part, parts)
    console.error(
      `${found.length} tests new or retitled; ${names.length} in part ${part}/${parts}.`,
    )
    if (said) {
      console.error(`::error::${said}`)
      process.exitCode = 1
    }
    console.log(names.join('\n'))
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', main], { stdio: 'ignore' })
  }
}

/**
 * What macOS alone reaches, for a run where macOS ran only its smoke set (scripts/ci-changes.ts:
 * a change that touches nothing macOS does differently). Such a run reaches less than one where
 * everything runs, though the change lost nothing: what only macOS reaches is what it reached on
 * main. So the coverage job (CI's "Coverage (all platforms)") borrows macOS's coverage from the
 * newest green run of CI on main, and the gate judges like with like.
 *
 * Coverage of a file that differs from main's is left out: its lines aren't main's, and this
 * run's Linux and Windows speak for it. What this can't see: a branch only macOS reaches, in a
 * file the change didn't touch, that the change stops being reached (through shared code, or by
 * taking away or weakening the test that reached it). Main's own run shows that, after. If main has nothing to borrow (a quiet month), it says
 * so, and what ran is judged as it is.
 *
 *   node scripts/borrow-coverage.ts        (GH_TOKEN, GITHUB_REPOSITORY; into .nyc_output/)
 *
 * tests/web/ci-changes.spec.ts tries what it keeps.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SHARDS } from './ci-changes.ts'

/** Coverage as istanbul keeps it: a file's, by its path. */
type Coverage = Record<string, unknown>

/** A path as a coverage file has it and as git has it: from the repository's top, with slashes. */
const plain = (path: string) => path.split('\\').join('/')

/** `coverage` without the files that changed: theirs is for other lines than these. */
export function withoutChanged(coverage: Coverage, changed: string[]): Coverage {
  const differs = new Set(changed.map(plain))
  return Object.fromEntries(Object.entries(coverage).filter(([path]) => !differs.has(plain(path))))
}

/**
 * What's borrowed of the files a run of main keeps (their texts): every shard's, without the
 * files that changed; or why none of it is. All or nothing: a part, or a file that isn't
 * coverage, would give a figure that's neither this run's nor main's.
 */
export function borrowedOf(
  texts: string[],
  changed: string[],
): { kept: Coverage[] } | { nothing: string } {
  if (texts.length !== SHARDS) {
    return {
      nothing: `${texts.length} of macOS’s ${SHARDS} coverage files are there, not all of them`,
    }
  }
  const kept: Coverage[] = []
  for (const text of texts) {
    let coverage: unknown
    try {
      coverage = JSON.parse(text)
    } catch {
      return { nothing: 'one of its files isn’t JSON' }
    }
    if (typeof coverage !== 'object' || coverage === null || Array.isArray(coverage)) {
      return { nothing: 'one of its files isn’t coverage' }
    }
    kept.push(withoutChanged(coverage as Coverage, changed))
  }
  return { kept }
}

if (import.meta.main) {
  const repo = process.env.GITHUB_REPOSITORY!
  const gh = (...args: string[]) => execFileSync('gh', args, { encoding: 'utf8' })
  const nothing = (why: string): never => {
    console.log(`Nothing borrowed from main: ${why}. What ran here is judged as it is.`)
    process.exit(0)
  }
  let run: { databaseId: number; headSha: string } | undefined
  try {
    ;[run] = JSON.parse(
      gh(
        ...['run', 'list', '--repo', repo, '--workflow', 'ci.yml', '--branch', 'main'],
        ...['--event', 'push', '--status', 'success', '--limit', '1'],
        ...['--json', 'databaseId,headSha'],
      ),
    ) as { databaseId: number; headSha: string }[]
  } catch (error) {
    nothing(`its runs couldn’t be asked for (${(error as Error).message.split('\n')[0]})`)
  }
  if (!run) nothing('no green run of CI there')
  const borrowed = 'borrowed-coverage'
  rmSync(borrowed, { recursive: true, force: true })
  try {
    gh(
      ...['run', 'download', String(run!.databaseId), '--repo', repo],
      ...['--pattern', 'coverage-macOS-*', '--dir', borrowed],
    )
  } catch {
    nothing(`run ${run!.databaseId} keeps no macOS coverage any more`)
  }
  let changed: string[] = []
  let texts: string[] = []
  try {
    // What differs from that run's commit, here: fetched alone, to compare with.
    execFileSync('git', ['fetch', '--quiet', '--depth=1', 'origin', run!.headSha])
    changed = execFileSync('git', ['diff', '--name-only', '--no-renames', run!.headSha, 'HEAD'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
    texts = readdirSync(borrowed, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.json'))
      .map((name) => readFileSync(join(borrowed, name), 'utf8'))
  } catch (error) {
    nothing(`what run ${run!.databaseId} keeps couldn’t be used (${(error as Error).message})`)
  }
  const result = borrowedOf(texts, changed)
  if ('nothing' in result) nothing(`of run ${run!.databaseId}, ${result.nothing}`)
  const { kept } = result as { kept: Coverage[] }
  mkdirSync('.nyc_output', { recursive: true })
  kept.forEach((coverage, i) =>
    writeFileSync(join('.nyc_output', `main-${i}.json`), JSON.stringify(coverage)),
  )
  const files = kept.length
  console.log(
    `macOS ran its smoke set here: its coverage is borrowed from main (${run!.headSha.slice(0, 7)}, run ${run!.databaseId}, ${files} files), less the ${changed.length} files that differ from it.`,
  )
}

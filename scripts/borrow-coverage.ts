/**
 * What macOS alone reaches, for a run where macOS ran only its smoke set (scripts/ci-changes.ts:
 * a change that touches nothing macOS does differently). Such a run reaches less than one where
 * everything runs, though the change lost nothing: what only macOS reaches. So the coverage job
 * (CI's "Coverage (all platforms)") borrows exactly that from the newest green run of CI on
 * main: each statement, function and branch that main's macOS shards reached and main's Linux
 * and Windows shards did not. Everything else is measured by this run's own Linux and Windows,
 * so a test taken away or weakened here shows here, as lost coverage, unless what it reached was
 * reached on macOS alone.
 *
 * Coverage of a file that differs from main's is left out: its lines aren't main's, and this
 * run's Linux and Windows speak for it. What this still can't see: something only macOS reaches,
 * in a file the change didn't touch, that the change stops being reached. Main's own run shows
 * that, after the merge, and it is the run whose gate binds. If main has nothing to borrow (a
 * quiet month, a run with a shard's coverage missing), it says so, and what ran is judged as
 * it is.
 *
 *   node scripts/borrow-coverage.ts        (GH_TOKEN, GITHUB_REPOSITORY; into .nyc_output/)
 *
 * tests/web/ci-changes.spec.ts tries what it keeps.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SHARDS } from './ci-changes.ts'

/** A file's coverage as istanbul keeps it: its counters, beside the maps that say what each is. */
interface FileCoverage {
  s?: Record<string, number>
  f?: Record<string, number>
  b?: Record<string, number[]>
  [key: string]: unknown
}
/** Coverage as istanbul keeps it: a file's, by its path. */
type Coverage = Record<string, FileCoverage>

/** A path as a coverage file has it and as git has it: from the repository's top, with slashes. */
const plain = (path: string) => path.split('\\').join('/')

/** `coverage` without the files that changed: theirs is for other lines than these. */
export function withoutChanged(coverage: Coverage, changed: string[]): Coverage {
  const differs = new Set(changed.map(plain))
  return Object.fromEntries(Object.entries(coverage).filter(([path]) => !differs.has(plain(path))))
}

/** Every shard's counts for each file, added up (by the file's plain path). */
function summed(shards: Coverage[]): Coverage {
  const all: Coverage = {}
  for (const shard of shards) {
    for (const [path, file] of Object.entries(shard)) {
      const into = (all[plain(path)] ??= { ...file, s: {}, f: {}, b: {} })
      for (const [id, hits] of Object.entries(file.s ?? {})) into.s![id] = (into.s![id] ?? 0) + hits
      for (const [id, hits] of Object.entries(file.f ?? {})) into.f![id] = (into.f![id] ?? 0) + hits
      for (const [id, arms] of Object.entries(file.b ?? {})) {
        into.b![id] = arms.map((hits, i) => (into.b![id]?.[i] ?? 0) + hits)
      }
    }
  }
  return all
}

/**
 * What `mac` reached and `others` didn't: each of macOS's counts kept where the other platforms'
 * is zero (or they never loaded the file), and zero where they reached it too.
 */
export function onlyMac(mac: Coverage[], others: Coverage[]): Coverage {
  const theirs = summed(others)
  return Object.fromEntries(
    Object.entries(summed(mac)).map(([path, file]) => {
      const other = theirs[path]
      const alone = (hits: number, reached: number | undefined) => (reached ? 0 : hits)
      return [
        path,
        {
          ...file,
          s: Object.fromEntries(
            Object.entries(file.s!).map(([id, n]) => [id, alone(n, other?.s?.[id])]),
          ),
          f: Object.fromEntries(
            Object.entries(file.f!).map(([id, n]) => [id, alone(n, other?.f?.[id])]),
          ),
          b: Object.fromEntries(
            Object.entries(file.b!).map(([id, arms]) => [
              id,
              arms.map((n, i) => alone(n, other?.b?.[id]?.[i])),
            ]),
          ),
        },
      ]
    }),
  )
}

/**
 * What's borrowed of the files a run of main keeps (their texts): what macOS's shards reached
 * and the other platforms' didn't, without the files that changed; or why none of it is. All or
 * nothing: with a shard missing, of macOS's or of the others', "only macOS" can't be told, and
 * a part would give a figure that's neither this run's nor main's.
 */
export function borrowedOf(
  texts: { mac: string[]; others: string[] },
  changed: string[],
): { kept: Coverage } | { nothing: string } {
  if (texts.mac.length !== SHARDS) {
    return {
      nothing: `${texts.mac.length} of macOS’s ${SHARDS} coverage files are there, not all of them`,
    }
  }
  if (texts.others.length !== SHARDS * 2) {
    return {
      nothing: `${texts.others.length} of Linux’s and Windows’ ${SHARDS * 2} coverage files are there, not all of them`,
    }
  }
  const read = (list: string[]): Coverage[] | string => {
    const all: Coverage[] = []
    for (const text of list) {
      let coverage: unknown
      try {
        coverage = JSON.parse(text)
      } catch {
        return 'one of its files isn’t JSON'
      }
      if (typeof coverage !== 'object' || coverage === null || Array.isArray(coverage)) {
        return 'one of its files isn’t coverage'
      }
      all.push(coverage as Coverage)
    }
    return all
  }
  const mac = read(texts.mac)
  if (typeof mac === 'string') return { nothing: mac }
  const others = read(texts.others)
  if (typeof others === 'string') return { nothing: others }
  return { kept: withoutChanged(onlyMac(mac, others), changed) }
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
      ...['--pattern', 'coverage-macOS-*', '--pattern', 'coverage-Linux-*'],
      ...['--pattern', 'coverage-Windows-*', '--dir', borrowed],
    )
  } catch {
    nothing(`run ${run!.databaseId} keeps no coverage any more`)
  }
  let changed: string[] = []
  const texts = { mac: [] as string[], others: [] as string[] }
  try {
    // What differs from that run's commit, here: fetched alone, to compare with.
    execFileSync('git', ['fetch', '--quiet', '--depth=1', 'origin', run!.headSha])
    changed = execFileSync('git', ['diff', '--name-only', '--no-renames', run!.headSha, 'HEAD'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
    for (const name of readdirSync(borrowed, { recursive: true, encoding: 'utf8' })) {
      if (!name.endsWith('.json')) continue
      const text = readFileSync(join(borrowed, name), 'utf8')
      if (name.includes('coverage-macOS-')) texts.mac.push(text)
      else if (/coverage-(Linux|Windows)-/.test(name)) texts.others.push(text)
    }
  } catch (error) {
    nothing(`what run ${run!.databaseId} keeps couldn’t be used (${(error as Error).message})`)
  }
  const result = borrowedOf(texts, changed)
  if ('nothing' in result) nothing(`of run ${run!.databaseId}, ${result.nothing}`)
  const { kept } = result as { kept: Coverage }
  mkdirSync('.nyc_output', { recursive: true })
  writeFileSync(join('.nyc_output', 'main-macos-alone.json'), JSON.stringify(kept))
  const arms = Object.values(kept)
    .flatMap((file) => Object.values(file.b ?? {}).flat())
    .filter(Boolean).length
  console.log(
    `macOS ran its smoke set here: what only macOS reached on main is borrowed (${run!.headSha.slice(0, 7)}, run ${run!.databaseId}: ${arms} branch arms that its Linux and Windows shards didn’t reach), less the ${changed.length} files that differ from it. Everything else is this run’s own.`,
  )
}

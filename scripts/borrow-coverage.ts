/**
 * What macOS alone reaches, for a run where macOS ran only its smoke set (scripts/ci-changes.ts:
 * for now, every pull request and every merge of main, unless asked otherwise). Such a run
 * reaches less than one where everything runs, though the change lost nothing: what only macOS
 * reaches. So the coverage job (CI's "Coverage (all platforms)") borrows exactly that from the
 * newest green run of CI on main whose macOS ran in full (its nightly run, or one by hand): each
 * statement, function and branch that its macOS shards reached and its Linux and Windows shards
 * did not. Everything else is measured by this run's own Linux and Windows,
 * so a test taken away or weakened here shows here, as lost coverage, unless what it reached was
 * reached on macOS alone.
 *
 * A pull request whose changes are alike on every system runs Linux alone (no Windows, no macOS:
 * CI's "What changed" says `windows=none`, in WINDOWS). There, what main's macOS and Windows
 * reached and its Linux didn't is borrowed alike, and this run's Linux is judged for the rest.
 *
 * Coverage of a file that differs from main's is left out: its lines aren't main's, and this
 * run's Linux and Windows speak for it. What this still can't see: something only macOS reaches,
 * in a file the change didn't touch, that the change stops being reached. Main's nightly run
 * shows that, and a red one is a red main. If main has nothing to borrow (no full run kept, a
 * run with a shard's coverage missing), it says so, and what ran is judged as it is.
 *
 *   node scripts/borrow-coverage.ts        (GH_TOKEN, GITHUB_REPOSITORY, WINDOWS; into .nyc_output/)
 *
 * tests/web/ci-changes.spec.ts tries what it keeps.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ranMacosInFull, SHARDS } from './ci-changes.ts'

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
 * What `borrowed` reached and `judging` didn't: each of the borrowed systems' counts kept where the
 * judging systems' is zero (or they never loaded the file), and zero where they reached it too.
 */
export function onlyIn(borrowed: Coverage[], judging: Coverage[]): Coverage {
  const theirs = summed(judging)
  return Object.fromEntries(
    Object.entries(summed(borrowed)).map(([path, file]) => {
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
 * How many coverage files of Linux's and of Windows' shards a run of main has: as many as its E2E
 * jobs' names (`E2E (ubuntu-latest, 2/14)`) say each was split into, which needn't be as many as
 * this run's (Linux's went from four to six to fourteen). Nothing where either has no such job.
 */
export function shardsIn(jobs: string[]): { linux: number; windows: number } | undefined {
  const of = (os: string) =>
    jobs.flatMap((name) => {
      const total = new RegExp(`^E2E \\(${os}, \\d+/(\\d+)\\)$`).exec(name)?.[1]
      return total ? [Number(total)] : []
    })
  const linux = of('ubuntu-latest')
  const windows = of('windows-latest')
  if (linux.length === 0 || windows.length === 0) return undefined
  return { linux: Math.max(...linux), windows: Math.max(...windows) }
}
/**
 * What's borrowed of the files a run of main keeps (their texts, by system): what macOS's shards
 * reached, and Windows' too where Windows didn't run here (`windowsRan`), that the systems that did
 * run here didn't reach there, without the files that changed; or why none of it is. All or
 * nothing: with a shard missing (`shards`: as many as that run's Linux and Windows had, shardsIn),
 * "only theirs" can't be told, and a part would give a figure that's neither this run's nor
 * main's.
 */
export function borrowedOf(
  texts: { mac: string[]; linux: string[]; windows: string[] },
  changed: string[],
  shards: { linux: number; windows: number },
  windowsRan = true,
): { kept: Coverage } | { nothing: string } {
  const macShards = SHARDS['macos-latest']
  for (const [name, have, want] of [
    ['macOS’s', texts.mac.length, macShards],
    ['Linux’s', texts.linux.length, shards.linux],
    ['Windows’', texts.windows.length, shards.windows],
  ] as const) {
    if (have !== want) {
      return { nothing: `${have} of ${name} ${want} coverage files are there, not all of them` }
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
  const linux = read(texts.linux)
  if (typeof linux === 'string') return { nothing: linux }
  const windows = read(texts.windows)
  if (typeof windows === 'string') return { nothing: windows }
  const borrowed = windowsRan ? mac : [...mac, ...windows]
  const judging = windowsRan ? [...linux, ...windows] : linux
  return { kept: withoutChanged(onlyIn(borrowed, judging), changed) }
}

if (import.meta.main) {
  const repo = process.env.GITHUB_REPOSITORY!
  const gh = (...args: string[]) => execFileSync('gh', args, { encoding: 'utf8' })
  const nothing = (why: string): never => {
    console.log(`Nothing borrowed from main: ${why}. What ran here is judged as it is.`)
    process.exit(0)
  }
  // Main's newest green run whose macOS ran in full, whatever started it (for now, its
  // nightly one or one by hand; a merge's runs macOS's smoke set), and whose coverage is kept.
  let run: { databaseId: number; headSha: string } | undefined
  // (And how many of Linux's and Windows' shards it had, by its jobs.)
  let shards: { linux: number; windows: number } | undefined
  try {
    const runs = JSON.parse(
      gh(
        ...['run', 'list', '--repo', repo, '--workflow', 'ci.yml', '--branch', 'main'],
        ...['--status', 'success', '--limit', '30', '--json', 'databaseId,headSha'],
      ),
    ) as { databaseId: number; headSha: string }[]
    run = runs.find(({ databaseId }) =>
      ranMacosInFull(
        gh(
          ...['api', `repos/${repo}/actions/runs/${databaseId}/artifacts?per_page=100`],
          ...['--jq', '.artifacts[] | select(.expired | not) | .name'],
        ).split('\n'),
      ),
    )
    if (run) {
      shards = shardsIn(
        gh(
          ...['run', 'view', String(run.databaseId), '--repo', repo],
          ...['--json', 'jobs', '--jq', '.jobs[].name'],
        ).split('\n'),
      )
    }
  } catch (error) {
    nothing(`its runs couldn’t be asked for (${(error as Error).message.split('\n')[0]})`)
  }
  if (!run) nothing('no green run of CI there whose macOS ran in full, and whose coverage is kept')
  if (shards === undefined)
    nothing(`run ${run!.databaseId}’s jobs don’t say how its Linux and Windows were split`)
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
  const texts = { mac: [] as string[], linux: [] as string[], windows: [] as string[] }
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
      else if (name.includes('coverage-Linux-')) texts.linux.push(text)
      else if (name.includes('coverage-Windows-')) texts.windows.push(text)
    }
  } catch (error) {
    nothing(`what run ${run!.databaseId} keeps couldn’t be used (${(error as Error).message})`)
  }
  // Whether Windows ran here (CI's "What changed": `windows`); as a plan that says nothing of it,
  // it did.
  const windowsRan = process.env.WINDOWS !== 'none'
  const result = borrowedOf(texts, changed, shards!, windowsRan)
  if ('nothing' in result) nothing(`of run ${run!.databaseId}, ${result.nothing}`)
  const { kept } = result as { kept: Coverage }
  mkdirSync('.nyc_output', { recursive: true })
  writeFileSync(join('.nyc_output', 'main-borrowed.json'), JSON.stringify(kept))
  const arms = Object.values(kept)
    .flatMap((file) => Object.values(file.b ?? {}).flat())
    .filter(Boolean).length
  const what = windowsRan ? 'macOS' : 'macOS and Windows'
  console.log(
    `${windowsRan ? 'macOS ran its smoke set here' : 'Linux alone ran here'}: what only ${what} reached on main is borrowed (${run!.headSha.slice(0, 7)}, run ${run!.databaseId}: ${arms} branch arms that its ${windowsRan ? 'Linux and Windows' : 'Linux'} shards didn’t reach), less the ${changed.length} files that differ from it. Everything else is this run’s own.`,
  )
}

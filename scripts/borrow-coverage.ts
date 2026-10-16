/**
 * What macOS alone reaches, for a run where macOS ran only its smoke set (scripts/ci-changes.ts:
 * for now, every pull request and every merge of main, unless asked otherwise). Such a run
 * reaches less than one where everything runs, though the change lost nothing: what only macOS
 * reaches. So the coverage job (CI's "Coverage (all platforms)") borrows exactly that from the
 * newest green run of CI on main whose macOS ran in full (its nightly run, or one by hand): each
 * statement, function and branch that its macOS shards reached and its Linux and Windows shards
 * did not. Everything else is measured by this run's own systems, so a test taken away or
 * weakened here shows here, as lost coverage, unless what it reached was reached on macOS alone
 * (or, where Linux alone ran, on macOS or Windows alone).
 *
 * A pull request whose changes are alike on every system runs Linux alone (no Windows, no macOS:
 * CI's "What changed" says `windows=none`, in WINDOWS). There, what main's macOS and Windows
 * reached and its Linux didn't is borrowed alike, and this run's Linux is judged for the rest:
 * from main's newest green run whose macOS ran in full where one is kept, else from its newest
 * merge's (whose macOS ran its smoke set), so that a Linux-only pull request has something to
 * borrow every day, not only after a full macOS run (pick).
 *
 * Coverage of a file that differs from main's is left out: its lines aren't main's, and this
 * run's own systems speak for it. What this still can't see: something only macOS reaches (or,
 * where Linux alone ran, only macOS or Windows), in a file the change didn't touch, that the
 * change stops being reached. Main's nightly run shows that, and a red one is a red main. If
 * main has nothing to borrow (no full run kept, a run with a shard's coverage missing), it says
 * so, and what ran is judged as it is.
 *
 *   node scripts/borrow-coverage.ts    (GH_TOKEN, GITHUB_REPOSITORY, WINDOWS; into .nyc_output/)
 *
 * tests/web/ci-changes.spec.ts tries what it keeps.
 */
import { execFile, execFileSync } from 'node:child_process'
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
 * this run's (Linux's went from four to six to fourteen to sixteen). Nothing where either has no such job.
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
 * What starts one of main's own runs: a merge, the nightly run, a run by hand. Never a pull
 * request: one from a fork's own `main` branch is listed as main's too, and its coverage files are
 * written by its own code, so they could say anything was reached.
 */
export const MAINS_OWN = ['push', 'schedule', 'workflow_dispatch'] as const

/** Of runs listed as main's, those main started itself (MAINS_OWN): what may be borrowed from. */
export const mainsOwn = <T extends { event: string }>(runs: T[]): T[] =>
  runs.filter(({ event }) => (MAINS_OWN as readonly string[]).includes(event))

/**
 * How `sha` is fetched to compare with: alone (`--depth=1`) only where the clone is shallow
 * already, as CI's checkout is. A full clone (a person's, run by hand) is never made shallow.
 */
export const fetchOf = (sha: string, shallow: boolean): string[] => [
  'fetch',
  '--quiet',
  ...(shallow ? ['--depth=1'] : []),
  'origin',
  sha,
]

/** How many of each system's coverage files a run of main has kept, and whether macOS's are whole. */
export interface Fit {
  linux: number
  windows: number
  mac: number
  full: boolean
}

/**
 * Whether a run of main can be borrowed from, and from how many of each system's coverage files:
 * every one of Linux's and Windows' shards kept (as its jobs say it was split: shardsIn), and
 * macOS's, every shard or its smoke set's one file. Nothing where any of them is missing.
 */
export function fitOf(names: string[], jobs: string[]): Fit | undefined {
  const shards = shardsIn(jobs)
  if (!shards) return undefined
  const all = (system: string, count: number) =>
    Array.from({ length: count }, (_, i) => `coverage-${system}-${i + 1}`).every((name) =>
      names.includes(name),
    )
  if (!all('Linux', shards.linux) || !all('Windows', shards.windows)) return undefined
  if (ranMacosInFull(names)) return { ...shards, mac: SHARDS['macos-latest'], full: true }
  if (names.includes('coverage-macOS-smoke')) return { ...shards, mac: 1, full: false }
  return undefined
}

/**
 * Which of main's runs (newest first) is borrowed from. Where macOS ran its smoke set here, the
 * newest whose macOS ran in full: what only macOS reaches is what its full suite reaches. Where
 * Linux alone ran, the newest whose macOS ran in full too, if one is kept; else the newest whose
 * Windows and macOS ran as main's merges run them (macOS's smoke set), which every merge has.
 * Never a run with a file missing; none, where no run fits.
 */
export function pick<T>(
  runs: { run: T; fit: Fit | undefined }[],
  windowsRan: boolean,
): { run: T; fit: Fit } | undefined {
  const fitting = runs.flatMap(({ run, fit }) => (fit ? [{ run, fit }] : []))
  return fitting.find(({ fit }) => fit.full) ?? (windowsRan ? undefined : fitting[0])
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
  shards: { linux: number; windows: number; mac?: number },
  windowsRan = true,
): { kept: Coverage } | { nothing: string } {
  // (macOS's every shard, or its smoke set's one file: as the run borrowed from ran it.)
  const macShards = shards.mac ?? SHARDS['macos-latest']
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

/**
 * What `each` makes of every item, in the items' order: `atOnce` of them asked at a time, each
 * next one as one's done. (Main's runs are judged so: one by one, two asks each, took two minutes
 * of a pull request's Coverage.)
 */
export async function inTurns<T, R>(
  items: readonly T[],
  atOnce: number,
  each: (item: T) => Promise<R>,
): Promise<R[]> {
  const made: R[] = new Array(items.length)
  let next = 0
  const turn = async () => {
    while (next < items.length) {
      const at = next++
      made[at] = await each(items[at]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, turn))
  return made
}

/** How many of main's runs are asked about at once. */
const RUNS_AT_ONCE = 10

/**
 * Each of main's runs judged (`ask`: its artifacts' names and its jobs' names), in their order. A
 * run whose asks fail is left out of the choice, and said (`skipped`), never the reason none is
 * borrowed: one run that didn't answer (as one did on 2026-10-16) mustn't cost every other.
 */
export async function judgeRuns<T>(
  runs: readonly T[],
  ask: (run: T) => Promise<{ names: string[]; jobs: string[] }>,
): Promise<{ judged: { run: T; fit: Fit | undefined }[]; skipped: { run: T; why: string }[] }> {
  const skipped: { run: T; why: string }[] = []
  const judged = await inTurns(runs, RUNS_AT_ONCE, async (run) => {
    try {
      const { names, jobs } = await ask(run)
      return { run, fit: fitOf(names, jobs) }
    } catch (error) {
      skipped.push({ run, why: (error as Error).message.split('\n')[0]! })
      return { run, fit: undefined }
    }
  })
  return { judged, skipped }
}

if (import.meta.main) {
  const repo = process.env.GITHUB_REPOSITORY!
  const gh = (...args: string[]) => execFileSync('gh', args, { encoding: 'utf8' })
  const ghLater = (...args: string[]) =>
    new Promise<string>((resolve, reject) =>
      execFile('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, said) =>
        error ? reject(error) : resolve(said),
      ),
    )
  const nothing = (why: string): never => {
    console.log(`Nothing borrowed from main: ${why}. What ran here is judged as it is.`)
    process.exit(0)
  }
  // Whether Windows ran here (CI's "What changed": `windows`); as a plan that says nothing of it,
  // it did.
  const windowsRan = process.env.WINDOWS !== 'none'
  // Main's newest green run of its own (mainsOwn) that fits (pick), and whose coverage is kept.
  let chosen: { run: { databaseId: number; headSha: string; event: string }; fit: Fit } | undefined
  try {
    const runs = JSON.parse(
      gh(
        ...['run', 'list', '--repo', repo, '--workflow', 'ci.yml', '--branch', 'main'],
        ...['--status', 'success', '--limit', '30', '--json', 'databaseId,headSha,event'],
      ),
    ) as { databaseId: number; headSha: string; event: string }[]
    const { judged, skipped } = await judgeRuns(mainsOwn(runs), async (run) => {
      const [names, jobs] = await Promise.all([
        ghLater(
          ...['api', `repos/${repo}/actions/runs/${run.databaseId}/artifacts?per_page=100`],
          ...['--jq', '.artifacts[] | select(.expired | not) | .name'],
        ),
        ghLater(
          ...['run', 'view', String(run.databaseId), '--repo', repo],
          ...['--json', 'jobs', '--jq', '.jobs[].name'],
        ),
      ])
      return { names: names.split('\n'), jobs: jobs.split('\n') }
    })
    for (const { run, why } of skipped) {
      console.log(`Run ${run.databaseId} of main didn’t answer, so it isn’t borrowed from: ${why}`)
    }
    chosen = pick(judged, windowsRan)
  } catch (error) {
    nothing(`its runs couldn’t be asked for (${(error as Error).message.split('\n')[0]})`)
  }
  if (!chosen) {
    nothing(
      windowsRan
        ? 'no green run of CI there whose macOS ran in full, and whose coverage is kept whole'
        : 'no green run of CI there whose Linux, Windows and macOS coverage is kept whole',
    )
  }
  const { run, fit: shards } = chosen!
  const borrowed = 'borrowed-coverage'
  rmSync(borrowed, { recursive: true, force: true })
  try {
    gh(
      ...['run', 'download', String(run.databaseId), '--repo', repo],
      ...['--pattern', 'coverage-macOS-*', '--pattern', 'coverage-Linux-*'],
      ...['--pattern', 'coverage-Windows-*', '--dir', borrowed],
    )
  } catch {
    nothing(`run ${run.databaseId} keeps no coverage any more`)
  }
  let changed: string[] = []
  const texts = { mac: [] as string[], linux: [] as string[], windows: [] as string[] }
  try {
    // What differs from that run's commit, here: fetched to compare with (fetchOf).
    const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      encoding: 'utf8',
    }).trim()
    execFileSync('git', fetchOf(run.headSha, shallow === 'true'))
    changed = execFileSync('git', ['diff', '--name-only', '--no-renames', run.headSha, 'HEAD'], {
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
    nothing(`what run ${run.databaseId} keeps couldn’t be used (${(error as Error).message})`)
  }
  const result = borrowedOf(texts, changed, shards, windowsRan)
  if ('nothing' in result) nothing(`of run ${run.databaseId}, ${result.nothing}`)
  const { kept } = result as { kept: Coverage }
  mkdirSync('.nyc_output', { recursive: true })
  writeFileSync(join('.nyc_output', 'main-borrowed.json'), JSON.stringify(kept))
  const arms = Object.values(kept)
    .flatMap((file) => Object.values(file.b ?? {}).flat())
    .filter(Boolean).length
  const what = windowsRan ? 'macOS' : 'macOS and Windows'
  console.log(
    `${windowsRan ? 'macOS ran its smoke set here' : 'Linux alone ran here'}: what only ${what} reached on main is borrowed (${run.headSha.slice(0, 7)}, run ${run.databaseId}${shards.full ? '' : ', macOS’s smoke set'}: ${arms} branch arms that its ${windowsRan ? 'Linux and Windows' : 'Linux'} shards didn’t reach), less the ${changed.length} files that differ from it. Everything else is this run’s own.`,
  )
}

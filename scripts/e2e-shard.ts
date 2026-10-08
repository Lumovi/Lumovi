/**
 * Which tests a CI shard runs: all of them, split over the shards so that each takes about as
 * long, by how long each took last time on this platform (tests/durations.json; a test without
 * a time counts as a typical one). Playwright's own --shard splits them by count, and a few long
 * tests made one shard take twice as long as another. Prints what `playwright test --test-list`
 * takes, and says how it split them.
 *
 *   node scripts/e2e-shard.ts 2/4 > shard.txt
 *   node scripts/e2e-shard.ts 1/2 playwright.integration.config.ts > shard.txt
 *
 * Where a config's tests don't all run in parallel (the integration tests share one cluster), a
 * file's tests stay together, in their shard, in their order.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface Spec {
  title: string
  tests: { projectName: string }[]
}
interface Suite {
  title: string
  file: string
  specs?: Spec[]
  suites?: Suite[]
}
interface Listed {
  config: { fullyParallel?: boolean; projects?: { name: string; fullyParallel?: boolean }[] }
  suites: Suite[]
}

const [current, total] = (process.argv[2] ?? '').split('/').map(Number)
const config = process.argv[3]
if (!current || !total || current > total) {
  console.error('Usage: node scripts/e2e-shard.ts <shard>/<shards> [config]')
  process.exit(1)
}

/**
 * Every test, as `--test-list` names it: `[project] › file › describe › title`. Listed to a file
 * (what's printed can have more in it: a download's progress, on CI).
 */
const cli = createRequire(import.meta.url).resolve('@playwright/test/cli')
const listing = mkdtempSync(join(tmpdir(), 'lumovi-shard-'))
execFileSync(
  process.execPath,
  [cli, 'test', '--list', '--reporter=json', ...(config ? ['-c', config] : [])],
  {
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: join(listing, 'tests.json') },
    stdio: ['ignore', 'ignore', 'inherit'],
  },
)
const listed = JSON.parse(readFileSync(join(listing, 'tests.json'), 'utf8')) as Listed
rmSync(listing, { recursive: true, force: true })
const parallel = new Map(
  (listed.config.projects ?? []).map((project) => [
    project.name,
    project.fullyParallel ?? listed.config.fullyParallel ?? false,
  ]),
)

interface Test {
  name: string
  /** What it runs with: itself, or its file where a file's tests run in order. */
  group: string
}
const tests: Test[] = []
function walk(suite: Suite, titles: string[]): void {
  for (const spec of suite.specs ?? []) {
    for (const { projectName } of spec.tests) {
      const file = suite.file.split('\\').join('/')
      const name = [projectName ? `[${projectName}]` : '', file, ...titles, spec.title]
        .filter(Boolean)
        .join(' › ')
      const group = parallel.get(projectName) ? name : `${projectName} ${file}`
      tests.push({ name, group })
    }
  }
  for (const child of suite.suites ?? []) walk(child, [...titles, child.title])
}
for (const file of listed.suites) walk(file, [])

/** How long each took last time on this platform, in seconds. */
const recorded =
  (
    JSON.parse(readFileSync('tests/durations.json', 'utf8')) as Record<
      string,
      Record<string, number>
    >
  )[process.platform] ?? {}
const known = tests.map((test) => recorded[test.name]).filter((seconds) => seconds !== undefined)
const typical = known.length > 0 ? known.sort((a, b) => a - b)[Math.floor(known.length / 2)]! : 10

// A test whose name begins another's (a test "x", and a describe "x" with tests in it) is listed
// by that name, which runs both: they go together.
const names = tests.map((test) => test.name).sort()
for (const test of tests) {
  const prefix = names.find((name) => name !== test.name && test.name.startsWith(`${name} › `))
  if (prefix) test.group = tests.find((other) => other.name === prefix)!.group
}

// The groups, longest first, each to the shard that has the least so far.
const groups = new Map<string, { names: string[]; seconds: number }>()
for (const test of tests) {
  const group = groups.get(test.group) ?? { names: [], seconds: 0 }
  group.names.push(test.name)
  group.seconds += recorded[test.name] ?? typical
  groups.set(test.group, group)
}
const shards = Array.from({ length: total }, () => ({ names: [] as string[], seconds: 0 }))
const order = [...groups.entries()].sort(
  ([a, x], [b, y]) => y.seconds - x.seconds || (a < b ? -1 : 1),
)
for (const [, group] of order) {
  const least = shards.reduce((a, b) => (b.seconds < a.seconds ? b : a))
  least.names.push(...group.names)
  least.seconds += group.seconds
}

const mine = shards[current - 1]!
const minutes = (seconds: number) => Math.round(seconds / 6) / 10
console.error(
  `Shard ${current}/${total}: ${mine.names.length} of ${tests.length} tests, about ${minutes(mine.seconds)} minutes of them (the shards: ${shards.map((shard) => minutes(shard.seconds)).join(', ')}; ${tests.length - known.length} without a time counted as ${Math.round(typical)} s each).`,
)
console.log(mine.names.join('\n'))

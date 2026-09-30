/**
 * The coverage gate: every source file must be loaded by the e2e suite and
 * every statement, branch, function and line must run.
 *
 * Reads the raw coverage in `.nyc_output/` (from one or several test runs, e.g.
 * the Linux, macOS and Windows CI jobs) and exits non-zero on any gap, listing
 * exactly what was missed.
 */
import { globSync, readFileSync } from 'node:fs'
import libCoverage from 'istanbul-lib-coverage'

const map = libCoverage.createCoverageMap({})
const files = globSync('.nyc_output/**/*.json')
if (files.length === 0) {
  console.error('No coverage found in .nyc_output/. Run `npm run test:e2e` first.')
  process.exit(1)
}
for (const file of files) map.merge(JSON.parse(readFileSync(file, 'utf8')))

const problems: string[] = []
const sources = globSync('src/**/*.{ts,tsx}')
  .map((path) => path.split('\\').join('/'))
  .filter((path) => !path.endsWith('.d.ts'))
const covered = new Set(map.files())
for (const source of sources) {
  if (!covered.has(source)) problems.push(`${source}: never loaded by any test`)
}

for (const path of map.files().sort()) {
  const coverage = map.fileCoverageFor(path)
  const lines = readFileSync(path, 'utf8').split('\n')
  const at = (line: number) => `${path}:${line}  ${(lines[line - 1] ?? '').trim().slice(0, 100)}`
  for (const [id, hits] of Object.entries(coverage.s)) {
    if (!hits) problems.push(`statement  ${at(coverage.statementMap[id]!.start.line)}`)
  }
  for (const [id, hits] of Object.entries(coverage.f)) {
    if (!hits) problems.push(`function   ${at(coverage.fnMap[id]!.loc.start.line)}`)
  }
  for (const [id, counts] of Object.entries(coverage.b)) {
    const branch = coverage.branchMap[id]!
    counts.forEach((hits, i) => {
      if (!hits)
        problems.push(
          `branch     ${at((branch.locations[i] ?? branch.loc).start.line || branch.loc.start.line)}`,
        )
    })
  }
}

const summary = map.getCoverageSummary()
const pct = (key: 'statements' | 'branches' | 'functions' | 'lines') =>
  `${key} ${summary[key].pct}%`
console.log(
  `Coverage from ${files.length} files: ${['statements', 'branches', 'functions', 'lines'].map((k) => pct(k as never)).join(', ')}`,
)

if (problems.length > 0) {
  console.error(
    `\n${problems.length} gap(s):\n${[...new Set(problems)].map((p) => `  ${p}`).join('\n')}`,
  )
  process.exit(1)
}
console.log(`All ${sources.length} source files are fully covered.`)

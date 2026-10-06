/**
 * The coverage gate: every source file must be loaded by the e2e suite, and more
 * than 95% of statements, branches, functions and lines must run.
 *
 * Reads the raw coverage in `.nyc_output/` (from one or several test runs, e.g.
 * the Linux, macOS and Windows CI jobs), lists exactly what wasn't run, and exits
 * non-zero if a file was never loaded, or any measure is 95% or less.
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

/** More than this, of each measure, must run. */
const THRESHOLD = 95

const unloaded: string[] = []
const problems: string[] = []
const sources = globSync('src/**/*.{ts,tsx}')
  .map((path) => path.split('\\').join('/'))
  .filter((path) => !path.endsWith('.d.ts'))
const covered = new Set(map.files())
for (const source of sources) {
  if (!covered.has(source)) unloaded.push(`${source}: never loaded by any test`)
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
const MEASURES = ['statements', 'branches', 'functions', 'lines'] as const
console.log(
  `Coverage from ${files.length} files: ${MEASURES.map((k) => `${k} ${summary[k].pct}%`).join(', ')}`,
)

// What wasn't run, said: to find what a change left untested.
if (problems.length > 0) {
  console.log(
    `\n${problems.length} not run:\n${[...new Set(problems)].map((p) => `  ${p}`).join('\n')}`,
  )
}
const low = MEASURES.filter((k) => summary[k].pct <= THRESHOLD)
if (unloaded.length > 0 || low.length > 0) {
  console.error(
    [
      ...unloaded.map((p) => `  ${p}`),
      ...low.map((k) => `  ${k}: ${summary[k].pct}%, not more than ${THRESHOLD}%`),
    ].join('\n'),
  )
  process.exit(1)
}
console.log(
  `All ${sources.length} source files are loaded, and more than ${THRESHOLD}% of each measure runs.`,
)

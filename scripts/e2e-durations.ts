/**
 * How long each test took on CI, by platform, from a run's logs (the `list` reporter says it of
 * each test): tests/durations.json, which splits the tests over CI's shards (e2e-shard.ts). Run
 * it on a full run of main from time to time, as tests come and go:
 *
 *   npm run test:durations -- <run id>
 *
 * Needs the GitHub CLI, signed in.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const run = process.argv[2]
if (!run) {
  console.error('Usage: npm run test:durations -- <run id>')
  process.exit(1)
}
const gh = (...args: string[]) =>
  execFileSync('gh', [...args, '-R', 'Lumovi/Lumovi'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })

const PLATFORMS = { ubuntu: 'linux', macos: 'darwin', windows: 'win32' } as const
const jobs = (
  JSON.parse(gh('run', 'view', run, '--json', 'jobs')) as {
    jobs: { databaseId: number; name: string }[]
  }
).jobs.flatMap(({ databaseId, name }) => {
  // E2E (macos-latest, 2/4), and the integration tests', which run on Linux.
  const os = /^E2E \((\w+)-/.exec(name)?.[1] as keyof typeof PLATFORMS | undefined
  if (os && PLATFORMS[os]) return [{ id: databaseId, platform: PLATFORMS[os] }]
  if (name.startsWith('Integration')) return [{ id: databaseId, platform: 'linux' }]
  return []
})

/** A test's line: `✓  12 [desktop] › tests/e2e/x.spec.ts:10:1 › title (12.3s)` (`ok` on Windows). */
const LINE =
  /(?:✓|✘|ok|x)\s+\d+\s+(?:(\[[^\]]+\]) › )?(\S+?):\d+:\d+ › (.+?) \((\d+(?:\.\d+)?)(ms|s|m)\)\s*$/
const UNIT = { ms: 0.001, s: 1, m: 60 }

const durations = JSON.parse(readFileSync('tests/durations.json', 'utf8')) as Record<
  string,
  Record<string, number>
>
const found: Record<string, Record<string, number>> = {}
for (const { id, platform } of jobs) {
  const log = gh('run', 'view', run, '--log', '--job', String(id))
  for (const raw of log.split('\n')) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '')
    if (line.includes('(retry #')) continue
    const match = LINE.exec(line)
    if (!match) continue
    const [, project, file, title, amount, unit] = match
    const name = [project, file!.split('\\').join('/'), title].filter(Boolean).join(' › ')
    found[platform] ??= {}
    found[platform][name] = Math.round(Number(amount) * UNIT[unit as keyof typeof UNIT] * 10) / 10
  }
}
for (const [platform, tests] of Object.entries(found)) {
  durations[platform] = Object.fromEntries(
    Object.entries(tests).sort(([a], [b]) => (a < b ? -1 : 1)),
  )
  console.log(`${platform}: ${Object.keys(tests).length} tests`)
}
writeFileSync('tests/durations.json', `${JSON.stringify(durations, null, 2)}\n`)

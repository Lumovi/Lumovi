/**
 * What the Release workflow asks before it goes on, each a question of its own:
 *
 *   node scripts/release-starts.ts <version> <the version in the commit before, or nothing>
 *     Whether a release starts by itself from this commit (GITHUB_EVENT_NAME; prints why not,
 *     and writes `starts` to $GITHUB_OUTPUT).
 *   node scripts/release-starts.ts --newer <version> <released versions…>
 *     Fails, naming one, if a version already released is newer than this one.
 *   node scripts/release-starts.ts --whole <version> <true if a prerelease> <the draft's files…>
 *     Fails, naming them, if the draft lacks any file a release is made of.
 *
 * A release starts by itself from the commit that set the version: package.json's version has
 * no release yet, and differs from what it was in the commit before. A later commit that finds
 * the version still unreleased (the release's own run was cancelled, turned down or failed, and
 * something merged after it) starts nothing: under the same version it would offer a different
 * commit than the one that was prepared and checked. Releasing main as it is then is a
 * deliberate act: the workflow run by hand.
 *
 * tests/web/ci-changes.spec.ts tries each.
 */
import { appendFileSync } from 'node:fs'

/** Why a release doesn't start by itself here, if it doesn't. */
export function whyNot({
  event,
  version,
  before,
}: {
  event: string | undefined
  version: string
  /** The version in the commit before this one (none: there is no such commit, or no version). */
  before: string | undefined
}): string | undefined {
  if (event === 'workflow_dispatch') return undefined
  if (before !== version) return undefined
  return `v${version} has no release, and this commit isn’t the one that set the version: nothing is released from here by itself. To release main as it is now, run the Release workflow by hand.`
}

/** A version's numbers, and what follows a hyphen (a prerelease's name). */
const parts = (version: string): [number, number, number, string | undefined] => {
  const [core = '', pre] = version.split(/-(.*)/)
  const [major = 0, minor = 0, patch = 0] = core.split('.').map(Number)
  return [major, minor, patch, pre]
}
/** Below zero where `a` is the older: by its numbers, then a prerelease before its release. */
function compare(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)]
  for (const i of [0, 1, 2] as const) if (x[i] !== y[i]) return x[i] - y[i]
  if (x[3] === y[3]) return 0
  return !x[3] ? 1 : !y[3] ? -1 : x[3] < y[3] ? -1 : 1
}

/** A version already released that is newer than `version`, if there is one. */
export function newerThan(version: string, released: string[]): string | undefined {
  return released
    .filter((tag) => /^\d+\.\d+\.\d+(-.+)?$/.test(tag) && tag !== version)
    .find((tag) => compare(version, tag) < 0)
}

/**
 * The files a release is made of, by name: every installer the four builds make (macOS, both
 * architectures as one build; Windows; Linux on each architecture), the bill of materials,
 * and, for a release people's apps update to, what tells them there is one.
 */
export function filesOf(version: string, prerelease: boolean): string[] {
  const named = (rest: string) => `Lumovi-${version}${rest}`
  return [
    ...['-mac-arm64.dmg', '-mac-arm64.zip', '-mac-x64.dmg', '-mac-x64.zip'].map(named),
    named('-win.exe'),
    ...['-linux-x86_64.AppImage', '-linux-amd64.deb', '-linux-x86_64.rpm'].map(named),
    ...['-linux-arm64.AppImage', '-linux-arm64.deb', '-linux-aarch64.rpm'].map(named),
    named('.cdx.json'),
    ...(prerelease
      ? []
      : ['latest-mac.yml', 'latest.yml', 'latest-linux.yml', 'latest-linux-arm64.yml']),
  ]
}

/** Which of a release's files a draft lacks. */
export const missingFrom = (version: string, prerelease: boolean, draft: string[]) =>
  filesOf(version, prerelease).filter((file) => !draft.includes(file))

if (import.meta.main) {
  const [first = '', ...rest] = process.argv.slice(2)
  if (first === '--newer') {
    const [version = '', ...released] = rest
    const newer = newerThan(version, released)
    if (newer) {
      console.error(`::error::${version} is older than v${newer}, released already.`)
      process.exit(1)
    }
  } else if (first === '--whole') {
    const [version = '', prerelease, ...draft] = rest
    const missing = missingFrom(version, prerelease === 'true', draft)
    if (missing.length) {
      console.error(
        `::error::The draft of ${version} lacks ${missing.length} of the files a release is made of, so it isn’t published: ${missing.join(', ')}. (A build that was run again may have started the draft over: run them all again.)`,
      )
      process.exit(1)
    }
    console.log(`The draft of ${version} has every file a release is made of.`)
  } else {
    const [version, before] = [first, rest[0]]
    const why = whyNot({
      event: process.env.GITHUB_EVENT_NAME,
      version,
      before: before || undefined,
    })
    if (why) console.log(why)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `starts=${!why}\n`)
    if (why && process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${why}\n`)
    }
  }
}

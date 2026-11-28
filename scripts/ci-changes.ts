/**
 * What a CI run needs, from what started it and what a pull request changes (CI's "What changed"
 * job), for $GITHUB_OUTPUT (LMV-405):
 *
 * - `full`: everything, on every system, macOS and Windows in full, the browser's tests on each,
 *   the integration tests, the packages and the coverage gate. Main's nightly run, a run by hand,
 *   a release's pull request (`release-<version>`, whose run the release itself waits on), and a
 *   pull request whose label (`full-ci`) asks.
 * - Anything else (a pull request, a merge to main) runs less, and quickly: on Linux, the smoke
 *   set (tests/e2e/smoke.txt and tests/smoke.txt) and every spec file it changes, split over
 *   shards by how long they took (`files` and `shard` in `e2e`); the security set too
 *   (SECURITY_SET), with the box in every browser engine (`browsers`), where it changes what
 *   holds a plugin in; Windows' and macOS's smoke sets where it changes what differs by system
 *   (`platforms`), or macOS's desktop tests in full where its label (`macos-full`) asks; and the
 *   packages where it changes how they're made (`packages`).
 * - `docs`: a pull request that changes only docs (Markdown, docs/, images outside the app): no
 *   E2E, packaging or integration tests, and "CI passed" all the same.
 * - `release`: whether this is a release's own pull request, whose branch is named for its version
 *   (`release-1.22.0`): any other branch whose name starts the same is an ordinary one.
 * - `integration`: whether the integration tests run: in a full run.
 *
 * A red nightly is a red main, said on the `main-red` issue (scripts/main-red.ts), which only a
 * green full run closes.
 *
 *   node scripts/ci-changes.ts [changed files...]   (by default, HEAD's against its first parent)
 *
 * tests/web/ci-changes.spec.ts tries it on each kind of run.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'

const OSES = ['ubuntu-latest', 'macos-latest', 'windows-latest'] as const
/**
 * How many machines each platform's tests are split over: Linux's over more, since it runs the
 * browser's tests and the desktop tests alike on every system as well.
 */
export const SHARDS = {
  'ubuntu-latest': 16,
  'macos-latest': 4,
  'windows-latest': 4,
} as const satisfies Record<(typeof OSES)[number], number>

/** What only explains the app: Markdown, and images that aren't the app's (in docs/, say). */
const isDocs = (path: string) =>
  (path.endsWith('.md') && !/^(src|tests)\//.test(path)) ||
  (/\.(png|jpe?g|gif|webp|svg)$/i.test(path) && !/^(src|build|packaging|charts|tests)\//.test(path))

/**
 * What a change can be, and Linux alone run it in full for a pull request: the pages and what
 * they share with the rest (src/renderer, src/shared), the server's own (src/server, which runs
 * in the image, on Linux), the chart, the tests themselves of the desktop app, the browser, the
 * plugins and the clusters (their spec files: not the harness they run in, nor the mock
 * clusters), the tests' timings, entries and docs. What's left runs every
 * system: Electron's own process and what it runs (src/main, src/preload, and src/backend, whose
 * kubeconfig, credential plugins and helm are the desktop app's on each system), packaging, the
 * dependencies, CI and its scripts, the tests' harness, and any path not named here. So does a
 * file of these whose text asks which system it's on, or reaches for what differs by system
 * (namesASystem): a terminal's keys, a shortcut's symbol (MOD_KEY), a path's separator, a process
 * started, a test that waits longer on Windows.
 */
const ALIKE_ON_EVERY_SYSTEM = [
  /^src\/(renderer|shared|server)\//,
  /^charts\//,
  /^changelog\.d\//,
  /^tests\/(e2e|web|integration|plugins)\/.+\.spec\.tsx?$/,
  /^tests\/durations\.json$/,
]
export const alikeOnEverySystem = (path: string) =>
  isDocs(path) || ALIKE_ON_EVERY_SYSTEM.some((alike) => alike.test(path))
/**
 * A file's text that asks which system it's on (anything's `.platform`, a system's name, the
 * shortcut key that differs by it), or reaches for what differs by system (the home folder, a
 * path's separators, starting a process, Windows' own folders): run on every system, wherever it
 * is. (Not a program's `.exe`: in these files it's only ever a test's or a sample's text, and
 * Windows' own programs are started from src/main and src/backend, which run every system. Nor
 * `.platform` in a host's name, `deploy.platform.example.com`: a label with another after it.)
 */
export const NAMES_A_SYSTEM =
  /\.platform\b(?!\.[\w-]+\.)|userAgentData|\bMOD_KEY\b|\bisMac\b|\bisWindows\b|'(darwin|win32|linux)'|\bhomedir\b|\bdelimiter\b|\bsep\b|child_process|\bspawn\b|\bexecFile|USERPROFILE|APPDATA/

/**
 * Of the files changed, those whose text names a system (NAMES_A_SYSTEM): as each is now, or, for
 * one taken away, as it was (`textOf` gives a file's text, or nothing where there's none). A file
 * with no text to read, now or before, is taken to name one: what can't be read runs everything.
 */
export function namingASystem(
  changed: string[],
  textOf: (path: string, at: 'now' | 'before') => string | undefined,
): string[] {
  return changed.filter((path) => {
    const text = textOf(path, 'now') ?? textOf(path, 'before')
    return text === undefined || NAMES_A_SYSTEM.test(text)
  })
}

/** A release's own branch: `release-` and its version (`release-1.22.0`, `release-2.0.0-rc.1`). */
export const isRelease = (branch: string) =>
  /^release-\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(branch)

/** The label that asks for everything on macOS, whatever changed. */
export const MACOS_FULL = 'macos-full'

/** The label that asks for everything, on every system, as a release's pull request runs. */
export const FULL_CI = 'full-ci'

/**
 * The tests' harness, and what runs them: their fixtures, helpers and the files they read, the mock
 * clusters and other stand-ins, the Playwright configs and the script that splits them. A change to
 * it can break any test, so it runs everything, as the label full-ci asks. So does a change to the
 * integration tests, specs and cluster alike: they run only in a run of everything.
 */
const HARNESS = [
  /^tests\/integration\//,
  /^tests\/(e2e|web)\/(?![^/]+\.spec\.ts$)(?![^/]+\.txt$).+/,
  /^tests\/mock-[\w-]+\//,
  /^tests\/[^/]+\.ts$/,
  /^playwright[\w.-]*\.config\.ts$/,
  /^scripts\/e2e-shard\.ts$/,
]
export const isHarness = (path: string) => HARNESS.some((harness) => harness.test(path))

/** A spec file of the desktop app's tests or the browser's: what a change to one runs in full. */
const isSpec = (path: string) => /^tests\/(e2e|web)\/[^/]+\.spec\.ts$/.test(path)

/**
 * What decides how the app is packaged, or what it's packaged with: a change to it builds the
 * packages on every system, and tries each.
 */
const PACKAGING = [
  /^(build|packaging)\//,
  /^electron-builder\.yml$/,
  /^package(-lock)?\.json$/,
  /^\.nvmrc$/,
  /^scripts\/(after-pack|sbom|helm|node-pty)[\w-]*\.(ts|mjs)$/,
  /^\.github\/workflows\/ci\.yml$/,
]
export const isPackaging = (path: string) => PACKAGING.some((packaging) => packaging.test(path))

/** What a plugin gets out of its box (nothing), on the desktop and a server, and what a hostile one can ask. */
const BOX = [
  'tests/e2e/plugin-box.spec.ts',
  'tests/e2e/plugin-box-ways-out.spec.ts',
  'tests/e2e/plugin-hostile.spec.ts',
  'tests/e2e/plugin-hostile-own.spec.ts',
  'tests/e2e/plugin-hostile-store.spec.ts',
  'tests/web/plugin-box.spec.ts',
  'tests/web/plugin-box-apart.spec.ts',
  'tests/web/box-check.spec.ts',
  'tests/web/box-check-calls.spec.ts',
  'tests/web/plugin-hostile.spec.ts',
  'tests/web/plugin-hand-over.spec.ts',
  'tests/web/plugin-code-switch.spec.ts',
]
/** A Secret's values masked, and what a view withholds. */
const MASKED = [
  'tests/e2e/plugin-secret-page.spec.ts',
  'tests/e2e/secret-by-key.spec.ts',
  'tests/e2e/withheld.spec.ts',
  'tests/web/plugin-secret-page.spec.ts',
  'tests/web/plugin-secret.spec.ts',
  'tests/web/secret-by-key.spec.ts',
  'tests/web/withheld.spec.ts',
]
/** An object's YAML, a compare and Find: a Secret's values hidden until revealed, and never found. */
const SHOWN_MASKED = [
  'tests/e2e/details.spec.ts',
  'tests/e2e/find.spec.ts',
  'tests/e2e/compare.spec.ts',
  'tests/web/compare.spec.ts',
]
/** A server's own pages and their policy: what may frame them, and what they may load. */
const SERVER_PAGES = [
  'tests/web/server.spec.ts',
  'tests/web/plugin-box.spec.ts',
  'tests/web/box-check.spec.ts',
]
/** What the audit keeps. */
const AUDIT = ['tests/e2e/audit.spec.ts', 'tests/web/audit.spec.ts']
/** What an assistant may read and change, and what its approvals show. */
const ASSISTANT = [
  'tests/e2e/assistant-permissions.spec.ts',
  'tests/web/assistant-permissions.spec.ts',
  'tests/e2e/assistants.spec.ts',
  'tests/web/assistants.spec.ts',
]
/** A Helm release's review, its Secrets masked. */
const HELM_DIFF = ['tests/web/helm-diff.spec.ts', 'tests/e2e/helm.spec.ts']
/** On a server: who may do what. */
const ACCESS = ['tests/web/access.spec.ts', 'tests/e2e/access-control.spec.ts']
/** On a server: signing in, and its sessions. */
const SIGN_IN = ['tests/web/sign-in.spec.ts', 'tests/web/server.spec.ts', 'tests/web/oidc.spec.ts']
/** A fleet's hub and agents, with the secrets they join by. */
const FLEET = [
  'tests/web/fleet-add.spec.ts',
  'tests/web/fleet-agents.spec.ts',
  'tests/web/fleet-join-agent.spec.ts',
  'tests/web/fleet-refusals.spec.ts',
  'tests/web/fleet-sources.spec.ts',
]

/**
 * Where Lumovi holds a plugin in, and keeps what it shouldn't hand on, each with the specs that
 * guard it: the main process and its preload (all of them); a plugin's box and its door, on the
 * desktop and on a server (the box's check, and the plugin's code a server hands a browser); a
 * Secret's values masked and withheld, in a view, its YAML, a compare and a Helm release's review;
 * an assistant's reads and approvals; the audit; and on a server, its own pages' policy, who may
 * do what, signing in, sessions and the fleet's secrets. A pull request that
 * changes any of it runs those specs, and every browser engine, not waiting for the nightly run.
 * The one list of it (CONTRIBUTING.md points here): a new file that holds any of that is added
 * here, with its specs, by the pull request that makes it.
 */
export const SECURITY: readonly { paths: RegExp; specs: readonly string[] }[] = [
  {
    paths: /^src\/(main|preload)\//,
    specs: [
      ...BOX,
      ...MASKED,
      ...SHOWN_MASKED,
      ...AUDIT,
      ...ASSISTANT,
      ...HELM_DIFF,
      ...ACCESS,
      ...SIGN_IN,
      ...FLEET,
      ...SERVER_PAGES,
    ],
  },
  { paths: /^src\/renderer\/src\/plugins\//, specs: [...BOX, ...MASKED] },
  { paths: /^src\/(backend|shared|server)\/plugin[\w-]*\.ts$/, specs: [...BOX, ...MASKED] },
  { paths: /^src\/(shared|server)\/box-check\.ts$/, specs: BOX },
  { paths: /^src\/backend\/withholding\.ts$/, specs: MASKED },
  {
    paths: /^src\/backend\/mcp\/(present|access|tools|approvals)\.ts$/,
    specs: [...ASSISTANT, ...MASKED],
  },
  { paths: /^src\/renderer\/src\/lib\/helm-diff\.ts$/, specs: [...HELM_DIFF, ...MASKED] },
  {
    paths: /^src\/renderer\/src\/features\/(details\/YamlTab|compare\/ComparePage)\.tsx$/,
    specs: [...SHOWN_MASKED, ...MASKED],
  },
  { paths: /^src\/server\/(pages|app)\.ts$/, specs: SERVER_PAGES },
  { paths: /^src\/backend\/audit\//, specs: AUDIT },
  { paths: /^src\/server\/audit\.ts$/, specs: AUDIT },
  { paths: /^src\/server\/access\.ts$/, specs: ACCESS },
  { paths: /^src\/server\/(auth|sessions)\.ts$/, specs: SIGN_IN },
  { paths: /^src\/server\/fleet\/secrets\.ts$/, specs: FLEET },
]
export const touchesSecurity = (path: string) => SECURITY.some(({ paths }) => paths.test(path))

/** The specs that guard what `changed` touches of SECURITY, each once. */
export const securitySpecs = (changed: string[]): string[] => [
  ...new Set(
    SECURITY.filter(({ paths }) => changed.some((path) => paths.test(path))).flatMap(
      ({ specs }) => specs,
    ),
  ),
]

/** The security set: every spec any of SECURITY names. */
export const SECURITY_SET: readonly string[] = [...new Set(SECURITY.flatMap(({ specs }) => specs))]

/**
 * How many minutes of Linux's tests, one after another, a shard of a run of less than everything
 * is given at most: a machine runs four at once, so seven or eight minutes of it, and with its
 * build the run ends within about fifteen.
 */
export const SMOKE_SHARD_MINUTES = 30

/** What the run needs, from the event, the pull request's branch, labels and what it changes. */
export function plan({
  event,
  branch = '',
  changed,
  labels = [],
  namesASystem = [],
  smoke = [],
  minutes = () => 0,
}: {
  event: string | undefined
  branch?: string
  changed: string[]
  /** The pull request's labels. */
  labels?: string[]
  /** Of the files changed, those whose text asks which system it's on (NAMES_A_SYSTEM). */
  namesASystem?: string[]
  /** The smoke set's spec files (tests/e2e/smoke.txt and tests/smoke.txt). */
  smoke?: readonly string[]
  /** How many minutes the tests of these spec files took on Linux, one after another. */
  minutes?: (files: string[]) => number
}) {
  const pullRequest = event === 'pull_request'
  const release = pullRequest && isRelease(branch)
  const askedFull = pullRequest && labels.includes(FULL_CI)
  // Everything, on every system: the nightly run, a run by hand, a release's pull request, one
  // whose label asks, and a change to the tests' harness (a pull request's or a merge's). Any other
  // merge to main runs what a pull request does: the nightly run, and the release's own, are the
  // ones that run everything.
  const harness = changed.some(isHarness)
  const full =
    event === 'schedule' || event === 'workflow_dispatch' || release || askedFull || harness
  // Docs alone run no tests on a pull request.
  const docs = pullRequest && !full && changed.length > 0 && changed.every(isDocs)
  const askedMacos = pullRequest && labels.includes(MACOS_FULL)
  const security = full || changed.some(touchesSecurity)
  // Windows and macOS: everywhere a change isn't alike on every system (or asks which it's on).
  const platforms =
    full ||
    askedMacos ||
    changed.some((path) => !alikeOnEverySystem(path) || namesASystem.includes(path))
  const integration = full
  const browsers = security
  const packages = full || changed.some(isPackaging)
  // Less than everything: on Linux, the smoke set, every spec file the change touches, and the
  // security set where it touches what holds a plugin in; split so each shard has its share.
  const files = [
    ...new Set([...smoke, ...changed.filter(isSpec), ...(full ? [] : securitySpecs(changed))]),
  ]
  const smokeShards = Math.max(2, Math.ceil(minutes(files) / SMOKE_SHARD_MINUTES))
  const everything = (os: (typeof OSES)[number]) =>
    Array.from({ length: SHARDS[os] }, (_, i) => ({
      os,
      shard: `${i + 1}/${SHARDS[os]}`,
      part: String(i + 1),
      projects: 'desktop web',
      only: '',
      files: '',
    }))
  const e2e = full
    ? OSES.flatMap(everything)
    : [
        ...Array.from({ length: smokeShards }, (_, i) => ({
          os: 'ubuntu-latest',
          shard: `${i + 1}/${smokeShards}`,
          part: `smoke-${i + 1}`,
          projects: 'desktop web',
          only: '',
          files: files.join(' '),
        })),
        ...(platforms
          ? (['macos-latest', 'windows-latest'] as const).flatMap((os) =>
              os === 'macos-latest' && askedMacos
                ? Array.from({ length: SHARDS[os] }, (_, i) => ({
                    os,
                    shard: `${i + 1}/${SHARDS[os]}`,
                    part: String(i + 1),
                    projects: 'desktop',
                    only: '',
                    files: '',
                  }))
                : [{ os, shard: 'smoke', part: 'smoke', projects: 'desktop', only: '', files: '' }],
            )
          : []),
      ]
  const said = [
    event === 'schedule'
      ? 'Main’s nightly run: everything, on every system.'
      : event === 'workflow_dispatch'
        ? 'A run by hand: everything, on every system.'
        : release
          ? 'A release’s pull request: everything, on every system, of its own commit.'
          : askedFull
            ? `Everything, on every system, as its label asks (${FULL_CI}).`
            : harness
              ? 'Everything, on every system: it changes the tests’ harness, which any test can rest on.'
              : !pullRequest
                ? 'Main’s merge: the smoke set, what the merge touches, and where it asks, more (everything runs nightly).'
                : `${changed.length} ${changed.length === 1 ? 'file' : 'files'} changed.`,
    docs ? 'Docs only: no E2E, packaging or integration tests.' : '',
    !full && !docs
      ? `On Linux, the smoke set and every spec file it changes${security ? ', with the security set' : ''}, in ${smokeShards} shards.`
      : '',
    !full && !docs && platforms
      ? askedMacos
        ? `Windows' smoke set, and macOS's desktop tests in full, as its label asks (${MACOS_FULL}).`
        : 'Windows’ and macOS’s smoke sets: it changes what differs by system.'
      : '',
    !full && !docs && packages ? 'The packages, built and tried on every system.' : '',
    !full && !docs && browsers ? 'The box in Firefox and WebKit too.' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return { docs, release, full, platforms, integration, browsers, packages, e2e, said }
}

/**
 * The pull request's labels as they are now, asked of GitHub (PR_NUMBER, GH_TOKEN,
 * GITHUB_REPOSITORY): a run started again after a label was put on must see it, and the event
 * the run was started by still says what was so then. None where it can't be asked.
 */
function labelsNow(): string[] {
  const { PR_NUMBER, GITHUB_REPOSITORY } = process.env
  if (!PR_NUMBER || !GITHUB_REPOSITORY) return []
  try {
    return execFileSync(
      'gh',
      ['api', `repos/${GITHUB_REPOSITORY}/issues/${PR_NUMBER}/labels`, '--jq', '.[].name'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    )
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}

if (import.meta.main) {
  const changed =
    process.argv.length > 2
      ? process.argv.slice(2)
      : // A file moved is where it was and where it is: both count.
        execFileSync('git', ['diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD'], {
          encoding: 'utf8',
        })
          .split('\n')
          .filter(Boolean)
  const event = process.env.GITHUB_EVENT_NAME
  // (A file taken away is read as it was, in the commit this one is merged into.)
  const namesASystem = namingASystem(changed, (path, at) => {
    try {
      return at === 'now'
        ? readFileSync(path, 'utf8')
        : execFileSync('git', ['show', `HEAD^1:${path}`], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          })
    } catch {
      return undefined
    }
  })
  // The smoke set's files, and how long each file's tests took on Linux, one after another.
  const smoke = ['tests/e2e/smoke.txt', 'tests/smoke.txt'].flatMap((list) =>
    readFileSync(list, 'utf8')
      .split('\n')
      .map((line) => line.trim().replace(/^\[[\w-]+\] › /, ''))
      .filter((line) => line && !line.startsWith('#')),
  )
  const linux =
    (
      JSON.parse(readFileSync('tests/durations.json', 'utf8')) as Record<
        string,
        Record<string, number>
      >
    ).linux ?? {}
  const minutes = (files: string[]) =>
    Object.entries(linux)
      .filter(([name]) => files.includes(name.split(' › ')[1]!))
      .reduce((total, [, seconds]) => total + seconds, 0) / 60
  const { docs, release, full, platforms, integration, browsers, packages, e2e, said } = plan({
    event,
    branch: process.env.GITHUB_HEAD_REF,
    changed,
    labels: labelsNow(),
    namesASystem,
    smoke,
    minutes,
  })
  console.log(said)
  const output = process.env.GITHUB_OUTPUT
  if (output) {
    appendFileSync(
      output,
      [
        `docs=${docs}`,
        `release=${release}`,
        `full=${full}`,
        `platforms=${platforms}`,
        `integration=${integration}`,
        `browsers=${browsers}`,
        `packages=${packages}`,
        `e2e=${JSON.stringify({ include: e2e })}`,
        '',
      ].join('\n'),
    )
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${said}\n`)
  }
}

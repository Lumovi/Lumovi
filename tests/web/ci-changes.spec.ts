/**
 * What CI runs (scripts/ci-changes.ts): everything, on every system, nightly, by hand, for a
 * release's pull request and where its label asks; anything else, quickly, the smoke set and what
 * it changes, with the security set where it touches what holds a plugin in; nothing but the
 * checks for a pull request of docs. Each case with the files as a pull request would change them
 * (a file moved is both where it was and where it is). And what judges a run of main
 * (main-is-green.ts, main-red.ts), what's new of a pull request's tests (new-tests.ts), and what
 * a release waits on (release-starts.ts, release-gate.ts).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { expect, test } from '../temp-folders.ts'
import {
  FULL_CI,
  isHarness,
  isRelease,
  NAMES_A_SYSTEM,
  namingASystem,
  plan,
  SECURITY,
  SECURITY_SET,
  securitySpecs,
  SMOKE_SHARD_MINUTES,
  touchesSecurity,
} from '../../scripts/ci-changes.ts'
import { added, MOST_NEW, namesOf, share } from '../../scripts/new-tests.ts'
import { EVERYTHING, gate, missing } from '../../scripts/release-gate.ts'
import { redOf, sentence, told, warningOf, type Gh } from '../../scripts/main-is-green.ts'
import {
  coverageOf,
  errorsOf,
  flakyComment,
  redComment,
  tell,
  testsOf,
  verdictOf,
  type Api,
  type Job,
} from '../../scripts/main-red.ts'
import { filesOf, missingFrom, newerThan, whyNot } from '../../scripts/release-starts.ts'

/** A pull request changing `changed`, on `branch`, with `labels`. */
const pr = (changed: string[], branch = 'lmv-1-x', labels: string[] = []) =>
  plan({ event: 'pull_request', branch, changed, labels })
const FULL = ['1/4', '2/4', '3/4', '4/4']
/** Linux's sixteen shards, as the plan names them. */
const LINUX = Array.from({ length: 16 }, (_, i) => `${i + 1}/16`)
/** Each system's shards, as the plan names them. */
const shards = (result: ReturnType<typeof plan>, os: string) =>
  result.e2e.filter((shard) => shard.os === os).map((shard) => shard.shard)
/** The spec files Linux's shards run, where the plan names them. */
const files = (result: ReturnType<typeof plan>) => [
  ...new Set(result.e2e.filter((shard) => shard.os === 'ubuntu-latest').map((s) => s.files)),
]

test('docs only: Markdown, and images that aren’t the app’s', () => {
  const result = pr([
    'README.md',
    'docs/guide.md',
    'docs/screenshots/pods-dark.webp',
    'CHANGELOG.md',
  ])
  expect(result.docs).toBe(true)
  expect(result.said).toContain('Docs only')
})

test('not docs: a file moved into docs/, code there, the tests’ Markdown, the app’s images', () => {
  // git mv src/main/menu.ts docs/menu.md, as --no-renames lists it.
  expect(pr(['src/main/menu.ts', 'docs/menu.md'])).toMatchObject({ docs: false, platforms: true })
  expect(pr(['electron-builder.yml', 'docs/electron-builder.yml']).docs).toBe(false)
  expect(pr(['docs/x.ts']).docs).toBe(false)
  expect(pr(['tests/e2e/README.md']).docs).toBe(false)
  expect(pr(['src/renderer/public/sponsor/lumovi-light.png']).docs).toBe(false)
  expect(pr(['build/icon.png']).docs).toBe(false)
})

test('a pull request runs the smoke set and every spec file it changes, on Linux, split so each shard has its share', () => {
  const smoke = ['tests/e2e/app.spec.ts', 'tests/web/server.spec.ts']
  const changed = [
    'src/renderer/src/features/x.tsx',
    'tests/e2e/lists.spec.ts',
    'changelog.d/x.added.md',
  ]
  const result = plan({ event: 'pull_request', changed, smoke, minutes: () => 10 })
  expect(result).toMatchObject({
    full: false,
    platforms: false,
    integration: false,
    packages: false,
  })
  // (An entry isn't a spec file: it runs nothing more.)
  expect(files(result)).toEqual([
    'tests/e2e/app.spec.ts tests/web/server.spec.ts tests/e2e/lists.spec.ts',
  ])
  expect(shards(result, 'ubuntu-latest')).toEqual(['1/2', '2/2'])
  expect(result.e2e.filter((shard) => shard.os === 'ubuntu-latest')).toEqual([
    expect.objectContaining({ part: 'smoke-1', projects: 'desktop web', only: '' }),
    expect.objectContaining({ part: 'smoke-2', projects: 'desktop web', only: '' }),
  ])
  // More of them where the tests take longer: each has at most SMOKE_SHARD_MINUTES.
  const long = plan({
    event: 'pull_request',
    changed: ['src/renderer/x.tsx'],
    smoke,
    minutes: (named) => (named.length === smoke.length ? 3 * SMOKE_SHARD_MINUTES + 1 : 0),
  })
  expect(shards(long, 'ubuntu-latest')).toEqual(['1/4', '2/4', '3/4', '4/4'])
  // Alike on every system: Linux alone. A change that differs by system: Windows' and macOS's
  // smoke sets too, never more.
  expect(shards(pr(['src/renderer/x.tsx']), 'windows-latest')).toEqual([])
  expect(shards(pr(['src/renderer/x.tsx']), 'macos-latest')).toEqual([])
  for (const os of ['windows-latest', 'macos-latest']) {
    expect(shards(pr(['src/main/index.ts']), os), os).toEqual(['smoke'])
  }
  expect(pr(['src/main/index.ts']).said).toContain('Windows’ and macOS’s smoke sets')
})

test('a change to what keeps people and clusters safe runs the specs that guard it, and every engine', () => {
  const smoke = ['tests/e2e/app.spec.ts']
  for (const [path, guards] of [
    ['src/main/plugin-box.ts', 'tests/web/fleet-agents.spec.ts'],
    ['src/preload/index.ts', 'tests/e2e/withheld.spec.ts'],
    ['src/renderer/src/plugins/box.ts', 'tests/e2e/plugin-box-ways-out.spec.ts'],
    // (A Secret's part on a plugin's page: its masking tests too.)
    ['src/renderer/src/plugins/secret-part.ts', 'tests/web/plugin-secret-page.spec.ts'],
    ['src/backend/plugin-reads.ts', 'tests/web/plugin-hostile.spec.ts'],
    ['src/shared/plugin-door.ts', 'tests/web/plugin-secret.spec.ts'],
    ['src/shared/plugins.ts', 'tests/e2e/plugin-box.spec.ts'],
    // The server's half: the box's check, and the plugin's code it hands a browser.
    ['src/server/box-check.ts', 'tests/web/box-check.spec.ts'],
    ['src/shared/box-check.ts', 'tests/web/box-check-calls.spec.ts'],
    ['src/server/plugin-code.ts', 'tests/web/plugin-hand-over.spec.ts'],
    // A Secret's values masked and withheld, in a view, its YAML, a compare, a release's review.
    ['src/backend/withholding.ts', 'tests/web/withheld.spec.ts'],
    ['src/renderer/src/lib/helm-diff.ts', 'tests/web/helm-diff.spec.ts'],
    ['src/renderer/src/features/details/YamlTab.tsx', 'tests/e2e/details.spec.ts'],
    ['src/renderer/src/features/compare/ComparePage.tsx', 'tests/web/compare.spec.ts'],
    // An assistant's reads and approvals.
    ['src/backend/mcp/present.ts', 'tests/e2e/assistant-permissions.spec.ts'],
    ['src/backend/mcp/access.ts', 'tests/web/assistant-permissions.spec.ts'],
    ['src/backend/mcp/tools.ts', 'tests/web/assistants.spec.ts'],
    ['src/backend/mcp/approvals.ts', 'tests/e2e/assistants.spec.ts'],
    // The audit; and on a server, its pages' policy, who may do what, signing in, sessions, fleets.
    ['src/backend/audit/log.ts', 'tests/e2e/audit.spec.ts'],
    ['src/server/audit.ts', 'tests/web/audit.spec.ts'],
    ['src/server/pages.ts', 'tests/web/server.spec.ts'],
    ['src/server/app.ts', 'tests/web/plugin-box.spec.ts'],
    ['src/server/access.ts', 'tests/e2e/access-control.spec.ts'],
    ['src/server/auth.ts', 'tests/web/sign-in.spec.ts'],
    ['src/server/sessions.ts', 'tests/web/oidc.spec.ts'],
    ['src/server/fleet/secrets.ts', 'tests/web/fleet-join-agent.spec.ts'],
  ] as const) {
    expect(touchesSecurity(path), path).toBe(true)
    const result = plan({ event: 'pull_request', changed: [path], smoke })
    expect(result.browsers, path).toBe(true)
    const runs = files(result)[0]!.split(' ')
    expect(runs, path).toEqual([...smoke, ...securitySpecs([path])])
    expect(runs, path).toContain(guards)
    expect(result.said, path).toContain('with the security set')
  }
  // Each touches its own: a change to the audit alone runs no box test.
  expect(securitySpecs(['src/backend/audit/log.ts'])).toEqual([
    'tests/e2e/audit.spec.ts',
    'tests/web/audit.spec.ts',
  ])
  // The main process runs all of them.
  expect(securitySpecs(['src/main/index.ts']).sort()).toEqual([...SECURITY_SET].sort())
  for (const path of [
    'src/renderer/src/features/x.tsx',
    'src/shared/kit/parts.ts',
    'tests/e2e/x.spec.ts',
  ]) {
    expect(touchesSecurity(path), path).toBe(false)
    expect(plan({ event: 'pull_request', changed: [path], smoke }).browsers, path).toBe(false)
  }
  // Every entry is of files that are there, and names specs that are: so one can't come in
  // without its tests, nor its tests go without it.
  const sources = readdirSync('src', { recursive: true, encoding: 'utf8' }).map(
    (path) => `src/${path.split('\\').join('/')}`,
  )
  for (const { paths, specs } of SECURITY) {
    expect(sources.filter((path) => paths.test(path)).length, String(paths)).toBeGreaterThan(0)
    expect(specs.length, String(paths)).toBeGreaterThan(0)
    for (const spec of specs) expect(readFileSync(spec, 'utf8').length, spec).toBeGreaterThan(0)
  }
})

test('a change to the tests’ harness runs everything, on every system, as full-ci does: any test can rest on it', () => {
  for (const path of [
    'tests/e2e/fixtures.ts',
    'tests/web/fixtures.ts',
    'tests/e2e/global-setup.ts',
    'tests/e2e/plugin-box/catchers.ts',
    'tests/e2e/helm/metrics-stack.yaml',
    'tests/mock-cluster/fixtures/demo.ts',
    'tests/mock-downloads/plugin-store.ts',
    'tests/temp-folders.ts',
    'playwright.config.ts',
    'playwright.integration.config.ts',
    'scripts/e2e-shard.ts',
    // The integration tests, which run only in a run of everything: their specs and their cluster.
    'tests/integration/served.spec.ts',
    'tests/integration/cluster.ts',
  ]) {
    expect(isHarness(path), path).toBe(true)
    const result = pr([path])
    expect(result, path).toMatchObject({ full: true, integration: true, packages: true })
    expect(shards(result, 'ubuntu-latest'), path).toEqual(LINUX)
    expect(result.said, path).toContain('it changes the tests’ harness')
    // A merge of it too.
    expect(plan({ event: 'push', changed: [path] }).full, path).toBe(true)
  }
  // Not a spec file, a list of them, the tests' timings, nor the plugins' tests.
  for (const path of [
    'tests/e2e/lists.spec.ts',
    'tests/web/fleet.spec.ts',
    'tests/e2e/smoke.txt',
    'tests/smoke.txt',
    'tests/durations.json',
    'tests/plugins/known.spec.ts',
  ]) {
    expect(isHarness(path), path).toBe(false)
  }
})

test('the label macos-full runs macOS’s desktop tests in full; full-ci, everything on every system', () => {
  const asked = pr(['src/renderer/x.tsx'], 'lmv-1-x', ['macos-full'])
  expect(shards(asked, 'macos-latest')).toEqual(FULL)
  expect(shards(asked, 'windows-latest')).toEqual(['smoke'])
  expect(asked.full).toBe(false)
  const everything = pr(['src/renderer/x.tsx'], 'lmv-1-x', [FULL_CI])
  expect(everything).toMatchObject({
    full: true,
    integration: true,
    browsers: true,
    packages: true,
  })
  expect(shards(everything, 'ubuntu-latest')).toEqual(LINUX)
  expect(shards(everything, 'macos-latest')).toEqual(FULL)
  expect(shards(everything, 'windows-latest')).toEqual(FULL)
  expect(everything.said).toContain(`as its label asks (${FULL_CI})`)
})

test('the packages, the integration tests and the other engines run in a full run, and where a change asks', () => {
  // The packages: for a change to how they're made, or what they're made with.
  for (const path of [
    'package.json',
    'package-lock.json',
    'build/icon.png',
    'packaging/x.desktop',
    'electron-builder.yml',
    '.github/workflows/ci.yml',
    'scripts/after-pack.mjs',
  ]) {
    expect(pr([path]).packages, path).toBe(true)
  }
  expect(pr(['src/main/index.ts']).packages).toBe(false)
  // The integration tests: in a full run only.
  expect(pr(['charts/lumovi/values.yaml']).integration).toBe(false)
  expect(pr(['x.ts'], 'release-1.24.0').integration).toBe(true)
  for (const event of ['schedule', 'workflow_dispatch']) {
    expect(plan({ event, changed: [] }), event).toMatchObject({
      integration: true,
      packages: true,
      browsers: true,
    })
  }
})

test('main’s merge runs what a pull request does: the smoke set and what it touches, never docs alone', () => {
  const merged = plan({
    event: 'push',
    changed: ['src/renderer/x.tsx', 'tests/e2e/lists.spec.ts'],
    smoke: ['tests/e2e/app.spec.ts'],
  })
  expect(merged).toMatchObject({ full: false, docs: false, integration: false })
  expect(files(merged)).toEqual(['tests/e2e/app.spec.ts tests/e2e/lists.spec.ts'])
  expect(merged.said).toContain('Main’s merge')
  // Its tests run even for docs.
  expect(plan({ event: 'push', changed: ['README.md'] }).docs).toBe(false)
})

test('main’s nightly run, a run by hand and a release’s pull request run everything, on every system', () => {
  for (const result of [
    plan({ event: 'schedule', changed: [] }),
    plan({ event: 'workflow_dispatch', changed: [] }),
    pr(['README.md'], 'release-1.24.0'),
  ]) {
    expect(result.full).toBe(true)
    expect(result.docs).toBe(false)
    expect(shards(result, 'ubuntu-latest')).toEqual(LINUX)
    expect(shards(result, 'macos-latest')).toEqual(FULL)
    expect(shards(result, 'windows-latest')).toEqual(FULL)
    for (const shard of result.e2e) {
      expect(shard).toMatchObject({ projects: 'desktop web', only: '', files: '' })
    }
  }
})

test('every system runs for a file that asks which system it’s on, the harness, or a path not named as alike', () => {
  const renderer = 'src/renderer/src/features/terminal/keys.ts'
  // Alike by where it is, but its text asks which system it's on.
  expect(pr([renderer], 'lmv-1-x').platforms).toBe(false)
  expect(
    plan({ event: 'pull_request', changed: [renderer], namesASystem: [renderer] }).platforms,
  ).toBe(true)
  for (const changed of [
    // The tests' harness, each alone: what the spec files run in, and the mock clusters.
    ['tests/e2e/global-setup.ts'],
    ['tests/e2e/fixtures.ts'],
    ['tests/e2e/action-helpers.ts'],
    ['tests/e2e/plugin-box/sealed.ts'],
    ['tests/integration/fixtures.ts'],
    ['tests/integration/cluster.ts'],
    ['tests/mock-cluster/fixtures/demo.ts'],
    // What the desktop app's own process runs: its kubeconfig, credential plugins and helm.
    ['src/backend/kube/kubeconfig.ts'],
    ['src/backend/audit/log.ts'],
    ['tests/e2e/smoke.txt'],
    ['tests/e2e/linux-only.txt'],
    ['tests/holds.ts'],
    ['playwright.config.ts'],
    ['package.json'],
    ['Dockerfile'],
    ['src/preload/index.ts'],
    ['scripts/e2e-shard.ts'],
    ['something-new/file.ts'],
  ]) {
    const result = pr(changed)
    expect(result.platforms, changed.join(' ')).toBe(true)
    // (The tests' harness runs everything: the next test.)
    expect(shards(result, 'windows-latest'), changed.join(' ')).toEqual(
      changed.some(isHarness) ? FULL : ['smoke'],
    )
  }
  // A release's pull request, the labels' asks, nightly and a run by hand: every system. A merge
  // to main is as a pull request.
  expect(pr(['src/renderer/x.tsx'], 'release-1.23.0').platforms).toBe(true)
  expect(pr(['src/renderer/x.tsx'], 'lmv-1-x', ['macos-full']).platforms).toBe(true)
  expect(pr(['src/renderer/x.tsx'], 'lmv-1-x', [FULL_CI]).platforms).toBe(true)
  for (const event of ['schedule', 'workflow_dispatch']) {
    expect(plan({ event, changed: ['src/renderer/x.tsx'] }).platforms, event).toBe(true)
  }
  expect(plan({ event: 'push', changed: ['src/renderer/x.tsx'] }).platforms).toBe(false)
  // What asks which system it is, in the words the app's own files use.
  for (const text of [
    "process.platform === 'darwin'",
    "const WINDOWS = process.platform === 'win32'",
    'navigator.platform.startsWith("Mac")',
    'if (isMac) return "⌘"',
    "api.host === 'server' && api.platform === 'linux'",
    "os.platform() === 'win32'",
    'nameable(name, this.host.platform)',
    "const windows = this.platform === 'win32'",
    "process.platform.startsWith('win')",
    "{MOD_KEY === '⌘' ? '⌘↩' : 'Ctrl+↩'}",
    'value.split(delimiter)',
    "join(homedir(), '.kube', 'config')",
    "import { spawn } from 'node:child_process'",
    'execFileSync(command, args)',
    'process.env.APPDATA',
  ]) {
    expect(NAMES_A_SYSTEM.test(text), text).toBe(true)
  }
  expect(NAMES_A_SYSTEM.test("const platform = 'phone'")).toBe(false)
  // `.platform` in a host's name asks nothing (an annotation's key, columns.spec.ts:284).
  expect(
    NAMES_A_SYSTEM.test("const prefix = 'deploy.platform.example.com/escalation-contact-for-'"),
  ).toBe(false)
  expect(NAMES_A_SYSTEM.test('a list of pods, filtered')).toBe(false)
  // A program's name is a test's or a sample's text there: Windows' own are started from src/main
  // and src/backend, which run every system by where they are.
  expect(NAMES_A_SYSTEM.test("'invoice-\u202efdp.exe'")).toBe(false)
  for (const file of ['tests/e2e/kit-table.spec.ts', 'src/renderer/src/kit/KitPage.tsx']) {
    expect(NAMES_A_SYSTEM.test(readFileSync(file, 'utf8')), file).toBe(false)
  }
  // The app's own files that ask, each in its own way.
  for (const file of [
    'src/renderer/src/components/Kbd.tsx',
    'src/renderer/src/features/shell/PinnedObjects.tsx',
    'src/renderer/src/features/assistants/ApprovalCenter.tsx',
    'src/backend/kube/kubeconfig.ts',
  ]) {
    expect(NAMES_A_SYSTEM.test(readFileSync(file, 'utf8')), file).toBe(true)
  }
  // A file as it is now, or, taken away, as it was.
  const texts: Record<string, { now?: string; before?: string }> = {
    'src/renderer/a.ts': { now: "api.platform === 'darwin'" },
    'src/renderer/gone.ts': { before: 'process.platform' },
    'src/renderer/b.ts': { now: 'a list', before: 'process.platform' },
    'src/renderer/c.ts': { now: 'a list' },
    'src/renderer/never.ts': {},
  }
  // (And one with no text to read at all is taken to name one: what can't be read runs everything.)
  expect(namingASystem(Object.keys(texts), (path, at) => texts[path]![at])).toEqual([
    'src/renderer/a.ts',
    'src/renderer/gone.ts',
    'src/renderer/never.ts',
  ])
})

test('a release’s pull request is its version’s branch alone: another whose name starts the same is an ordinary one', () => {
  for (const branch of ['release-1.22.0', 'release-2.0.0-rc.1']) {
    expect(isRelease(branch), branch).toBe(true)
    expect(pr(['x.ts'], branch)).toMatchObject({ release: true, full: true })
  }
  for (const branch of [
    'release-guard',
    'release-waits-for-approval',
    'release-1.22',
    'release-v1.22.0',
  ]) {
    expect(isRelease(branch), branch).toBe(false)
    const result = pr(['x.ts'], branch)
    expect(result).toMatchObject({ release: false, full: false })
    expect(result.said).not.toContain('A release’s pull request')
  }
  // Nor is a branch of that name pushed to main, or main's own runs.
  expect(plan({ event: 'push', branch: 'release-1.22.0', changed: ['x.ts'] }).release).toBe(false)
  expect(plan({ event: 'schedule', changed: [] }).release).toBe(false)
})

test('the tests a pull request adds are each whole name that’s new: a retitled one is new, a moved one too', () => {
  const listing = (titles: Record<string, string[]>) => ({
    suites: Object.entries(titles).map(([file, specs]) => ({
      title: file,
      file,
      specs: specs.map((title) => ({ title, tests: [{ projectName: 'desktop' }] })),
      suites: [
        {
          title: 'a describe',
          file,
          specs: [{ title: 'inside', tests: [{ projectName: 'web' }] }],
        },
      ],
    })),
  })
  const before = namesOf(listing({ 'tests/e2e/a.spec.ts': ['one', 'two'] }))
  expect(before).toEqual([
    '[desktop] › tests/e2e/a.spec.ts › one',
    '[desktop] › tests/e2e/a.spec.ts › two',
    '[web] › tests/e2e/a.spec.ts › a describe › inside',
  ])
  const now = namesOf(
    listing({
      'tests/e2e/a.spec.ts': ['one', 'two, retitled', 'three'],
      'tests\\e2e\\b.spec.ts': ['one'],
    }),
  )
  expect(added(now, before)).toEqual([
    '[desktop] › tests/e2e/a.spec.ts › two, retitled',
    '[desktop] › tests/e2e/a.spec.ts › three',
    '[desktop] › tests/e2e/b.spec.ts › one',
    '[web] › tests/e2e/b.spec.ts › a describe › inside',
  ])
  expect(added(before, before)).toEqual([])
  // Shared over the job's parts, each its every third; more than its time holds, said by the
  // first part and run by none.
  const seven = Array.from({ length: 7 }, (_, i) => `t${i}`)
  expect([1, 2, 3].map((part) => share(seven, part, 3).names)).toEqual([
    ['t0', 't3', 't6'],
    ['t1', 't4'],
    ['t2', 't5'],
  ])
  const many = Array.from({ length: MOST_NEW + 1 }, (_, i) => `t${i}`)
  expect(share(many, 1, 3)).toEqual({
    names: [],
    said: `${MOST_NEW + 1} tests are new or retitled: more than this job repeats in its time (${MOST_NEW}). Run them 25 times with Actions, Repeat a test, a few files at a time, and say so on the pull request.`,
  })
  expect(share(many, 2, 3)).toEqual({ names: [] })
  expect(share(many.slice(1), 3, 3).names).toHaveLength(MOST_NEW / 3)
})

test('a commit is released only after a run of CI of it ran everything and passed', () => {
  const run = (id: number) => ({
    id,
    conclusion: 'success',
    html_url: `https://github.com/Lumovi/Lumovi/actions/runs/${id}`,
  })
  const passed = (names: string[]) => names.map((name) => ({ name, conclusion: 'success' }))
  const smoke = passed([
    'What changed',
    'E2E (ubuntu-latest, 1/2)',
    'E2E (ubuntu-latest, 2/2)',
    'CI passed',
  ])
  const everything = passed(['What changed', ...EVERYTHING])
  const github = (
    runs: number[],
    jobs: Record<number, { name: string; conclusion: string }[]>,
    red = false,
  ) => {
    const asked: string[] = []
    const gh = (path: string) => {
      asked.push(path)
      if (path.includes('/issues?labels=main-red')) return red ? [{ number: 41 }] : []
      if (path.includes('/workflows/ci.yml/runs?')) return { workflow_runs: runs.map(run) }
      const id = Number(/runs\/(\d+)\/jobs/.exec(path)![1])
      return { jobs: jobs[id] }
    }
    return { gh, asked }
  }
  const sha = 'a'.repeat(40)
  // The merge's run (the smoke set) and the release's pull request's (everything): the latter.
  const both = github([2, 1], { 2: smoke, 1: everything })
  expect(gate(both.gh, 'Lumovi/Lumovi', sha)).toEqual({
    run: run(1),
    why: 'aaaaaaa ran everything, and passed: https://github.com/Lumovi/Lumovi/actions/runs/1',
  })
  expect(both.asked[1]).toBe(
    `repos/Lumovi/Lumovi/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=20`,
  )
  // While main is red, nothing is released, whatever this commit's own run said.
  expect(gate(github([1], { 1: everything }, true).gh, 'Lumovi/Lumovi', sha)).toEqual({
    why: 'Main is red (#41): a release waits until a run of everything of main is green, and closes it.',
  })
  // Only the smoke set passed, or nothing: refused, saying which.
  expect(gate(github([2], { 2: smoke }).gh, 'Lumovi/Lumovi', sha)).toEqual({
    why: 'No run of CI of aaaaaaa that passed ran everything (1 passed with less): a release’s pull request’s must.',
  })
  expect(gate(github([], {}).gh, 'Lumovi/Lumovi', sha).why).toBe(
    'No run of CI of aaaaaaa passed: a release’s pull request runs everything of its commit, and that run must pass.',
  )
  // Everything but one shard, or one that didn't pass, is less than everything.
  expect(missing(everything.filter(({ name }) => name !== 'E2E (macos-latest, 3/4)'))).toEqual([
    'E2E (macos-latest, 3/4)',
  ])
  expect(
    missing(
      everything.map((job) =>
        job.name === 'Coverage (all platforms)' ? { ...job, conclusion: 'skipped' } : job,
      ),
    ),
  ).toEqual(['Coverage (all platforms)'])
  expect(EVERYTHING).toContain('E2E (ubuntu-latest, 16/16)')
  expect(EVERYTHING).toContain('Integration (kind, 6/6)')
  // And release.yml asks, before anything is made, whatever started it.
  const release = readFileSync('.github/workflows/release.yml', 'utf8')
  expect(release).toContain(
    '      - name: A run of everything of this commit passed\n        if: steps.version.outputs.version',
  )
  expect(release).toContain('run: node scripts/release-gate.ts "$SHA"')
})

test('main is red unless its newest finished run passed: only a run somebody cancelled says nothing', () => {
  const run = (sha: string, conclusion: string | null, ranOutOfTime?: boolean) => ({
    id: 1,
    sha,
    conclusion,
    url: `https://github.com/Lumovi/Lumovi/actions/runs/${sha}`,
    ...(ranOutOfTime === undefined ? {} : { ranOutOfTime }),
  })
  expect(redOf([run('aaaaaaa1', 'success'), run('bbbbbbb2', 'failure')])).toBeUndefined()
  expect(redOf([run('aaaaaaa1', 'failure'), run('bbbbbbb2', 'success')])?.sha).toBe('aaaaaaa1')
  // (Newest first.) A run somebody cut off, or one that hasn't ended, isn't a verdict on the code.
  expect(
    redOf([run('ccccccc3', 'cancelled', false), run('ddddddd4', null), run('eeeeeee5', 'failure')])
      ?.sha,
  ).toBe('eeeeeee5')
  expect(redOf([run('ccccccc3', 'cancelled', false), run('eeeeeee5', 'success')])).toBeUndefined()
  expect(redOf([])).toBeUndefined()
  // A job that ran out of its time is called cancelled too: that one is red. A hang stops the line.
  expect(redOf([run('fffffff6', 'cancelled', true), run('eeeeeee5', 'success')])?.sha).toBe(
    'fffffff6',
  )
  // And whatever else isn't a pass.
  for (const conclusion of ['timed_out', 'startup_failure', 'action_required', 'stale']) {
    expect(redOf([run('aaaaaaa1', conclusion), run('bbbbbbb2', 'success')])?.sha, conclusion).toBe(
      'aaaaaaa1',
    )
  }
  // What a pull request is told: main's commit, what failed there, and where to read it.
  expect(
    sentence(run('eeeeeee5f', 'failure'), ['E2E (macos-latest, 2/4)', 'Coverage (all platforms)']),
  ).toBe(
    'main is red at eeeeeee (E2E (macos-latest, 2/4), Coverage (all platforms)): a warning, not a stop. Check that this pull request isn’t why. https://github.com/Lumovi/Lumovi/actions/runs/eeeeeee5f',
  )
  expect(
    sentence(run('fffffff6f', 'cancelled', true), ['E2E (macos-latest, 2/4) ran out of time']),
  ).toContain('main is red at fffffff (E2E (macos-latest, 2/4) ran out of time)')
})

test('a red main is a warning on a pull request, never its failure; a green one says nothing', () => {
  const run = (sha: string, conclusion: string) => ({
    id: 1,
    sha,
    conclusion,
    url: `https://github.com/Lumovi/Lumovi/actions/runs/${sha}`,
  })
  // Red: said, with main's commit and what failed there (the script prints it as a warning, and
  // ends well: "CI passed" fails only where the pull request's own jobs did).
  expect(warningOf([run('aaaaaaa1', 'failure')], ['Coverage (all platforms)'])).toBe(
    'main is red at aaaaaaa (Coverage (all platforms)): a warning, not a stop. Check that this pull request isn’t why. https://github.com/Lumovi/Lumovi/actions/runs/aaaaaaa1',
  )
  // Green, or nothing finished yet: nothing to say.
  expect(warningOf([run('bbbbbbb2', 'success'), run('aaaaaaa1', 'failure')], [])).toBeUndefined()
  expect(warningOf([], [])).toBeUndefined()
  // What "CI passed" prints, asking a GitHub that answers each question as given here.
  const github =
    (answers: Record<string, unknown>): Gh =>
    (path) => {
      const asked = Object.keys(answers).find((start) => path.includes(start))
      if (!asked) throw new Error(`Nothing for ${path}`)
      return JSON.stringify(answers[asked])
    }
  // Main's merges and its nightly runs are asked apart (for now, macOS runs in full only at
  // night): both green, or none finished yet, is green.
  expect(
    told(
      github({ 'event=push': [run('aaaaaaa1', 'success')], 'event=schedule': [] }),
      'Lumovi/Lumovi',
    ),
  ).toBe('Main is green.')
  expect(
    told(
      github({
        'event=push': [run('aaaaaaa1', 'failure')],
        'event=schedule': [run('bbbbbbb2', 'success')],
        '/jobs?': [{ id: 7, name: 'Coverage' }],
      }),
      'Lumovi/Lumovi',
    ),
  ).toBe(
    '::warning::main is red at aaaaaaa (Coverage): a warning, not a stop. Check that this pull request isn’t why. https://github.com/Lumovi/Lumovi/actions/runs/aaaaaaa1',
  )
  // A red nightly is a red main, though the merge after it was green: that one ran macOS's smoke
  // set, and what the nightly found is still there.
  expect(
    told(
      github({
        'event=push': [run('ccccccc3', 'success')],
        'event=schedule': [run('bbbbbbb2', 'failure')],
        '/jobs?': [{ id: 8, name: 'E2E (macos-latest, 2/4)' }],
      }),
      'Lumovi/Lumovi',
    ),
  ).toBe(
    '::warning::main’s nightly run is red at bbbbbbb (E2E (macos-latest, 2/4)): a warning, not a stop. Check that this pull request isn’t why. https://github.com/Lumovi/Lumovi/actions/runs/bbbbbbb2',
  )
  // Both red: both said, each on its own line.
  expect(
    told(
      github({
        'event=push': [run('aaaaaaa1', 'failure')],
        'event=schedule': [run('bbbbbbb2', 'failure')],
        '/jobs?': [{ id: 7, name: 'Coverage' }],
      }),
      'Lumovi/Lumovi',
    ).split('\n'),
  ).toHaveLength(2)
  // GitHub not answering says nothing of the pull request either: a warning, on one line.
  const down: Gh = () => {
    throw new Error(
      'Command failed: gh api repos/Lumovi/Lumovi/actions/…\nHTTP 504: Gateway Timeout',
    )
  }
  expect(told(down, 'Lumovi/Lumovi')).toBe(
    '::warning::Lumovi couldn’t read main’s runs: Command failed: gh api repos/Lumovi/Lumovi/actions/…',
  )
  // And nothing in it reads a label: no pull request is let through, or held, by one.
  expect(readFileSync('scripts/main-is-green.ts', 'utf8')).not.toMatch(
    /fixes-main|labels|exit\(1\)/,
  )
})

test('a release starts by itself only from the commit that set the version', () => {
  // The release's own commit: the version is new here.
  expect(whyNot({ event: 'workflow_run', version: '1.22.0', before: '1.21.0' })).toBeUndefined()
  // The first commit there is, or one before which package.json had no version.
  expect(whyNot({ event: 'workflow_run', version: '1.0.0', before: undefined })).toBeUndefined()
  // A later commit that finds the version still without a release: not from here.
  expect(whyNot({ event: 'workflow_run', version: '1.22.0', before: '1.22.0' })).toBe(
    'v1.22.0 has no release, and this commit isn’t the one that set the version: nothing is released from here by itself. To release main as it is now, run the Release workflow by hand.',
  )
  // By hand, it's what was asked for.
  expect(
    whyNot({ event: 'workflow_dispatch', version: '1.22.0', before: '1.22.0' }),
  ).toBeUndefined()
})

test('a release is newer than every one before it', () => {
  expect(newerThan('1.22.0', ['1.21.0', '1.20.0', '1.9.0'])).toBeUndefined()
  expect(newerThan('1.21.0', ['1.21.0'])).toBeUndefined()
  expect(newerThan('1.20.0', ['1.19.0', '1.21.0'])).toBe('1.21.0')
  // By its numbers, not its letters; a prerelease comes before its release.
  expect(newerThan('1.9.0', ['1.10.0'])).toBe('1.10.0')
  expect(newerThan('1.22.0-beta.1', ['1.22.0'])).toBe('1.22.0')
  expect(newerThan('1.22.0', ['1.22.0-beta.1'])).toBeUndefined()
  // What isn't a version's tag says nothing.
  expect(newerThan('1.0.0', ['nightly', 'v2'])).toBeUndefined()
})

test('a release is published whole: a draft that lacks a file one of the builds makes is refused, by name', () => {
  const all = filesOf('1.22.0', false)
  expect(all).toHaveLength(16)
  expect(
    missingFrom('1.22.0', false, [...all, 'SHA256SUMS.txt', 'Lumovi-1.22.0-win.exe.blockmap']),
  ).toEqual([])
  // The Linux build run again by itself, having started the draft over: only its own files.
  const linuxOnly = all.filter((file) => /linux-(x86_64|amd64)|cdx|latest-linux\.yml/.test(file))
  expect(missingFrom('1.22.0', false, linuxOnly)).toEqual([
    'Lumovi-1.22.0-mac-arm64.dmg',
    'Lumovi-1.22.0-mac-arm64.zip',
    'Lumovi-1.22.0-mac-x64.dmg',
    'Lumovi-1.22.0-mac-x64.zip',
    'Lumovi-1.22.0-win.exe',
    'Lumovi-1.22.0-linux-arm64.AppImage',
    'Lumovi-1.22.0-linux-arm64.deb',
    'Lumovi-1.22.0-linux-aarch64.rpm',
    'latest-mac.yml',
    'latest.yml',
    'latest-linux-arm64.yml',
  ])
  // Another version's files aren't this one's.
  expect(missingFrom('1.22.0', false, filesOf('1.21.0', false))).toHaveLength(12)
  // A prerelease: its installers and its bill of materials (what tells apps of an update is
  // named for its channel, and isn't asked for by name).
  expect(filesOf('1.22.0-beta.1', true)).toHaveLength(12)
})

test('every spec that has a test for each browser engine is in CI’s Browsers job: its file named, and every such title of its tests asked for', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
  // The job's one command: the files it names, and the titles it asks for.
  const command = /- name: Run what differs by engine\n[\s\S]*?\n {8}run: >-\n([\s\S]*?)\n\n/.exec(
    ci,
  )?.[1]
  expect(command).toBeDefined()
  const named = [...command!.matchAll(/tests\/web\/[\w-]+\.spec\.ts/g)].map(([file]) => file)
  const asked = new RegExp(/--grep "([^"]+)"/.exec(command!)![1]!)
  // The specs with a test for each engine: they read the switch only that job sets, which is
  // what lets every other job skip the engines it hasn't got. (Its name is put together here,
  // so that this file isn't one of them.)
  const SWITCH = ['LUMOVI', 'E2E', 'BROWSERS'].join('_')
  const byEngine = readdirSync('tests/web')
    .filter((file) => file.endsWith('.spec.ts'))
    .map((file) => `tests/web/${file}`)
    .filter((file) => readFileSync(file, 'utf8').includes(SWITCH))
  // Skipped everywhere else as "CI’s Browsers job runs it": so the job must, each of them.
  expect([...named].sort()).toEqual([...byEngine].sort())
  expect(byEngine.length).toBeGreaterThan(0)
  // And named isn't run: every title of its tests with an engine's name in it is one the job
  // asks for, each by itself. (A title takes the engine's name as `${name}`. One the job
  // doesn't ask for would run in no engine but the first, in a file that looks covered.)
  for (const file of byEngine) {
    const titles = [
      ...readFileSync(file, 'utf8').matchAll(
        /\b(?:test|test\.describe)\(\s*`([^`]*\$\{name\}[^`]*)`/g,
      ),
    ].map(([, title]) => title!.replace('${name}', 'Firefox'))
    expect(titles.length, file).toBeGreaterThan(0)
    expect(
      titles.filter((title) => !asked.test(title)),
      `${file}: titles the job’s ${asked} doesn’t ask for`,
    ).toEqual([])
  }
})

test('a job’s log says which tests failed on every try and which passed only when tried again, as Playwright sums them up', () => {
  const at = (line: string) => `2026-11-27T11:04:11.0000000Z ${line}`
  const log = [
    '  ✘   63 [desktop] › tests/e2e/settings.spec.ts:107:1 › the time zone and clock are every date’s (19.8s)',
    '  1 failed',
    '    [desktop] › tests/e2e/settings.spec.ts:107:1 › the time zone and clock are every date’s ───────',
    '  2 flaky',
    '    [desktop] › tests\\e2e\\helm.spec.ts:284:1 › install and upgrade options, each said ──',
    '    [web] › tests/web/phone.spec.ts:803:3 › on a touch screen › Approve waits its moment',
    '  33 skipped',
    '    [web] › tests/web/plugin-box.spec.ts:1160:7 › a plugin’s box in Firefox',
    '  100 passed (6.2m)',
  ]
    .map(at)
    .join('\n')
  // Each as its project, file and line, and title: a Windows path with slashes, the line's rule
  // gone; what was skipped isn't either.
  expect(testsOf(log)).toEqual({
    failed: [
      '[desktop] › tests/e2e/settings.spec.ts:107 › the time zone and clock are every date’s',
    ],
    flaky: [
      '[desktop] › tests/e2e/helm.spec.ts:284 › install and upgrade options, each said',
      '[web] › tests/web/phone.spec.ts:803 › on a touch screen › Approve waits its moment',
    ],
  })
  // A job that stopped before its tests: none.
  expect(testsOf(at('##[error]Process completed with exit code 1.'))).toEqual({
    failed: [],
    flaky: [],
  })
})

test('a job that failed with no test failed says what did: its errors, not its exit code nor a test’s', () => {
  const at = (line: string) => `2026-11-28T20:51:00.0000000Z ${line}`
  const log = [
    '  ok 103 [desktop] › tests\\e2e\\lists.spec.ts:410:3 › a list’s bar keeps to one row',
    '##[error]Worker teardown timeout of 60000ms exceeded.',
    '##[error]  1) [desktop] › tests\\e2e\\helm.spec.ts:284:1 › install and upgrade options ',
    '  1 flaky',
    '    [desktop] › tests\\e2e\\helm.spec.ts:284:1 › install and upgrade options',
    '  254 passed (16.4m)',
    '##[error]Worker teardown timeout of 60000ms exceeded.',
    '##[error]Process completed with exit code 1.',
  ]
    .map(at)
    .join('\n')
  expect(errorsOf(log)).toEqual(['Worker teardown timeout of 60000ms exceeded.'])
  expect(errorsOf(at('##[error]Process completed with exit code 1.'))).toEqual([])
})

test('a coverage gate that failed says where it fell: unloaded files, low measures, and the files with the most not run', () => {
  const at = (line: string) => `2026-11-29T03:10:00.0000000Z ${line}`
  const log = [
    'Coverage from 36 files: statements 91.2%, branches 89.97%, functions 92%, lines 91.5%',
    '',
    '5 not run:',
    '  statement  src/main/a.ts:10  if (x) {',
    '  branch     src/main/a.ts:12  ? y : z',
    '  branch     src/renderer/src/b.tsx:3  a ?? b',
    '  function   src/main/a.ts:20  function f() {',
    '  statement  src/shared/c.ts:1  export const c = 1',
    '  src/renderer/src/new.ts: never loaded by any test',
    '  branches: 89.97%, not more than 90%',
    '##[error]Process completed with exit code 1.',
  ]
    .map(at)
    .join('\n')
  expect(coverageOf(log)).toEqual([
    'src/renderer/src/new.ts: never loaded by any test',
    'branches: 89.97%, not more than 90%',
    'src/main/a.ts: 3 not run',
    'src/renderer/src/b.tsx: 1 not run',
    'src/shared/c.ts: 1 not run',
  ])
  // A gate that passed says nothing.
  expect(
    coverageOf(at('All 573 source files are loaded, and more than 90% of each measure runs.')),
  ).toEqual([])
  expect(
    redComment({
      what: 'Main’s nightly run',
      sha: 'abcdef0123456789',
      url: 'u',
      failedJobs: ['Coverage (all platforms)'],
      failed: [],
      flaky: [],
      coverage: coverageOf(log).slice(1, 3),
    }),
  ).toBe(
    [
      '**Main’s nightly run is red at abcdef0:** u',
      '',
      '- Coverage (all platforms)',
      '',
      'Coverage, where it fell:',
      '',
      '- branches: 89.97%, not more than 90%',
      '- src/main/a.ts: 3 not run',
    ].join('\n'),
  )
})

test('a run of main is red where a job failed or ran out of its time, green where all passed, and says nothing where somebody cancelled it', () => {
  expect(verdictOf(['success', 'failure', 'skipped'], false)).toBe('red')
  expect(verdictOf(['success', 'cancelled'], true)).toBe('red')
  expect(verdictOf(['success', 'cancelled'], false)).toBe('nothing')
  expect(verdictOf(['success', 'skipped'], false)).toBe('green')
})

test('main red opens an issue, or says so on the open one; green closes it; flaky tests go on their own; a pull request’s run never asks', () => {
  const said = {
    what: 'Main’s nightly run',
    sha: 'abcdef0123456789',
    url: 'https://github.com/Lumovi/Lumovi/actions/runs/9',
    failedJobs: ['E2E (ubuntu-latest, 2/16)'],
    failed: ['[desktop] › tests/e2e/settings.spec.ts:107 › the time zone'],
    flaky: ['[desktop] › tests/e2e/helm.spec.ts:284 › install and upgrade options'],
  }
  expect(redComment(said)).toBe(
    [
      '**Main’s nightly run is red at abcdef0:** https://github.com/Lumovi/Lumovi/actions/runs/9',
      '',
      '- E2E (ubuntu-latest, 2/16)',
      '',
      'Failed on every try:',
      '',
      '- [desktop] › tests/e2e/settings.spec.ts:107 › the time zone',
    ].join('\n'),
  )
  expect(flakyComment(said)).toBe(
    [
      '**Main’s nightly run at abcdef0**, passed only when tried again: https://github.com/Lumovi/Lumovi/actions/runs/9',
      '',
      '- [desktop] › tests/e2e/helm.spec.ts:284 › install and upgrade options',
    ].join('\n'),
  )
  // GitHub as asked here: this run's jobs, the issues open by label and their text, a job's
  // annotations, how two commits compare; and an issue made with the labels asked for, unless it
  // drops them.
  const RED_SHA = said.sha.padEnd(40, '0')
  const github = (
    jobs: Job[],
    {
      open = {},
      texts = {},
      annotations = {},
      compared = 'ahead',
      drops = false,
    }: {
      open?: Record<string, number>
      texts?: Record<number, string>
      annotations?: Record<number, string>
      compared?: string | ((base: string, head: string) => string)
      drops?: boolean
    } = {},
  ) => {
    const calls: unknown[][] = []
    const api: Api = (method, path, body) => {
      calls.push(body === undefined ? [method, path] : [method, path, body])
      if (path.includes('/attempts/2/jobs')) return { jobs }
      const label = /labels=([\w-]+)/.exec(path)?.[1]
      if (label) return open[label] === undefined ? [] : [{ number: open[label] }]
      const issue = /\/issues\/(\d+)$/.exec(path)?.[1]
      if (method === 'GET' && issue) return { body: texts[Number(issue)] }
      const comparing = /\/compare\/(\w+)\.\.\.(\w+)$/.exec(path)
      if (comparing) {
        const [, base, head] = comparing
        return { status: typeof compared === 'string' ? compared : compared(base!, head!) }
      }
      const annotated = /check-runs\/(\d+)\/annotations/.exec(path)
      if (annotated) return [{ message: annotations[Number(annotated[1])] ?? 'A step failed.' }]
      if (method !== 'POST' || !path.endsWith('/issues')) return {}
      const labels = drops ? [] : (body!.labels as string[]).map((name) => ({ name }))
      return { number: 40, labels }
    }
    const made = () => calls.filter(([method]) => method !== 'GET')
    return { api, calls, made }
  }
  const logs: Record<number, string> = {
    1: '  1 failed\n    [desktop] › tests/e2e/settings.spec.ts:107:1 › the time zone ──',
    2: '  1 flaky\n    [desktop] › tests/e2e/helm.spec.ts:284:1 › install and upgrade options',
    7: '  12 passed (1.0m)\n##[error]Worker teardown timeout of 60000ms exceeded.\n##[error]Process completed with exit code 1.',
  }
  const run = {
    repository: 'Lumovi/Lumovi',
    run: '9',
    attempt: '2',
    sha: RED_SHA,
    what: said.what,
    url: said.url,
  }
  const job = (id: number, name: string, conclusion: string | null): Job => ({
    id,
    name,
    conclusion,
  })
  const red = [
    job(1, 'E2E (ubuntu-latest, 2/16)', 'failure'),
    job(2, 'E2E (windows-latest, 1/4)', 'success'),
    job(3, 'Coverage (all platforms)', 'skipped'),
    job(4, 'CI passed', 'failure'),
    // (Its own, still running.)
    job(5, 'Whether main is red, said', null),
  ]
  const read: number[] = []
  const logOf = ({ id }: Job) => (read.push(id), logs[id] ?? '')
  const saidHere = { ...said, sha: RED_SHA }
  const note = `<!-- main-red at ${RED_SHA} -->`
  // Red, with none open: one opened, with what failed and its commit kept hidden in its text; the
  // flaky test on an issue of its own.
  const first = github(red)
  expect(tell(first.api, run, logOf, true)).toEqual(['Red: opened #40', 'Flaky: opened #40'])
  expect(first.made()).toEqual([
    [
      'POST',
      'repos/Lumovi/Lumovi/issues',
      { title: 'Main is red', body: `${redComment(saidHere)}\n\n${note}`, labels: ['main-red'] },
    ],
    [
      'POST',
      'repos/Lumovi/Lumovi/issues',
      {
        title: 'Tests that passed only when tried again',
        body: flakyComment(saidHere),
        labels: ['ci-flaky'],
      },
    ],
  ])
  // Only the logs of jobs that ran tests, and ran.
  expect(read).toEqual([1, 2])
  // Red again, of any commit, with both open: said on each, and the issue's note now this commit.
  const older = `<!-- main-red at ${'1'.repeat(40)} -->`
  const again = github(red, {
    open: { 'main-red': 12, 'ci-flaky': 7 },
    texts: { 12: `It began here.\n\n${older}` },
  })
  expect(tell(again.api, run, logOf, true)).toEqual(['Red: said on #12', 'Flaky: said on #7'])
  expect(again.made()).toEqual([
    ['POST', 'repos/Lumovi/Lumovi/issues/12/comments', { body: redComment(saidHere) }],
    ['PATCH', 'repos/Lumovi/Lumovi/issues/12', { body: `It began here.\n\n${note}` }],
    ['POST', 'repos/Lumovi/Lumovi/issues/7/comments', { body: flakyComment(saidHere) }],
  ])
  // Green, of everything and of the red commit or one after it: the issue closed, saying where.
  const green = [
    job(2, 'E2E (windows-latest, 1/4)', 'success'),
    job(3, 'Coverage (all platforms)', 'success'),
  ]
  const greenRun = { ...run, sha: 'b'.repeat(40) }
  const withRed = { open: { 'main-red': 12, 'ci-flaky': 7 }, texts: { 12: `Red.\n\n${note}` } }
  const closing = github(green, withRed)
  expect(tell(closing.api, greenRun, logOf, true)).toEqual([
    'Green: closed #12',
    'Flaky: said on #7',
  ])
  expect(closing.calls).toContainEqual([
    'GET',
    `repos/Lumovi/Lumovi/compare/${RED_SHA}...${'b'.repeat(40)}`,
  ])
  expect(closing.made().slice(0, 2)).toEqual([
    [
      'POST',
      'repos/Lumovi/Lumovi/issues/12/comments',
      { body: `**Green again at bbbbbbb:** ${said.url}` },
    ],
    ['PATCH', 'repos/Lumovi/Lumovi/issues/12', { state: 'closed', state_reason: 'completed' }],
  ])
  // Runs of two merges end in either order: a green of a commit before the newest red one leaves
  // it open. So does a green of less than everything, and an issue that names no red commit.
  for (const [compared, full, texts, left] of [
    [
      'behind',
      true,
      withRed.texts,
      `Green, of a commit before #12’s newest red (${RED_SHA.slice(0, 7)}): left open.`,
    ],
    [
      'diverged',
      true,
      withRed.texts,
      `Green, of a commit before #12’s newest red (${RED_SHA.slice(0, 7)}): left open.`,
    ],
    [
      'ahead',
      false,
      withRed.texts,
      'Green, of what ran here only: #12 left open for a run of everything.',
    ],
    ['ahead', true, { 12: 'Made by hand.' }, 'Green: #12 names no red commit, so it’s left open.'],
  ] as const) {
    const leaving = github(green, { ...withRed, texts, compared })
    expect(tell(leaving.api, greenRun, logOf, full)[0]).toBe(left)
    expect(leaving.made().filter(([, path]) => String(path).includes('/issues/12'))).toEqual([])
  }
  // Three commits of main, A before B before C, whose runs end C's red, A's red, B's green: A's
  // red doesn't put the issue's note back to A, so B's green, before C, leaves it open.
  const [A, B, C] = ['a', 'b', 'c'].map((letter) => letter.repeat(40)) as [string, string, string]
  const order = (base: string, head: string) =>
    head === base ? 'identical' : head > base ? 'ahead' : 'behind'
  const noted = (sha: string) => ({ 12: `Red.\n\n<!-- main-red at ${sha} -->` })
  const aRed = github(red, { open: { 'main-red': 12 }, texts: noted(C), compared: order })
  expect(tell(aRed.api, { ...run, sha: A }, logOf, true)[0]).toBe('Red: said on #12')
  expect(aRed.made().filter(([method]) => method === 'PATCH')).toEqual([])
  const bGreen = github(green, { open: { 'main-red': 12 }, texts: noted(C), compared: order })
  expect(tell(bGreen.api, { ...run, sha: B }, logOf, true)[0]).toBe(
    `Green, of a commit before #12’s newest red (ccccccc): left open.`,
  )
  // (And C's red after A's: the note moves on to C.)
  const cRed = github(red, { open: { 'main-red': 12 }, texts: noted(A), compared: order })
  tell(cRed.api, { ...run, sha: C }, logOf, true)
  expect(cRed.made().filter(([method]) => method === 'PATCH')).toEqual([
    ['PATCH', 'repos/Lumovi/Lumovi/issues/12', { body: `Red.\n\n<!-- main-red at ${C} -->` }],
  ])
  const quiet = github([job(3, 'Coverage (all platforms)', 'success')])
  expect(tell(quiet.api, greenRun, logOf, true)).toEqual(['Green.'])
  expect(quiet.made()).toEqual([])
  // Cancelled by somebody: nothing said, not even its flaky tests. Out of its time: red.
  const cancelled = [
    job(2, 'E2E (windows-latest, 1/4)', 'success'),
    job(6, 'E2E (macos-latest, 2/4)', 'cancelled'),
  ]
  const stopped = github(cancelled)
  expect(tell(stopped.api, run, logOf, true)).toEqual(['Cancelled by somebody: nothing said.'])
  expect(stopped.made()).toEqual([])
  const late = github(cancelled, {
    annotations: { 6: 'The job has exceeded the maximum execution time of 1h0m0s' },
  })
  expect(tell(late.api, run, logOf, true)[0]).toBe('Red: opened #40')
  // A job that failed with no test failed in it says what did, beside its name.
  const torn = github([job(7, 'E2E (windows-latest, 3/4)', 'failure')])
  tell(torn.api, run, logOf, true)
  expect(torn.made()[0]![2]).toMatchObject({
    body: expect.stringContaining(
      '- E2E (windows-latest, 3/4): Worker teardown timeout of 60000ms exceeded.',
    ),
  })
  // An issue GitHub made without its label: said, as later runs wouldn't find it.
  const dropped = github(red, { drops: true })
  expect(tell(dropped.api, run, logOf, true)[0]).toBe(
    'Red: opened #40\n::warning::#40 hasn’t the label main-red: later runs won’t find it. Is the label there, and may this token set it?',
  )
  // And a pull request's run never asks: the workflow's job is main's alone.
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')
  expect(workflow).toContain(
    "if: always() && github.event_name != 'pull_request' && github.ref == 'refs/heads/main'\n    needs: [changes, checks, e2e, new-tests, coverage, package, integration, browsers]\n    continue-on-error: true",
  )
  // And it's told whether this run ran everything.
  expect(workflow).toContain(
    'FULL: ${{ needs.changes.outputs.full }}\n        run: node scripts/main-red.ts',
  )
})

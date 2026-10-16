/**
 * What CI runs (scripts/ci-changes.ts): nothing but the checks for a pull request of docs; and on
 * macOS, for now, its smoke set for every pull request and every merge, whatever it changes,
 * with its full suite nightly, by hand, for a release's pull request, or where a label asks. Each
 * case with the files as a pull request would change them (a file moved is both where it was and
 * where it is).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  borrowedOf,
  fetchOf,
  fitOf,
  mainsOwn,
  onlyIn,
  pick,
  shardsIn,
  withoutChanged,
} from '../../scripts/borrow-coverage.ts'
import {
  isRelease,
  NAMES_A_SYSTEM,
  namingASystem,
  plan,
  ranMacosInFull,
} from '../../scripts/ci-changes.ts'
import { redOf, sentence, told, warningOf, type Gh } from '../../scripts/main-is-green.ts'
import { filesOf, missingFrom, newerThan, whyNot } from '../../scripts/release-starts.ts'

/** A pull request changing `changed`, on `branch`, with `labels`. */
const pr = (changed: string[], branch = 'lmv-1-x', labels: string[] = []) =>
  plan({ event: 'pull_request', branch, changed, labels })
const macos = (result: ReturnType<typeof plan>) =>
  result.e2e.filter((shard) => shard.os === 'macos-latest').map((shard) => shard.shard)
const FULL = ['1/4', '2/4', '3/4', '4/4']
/** Linux's fourteen shards, as the plan names them. */
const LINUX = Array.from({ length: 14 }, (_, i) => `${i + 1}/14`)
/** Each system's shards, as the plan names them. */
const shards = (result: ReturnType<typeof plan>, os: string) =>
  result.e2e.filter((shard) => shard.os === os).map((shard) => shard.shard)
/** The tests' projects each system runs, as one text each. */
const projects = (result: ReturnType<typeof plan>) =>
  Object.fromEntries(result.e2e.map((shard) => [shard.os, shard.projects]))
/** What each system's shards leave to Linux, as one text each. */
const only = (result: ReturnType<typeof plan>) =>
  Object.fromEntries(result.e2e.map((shard) => [shard.os, shard.only]))

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
  expect(pr(['src/main/menu.ts', 'docs/menu.md'])).toMatchObject({ docs: false, macos: false })
  expect(pr(['electron-builder.yml', 'docs/electron-builder.yml']).docs).toBe(false)
  expect(pr(['docs/x.ts']).docs).toBe(false)
  expect(pr(['tests/e2e/README.md']).docs).toBe(false)
  expect(pr(['src/renderer/public/sponsor/lumovi-light.png']).docs).toBe(false)
  expect(pr(['build/icon.png']).docs).toBe(false)
})

test('a pull request that changes a system’s own runs macOS’s smoke set, Windows and Linux in full', () => {
  // The app's own process, Electron, packaging, the lockfile, CI itself, the harness: each was a
  // reason for macOS's full suite once, and is one for every system still.
  for (const changed of [
    ['src/main/menu.ts'],
    ['electron-builder.yml', 'package-lock.json'],
    ['.github/workflows/ci.yml', 'scripts/ci-changes.ts'],
    ['tests/e2e/fixtures.ts', 'tests/e2e/smoke.txt'],
  ]) {
    const result = pr(changed)
    expect(result, changed.join(' ')).toMatchObject({ docs: false, macos: false, platforms: true })
    expect(macos(result)).toEqual(['smoke'])
    // Linux runs the browser's tests too, and the desktop tests alike everywhere: over fourteen.
    expect(shards(result, 'ubuntu-latest')).toEqual(LINUX)
    expect(shards(result, 'windows-latest')).toEqual(FULL)
    expect(result.said).toContain('macOS runs its smoke set (its full suite runs nightly')
  }
})

test('the label macos-full runs everything on macOS, whatever changed', () => {
  const path = 'src/renderer/src/features/lists/ResourceList.tsx'
  // (Alike on every system: Linux alone.)
  expect(macos(pr([path]))).toEqual([])
  const asked = pr([path], 'lmv-1-x', ['design', 'macos-full'])
  expect(asked.macos).toBe(true)
  expect(macos(asked)).toEqual(FULL)
  expect(asked.said).toContain('as its label asks')
  // A label is a pull request's: a merge's run has none to ask with.
  expect(macos(plan({ event: 'push', changed: [path], labels: ['macos-full'] }))).toEqual(['smoke'])
})

test('a pull request whose changes are alike on every system runs Linux alone, in full', () => {
  for (const changed of [
    ['src/renderer/src/features/lists/ResourceList.tsx', 'tests/e2e/lists.spec.ts'],
    ['src/shared/kit/parts.ts', 'tests/web/audit.spec.ts'],
    ['src/server/index.ts', 'charts/lumovi/values.yaml'],
    ['tests/plugins/plugins.spec.ts'],
    ['tests/integration/metrics.spec.ts', 'tests/durations.json', 'changelog.d/x.fixed.md'],
  ]) {
    const result = pr(changed)
    expect(result, changed.join(' ')).toMatchObject({ docs: false, platforms: false })
    expect(shards(result, 'ubuntu-latest')).toEqual(LINUX)
    expect(shards(result, 'windows-latest')).toEqual([])
    expect(macos(result)).toEqual([])
    expect(result.said).toContain('Linux alone: nothing it changes is a system’s own')
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
    expect(shards(result, 'windows-latest')).toEqual(FULL)
  }
  // A release's pull request, a label's ask, main's merge, nightly and a run by hand: every system.
  expect(pr(['src/renderer/x.tsx'], 'release-1.23.0').platforms).toBe(true)
  expect(pr(['src/renderer/x.tsx'], 'lmv-1-x', ['macos-full']).platforms).toBe(true)
  for (const event of ['push', 'schedule', 'workflow_dispatch']) {
    expect(plan({ event, changed: ['src/renderer/x.tsx'] }).platforms, event).toBe(true)
  }
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

test('the integration tests run for anything they see: a pull request of the other tests alone runs none', () => {
  const others = pr([
    'tests/e2e/lists.spec.ts',
    'tests/web/audit.spec.ts',
    'tests/mock-cluster/fixtures/demo.ts',
    'tests/plugins/plugins.spec.ts',
    'tests/durations.json',
    'changelog.d/x.fixed.md',
  ])
  expect(others.integration).toBe(false)
  expect(others.said).toContain('No integration tests: nothing it changes is theirs.')
  // The server, the chart, the image, the app, the pages, CI, their own tests, a path not named.
  for (const changed of [
    'src/backend/audit/log.ts',
    'src/server/index.ts',
    'charts/lumovi/values.yaml',
    'Dockerfile',
    'src/main/kube.ts',
    'src/renderer/src/features/lists/ResourceList.tsx',
    'src/shared/metrics-stack.ts',
    '.github/workflows/ci.yml',
    'tests/integration/metrics.spec.ts',
    'something-new/file.ts',
  ]) {
    expect(pr(['tests/e2e/lists.spec.ts', changed]).integration, changed).toBe(true)
  }
  // Main's merge, nightly, a run by hand and a release's pull request: always.
  for (const event of ['push', 'schedule', 'workflow_dispatch']) {
    expect(plan({ event, changed: ['tests/e2e/lists.spec.ts'] }).integration, event).toBe(true)
  }
  expect(pr(['tests/e2e/lists.spec.ts'], 'release-1.23.0').integration).toBe(true)
})

test('main’s merge runs Linux and Windows in full and macOS’s smoke set; its tests run even for docs', () => {
  for (const changed of [['src/main/menu.ts'], ['README.md']]) {
    const result = plan({ event: 'push', changed })
    expect(result).toMatchObject({ docs: false, macos: false })
    expect(macos(result)).toEqual(['smoke'])
    expect(result.e2e).toHaveLength(19)
    // Every merge runs Windows and macOS, whatever it changed.
    expect(result.platforms).toBe(true)
    expect(shards(result, 'windows-latest')).toEqual(FULL)
    expect(shards(result, 'ubuntu-latest')).toEqual(LINUX)
    expect(result.said).toContain('Main’s merge')
    // The browser's tests on Linux alone, where the server Lumovi ships runs; and Windows leaves
    // to Linux the desktop tests alike on every system (macOS runs its smoke set by name).
    expect(projects(result)).toEqual({
      'ubuntu-latest': 'desktop web',
      'macos-latest': 'desktop',
      'windows-latest': 'desktop',
    })
    expect(only(result)).toEqual({
      'ubuntu-latest': '',
      'macos-latest': '',
      'windows-latest': 'system',
    })
  }
  // macOS in full, as its label asks, is all of the desktop app's tests there.
  expect(only(pr(['x.ts'], 'lmv-1-x', ['macos-full']))).toEqual({
    'ubuntu-latest': '',
    'macos-latest': '',
    'windows-latest': 'system',
  })
  // And for a pull request, whatever it changes or its label asks.
  for (const result of [pr(['src/main/menu.ts']), pr(['x.ts'], 'lmv-1-x', ['macos-full'])]) {
    expect(projects(result)).toEqual({
      'ubuntu-latest': 'desktop web',
      'macos-latest': 'desktop',
      'windows-latest': 'desktop',
    })
    expect(result.said).toContain('The browser’s tests run on Linux (on every system nightly).')
  }
})

test('main’s nightly run, a run by hand and a release’s pull request run everything, macOS in full', () => {
  for (const [result, said] of [
    [plan({ event: 'schedule', changed: [] }), 'Main’s nightly run'],
    [plan({ event: 'workflow_dispatch', changed: [] }), 'A run by hand'],
    [pr(['CHANGELOG.md', 'package.json'], 'release-1.16.0'), 'A release’s pull request'],
    [pr(['README.md'], 'release-1.16.0'), 'A release’s pull request'],
  ] as const) {
    expect(result).toMatchObject({ docs: false, macos: true })
    expect(result.e2e).toHaveLength(22)
    expect(result.said).toContain(said)
    // Every system runs every test: a break in the browser's on one system shows here.
    expect(new Set(result.e2e.map((shard) => shard.projects))).toEqual(new Set(['desktop web']))
    expect(new Set(result.e2e.map((shard) => shard.only))).toEqual(new Set(['']))
  }
})

test('a release’s pull request is its version’s branch alone: another whose name starts the same is an ordinary one', () => {
  for (const branch of ['release-1.22.0', 'release-2.0.0-rc.1']) {
    expect(isRelease(branch), branch).toBe(true)
    expect(pr(['x.ts'], branch)).toMatchObject({ release: true, macos: true })
  }
  for (const branch of [
    'release-guard',
    'release-waits-for-approval',
    'release-1.22',
    'release-v1.22.0',
  ]) {
    expect(isRelease(branch), branch).toBe(false)
    const result = pr(['x.ts'], branch)
    expect(result).toMatchObject({ release: false, macos: false })
    expect(result.said).not.toContain('A release’s pull request')
  }
  // Nor is a branch of that name pushed to main, or main's own runs.
  expect(plan({ event: 'push', branch: 'release-1.22.0', changed: ['x.ts'] }).release).toBe(false)
  expect(plan({ event: 'schedule', changed: [] }).release).toBe(false)
})

test('a shard of a system’s tests is of the projects CI names: the browser’s left out where it says', () => {
  const listed = (env: Record<string, string>) =>
    execFileSync(process.execPath, ['scripts/e2e-shard.ts', '1/1'], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean)
  const desktop = listed({ E2E_PROJECTS: 'desktop' })
  expect(desktop.length).toBeGreaterThan(100)
  expect(desktop.every((name) => name.startsWith('[desktop] › '))).toBe(true)
  const both = listed({ E2E_PROJECTS: 'desktop web' })
  expect(both.some((name) => name.startsWith('[web] › '))).toBe(true)
  expect(both.length).toBeGreaterThan(desktop.length)
  // Where CI names none (a plan that says nothing of them), every project's.
  expect(listed({ E2E_PROJECTS: '' })).toEqual(both)
  // A system's shard leaves the desktop tests alike on every system to Linux: each named spec is
  // there, and none of its tests is in the system's shard.
  const alike = readFileSync('tests/e2e/linux-only.txt', 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
  expect(alike.length).toBeGreaterThan(5)
  const system = listed({ E2E_PROJECTS: 'desktop', E2E_ONLY: 'system' })
  for (const file of alike) {
    expect(
      desktop.some((name) => name.startsWith(`[desktop] › ${file} › `)),
      file,
    ).toBe(true)
    expect(
      system.some((name) => name.startsWith(`[desktop] › ${file} › `)),
      file,
    ).toBe(false)
  }
  expect(system.length).toBeLessThan(desktop.length)
  // The specs that rest on what a system does are never left to Linux.
  for (const kept of [
    'plugin-box',
    'plugin-hand-over',
    'plugin-page',
    'secret-by-key',
    'safety',
    'details',
  ]) {
    expect(alike, kept).not.toContain(`tests/e2e/${kept}.spec.ts`)
  }
})

test('a nightly run on a head that’s run macOS in full already runs nothing more', () => {
  const again = plan({ event: 'schedule', changed: [], ranAlready: true })
  expect(again).toMatchObject({ docs: true, macos: false })
  expect(again.said).toBe(
    'Main’s nightly run: its head has run macOS in full already, so nothing more runs.',
  )
  // Only a nightly run is spared so: anything else runs as it would.
  expect(plan({ event: 'push', changed: ['src/main/menu.ts'], ranAlready: true }).docs).toBe(false)
  expect(plan({ event: 'workflow_dispatch', changed: [], ranAlready: true }).macos).toBe(true)
})

test('the full macOS run borrowed from is one that kept every shard’s coverage, not the smoke set’s', () => {
  const full = [
    'coverage-Linux-1',
    'coverage-macOS-1',
    'coverage-macOS-2',
    'coverage-macOS-3',
    'coverage-macOS-4',
  ]
  expect(ranMacosInFull(full)).toBe(true)
  expect(ranMacosInFull(['coverage-Linux-1', 'coverage-macOS-smoke'])).toBe(false)
  expect(ranMacosInFull(full.filter((name) => name !== 'coverage-macOS-3'))).toBe(false)
  expect(ranMacosInFull([])).toBe(false)
  // And what it keeps leaves out the files a change touched: this run's own speak for them.
  const path = 'src/renderer/src/features/overview/OverviewPage.tsx'
  const main = { [path]: { s: { 0: 9 } }, 'src/main/menu.ts': { s: { 0: 2 } } }
  expect(Object.keys(withoutChanged(main, [path]))).toEqual(['src/main/menu.ts'])
})

test('where macOS ran the smoke set, main’s macOS coverage is borrowed: not of files that changed', () => {
  const main = {
    'src/main/terminal-keys.ts': { s: { 0: 3 } },
    'src/renderer/src/features/lists/ResourceList.tsx': { s: { 0: 1 } },
    // (As Windows writes a path, should a run there ever be borrowed.)
    'src\\main\\menu.ts': { s: { 0: 2 } },
  }
  // What only macOS reaches is what main reached; a file that isn't main's any more has other
  // lines than its coverage counts, and this run's Linux and Windows speak for it.
  expect(
    Object.keys(
      withoutChanged(main, [
        'src/renderer/src/features/lists/ResourceList.tsx',
        'src/main/menu.ts',
      ]),
    ),
  ).toEqual(['src/main/terminal-keys.ts'])
  expect(withoutChanged(main, [])).toEqual(main)
})

test('what’s borrowed is what main’s macOS reached and its Linux and Windows didn’t: nothing else', () => {
  const file = (s: number[], f: number[], b: number[][]) => ({
    path: 'kept as it is',
    s: Object.fromEntries(s.map((n, i) => [i, n])),
    f: Object.fromEntries(f.map((n, i) => [i, n])),
    b: Object.fromEntries(b.map((arms, i) => [i, arms])),
  })
  // macOS's two shards together reach statements 0, 1 and 2; the others reach 0 and 3.
  const mac: Record<string, ReturnType<typeof file>>[] = [
    { 'src/main/menu.ts': file([1, 0, 0, 0], [1], [[2, 0]]) },
    {
      'src/main/menu.ts': file([0, 4, 1, 0], [0], [[0, 3]]),
      'src/main/dock.ts': file([5], [5], []),
    },
  ]
  const others: Record<string, ReturnType<typeof file>>[] = [
    // (As Windows writes a path.)
    { 'src\\main\\menu.ts': file([7, 0, 0, 1], [0], [[1, 0]]) },
    { 'src/main/menu.ts': file([0, 0, 0, 0], [0], [[0, 0]]) },
  ]
  expect(onlyIn(mac, others)).toEqual({
    // Statement 0 and the branch's first arm are the others' too: not borrowed. What they never
    // reached is, with macOS's own counts; and a file they never loaded, whole.
    'src/main/menu.ts': file([0, 4, 1, 0], [1], [[0, 3]]),
    'src/main/dock.ts': file([5], [5], []),
  })
  // So a test taken away in a pull request loses what it reached, unless only macOS reached it.
  expect(onlyIn(mac, mac)['src/main/menu.ts']).toEqual(file([0, 0, 0, 0], [0], [[0, 0]]))
})

test('what’s borrowed is every shard’s or nothing, and never a file that isn’t coverage', () => {
  const shard = JSON.stringify({
    'src/main/menu.ts': { s: { 0: 2 }, f: {}, b: {} },
    'src/a.ts': { s: { 0: 1 }, f: {}, b: {} },
  })
  const none = JSON.stringify({ 'src/main/menu.ts': { s: { 0: 0 }, f: {}, b: {} } })
  const mac = [shard, shard, shard, shard]
  const of = (count: number, text = none) => Array.from({ length: count }, () => text)
  // (A run of main from before Linux's fourteen shards keeps six of Linux's; after, fourteen.)
  for (const linux of [6, 14]) {
    const texts = { mac, linux: of(linux), windows: of(4) }
    expect(borrowedOf(texts, ['src/a.ts'], { linux, windows: 4 })).toEqual({
      kept: { 'src/main/menu.ts': { s: { 0: 8 }, f: {}, b: {} } },
    })
  }
  const texts = { mac, linux: of(14), windows: of(4) }
  const shards = { linux: 14, windows: 4 }
  // Three of four would be most of what macOS reaches, and read as all of it; and with one of
  // the others' missing, what it reached would be taken for macOS's alone.
  expect(borrowedOf({ ...texts, mac: mac.slice(1) }, [], shards)).toEqual({
    nothing: '3 of macOS’s 4 coverage files are there, not all of them',
  })
  expect(borrowedOf({ ...texts, mac: [] }, [], shards)).toEqual({
    nothing: '0 of macOS’s 4 coverage files are there, not all of them',
  })
  expect(borrowedOf({ ...texts, linux: of(13) }, [], shards)).toEqual({
    nothing: '13 of Linux’s 14 coverage files are there, not all of them',
  })
  expect(borrowedOf({ ...texts, windows: of(3) }, [], shards)).toEqual({
    nothing: '3 of Windows’ 4 coverage files are there, not all of them',
  })
  expect(borrowedOf({ ...texts, mac: [shard, shard, shard, 'cut sh'] }, [], shards)).toEqual({
    nothing: 'one of its files isn’t JSON',
  })
  expect(borrowedOf({ ...texts, windows: [...of(3), '[]'] }, [], shards)).toEqual({
    nothing: 'one of its files isn’t coverage',
  })
})

test('where Linux alone ran, what main’s macOS and Windows reached and its Linux didn’t is borrowed alike', () => {
  const coverage = (s: number) =>
    JSON.stringify({ 'src/main/menu.ts': { s: { 0: s }, f: {}, b: {} } })
  const texts = {
    mac: Array.from({ length: 4 }, () => coverage(0)),
    linux: [coverage(0)],
    windows: [coverage(3)],
  }
  const shards = { linux: 1, windows: 1 }
  // Windows ran here: what only its shards reached there is this run's own to reach again.
  expect(borrowedOf(texts, [], shards)).toEqual({
    kept: { 'src/main/menu.ts': { s: { 0: 0 }, f: {}, b: {} } },
  })
  // It didn't: what main's Windows reached, and its Linux didn't, is borrowed with macOS's.
  expect(borrowedOf(texts, [], shards, false)).toEqual({
    kept: { 'src/main/menu.ts': { s: { 0: 3 }, f: {}, b: {} } },
  })
  // And never of what main's Linux reached too, nor of a file that changed.
  expect(borrowedOf({ ...texts, linux: [coverage(1)] }, [], shards, false)).toEqual({
    kept: { 'src/main/menu.ts': { s: { 0: 0 }, f: {}, b: {} } },
  })
  expect(borrowedOf(texts, ['src/main/menu.ts'], shards, false)).toEqual({ kept: {} })
})

test('a run of main is borrowed from only whole: every Linux and Windows shard, and macOS in full or its smoke set', () => {
  const jobs = [
    ...Array.from({ length: 14 }, (_, i) => `E2E (ubuntu-latest, ${i + 1}/14)`),
    ...Array.from({ length: 4 }, (_, i) => `E2E (windows-latest, ${i + 1}/4)`),
  ]
  const files = (system: string, count: number) =>
    Array.from({ length: count }, (_, i) => `coverage-${system}-${i + 1}`)
  const merge = [...files('Linux', 14), ...files('Windows', 4), 'coverage-macOS-smoke']
  const nightly = [...files('Linux', 14), ...files('Windows', 4), ...files('macOS', 4)]
  expect(fitOf(merge, jobs)).toEqual({ linux: 14, windows: 4, mac: 1, full: false })
  expect(fitOf(nightly, jobs)).toEqual({ linux: 14, windows: 4, mac: 4, full: true })
  // A shard's file missing, or macOS's: not whole, so not borrowed from.
  expect(
    fitOf(
      merge.filter((name) => name !== 'coverage-Windows-3'),
      jobs,
    ),
  ).toBeUndefined()
  expect(
    fitOf(
      merge.filter((name) => name !== 'coverage-Linux-14'),
      jobs,
    ),
  ).toBeUndefined()
  expect(
    fitOf(
      merge.filter((name) => name !== 'coverage-macOS-smoke'),
      jobs,
    ),
  ).toBeUndefined()
  expect(fitOf(merge, jobs.slice(0, 14))).toBeUndefined()

  const runs = [
    { run: 'newest merge', fit: fitOf(merge, jobs) },
    { run: 'a merge with a file gone', fit: undefined },
    { run: 'nightly', fit: fitOf(nightly, jobs) },
    { run: 'older merge', fit: fitOf(merge, jobs) },
  ]
  // macOS ran its smoke set here: only a full macOS run says what only macOS reaches.
  expect(pick(runs, true)?.run).toBe('nightly')
  expect(pick([runs[0]!, runs[3]!], true)).toBeUndefined()
  // Linux alone: a full run where one is kept; else the newest merge's, which every day has.
  expect(pick(runs, false)?.run).toBe('nightly')
  expect(pick([runs[0]!, runs[1]!, runs[3]!], false)?.run).toBe('newest merge')
  expect(pick([runs[1]!], false)).toBeUndefined()
  // Only main's own runs: a pull request from a fork's own `main` branch is listed as main's too,
  // and its coverage files are its own code's to write. Newer and whole, it's still skipped.
  const listed = [
    { databaseId: 9, event: 'pull_request' },
    { databaseId: 8, event: 'push' },
    { databaseId: 7, event: 'schedule' },
    { databaseId: 6, event: 'workflow_dispatch' },
    { databaseId: 5, event: 'pull_request_target' },
  ]
  expect(mainsOwn(listed).map(({ databaseId }) => databaseId)).toEqual([8, 7, 6])
  const fork = { run: 'a fork’s main, newest', fit: fitOf(nightly, jobs), event: 'pull_request' }
  const own = mainsOwn([fork, ...runs.map((each) => ({ ...each, event: 'push' }))])
  expect(pick(own, false)?.run).toBe('nightly')
  expect(pick(own, true)?.run).toBe('nightly')
  // And from a merge's run, macOS's one smoke file is all of macOS's there is to borrow.
  const coverage = (s: number) =>
    JSON.stringify({ 'src/main/mcp-node.ts': { s: { 0: s }, f: {}, b: {} } })
  expect(
    borrowedOf(
      { mac: [coverage(2)], linux: [coverage(0)], windows: [coverage(1)] },
      [],
      { linux: 1, windows: 1, mac: 1 },
      false,
    ),
  ).toEqual({ kept: { 'src/main/mcp-node.ts': { s: { 0: 3 }, f: {}, b: {} } } })
  expect(
    borrowedOf(
      { mac: [], linux: [coverage(0)], windows: [coverage(1)] },
      [],
      { linux: 1, windows: 1, mac: 1 },
      false,
    ),
  ).toEqual({ nothing: '0 of macOS’s 1 coverage files are there, not all of them' })
})

test('how many of Linux’s and Windows’ coverage files a run of main has: as its E2E jobs say each was split', () => {
  const jobs = (linux: number, windows: number) => [
    'What changed',
    'E2E (macos-latest, smoke)',
    ...Array.from({ length: linux }, (_, i) => `E2E (ubuntu-latest, ${i + 1}/${linux})`),
    ...Array.from({ length: windows }, (_, i) => `E2E (windows-latest, ${i + 1}/${windows})`),
    'Coverage (all platforms)',
  ]
  // (A run from before Linux's fourteen shards, and one after.)
  expect(shardsIn(jobs(6, 4))).toEqual({ linux: 6, windows: 4 })
  expect(shardsIn(jobs(14, 4))).toEqual({ linux: 14, windows: 4 })
  // However many of a platform's jobs are listed, its count is what their names say it was split into.
  expect(shardsIn(jobs(14, 4).filter((name) => name !== 'E2E (ubuntu-latest, 14/14)'))).toEqual({
    linux: 14,
    windows: 4,
  })
  // A platform with no such job: nothing to count.
  expect(shardsIn(jobs(0, 4))).toBeUndefined()
  expect(shardsIn(jobs(14, 0))).toBeUndefined()
})

test('main’s commit is fetched to compare with, and a full clone stays full: only a shallow one fetches it alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-fetch-'))
  try {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      }).trim()
    const origin = join(dir, 'origin')
    git(dir, 'init', '--quiet', '-b', 'main', origin)
    for (const n of [1, 2, 3]) {
      git(
        origin,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        `${n}`,
      )
    }
    const sha = git(origin, 'rev-parse', 'HEAD~1')
    const shallowOf = (cwd: string) => git(cwd, 'rev-parse', '--is-shallow-repository') === 'true'
    // A person's clone, whole: the commit's fetched and the clone keeps every commit.
    const full = join(dir, 'full')
    git(dir, 'clone', '--quiet', `file://${origin}`, full)
    git(full, ...fetchOf(sha, shallowOf(full)))
    expect(shallowOf(full)).toBe(false)
    expect(git(full, 'rev-list', '--count', 'HEAD')).toBe('3')
    // CI's checkout, shallow: the commit alone is fetched, and it's there to compare with.
    const ci = join(dir, 'ci')
    git(dir, 'clone', '--quiet', '--depth=1', `file://${origin}`, ci)
    expect(fetchOf(sha, shallowOf(ci))).toContain('--depth=1')
    git(ci, ...fetchOf(sha, shallowOf(ci)))
    expect(git(ci, 'cat-file', '-t', sha)).toBe('commit')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

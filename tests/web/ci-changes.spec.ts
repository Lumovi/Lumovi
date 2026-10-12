/**
 * What CI runs for a change (scripts/ci-changes.ts): nothing but the checks for docs, and on
 * macOS, the full E2E suite only where it touches what macOS does differently. Each case with
 * the files as a pull request would change them (a file moved is both where it was and where it
 * is), and what's in them, then and now.
 */
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { borrowedOf, onlyMac, withoutChanged } from '../../scripts/borrow-coverage.ts'
import { MACOS_JOBS, plan, workflowParts } from '../../scripts/ci-changes.ts'
import { redOf, sentence, told, warningOf, type Gh } from '../../scripts/main-is-green.ts'
import { filesOf, missingFrom, newerThan, whyNot } from '../../scripts/release-starts.ts'

/** A pull request changing `changed`, whose files hold `texts` (now, or then: deleted). */
const pr = (changed: string[], texts: Record<string, string[]> = {}, branch = 'lmv-1-x') =>
  plan({
    event: 'pull_request',
    branch,
    changed,
    versions: (path) => texts[path] ?? ['', ''],
  })
const macos = (result: ReturnType<typeof plan>) =>
  result.e2e.filter((shard) => shard.os === 'macos-latest').map((shard) => shard.shard)

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
  expect(pr(['src/main/menu.ts', 'docs/menu.md'])).toMatchObject({ docs: false, macos: true })
  expect(pr(['electron-builder.yml', 'docs/electron-builder.yml']).docs).toBe(false)
  expect(pr(['docs/x.ts']).docs).toBe(false)
  expect(pr(['tests/e2e/README.md']).docs).toBe(false)
  expect(pr(['src/renderer/public/sponsor/lumovi-light.png']).docs).toBe(false)
  expect(pr(['build/icon.png']).docs).toBe(false)
})

test('macOS runs everything for the main process, Electron, packaging, the lockfile, CI and the harness', () => {
  for (const path of [
    'src/main/window.ts',
    'src/preload/index.ts',
    'electron-builder.yml',
    'electron.vite.config.ts',
    'build/entitlements.mac.plist',
    'packaging/after-pack.mjs',
    'package.json',
    'package-lock.json',
    'playwright.config.ts',
    'tests/e2e/fixtures.ts',
    'tests/e2e/smoke.txt',
    'scripts/borrow-coverage.ts',
    'scripts/vite-coverage.ts',
  ]) {
    expect(macos(pr([path])), path).toEqual(['1/4', '2/4', '3/4', '4/4'])
  }
})

test('code every platform runs alike is the smoke set’s, unless it asks which platform it’s on', () => {
  // The backend and what's shared with the page: Node's, the same on all three.
  for (const path of ['src/backend/kube/list.ts', 'src/shared/api.ts']) {
    expect(macos(pr([path], { [path]: ['export const x = 1', ''] })), path).toEqual(['smoke'])
  }
  // But not its files that start programs or use the home and temp folders, by name…
  for (const path of [
    'src/backend/helm/service.ts',
    'src/backend/kube/client.ts',
    'src/backend/kube/kubeconfig.ts',
    'src/backend/kube/files.ts',
    'src/backend/kube/streams.ts',
    'src/backend/network.ts',
  ]) {
    expect(pr([path], { [path]: ['export const x = 1', ''] }).macos, path).toBe(true)
  }
  // …nor any other that comes to do the same.
  for (const text of [
    "import { spawn } from 'node:child_process'",
    'const dir = tmpdir()',
    'join(homedir(), ".kube")',
  ]) {
    const path = 'src/backend/kube/new.ts'
    expect(pr([path], { [path]: [text, ''] }).macos, text).toBe(true)
  }
  const asks = 'src/backend/kube/exec.ts'
  expect(
    pr([asks], { [asks]: ["const shell = process.platform === 'win32' ? cmd : sh", ''] }).macos,
  ).toBe(true)
})

test('the label macos-full runs everything on macOS, whatever changed', () => {
  const path = 'src/renderer/src/features/lists/ResourceList.tsx'
  const plain = { event: 'pull_request', changed: [path], versions: () => ['', ''] }
  expect(macos(plan(plain))).toEqual(['smoke'])
  const asked = plan({ ...plain, labels: ['design', 'macos-full'] })
  expect(macos(asked)).toEqual(['1/4', '2/4', '3/4', '4/4'])
  expect(asked.said).toContain('as its label asks')
})

test('macOS runs everything for code that does differently there, as it is or as it was', () => {
  const cases: Record<string, string> = {
    'src/renderer/src/features/commands/Commands.tsx': 'if (event.metaKey || event.ctrlKey) open()',
    'src/renderer/src/features/terminal/session.ts': "if (api.platform === 'win32') paste()",
    'src/renderer/src/components/Kbd.tsx': 'const mod = MOD_KEY',
    'src/renderer/src/styles/index.css': '.titlebar { -webkit-app-region: drag; }',
    'src/renderer/src/lib/os.ts': 'navigator.userAgentData?.platform',
  }
  for (const [path, text] of Object.entries(cases)) {
    expect(pr([path], { [path]: [text, ''] }).macos, path).toBe(true)
  }
  // Deleted: only what it was.
  const gone = 'src/renderer/src/lib/mac.ts'
  expect(
    pr([gone], { [gone]: ['', "export const isMac = process.platform === 'darwin'"] }).macos,
  ).toBe(true)
})

test('a word that asks for the platform in a comment asks nothing; in code, it asks wherever it is', () => {
  const quiet: Record<string, string> = {
    'src/shared/api.ts':
      '/** The operating system the page runs on, as Node.js names it (darwin, win32, linux). */\nplatform: string',
    'src/renderer/src/kit/Width.ts': 'const width = 280 // ⌘ on macOS (metaKey), Ctrl elsewhere',
    'src/renderer/src/kit/List.tsx': '{/* The list reads metaKey itself. */}\n<List />',
    'src/renderer/src/styles/kit.css':
      '/* Not app-region: the page scrolls. */\n.kit { overflow: auto; }',
  }
  for (const [path, text] of Object.entries(quiet)) {
    expect(pr([path], { [path]: [text, ''] }).macos, path).toBe(false)
  }
  const asks: Record<string, string> = {
    'src/renderer/src/kit/Link.tsx': "open('https://lumovi.dev'); if (event.metaKey) more()",
    'src/renderer/src/kit/Keys.ts': 'const mod = MOD_KEY /* ⌘ or Ctrl */',
    'src/renderer/src/kit/Press.ts': '/* What a key does. */ if (event.metaKey) open()',
    // (A string that holds `//` or `/*` starts no comment: what follows it is still code.)
    'src/renderer/src/kit/Url.ts':
      "const shown = 'a // b'; if (process.platform === 'darwin') narrower()",
    'src/renderer/src/kit/Files.ts':
      "const glob = 'plugins /*.yaml'\nif (event.metaKey) open()\nconst end = '*/'",
  }
  for (const [path, text] of Object.entries(asks)) {
    expect(pr([path], { [path]: [text, ''] }).macos, path).toBe(true)
  }
})

test('a workflow runs macOS in full only where it changes CI’s top, or a job that decides, runs or gathers macOS’s share', () => {
  const CI = '.github/workflows/ci.yml'
  const FULL = ['1/4', '2/4', '3/4', '4/4']
  const was = [
    'name: CI',
    'on:',
    '  pull_request:',
    'env:',
    "  CSC_IDENTITY_AUTO_DISCOVERY: 'false'",
    'jobs:',
    '  # What the change needs run.',
    '  changes:',
    '    runs-on: ubuntu-latest',
    '  checks:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: npm run lint',
    '  e2e:',
    '    runs-on: ${{ matrix.os }}',
    '    steps:',
    '      - run: npm run build:coverage',
    '  coverage:',
    '    runs-on: ubuntu-latest',
    '  browsers:',
    '    runs-on: ubuntu-latest',
  ].join('\n')
  const changing = (from: string, to: string) => {
    const now = was.replace(from, to)
    expect(now).not.toBe(was)
    return macos(pr([CI], { [CI]: [now, was] }))
  }
  // A job that doesn't run macOS's tests, a job added beside them, a comment: the smoke set.
  expect(changing('npm run lint', 'npm run lint -- --max-warnings 0')).toEqual(['smoke'])
  expect(
    changing('  browsers:\n    runs-on: ubuntu-latest', '  browsers:\n    runs-on: ubuntu-24.04'),
  ).toEqual(['smoke'])
  expect(changing('  browsers:', '  more:\n    runs-on: ubuntu-latest\n  browsers:')).toEqual([
    'smoke',
  ])
  expect(changing('# What the change needs run.', '# What a change needs run.')).toEqual(['smoke'])
  // Its top, and the jobs that decide macOS's share, run it and gather its coverage: everything.
  expect(changing("'false'", "'true'")).toEqual(FULL)
  expect(
    changing('  changes:\n    runs-on: ubuntu-latest', '  changes:\n    runs-on: ubuntu-24.04'),
  ).toEqual(FULL)
  expect(changing('npm run build:coverage', 'npm run build')).toEqual(FULL)
  expect(
    changing('  coverage:\n    runs-on: ubuntu-latest', '  coverage:\n    runs-on: ubuntu-24.04'),
  ).toEqual(FULL)
  // The workflow new, or gone: everything.
  expect(macos(pr([CI], { [CI]: [was, ''] }))).toEqual(FULL)
  expect(macos(pr([CI], { [CI]: ['', was] }))).toEqual(FULL)
  // Another workflow runs no E2E test: the smoke set.
  for (const path of ['.github/workflows/release.yml', '.github/workflows/pull-request.yml']) {
    const text = 'name: x\njobs:\n  build:\n    runs-on: macos-latest'
    expect(macos(pr([path], { [path]: [text, ''] })), path).toEqual(['smoke'])
  }
  // CI's workflow as it is has those jobs, by those names: renamed, this would stop seeing them.
  const parts = workflowParts(readFileSync(CI, 'utf8'))
  for (const job of MACOS_JOBS) expect(parts.has(job), job).toBe(true)
  expect(parts.get('e2e')).toContain('needs.changes.outputs.e2e')
  expect(parts.get('coverage')).toContain('needs.changes.outputs.macos')
})

test('macOS runs the smoke set for the rest; Linux and Windows always run everything', () => {
  const path = 'src/renderer/src/features/lists/ResourceList.tsx'
  const result = pr([path, 'CHANGELOG.md'], { [path]: ['export function ResourceList() {}', ''] })
  expect(result).toMatchObject({ docs: false, macos: false })
  expect(macos(result)).toEqual(['smoke'])
  for (const os of ['ubuntu-latest', 'windows-latest']) {
    expect(result.e2e.filter((shard) => shard.os === os)).toHaveLength(4)
  }
  expect(result.said).toContain('macOS runs the smoke set')
})

test('a change to a file macOS covers, that asks nothing of the platform: the smoke set, and its borrowed coverage dropped', () => {
  // The renderer's own file: macOS reaches it on main, as every platform does.
  const path = 'src/renderer/src/features/overview/OverviewPage.tsx'
  expect(macos(pr([path], { [path]: ['export function OverviewPage() {}', ''] }))).toEqual([
    'smoke',
  ])
  const main = { [path]: { s: { 0: 9 } }, 'src/main/menu.ts': { s: { 0: 2 } } }
  expect(Object.keys(withoutChanged(main, [path]))).toEqual(['src/main/menu.ts'])
})

test('main, a release’s pull request, and a run by hand run everything', () => {
  for (const result of [
    plan({ event: 'push', changed: ['README.md'] }),
    plan({ event: 'workflow_dispatch', changed: [] }),
    pr(['CHANGELOG.md', 'package.json'], {}, 'release-1.16.0'),
    pr(['README.md'], {}, 'release-1.16.0'),
  ]) {
    expect(result).toMatchObject({ everything: true, docs: false, macos: true })
    expect(result.e2e).toHaveLength(12)
  }
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
  expect(onlyMac(mac, others)).toEqual({
    // Statement 0 and the branch's first arm are the others' too: not borrowed. What they never
    // reached is, with macOS's own counts; and a file they never loaded, whole.
    'src/main/menu.ts': file([0, 4, 1, 0], [1], [[0, 3]]),
    'src/main/dock.ts': file([5], [5], []),
  })
  // So a test taken away in a pull request loses what it reached, unless only macOS reached it.
  expect(onlyMac(mac, mac)['src/main/menu.ts']).toEqual(file([0, 0, 0, 0], [0], [[0, 0]]))
})

test('what’s borrowed is every shard’s or nothing, and never a file that isn’t coverage', () => {
  const shard = JSON.stringify({
    'src/main/menu.ts': { s: { 0: 2 }, f: {}, b: {} },
    'src/a.ts': { s: { 0: 1 }, f: {}, b: {} },
  })
  const none = JSON.stringify({ 'src/main/menu.ts': { s: { 0: 0 }, f: {}, b: {} } })
  const mac = [shard, shard, shard, shard]
  const others = Array.from({ length: 8 }, () => none)
  expect(borrowedOf({ mac, others }, ['src/a.ts'])).toEqual({
    kept: { 'src/main/menu.ts': { s: { 0: 8 }, f: {}, b: {} } },
  })
  // Three of four would be most of what macOS reaches, and read as all of it; and with one of
  // the others' missing, what it reached would be taken for macOS's alone.
  expect(borrowedOf({ mac: mac.slice(1), others }, [])).toEqual({
    nothing: '3 of macOS’s 4 coverage files are there, not all of them',
  })
  expect(borrowedOf({ mac: [], others }, [])).toEqual({
    nothing: '0 of macOS’s 4 coverage files are there, not all of them',
  })
  expect(borrowedOf({ mac, others: others.slice(1) }, [])).toEqual({
    nothing: '7 of Linux’s and Windows’ 8 coverage files are there, not all of them',
  })
  expect(borrowedOf({ mac: [shard, shard, shard, 'cut sh'], others }, [])).toEqual({
    nothing: 'one of its files isn’t JSON',
  })
  expect(borrowedOf({ mac, others: [...others.slice(1), '[]'] }, [])).toEqual({
    nothing: 'one of its files isn’t coverage',
  })
})

test('a changed test doesn’t run macOS in full by itself: main’s own run, after the merge, is what sees it', () => {
  const spec = 'tests/web/audit.spec.ts'
  const helper = 'tests/e2e/action-helpers.ts'
  const was = "test('a', () => {\n  expect(1).toBe(1)\n})\n"
  // A case added, weakened, gone; a file gone; a helper changed: the smoke set on the pull
  // request each time. Coverage borrowed from main may count what it no longer reaches there,
  // which is why main's run is the one whose gate binds.
  for (const now of [`${was}\ntest('b', () => {})\n`, was.replace('toBe(1)', 'toBeTruthy()'), '']) {
    expect(macos(pr([spec], { [spec]: [now, was] }))).toEqual(['smoke'])
  }
  expect(
    macos(pr([helper], { [helper]: ['export const open = 2\n', 'export const open = 1\n'] })),
  ).toEqual(['smoke'])
  // The harness every desktop test stands on is another matter.
  expect(pr(['tests/e2e/fixtures.ts']).macos).toBe(true)
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
    'main is red at eeeeeee (E2E (macos-latest, 2/4), Coverage (all platforms)): a warning, not a stop. See that this pull request isn’t why. https://github.com/Lumovi/Lumovi/actions/runs/eeeeeee5f',
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
    'main is red at aaaaaaa (Coverage (all platforms)): a warning, not a stop. See that this pull request isn’t why. https://github.com/Lumovi/Lumovi/actions/runs/aaaaaaa1',
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
  expect(told(github({ '/runs?': [run('aaaaaaa1', 'success')] }), 'Lumovi/Lumovi')).toBe(
    'Main is green.',
  )
  expect(
    told(
      github({ '/runs?': [run('aaaaaaa1', 'failure')], '/jobs?': [{ id: 7, name: 'Coverage' }] }),
      'Lumovi/Lumovi',
    ),
  ).toBe(
    '::warning::main is red at aaaaaaa (Coverage): a warning, not a stop. See that this pull request isn’t why. https://github.com/Lumovi/Lumovi/actions/runs/aaaaaaa1',
  )
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

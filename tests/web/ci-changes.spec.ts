/**
 * What CI runs (scripts/ci-changes.ts): nothing but the checks for a pull request of docs; and on
 * macOS, for now, its smoke set for every pull request and every merge, whatever it changes,
 * with its full suite nightly, by hand, for a release's pull request, or where a label asks. Each
 * case with the files as a pull request would change them (a file moved is both where it was and
 * where it is).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { borrowedOf, onlyMac, withoutChanged } from '../../scripts/borrow-coverage.ts'
import { plan, ranMacosInFull } from '../../scripts/ci-changes.ts'
import { redOf, sentence, told, warningOf, type Gh } from '../../scripts/main-is-green.ts'
import { filesOf, missingFrom, newerThan, whyNot } from '../../scripts/release-starts.ts'

/** A pull request changing `changed`, on `branch`, with `labels`. */
const pr = (changed: string[], branch = 'lmv-1-x', labels: string[] = []) =>
  plan({ event: 'pull_request', branch, changed, labels })
const macos = (result: ReturnType<typeof plan>) =>
  result.e2e.filter((shard) => shard.os === 'macos-latest').map((shard) => shard.shard)
const FULL = ['1/4', '2/4', '3/4', '4/4']
/** The tests' projects each system runs, as one text each. */
const projects = (result: ReturnType<typeof plan>) =>
  Object.fromEntries(result.e2e.map((shard) => [shard.os, shard.projects]))

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

test('for now, a pull request runs macOS’s smoke set, whatever it changes; Linux and Windows run everything', () => {
  // The app's own process, Electron, packaging, the lockfile, CI itself, the harness, code that
  // asks which platform it's on, a test: each was a reason for macOS's full suite once.
  for (const changed of [
    ['src/main/menu.ts'],
    ['electron-builder.yml', 'package-lock.json'],
    ['.github/workflows/ci.yml', 'scripts/ci-changes.ts'],
    ['tests/e2e/fixtures.ts', 'tests/e2e/smoke.txt'],
    ['src/renderer/src/lib/keys.ts', 'tests/web/audit.spec.ts'],
  ]) {
    const result = pr(changed)
    expect(result, changed.join(' ')).toMatchObject({ docs: false, macos: false })
    expect(macos(result)).toEqual(['smoke'])
    for (const os of ['ubuntu-latest', 'windows-latest']) {
      expect(result.e2e.filter((shard) => shard.os === os)).toHaveLength(4)
    }
    expect(result.said).toContain('macOS runs its smoke set (its full suite runs nightly')
  }
})

test('the label macos-full runs everything on macOS, whatever changed', () => {
  const path = 'src/renderer/src/features/lists/ResourceList.tsx'
  expect(macos(pr([path]))).toEqual(['smoke'])
  const asked = pr([path], 'lmv-1-x', ['design', 'macos-full'])
  expect(asked.macos).toBe(true)
  expect(macos(asked)).toEqual(FULL)
  expect(asked.said).toContain('as its label asks')
  // A label is a pull request's: a merge's run has none to ask with.
  expect(macos(plan({ event: 'push', changed: [path], labels: ['macos-full'] }))).toEqual(['smoke'])
})

test('main’s merge runs Linux and Windows in full and macOS’s smoke set; its tests run even for docs', () => {
  for (const changed of [['src/main/menu.ts'], ['README.md']]) {
    const result = plan({ event: 'push', changed })
    expect(result).toMatchObject({ docs: false, macos: false })
    expect(macos(result)).toEqual(['smoke'])
    expect(result.e2e).toHaveLength(9)
    expect(result.said).toContain('Main’s merge')
    // The browser's tests on Linux alone, where the server Lumovi ships runs.
    expect(projects(result)).toEqual({
      'ubuntu-latest': 'desktop web',
      'macos-latest': 'desktop',
      'windows-latest': 'desktop',
    })
  }
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
    expect(result.e2e).toHaveLength(12)
    expect(result.said).toContain(said)
    // Every system runs every test: a break in the browser's on one system shows here.
    expect(new Set(result.e2e.map((shard) => shard.projects))).toEqual(new Set(['desktop web']))
  }
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

/**
 * What CI runs for a change (scripts/ci-changes.ts): nothing but the checks for docs, and on
 * macOS, the full E2E suite only where it touches what macOS does differently. Each case with
 * the files as a pull request would change them (a file moved is both where it was and where it
 * is), and what's in them, then and now.
 */
import { expect, test } from '@playwright/test'
import { borrowedOf, withoutChanged } from '../../scripts/borrow-coverage.ts'
import { plan } from '../../scripts/ci-changes.ts'

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

test('macOS runs everything for the main process, shared code, Electron, packaging, the lockfile and CI', () => {
  for (const path of [
    'src/main/window.ts',
    'src/preload/index.ts',
    'src/backend/helm/service.ts',
    'src/shared/api.ts',
    'electron-builder.yml',
    'electron.vite.config.ts',
    'build/entitlements.mac.plist',
    'packaging/after-pack.mjs',
    'package.json',
    'package-lock.json',
    '.github/workflows/ci.yml',
    'playwright.config.ts',
    'tests/e2e/fixtures.ts',
  ]) {
    expect(macos(pr([path])), path).toEqual(['1/4', '2/4', '3/4', '4/4'])
  }
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

test('what’s borrowed is every shard’s or nothing, and never a file that isn’t coverage', () => {
  const shard = JSON.stringify({ 'src/main/menu.ts': { s: { 0: 2 } }, 'src/a.ts': { s: { 0: 1 } } })
  expect(borrowedOf([shard, shard, shard, shard], ['src/a.ts'])).toEqual({
    kept: Array.from({ length: 4 }, () => ({ 'src/main/menu.ts': { s: { 0: 2 } } })),
  })
  // Three of four would be most of what macOS reaches, and read as all of it.
  expect(borrowedOf([shard, shard, shard], [])).toEqual({
    nothing: '3 of macOS’s 4 coverage files are there, not all of them',
  })
  expect(borrowedOf([], [])).toEqual({
    nothing: '0 of macOS’s 4 coverage files are there, not all of them',
  })
  expect(borrowedOf([shard, shard, shard, 'cut sh'], [])).toEqual({
    nothing: 'one of its files isn’t JSON',
  })
  expect(borrowedOf([shard, shard, shard, '[]'], [])).toEqual({
    nothing: 'one of its files isn’t coverage',
  })
})

test('a test or its helper with lines taken away or changed runs macOS in full; one that only gains lines doesn’t', () => {
  const spec = 'tests/web/audit.spec.ts'
  const helper = 'tests/e2e/action-helpers.ts'
  const was = "test('a', () => {\n  expect(1).toBe(1)\n})\n"
  // A case added, a new file: nothing that was reached is taken away.
  expect(pr([spec], { [spec]: [`${was}\ntest('b', () => {})\n`, was] }).macos).toBe(false)
  expect(pr([spec], { [spec]: [was, ''] }).macos).toBe(false)
  // A case weakened, a case gone, a file gone, a helper changed.
  expect(pr([spec], { [spec]: [was.replace('toBe(1)', 'toBeTruthy()'), was] }).macos).toBe(true)
  expect(pr([spec], { [spec]: ["test('a', () => {\n})\n", was] }).macos).toBe(true)
  expect(pr([spec], { [spec]: ['', was] }).macos).toBe(true)
  expect(
    pr([helper], { [helper]: ['export const open = 2\n', 'export const open = 1\n'] }).macos,
  ).toBe(true)
})

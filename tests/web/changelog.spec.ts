/**
 * The changelog's entries as files (scripts/changelog.ts): what a well-formed one is, how
 * they're joined into a version's section, and what a pull request is told about its own.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '../temp-folders.ts'
import {
  entriesIn,
  joined,
  problemOf,
  released,
  saysNone,
  UNRELEASED,
  unreleasedOf,
  verdict,
  type Entry,
} from '../../scripts/changelog.ts'

const entry = (file: string, text: string, since?: number): Entry => ({
  file,
  section: file.split('.').at(-2) as Entry['section'],
  text,
  since,
})

const CHANGELOG = `# Changelog

Words about it.

## [Unreleased]

${UNRELEASED}

## [1.2.0] - 2026-01-02

Something.

### Fixed

- A thing.

[1.2.0]: https://github.com/Lumovi/Lumovi/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Lumovi/Lumovi/releases/tag/v1.1.0
`

test('an entry file: its name says its section, and it holds one entry', () => {
  expect(problemOf('create-alias.fixed.md', '- Create answers.\n')).toBeUndefined()
  expect(problemOf('a.added.md', '- One line,\n  and a second set in.\n')).toBeUndefined()
  for (const [file, text, said] of [
    ['create-alias.md', '- x\n', 'name it <what>.<section>.md'],
    ['create-alias.mended.md', '- x\n', 'the section one of added'],
    ['Create Alias.fixed.md', '- x\n', 'in lower case with hyphens'],
    ['a.fixed.md', 'Create answers.\n', 'starts with "- "'],
    ['a.fixed.md', '- x', 'ends with one line break'],
    ['a.fixed.md', '- x\n\n', 'ends with one line break'],
    ['a.fixed.md', '- x\n- y\n', 'one entry a file'],
    ['a.fixed.md', '- x\n### Fixed\n', 'one entry a file'],
    ['a.fixed.md', '- x\nnot set in\n', 'one entry a file'],
  ] as const) {
    expect(problemOf(file, text), `${file}: ${JSON.stringify(text)}`).toContain(said)
  }
})

test('entries are read from their folder; one that isn’t well formed is said, by its name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-changelog-'))
  mkdirSync(join(dir, 'd'))
  const at = join(dir, 'd')
  expect(entriesIn(join(dir, 'none'))).toEqual([])
  writeFileSync(join(at, 'README.md'), '# How\n')
  writeFileSync(join(at, 'b.fixed.md'), '- B.\n')
  writeFileSync(join(at, 'a.added.md'), '- A.\n')
  expect(entriesIn(at, () => 5).map(({ file, section, since }) => [file, section, since])).toEqual([
    ['a.added.md', 'added', 5],
    ['b.fixed.md', 'fixed', 5],
  ])
  writeFileSync(join(at, 'c.fixed.md'), 'C.\n')
  expect(() => entriesIn(at, () => 5)).toThrow('c.fixed.md: an entry starts with "- "')
})

test('joined: the sections in their order, each one’s entries in the order they reached main', () => {
  expect(
    joined([
      entry('z.fixed.md', '- Fixed later.\n', 30),
      entry('a.fixed.md', '- Fixed first,\n  on two lines.\n', 10),
      entry('m.security.md', '- Safer.\n', 5),
      entry('b.added.md', '- Added second.\n', 20),
      entry('c.added.md', '- Added first.\n', 10),
      // Of one commit: by their names. Not committed yet: last.
      entry('02-y.changed.md', '- Changed, second of one commit.\n', 7),
      entry('01-x.changed.md', '- Changed, first of one commit.\n', 7),
      entry('new.changed.md', '- Changed, not committed yet.\n'),
    ]),
  ).toBe(`### Added

- Added first.
- Added second.

### Changed

- Changed, first of one commit.
- Changed, second of one commit.
- Changed, not committed yet.

### Fixed

- Fixed first,
  on two lines.
- Fixed later.

### Security

- Safer.
`)
  expect(joined([])).toBe('')
})

test('a release: the version’s section under Unreleased, which stays, and its link first', () => {
  const now = released(CHANGELOG, '1.3.0', '2026-02-03', [
    entry('a.added.md', '- New.\n', 1),
    entry('b.fixed.md', '- Mended.\n', 2),
  ])
  expect(now).toBe(`# Changelog

Words about it.

## [Unreleased]

${UNRELEASED}

## [1.3.0] - 2026-02-03

### Added

- New.

### Fixed

- Mended.

## [1.2.0] - 2026-01-02

Something.

### Fixed

- A thing.

[1.3.0]: https://github.com/Lumovi/Lumovi/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Lumovi/Lumovi/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Lumovi/Lumovi/releases/tag/v1.1.0
`)
  expect(unreleasedOf(now)).toBe(UNRELEASED)
  // Not twice, and not of nothing.
  expect(() => released(now, '1.3.0', '2026-02-04', [entry('a.added.md', '- x\n')])).toThrow(
    'already has a section for 1.3.0',
  )
  expect(() => released(CHANGELOG, '1.3.0', '2026-02-03', [])).toThrow('Nothing in changelog.d/')
})

test('a pull request: what ships needs an entry or a reason; Unreleased itself isn’t written to', () => {
  const same = { changelog: CHANGELOG }
  const ships = ['src/renderer/src/App.tsx', 'tests/web/app.spec.ts']
  // An entry added, or one waiting changed; or the text says why none.
  expect(verdict({ ...same, changed: [...ships, 'changelog.d/app.fixed.md'], text: '' })).toEqual(
    [],
  )
  expect(
    verdict({ ...same, changed: ships, text: 'Fixes it.\n\nChangelog: none: a refactor\n' }),
  ).toEqual([])
  // Neither.
  for (const text of ['', 'Changelog: none', 'Changelog: none: ', 'no Changelog: none: x here']) {
    expect(verdict({ ...same, changed: ships, text }), JSON.stringify(text)).toEqual([
      expect.stringContaining('changes what ships and has no changelog entry'),
    ])
  }
  // An entry taken away is no entry.
  expect(
    verdict({ ...same, changed: [...ships, 'changelog.d/old.fixed.md'], written: ships, text: '' }),
  ).toHaveLength(1)
  // The folder's own README isn't an entry.
  expect(verdict({ ...same, changed: [...ships, 'changelog.d/README.md'], text: '' })).toHaveLength(
    1,
  )
  // What doesn't ship needs none: tests, scripts, CI, docs.
  expect(
    verdict({
      ...same,
      changed: ['tests/web/a.spec.ts', 'scripts/x.ts', '.github/workflows/ci.yml', 'README.md'],
      text: '',
    }),
  ).toEqual([])
  for (const path of ['charts/lumovi/values.yaml', 'packaging/a.sh', 'build/icon.png']) {
    expect(verdict({ ...same, changed: [path], text: '' }), path).toHaveLength(1)
  }
  // Written under Unreleased as before: said, entry file or not. An older version's section
  // (a typo mended) is nobody's business here.
  const under = CHANGELOG.replace(UNRELEASED, `${UNRELEASED}\n\n### Fixed\n\n- Mine.`)
  expect(verdict({ changelog: under, changed: ['CHANGELOG.md'], text: '' })).toEqual([
    expect.stringContaining('[Unreleased] isn’t written to any more'),
  ])
  expect(
    verdict({
      changelog: CHANGELOG.replace('A thing', 'One thing'),
      changed: ['CHANGELOG.md'],
      text: '',
    }),
  ).toEqual([])
  // What's wrong with an entry file comes first.
  expect(
    verdict({ ...same, changed: [], text: '', problems: ['changelog.d/x.md: name it…'] }),
  ).toEqual(['changelog.d/x.md: name it…'])
  expect(saysNone('Changelog: none: tests only')).toBe(true)
})

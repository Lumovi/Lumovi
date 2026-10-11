/**
 * The changelog's entries, between releases: one small file each in changelog.d/, so that two
 * pull requests never meet in the same lines of CHANGELOG.md.
 *
 * A file is `<what>.<section>.md` (create-alias.fixed.md, access-control.added.md): the section
 * is added, changed, deprecated, removed, fixed or security, and what's in it is the entry word
 * for word as CHANGELOG.md will have it, starting with "- ".
 *
 *   node scripts/changelog.ts            what's unreleased, joined (`npm run changelog`)
 *   node scripts/changelog.ts release    gathers the files into "## [x.y.z] - <date>", adds the
 *                                        version's link and deletes them (`npm version` runs it)
 *   node scripts/changelog.ts check      a pull request's entries (CI's "CI passed")
 *
 * Within a section the entries stand in the order their pull requests reached main (when each
 * file first appeared there, by git), files of one commit by their names. A release's opening
 * paragraph is still written by hand, above the sections.
 *
 * tests/web/changelog.spec.ts tries each part.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DIR = 'changelog.d'
/** Keep a Changelog's sections, in its order. */
export const SECTIONS = ['added', 'changed', 'deprecated', 'removed', 'fixed', 'security'] as const
export type Section = (typeof SECTIONS)[number]

/** What the one line under "## [Unreleased]" says. */
export const UNRELEASED = `Entries wait in [\`${DIR}/\`](${DIR}), a file each, until a release gathers them here (\`npm run changelog\` prints them).`

export interface Entry {
  file: string
  section: Section
  text: string
  /** When it first appeared on this branch (seconds), or none: not committed yet. */
  since?: number
}

const NAME = new RegExp(`^[a-z0-9][a-z0-9-]*\\.(${SECTIONS.join('|')})\\.md$`)
const title = (section: Section) => section[0]!.toUpperCase() + section.slice(1)

/** What's wrong with an entry file, if anything: by its name and what's in it. */
export function problemOf(file: string, text: string): string | undefined {
  if (!NAME.test(file)) {
    return `${DIR}/${file}: name it <what>.<section>.md, in lower case with hyphens, the section one of ${SECTIONS.join(', ')}.`
  }
  if (!text.startsWith('- ')) return `${DIR}/${file}: an entry starts with "- ".`
  if (!text.endsWith('\n') || text.endsWith('\n\n')) {
    return `${DIR}/${file}: an entry ends with one line break.`
  }
  // One entry a file: nothing after it that starts another, or a heading.
  const stray = text
    .split('\n')
    .slice(1)
    .find((line) => line !== '' && !line.startsWith('  '))
  if (stray !== undefined) {
    return `${DIR}/${file}: one entry a file, its other lines set in by two spaces (found “${stray.slice(0, 40)}”).`
  }
  return undefined
}

/** When a file first appeared in this branch's history. */
function sinceOf(dir: string, file: string): number | undefined {
  try {
    const out = execFileSync(
      'git',
      ['log', '--diff-filter=A', '--format=%ct', '--', join(dir, file)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    // (Added, taken away and added again: its first time is the last line.)
    return out ? Number(out.split('\n').at(-1)) : undefined
  } catch {
    return undefined
  }
}

/** The entry files in `dir`: read, and when each arrived. Throws if one isn't well formed. */
export function entriesIn(
  dir = DIR,
  since: (file: string) => number | undefined = (file) => sinceOf(dir, file),
): Entry[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md') && file !== 'README.md')
    .map((file) => {
      const text = readFileSync(join(dir, file), 'utf8')
      const problem = problemOf(file, text)
      if (problem) throw new Error(problem)
      return { file, section: file.split('.').at(-2) as Section, text, since: since(file) }
    })
}

/** The sections as CHANGELOG.md has them: each with its entries in the order they arrived. */
export function joined(entries: Entry[]): string {
  const ordered = [...entries].sort(
    (a, b) =>
      (a.since ?? Infinity) - (b.since ?? Infinity) ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
  )
  return SECTIONS.map((section) => {
    const texts = ordered.filter((entry) => entry.section === section).map((entry) => entry.text)
    return texts.length ? `### ${title(section)}\n\n${texts.join('')}` : ''
  })
    .filter(Boolean)
    .join('\n')
}

/** What's between "## [Unreleased]" and the next version's heading. */
export function unreleasedOf(changelog: string): string {
  const from = changelog.indexOf('## [Unreleased]')
  if (from < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]".')
  const rest = changelog.slice(from + '## [Unreleased]'.length)
  const to = rest.search(/^## \[/m)
  return (to < 0 ? rest : rest.slice(0, to)).trim()
}

/**
 * CHANGELOG.md with `version`'s section made of `entries` under "## [Unreleased]" (which stays,
 * with its one line), and the version's link above the others.
 */
export function released(
  changelog: string,
  version: string,
  date: string,
  entries: Entry[],
): string {
  if (changelog.includes(`## [${version}]`)) {
    throw new Error(`CHANGELOG.md already has a section for ${version}.`)
  }
  if (entries.length === 0) throw new Error(`Nothing in ${DIR}/ to release as ${version}.`)
  const from = changelog.indexOf('## [Unreleased]')
  if (from < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]".')
  const after = changelog.slice(from)
  const next = after.slice(1).search(/^## \[/m)
  const tail = next < 0 ? '' : after.slice(next + 1)
  const section = `## [${version}] - ${date}\n\n${joined(entries)}\n`
  const body = `${changelog.slice(0, from)}## [Unreleased]\n\n${UNRELEASED}\n\n${section}${tail}`
  // The link compares it with the release before it: the first one the links name.
  const first = /^\[(\d[^\]]*)\]: (https:\/\/[^\s]+?)\/(compare|releases)\//m.exec(body)
  if (!first) throw new Error('CHANGELOG.md has no version links to add to.')
  const link = `[${version}]: ${first[2]}/compare/v${first[1]}...v${version}\n`
  return body.slice(0, first.index) + link + body.slice(first.index)
}

/** A pull request's text says no entry is needed, and why: "Changelog: none: <reason>". */
export const saysNone = (text: string) => /^Changelog: none: \S/m.test(text)
/** What ships: a change here is one people meet. */
const SHIPS = /^(src|charts|packaging|build)\//

/**
 * What's wrong with a pull request's entries, if anything: `changed` are the files it changes,
 * `written` those of them it adds or changes (an entry taken away is no entry), `text` its own
 * text, `changelog` CHANGELOG.md as the pull request has it.
 */
export function verdict({
  changed,
  written = changed,
  text,
  changelog,
  problems = [],
}: {
  changed: string[]
  written?: string[]
  text: string
  changelog: string
  problems?: string[]
}): string[] {
  const said = [...problems]
  // Between releases it holds its one line and nothing else: an entry written there, the old
  // way, is the very thing two pull requests used to meet in.
  if (unreleasedOf(changelog) !== UNRELEASED) {
    said.push(
      `CHANGELOG.md’s [Unreleased] isn’t written to any more: put the entry in a file of its own in ${DIR}/ (see ${DIR}/README.md), and leave [Unreleased] its one line.`,
    )
  }
  const entry = written.some((file) => file.startsWith(`${DIR}/`) && file !== `${DIR}/README.md`)
  if (changed.some((file) => SHIPS.test(file)) && !entry && !saysNone(text)) {
    said.push(
      `This changes what ships and has no changelog entry: add a file to ${DIR}/, or a line to the pull request's text, "Changelog: none: <why nobody would look for one>".`,
    )
  }
  return said
}

if (import.meta.main) {
  const [command] = process.argv.slice(2)
  if (command === 'release') {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    const entries = entriesIn()
    const today = new Date().toISOString().slice(0, 10)
    writeFileSync(
      'CHANGELOG.md',
      released(readFileSync('CHANGELOG.md', 'utf8'), version, today, entries),
    )
    for (const entry of entries) rmSync(join(DIR, entry.file))
    console.log(
      `CHANGELOG.md has ${version}'s section, of ${entries.length} entries: write its opening paragraph above them.`,
    )
  } else if (command === 'check') {
    // A pull request's merge commit: what it's merged into is its first parent.
    const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' })
    const files = (...filter: string[]) =>
      git('diff', '--name-only', '--no-renames', ...filter, 'HEAD^1', 'HEAD')
        .split('\n')
        .filter(Boolean)
    const changed = files()
    const written = files('--diff-filter=AM')
    const problems: string[] = []
    try {
      entriesIn(DIR, () => undefined)
    } catch (error) {
      problems.push((error as Error).message)
    }
    const said = verdict({
      changed,
      written,
      text: process.env.PR_TEXT ?? '',
      changelog: readFileSync('CHANGELOG.md', 'utf8'),
      problems,
    })
    for (const line of said) console.error(`::error::${line}`)
    if (said.length) process.exit(1)
    console.log('The changelog entries are in order.')
  } else {
    console.log(joined(entriesIn()) || 'Nothing unreleased.')
  }
}

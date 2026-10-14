/**
 * Says which release first carries what a plugin can use of Lumovi's door that no release has
 * carried yet: each `next` in src/shared/plugin-since.ts becomes package.json's version.
 * `npm version` runs it (the "version" script), so the release's own commit has the numbers.
 */
import { readFileSync, writeFileSync } from 'node:fs'

export const SINCE_FILE = 'src/shared/plugin-since.ts'

/**
 * The file's text with each thing's `next` as `version`: only an entry's, never the type's. An
 * entry's key is a name, or quoted where it's a path (a part's props: 'Table.filters').
 */
export const released = (text: string, version: string): string =>
  text.replaceAll(/^(\s+(?:\w+|'[^'\n]+'): )'next'(,?)$/gm, `$1'${version}'$2`)

if (import.meta.main) {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
  writeFileSync(SINCE_FILE, released(readFileSync(SINCE_FILE, 'utf8'), version))
}

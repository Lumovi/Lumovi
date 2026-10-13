/**
 * The first release to carry each thing a plugin can use of the door (src/shared/plugin-since.ts):
 * every part a page may name has one, and so does everything a file can add; each is a release
 * no newer than this one, or the one being made; and the release's own step writes its number
 * in for those, and for nothing else. Plain data and a plain function: nothing is built.
 */
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { released, SINCE_FILE } from '../../scripts/plugin-since.ts'
import { DECLARED } from '../../src/shared/kit/parts.ts'
import { PLUGIN_SINCE } from '../../src/shared/plugin-since.ts'
import type { Added } from '../../src/shared/plugins.ts'

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/
const numbers = (version: string) => VERSION.exec(version)!.slice(1).map(Number)
const older = (a: string, b: string) => {
  const [x, y] = [numbers(a), numbers(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]!
  return false
}

test('every part a page may name, and everything a file can add, has the release that first carried it', () => {
  expect(Object.keys(PLUGIN_SINCE.parts).sort()).toEqual(Object.keys(DECLARED).sort())
  const added: Record<keyof Added, true> = { pages: true, tabs: true, commands: true }
  for (const key of [...Object.keys(added), 'reads', 'showsSecrets', 'manages']) {
    expect(Object.hasOwn(PLUGIN_SINCE.file, key), key).toBe(true)
  }
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
  for (const [what, each] of Object.entries(PLUGIN_SINCE)) {
    for (const [name, since] of Object.entries(each) as [string, string][]) {
      // The one being made, or one made already: never a release that isn't.
      if (since === 'next') continue
      expect(since, `${what}.${name}`).toMatch(VERSION)
      expect(older(version, since), `${what}.${name}`).toBe(false)
    }
  }
})

test('the release’s own step says it first carries what no release did, and changes nothing else', () => {
  const text = readFileSync(SINCE_FILE, 'utf8')
  const entries = (written: string, since: string) =>
    written.split('\n').filter((line) => new RegExp(`^\\s+\\w+: '${since}',?$`).test(line)).length
  const now = entries(text, 'next')
  const done = released(text, '1.99.0')
  // Each entry that was the one being made is that release's now; every other line is as it was.
  expect(entries(done, 'next')).toBe(0)
  expect(entries(done, '1.99.0')).toBe(now + entries(text, '1.99.0'))
  expect(done.split('\n').filter((line, i) => line !== text.split('\n')[i])).toHaveLength(now)
  // (The type still says what `next` is, for the next release's lines.)
  expect(done).toContain(`| 'next'`)
  expect(released("  pages: '1.2.0',\n  tabs: 'next'\n", '1.3.0')).toBe(
    "  pages: '1.2.0',\n  tabs: '1.3.0'\n",
  )
})

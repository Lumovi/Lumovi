/**
 * What an AI assistant's tools are built from never reaches a page's code or a plugin's box:
 * held by reading the imports, all the way down. An assistant reads clusters through Lumovi's
 * own service; nothing a plugin wrote on a page, or worked out in its box, is in reach of it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { BOX_LIMITS, overProcessor, placed } from '../../src/shared/plugin-box.ts'

const SRC = resolve('src')
const ALIASES: Record<string, string> = {
  '@shared': join(SRC, 'shared'),
  '@renderer': join(SRC, 'renderer', 'src'),
}

/** The file an import names, if it's one of Lumovi's own. */
function fileOf(from: string, named: string): string | undefined {
  const alias = Object.keys(ALIASES).find((key) => named === key || named.startsWith(`${key}/`))
  const base = alias
    ? join(ALIASES[alias]!, named.slice(alias.length))
    : named.startsWith('.')
      ? resolve(dirname(from), named)
      : undefined
  if (!base) return undefined
  const clean = base.replace(/\?.*$/, '')
  return [clean, `${clean}.ts`, `${clean}.tsx`, join(clean, 'index.ts')].find(
    (path) => existsSync(path) && statSync(path).isFile(),
  )
}

/** Everything `starts` import, and what those import, by file. */
function reachedFrom(starts: string[]): Map<string, string> {
  const by = new Map<string, string>()
  const queue = [...starts]
  for (const start of starts) by.set(start, '(a start)')
  while (queue.length) {
    const file = queue.pop()!
    const text = readFileSync(file, 'utf8')
    const named = [
      ...text.matchAll(/\bfrom\s+'([^']+)'/g),
      ...text.matchAll(/\bimport\s*\(\s*'([^']+)'\s*\)/g),
      ...text.matchAll(/^\s*import\s+'([^']+)'/gm),
    ].map((match) => match[1]!)
    for (const name of named) {
      const found = fileOf(file, name)
      if (!found || by.has(found)) continue
      by.set(found, file)
      queue.push(found)
    }
  }
  return by
}

test('an assistant’s tools import nothing of a page, nor of a plugin’s box', () => {
  const tools = join(SRC, 'backend', 'mcp')
  const starts = readdirSync(tools)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(tools, name))
  expect(starts.length).toBeGreaterThan(3)
  const reached = reachedFrom(starts)
  // (It reads something: the walk isn't empty-handed.)
  expect(reached.size).toBeGreaterThan(starts.length + 5)
  const forbidden = [...reached.keys()]
    .map((file) => relative(SRC, file).split('\\').join('/'))
    .filter(
      (file) =>
        file.startsWith('renderer/') ||
        file === 'main/plugin-box.ts' ||
        file === 'shared/plugin-box.ts',
    )
  expect(forbidden).toEqual([])
})

test('the walk does find what’s there: a page’s code reaches the box, and is seen to', () => {
  const reached = reachedFrom([join(SRC, 'renderer', 'src', 'main.tsx')])
  expect([...reached.keys()].map((file) => relative(SRC, file).split('\\').join('/'))).toContain(
    'shared/plugin-box.ts',
  )
})

test('a plugin found in a process with another has that process ended; in the page’s own, its boxes go', () => {
  // As it should be: each plugin apart, two pages of one together.
  expect(
    placed(
      [
        { plugin: 'first', pid: 11 },
        { plugin: 'first', pid: 11 },
        { plugin: 'second', pid: 12 },
      ],
      10,
    ),
  ).toEqual({
    endProcesses: new Map(),
    takeOff: [],
    pluginOf: new Map([
      [11, 'first'],
      [12, 'second'],
    ]),
  })
  // Two plugins in one process: it's ended, and neither is measured as if it were alone.
  const together = placed(
    [
      { plugin: 'first', pid: 11 },
      { plugin: 'second', pid: 11 },
      { plugin: 'third', pid: 13 },
    ],
    10,
  )
  expect(together.endProcesses).toEqual(new Map([[11, ['first', 'second']]]))
  expect(together.pluginOf).toEqual(new Map([[13, 'third']]))
  // In the page's own process, which is never ended: its boxes are taken off the page.
  const withThePage = placed(
    [
      { plugin: 'first', pid: 10 },
      { plugin: 'second', pid: 12 },
    ],
    10,
  )
  expect(withThePage.takeOff).toEqual(['first'])
  expect(withThePage.endProcesses.size).toBe(0)
  expect(withThePage.pluginOf.has(10)).toBe(false)
})

test('the processor’s limit is over the last while, so an idle second doesn’t undo it', () => {
  const measures = BOX_LIMITS.processorForMs / BOX_LIMITS.measureEveryMs
  const busy = (n: number) => Array.from({ length: n }, () => 1)
  // Not before it has been measured for the whole while.
  expect(overProcessor(busy(measures - 1), measures)).toBe(false)
  expect(overProcessor(busy(measures), measures)).toBe(true)
  // Twenty-nine seconds on and one off, again and again: still near a whole core.
  expect(overProcessor([...busy(measures - 1), 0], measures)).toBe(true)
  expect(overProcessor([...busy(14), 0, ...busy(15)], measures)).toBe(true)
  // Half the time isn't.
  expect(
    overProcessor(
      Array.from({ length: measures }, (_, i) => i % 2),
      measures,
    ),
  ).toBe(false)
  // And only the last while counts.
  expect(
    overProcessor([...busy(measures), ...Array.from({ length: measures }, () => 0.1)], measures),
  ).toBe(false)
})

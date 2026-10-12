/**
 * Searching logs: plain text, or a regular expression a person typed; with or without matching
 * case; for the lines that match, or for those that don't.
 *
 * No search is run on the page's own thread: some expressions take longer on a long line than
 * anyone would wait (a "catastrophic" pattern), and the page would stop answering. Here an
 * expression is only checked for being one; every search is run in a worker the page stops if it
 * takes too long (`match.worker.ts`, through `LineSearch` in features/logs).
 */
import type { LogLine } from './logs'

/** What a person searches the logs for, and how. */
export interface LogQuery {
  text: string
  regex: boolean
  matchCase: boolean
  /** The lines that don't match, rather than those that do. */
  exclude: boolean
}

export const NO_QUERY: LogQuery = { text: '', regex: false, matchCase: false, exclude: false }

/** A query, made ready: nothing to search for, plain text, an expression, or not one. */
export type Search =
  | { kind: 'none' }
  | { kind: 'plain'; needle: string; matchCase: boolean; exclude: boolean }
  | { kind: 'regex'; source: string; flags: string; exclude: boolean }
  | { kind: 'invalid'; why: string }

/** Where a match is in one of the texts a line shows: which text, and where in it. */
export type Range = readonly [part: number, start: number, end: number]

/** The most matches marked in one text of a line: past them it's marked no further. */
export const MOST_MARKED = 100

export function search(query: LogQuery): Search {
  // (Spaces at either end are kept in an expression, which may mean them; dropped from text.)
  const text = query.regex ? query.text : query.text.trim()
  if (!text) return { kind: 'none' }
  if (!query.regex) {
    return { kind: 'plain', needle: text, matchCase: query.matchCase, exclude: query.exclude }
  }
  const flags = query.matchCase ? 'g' : 'gi'
  try {
    // Only made, never run: making one takes no time whatever it says.
    new RegExp(text, flags)
  } catch {
    return { kind: 'invalid', why: whyNot(text) }
  }
  return { kind: 'regex', source: text, flags, exclude: query.exclude }
}

/**
 * Why something isn't a regular expression, in Lumovi's words, where it's one a person can put
 * right; otherwise only that it isn't one. (Never the browser's own message: its words differ
 * by browser and version.)
 */
export function whyNot(text: string): string {
  const not = (why: string) => `This isn’t a regular expression: ${why}.`
  let groups = 0
  let inClass = false
  // (What can come before a * to be repeated: anything but nothing, a ( or a |.)
  let repeatable = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '\\') {
      if (i === text.length - 1) return not('a \\ ends it')
      i++
      repeatable = true
    } else if (inClass) {
      if (c === ']') inClass = false
    } else if (c === '[') {
      inClass = true
      repeatable = true
    } else if (c === '(' && text[i + 1] === '?') {
      // (A group of its own kind: (?:…), (?<name>…), (?=…). Its ? repeats nothing.)
      groups++
      i++
      repeatable = false
    } else if ('*+?'.includes(c) && !repeatable) {
      return not(`there’s nothing for ${c} to repeat`)
    } else {
      if (c === '(') groups++
      else if (c === ')') groups--
      repeatable = c !== '(' && c !== '|'
    }
  }
  if (inClass) return not('a [ isn’t closed')
  if (groups > 0) return not('a ( isn’t closed')
  return 'This isn’t a regular expression Lumovi can use.'
}

/**
 * The texts a line shows, in order: where its matches are marked. Its message; for a JSON line,
 * its msg and then its other fields as `key=value`, as the view draws them.
 */
export function shownParts(line: LogLine): string[] {
  if (!line.fields) return [line.message]
  const { level: _level, msg, ...rest } = line.fields
  const extra = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
  return [msg === undefined ? '' : String(msg), extra]
}

/** Whether plain text is in a line's message. */
export function plainMatch(message: string, needle: string, matchCase: boolean): boolean {
  return matchCase ? message.includes(needle) : message.toLowerCase().includes(needle.toLowerCase())
}

/** Where plain text is in a text, as many times as it's there (up to `MOST_MARKED`). */
export function plainRanges(text: string, needle: string, matchCase: boolean): [number, number][] {
  const haystack = matchCase ? text : text.toLowerCase()
  const looked = matchCase ? needle : needle.toLowerCase()
  const found: [number, number][] = []
  for (let at = haystack.indexOf(looked); at >= 0 && found.length < MOST_MARKED;) {
    found.push([at, at + looked.length])
    at = haystack.indexOf(looked, at + looked.length)
  }
  return found
}

/** Where an expression matches in a text (up to `MOST_MARKED`); an empty match marks nothing. */
export function regexRanges(text: string, pattern: RegExp): [number, number][] {
  const found: [number, number][] = []
  pattern.lastIndex = 0
  for (let match = pattern.exec(text); match && found.length < MOST_MARKED;) {
    if (match[0].length === 0) pattern.lastIndex++
    else found.push([match.index, match.index + match[0].length])
    match = pattern.exec(text)
  }
  return found
}

/** A line as the worker is given it: its message, which is matched, and the texts it shows. */
export interface ToMatch {
  key: number
  message: string
  parts: string[]
}

/** What the worker says of a line: whether its message matches, and where in what it shows. */
export interface Matched {
  key: number
  match: boolean
  ranges: Range[]
}

/** A search the worker runs: plain text, or an expression. */
export type Runnable =
  | { kind: 'plain'; needle: string; matchCase: boolean }
  | { kind: 'regex'; source: string; flags: string }

/** How a search finds itself in a text: whether it's there, and where. */
export interface Matcher {
  test(text: string): boolean
  ranges(text: string): [number, number][]
}

export function matcherOf(search: Runnable): Matcher {
  if (search.kind === 'plain') {
    const { needle, matchCase } = search
    return {
      test: (text) => plainMatch(text, needle, matchCase),
      ranges: (text) => plainRanges(text, needle, matchCase),
    }
  }
  const pattern = new RegExp(search.source, search.flags)
  return {
    test: (text) => {
      pattern.lastIndex = 0
      return pattern.test(text)
    },
    ranges: (text) => regexRanges(text, pattern),
  }
}

/** One line against a search: run in the worker alone. */
export function matchLine(line: ToMatch, matcher: Matcher): Matched {
  const match = matcher.test(line.message)
  const ranges: Range[] = []
  if (match) {
    line.parts.forEach((part, i) => {
      for (const [start, end] of matcher.ranges(part)) ranges.push([i, start, end])
    })
  }
  return { key: line.key, match, ranges }
}

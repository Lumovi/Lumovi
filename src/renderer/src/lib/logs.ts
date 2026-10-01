/**
 * Log lines as the API server sends them (`timestamp message`), parsed, and
 * merged across containers in the order they were written.
 */

export type Level = 'error' | 'warn' | 'info'

// A declared level (`"level":"warn"`, `level=WARN`) wins over keywords in the message.
const LEVEL_FIELD = /\blevel"?\s*[:=]\s*"?([a-z]+)/i

export function logLevel(message: string): Level {
  const text = LEVEL_FIELD.exec(message)?.[1] ?? message
  if (/\b(error|fatal|panic|crit(ical)?|exception)\b/i.test(text)) return 'error'
  return /\bwarn(ing)?\b/i.test(text) ? 'warn' : 'info'
}

/** Text in one style, as ANSI escape codes (SGR) set it. */
export interface Segment {
  text: string
  color?: string
  background?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

// Escape sequences (CSI): styles end in `m`; others (erasing a line, moving the cursor) mean nothing here.
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[([0-9;?]*)([A-Za-z])/g

/** One of the 256 colors terminals know: the 16 named ones follow the theme. */
function color256(n: number): string {
  if (n < 16) return `var(--ansi-${n})`
  if (n >= 232) {
    const gray = 8 + (n - 232) * 10
    return `rgb(${gray} ${gray} ${gray})`
  }
  const cube = n - 16
  const level = (c: number) => (c === 0 ? 0 : 55 + c * 40)
  return `rgb(${level(Math.floor(cube / 36))} ${level(Math.floor(cube / 6) % 6)} ${level(cube % 6)})`
}

/** Applies SGR parameters (`1;31`, `38;5;208`, `0`…) to a style. */
function applySgr(style: Omit<Segment, 'text'>, params: number[]): Omit<Segment, 'text'> {
  let next = { ...style }
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!
    if (p === 0) next = {}
    else if (p === 1) next.bold = true
    else if (p === 2) next.dim = true
    else if (p === 3) next.italic = true
    else if (p === 4) next.underline = true
    else if (p === 22) next.bold = next.dim = undefined
    else if (p === 23) next.italic = undefined
    else if (p === 24) next.underline = undefined
    else if (p === 39) next.color = undefined
    else if (p === 49) next.background = undefined
    else if (p >= 30 && p <= 37) next.color = color256(p - 30)
    else if (p >= 90 && p <= 97) next.color = color256(p - 90 + 8)
    else if (p >= 40 && p <= 47) next.background = color256(p - 40)
    else if (p >= 100 && p <= 107) next.background = color256(p - 100 + 8)
    else if (p === 38 || p === 48) {
      // 38;5;n picks one of 256 colors; 38;2;r;g;b any color.
      const value =
        params[i + 1] === 5
          ? color256(params[i + 2]!)
          : `rgb(${params[i + 2]} ${params[i + 3]} ${params[i + 4]})`
      i += params[i + 1] === 5 ? 2 : 4
      if (p === 38) next.color = value
      else next.background = value
    }
  }
  return next
}

/** A line's text in its styles, without the escape codes. */
export function parseAnsi(text: string): Segment[] {
  const segments: Segment[] = []
  let style: Omit<Segment, 'text'> = {}
  let last = 0
  for (const match of text.matchAll(CSI)) {
    if (match.index > last) segments.push({ ...style, text: text.slice(last, match.index) })
    if (match[2] === 'm') style = applySgr(style, match[1]!.split(';').map(Number))
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({ ...style, text: text.slice(last) })
  return segments
}

export interface LogLine {
  /** The stream it came from. */
  source: string
  /** The line as sent, timestamp first. */
  raw: string
  /** When it was written, in milliseconds. */
  at: number
  /** What it says, without escape codes. */
  message: string
  level: Level
  /** Parsed fields when the line is a JSON object. */
  fields?: Record<string, unknown>
  /** Its styles, when it has escape codes (colors, bold…). */
  segments?: Segment[]
}

export function parseLine(raw: string, source: string): LogLine {
  const space = raw.indexOf(' ')
  const written = raw.slice(space + 1)
  const segments = written.includes('\x1b[') ? parseAnsi(written) : undefined
  const message = segments ? segments.map((s) => s.text).join('') : written
  let fields: Record<string, unknown> | undefined
  if (message.startsWith('{')) {
    try {
      fields = JSON.parse(message) as Record<string, unknown>
    } catch {
      // A truncated or malformed JSON line: show it as text.
    }
  }
  return {
    source,
    raw,
    at: Date.parse(raw.slice(0, space)),
    message,
    level: logLevel(message),
    fields,
    segments,
  }
}

/**
 * Merges two lists of lines, each in the order they were written, into one.
 * Lines written at the same time keep the order they arrived in.
 */
export function mergeLines(lines: LogLine[], incoming: LogLine[]): LogLine[] {
  const merged: LogLine[] = []
  let i = 0
  let j = 0
  while (i < lines.length && j < incoming.length) {
    merged.push(incoming[j]!.at < lines[i]!.at ? incoming[j++]! : lines[i++]!)
  }
  return merged.concat(lines.slice(i), incoming.slice(j))
}

/**
 * What tells pods apart: their names without the part they share
 * (`storefront-7c9f8d6b4-x2lq9` → `x2lq9`), cut at a dash.
 */
export function shortNames(names: string[]): Map<string, string> {
  let shared = names[0]!
  for (const name of names) {
    while (!name.startsWith(shared)) shared = shared.slice(0, -1)
  }
  const cut = names.length > 1 ? shared.lastIndexOf('-') + 1 : 0
  return new Map(names.map((name) => [name, name.slice(cut)]))
}

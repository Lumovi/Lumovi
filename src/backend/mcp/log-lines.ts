/**
 * A container's log lines as get_logs answers with them: those with a text in them, those of a
 * level and above, and never more than an answer holds. Where they'd be more, the first and the
 * last of them, and between them what was left out and how to ask for it: never an error, and
 * never cut without saying so.
 */

/** Levels a log line can have, the least first. */
export const LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type Level = (typeof LEVELS)[number]

/** What a line's own level is called, where a log says it. */
const SAID: Readonly<Record<string, Level>> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  notice: 'info',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  err: 'error',
  fatal: 'error',
  critical: 'error',
  crit: 'error',
  panic: 'error',
  emerg: 'error',
  alert: 'error',
}

/**
 * A line's level, where it says one: a structured line's `level` or `severity` (JSON, or
 * `level=` as logfmt writes it), or a word of its own at its start (ERROR, [warn], W1014…).
 * A Go panic and a stack's first line are errors. Nothing, where it doesn't say.
 */
export function levelOf(line: string): Level | undefined {
  const field = /["']?(?:level|severity|lvl)["']?\s*[:=]\s*["']?([a-z]+)/i.exec(line)
  if (field) return SAID[field[1]!.toLowerCase()]
  const word = /^\W{0,2}([a-z]+)\b/i.exec(line)
  if (word && SAID[word[1]!.toLowerCase()]) return SAID[word[1]!.toLowerCase()]
  if (/^(panic|fatal error):/i.test(line) || /^Traceback \(most recent call last\)/.test(line)) {
    return 'error'
  }
  return undefined
}

/**
 * The lines with `match` in them (any case), and of `level` and above (a line that says no
 * level is kept with the one before it, as a stack's lines belong to their error).
 */
export function linesOf(
  text: string,
  { match, level }: { match?: string; level?: Level } = {},
): string[] {
  let lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (level) {
    const least = LEVELS.indexOf(level)
    let keeping = false
    lines = lines.filter((line) => {
      const said = levelOf(line)
      if (said !== undefined) keeping = LEVELS.indexOf(said) >= least
      return keeping
    })
  }
  if (match) {
    const wanted = match.toLowerCase()
    lines = lines.filter((line) => line.toLowerCase().includes(wanted))
  }
  return lines
}

/** The longest a line is shown: past it, cut, and said so. */
const LINE_CHARS = 2_000

/**
 * Lines as an answer holds them, from line `from` on (1, unless given): all of them where they
 * fit in `most` characters; else the first fifth and the last of what fits, and between them
 * how many were left out and the `from` that asks for them.
 */
export function fitted(lines: readonly string[], most: number, from = 1): string {
  const shown = lines
    .slice(from - 1)
    .map((line) =>
      line.length > LINE_CHARS
        ? `${line.slice(0, LINE_CHARS)}… (${line.length - LINE_CHARS} more characters)`
        : line,
    )
  const whole = shown.join('\n')
  if (whole.length <= most) return whole
  // (Room left for the line that says what was left out.)
  const room = most - 400
  const head: string[] = []
  let used = 0
  for (const line of shown) {
    if (used + line.length + 1 > room / 5) break
    head.push(line)
    used += line.length + 1
  }
  const tail: string[] = []
  for (let i = shown.length - 1; i >= head.length; i--) {
    const line = shown[i]!
    if (used + line.length + 1 > room) break
    tail.unshift(line)
    used += line.length + 1
  }
  const leftOut = shown.length - head.length - tail.length
  const first = from + head.length
  return [
    ...head,
    `… ${leftOut} lines left out here (lines ${first} to ${first + leftOut - 1} of ${from + shown.length - 1}): ask again with from: ${first}, and the same tailLines, match and level, for them (a log that has grown since numbers its lines anew).`,
    ...tail,
  ].join('\n')
}

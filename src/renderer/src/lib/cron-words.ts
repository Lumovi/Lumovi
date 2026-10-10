/**
 * A CronJob's schedule, read back in words: "30 2 * * *" is "Every day at 02:30". For whoever
 * types one in Create's form, to see that it says what they meant.
 *
 * It reads what Kubernetes does: five fields (minute, hour, day of the month, month, day of
 * the week), each `*`, a number, a range, a list, or any of those with a step; names for
 * months and days; `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`; and `@every` with
 * a length of time. A schedule that
 * isn't one of those is said to be wrong, and which field. One that's right but more
 * involved than these words reach is said to be right, with no words put in its mouth.
 */

export type Scheduled =
  /**
   * `words` is the sentence, without where its clock is; none, where words don't reach it.
   * `never` says, in place of words, that it's a schedule whose day never comes.
   */
  { ok: true; words?: string; never?: string } | { ok: false; why: string }

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

interface Field {
  name: string
  /** What it can be, said to whoever typed something else. */
  goes: string
  min: number
  max: number
  names?: string[]
  /** What a name's number starts from: months from 1, days from 0. */
  from?: number
}

const FIELDS: Field[] = [
  { name: 'minute', goes: 'minutes go from 0 to 59', min: 0, max: 59 },
  { name: 'hour', goes: 'hours go from 0 to 23', min: 0, max: 23 },
  { name: 'day of the month', goes: 'days of the month go from 1 to 31', min: 1, max: 31 },
  {
    name: 'month',
    goes: 'months go from 1 to 12, or jan to dec',
    min: 1,
    max: 12,
    names: MONTHS,
    from: 1,
  },
  {
    name: 'day of the week',
    // (Not 7 for Sunday, as some crons have it: Kubernetes' doesn't, and refuses it.)
    goes: 'days of the week go from 0 to 6, or sun to sat',
    min: 0,
    max: 6,
    names: DAYS,
    from: 0,
  },
]

/** What a field says: every value, every `step`th, or these. */
interface Said {
  any: boolean
  /** A star with a step of five: every fifth, from the field's first. */
  every?: number
  /** One `a-b`, and nothing else. */
  range?: [number, number]
  /** The values it comes to, in order, each once. */
  values: number[]
  /** Whether any of it was said by a step. */
  stepped: boolean
  /** A step longer than what it steps through: valid, and nobody's meaning. */
  over: boolean
}

function number(text: string, field: Field): number | undefined {
  if (/^\d{1,2}$/.test(text)) return Number(text)
  const named = field.names?.findIndex(
    (name) => name.slice(0, 3).toLowerCase() === text.toLowerCase(),
  )
  return named === undefined || named < 0 ? undefined : named + field.from!
}

/** A field read, or what's wrong with it: a sentence. */
function read(text: string, field: Field): Said | string {
  const values = new Set<number>()
  let any = false
  let every: number | undefined
  let range: [number, number] | undefined
  let stepped = false
  let over = false
  const parts = text.split(',')
  const wrong = (part: string, why = field.goes) => `The ${field.name} is “${part}”, and ${why}.`
  for (const part of parts) {
    if (part === '') return `The ${field.name} has nothing between two of its commas.`
    const [span, step, more] = part.split('/')
    if (more !== undefined || span === undefined || span === '') return wrong(part)
    const by = step === undefined ? 1 : /^\d{1,2}$/.test(step) ? Number(step) : 0
    if (by < 1) return wrong(part, 'a step is a number from 1')
    if (by > 1) stepped = true
    let from: number | undefined
    let to: number | undefined
    if (span === '*' || span === '?') {
      ;[from, to] = [field.min, field.max]
      if (parts.length === 1) {
        if (by === 1) any = true
        // "Every 15 minutes" is true only where the step divides the hour: every 7 starts
        // over at :00, and is its list of minutes.
        else if ((to - from + 1) % by === 0) every = by
      }
    } else {
      const [first, last, extra] = span.split('-')
      from = number(first ?? '', field)
      // `5/15` is from 5 on, by 15s.
      to = last === undefined ? (step === undefined ? from : field.max) : number(last, field)
      if (extra !== undefined || from === undefined || to === undefined) return wrong(part)
      if (from < field.min || to > field.max) return wrong(part)
      if (from > to) return wrong(part, 'a range goes from the lower to the higher')
      if (parts.length === 1 && last !== undefined && by === 1) range = [from, to]
    }
    if (by > 1 && by > to - from) over = true
    for (let value = from; value <= to; value += by) values.add(value)
  }
  return { any, every, range, values: [...values].sort((a, b) => a - b), stepped, over }
}

const two = (value: number) => String(value).padStart(2, '0')
const clock = (hour: number, minute: number) => `${two(hour)}:${two(minute)}`

/** "one, two and three". */
const listed = (items: string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/** "1st", "22nd". */
function ordinal(day: number): string {
  const tens = day % 100
  const end = tens > 10 && tens < 14 ? 'th' : (['th', 'st', 'nd', 'rd'][day % 10] ?? 'th')
  return `${day}${end}`
}

/** When in the day: "at 02:30", "every 15 minutes". Nothing, where words don't reach it. */
function times(minute: Said, hour: Said): string | undefined {
  const one = minute.values.length === 1 ? minute.values[0]! : undefined
  if (minute.any && hour.any) return 'every minute'
  if (minute.every && hour.any) return `every ${minute.every} minutes`
  if (one !== undefined && hour.any) {
    return one === 0 ? 'every hour, on the hour' : `every hour, at ${one} minutes past`
  }
  if (one !== undefined && hour.every) {
    return `every ${hour.every} hours, ${one === 0 ? 'on the hour' : `at ${one} minutes past`}`
  }
  if (one !== undefined && hour.range) {
    return `every hour from ${clock(hour.range[0], one)} to ${clock(hour.range[1], one)}`
  }
  if (one !== undefined && hour.values.length <= 6) {
    return `at ${listed(hour.values.map((value) => clock(value, one)))}`
  }
  if ((minute.any || minute.every) && hour.range) {
    const often = minute.any ? 'every minute' : `every ${minute.every} minutes`
    return `${often} from ${clock(hour.range[0], 0)} to ${clock(hour.range[1], 59)}`
  }
  if ((minute.any || minute.every) && hour.values.length === 1) {
    const often = minute.any ? 'every minute' : `every ${minute.every} minutes`
    return `${often} from ${clock(hour.values[0]!, 0)} to ${clock(hour.values[0]!, 59)}`
  }
  return undefined
}

/** Whether numbers, in the order given, each follow the last. */
const inARow = (values: number[]) =>
  values.length > 2 && values.every((value, i) => i === 0 || value === values[i - 1]! + 1)

/**
 * Days of the week as they're said: a run as its ends ("Monday to Friday", "Friday to
 * Sunday"), anything else as a list from Monday ("Saturday and Sunday").
 */
function week(dow: Said): { names: string[]; run?: string } {
  // From Monday: Sunday, which cron counts first, is said last.
  const fromMonday = [...dow.values].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
  const names = fromMonday.map((value) => DAYS[value]!)
  if (inARow(dow.values)) {
    return { names, run: `${DAYS[dow.values[0]!]} to ${DAYS[dow.values.at(-1)!]}` }
  }
  if (inARow(fromMonday.map((value) => (value + 6) % 7))) {
    return { names, run: `${names[0]} to ${names.at(-1)}` }
  }
  return { names }
}

/** The most days a month has. */
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** "one, two or three". */
const either = (items: string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`

/** A day no month it names has: what to say of a schedule that never comes. Else nothing. */
function never(dom: Said, month: Said, dow: Said): string | undefined {
  // With a day of the week too, cron runs on either: it comes.
  if (dom.any || !dow.any) return undefined
  const most = Math.max(...month.values.map((value) => DAYS_IN[value - 1]!))
  if (!dom.values.every((day) => day > most)) return undefined
  const none = either(dom.values.map(ordinal))
  return month.values.length === 1
    ? `It never runs: ${MONTHS[month.values[0]! - 1]} has no ${none}.`
    : `It never runs: none of those months has a ${none}.`
}

/**
 * Which days: "every day", "Monday to Friday", "on the 1st of every month". `either` where
 * both a day of the month and a day of the week are said, which cron runs on either of.
 * Nothing, where words don't reach.
 */
function days(dom: Said, month: Said, dow: Said): { text: string; either?: true } | undefined {
  // Every other day, every third month: the days they come to are a list nobody would say.
  if (dom.stepped || month.stepped || dow.stepped) return undefined
  const { names, run } = week(dow)
  const months = month.values.map((value) => MONTHS[value - 1]!)
  const monthRun = month.range !== undefined && months.length > 2
  // "in January and July"; "from June to August".
  const inMonths = month.any
    ? ''
    : monthRun
      ? ` from ${months[0]} to ${months.at(-1)}`
      : ` in ${listed(months)}`
  const dates = dom.any
    ? undefined
    : dom.range && dom.values.length > 2
      ? // "from the 22nd to the 24th of every month"
        `from the ${ordinal(dom.range[0])} to the ${ordinal(dom.range[1])} of ${month.any ? 'every month' : monthRun ? `every month${inMonths}` : listed(months)}`
      : months.length === 1 && !month.any
        ? // "on 1 January"; "on 1 and 15 January"
          `on ${listed(dom.values.map(String))} ${months[0]}`
        : `on the ${listed(dom.values.map(ordinal))} of ${month.any ? 'every month' : monthRun ? `every month${inMonths}` : listed(months)}`
  if (dates && !dow.any) {
    return { text: `${dates} and on every ${listed(names)}${inMonths}`, either: true }
  }
  if (dates) return { text: dates }
  if (dow.any) return { text: `every day${inMonths}` }
  // "Monday to Friday"; "every Monday, Wednesday and Friday".
  return {
    text: `${run ?? `every ${listed(names)}`}${inMonths}`,
  }
}

const SHORT: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

/** A sentence with its first letter a capital. */
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** What a schedule says, in words; or why it isn't a schedule. */
export function scheduleWords(schedule: string): Scheduled {
  const text = schedule.trim()
  if (text === '')
    return { ok: false, why: 'A schedule is five fields, like 30 2 * * * for every day at 02:30.' }
  // Every so long, counted from when its controller starts: Kubernetes reads it, and it isn't
  // a time of day to put into words.
  if (/^@every\s+(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(text)) return { ok: true }
  if (text.startsWith('@')) {
    const long = SHORT[text.toLowerCase()]
    return long
      ? scheduleWords(long)
      : {
          ok: false,
          why: `“${text}” isn’t a schedule Kubernetes names: it has @hourly, @daily, @weekly, @monthly, @yearly, and @every with a length of time (@every 1h30m).`,
        }
  }
  const parts = text.split(/\s+/)
  if (parts.length !== 5) {
    return {
      ok: false,
      why: `A schedule is five fields (minute, hour, day of the month, month, day of the week), and this has ${parts.length}.`,
    }
  }
  const read5 = parts.map((part, i) => read(part, FIELDS[i]!))
  const wrong = read5.find((field) => typeof field === 'string')
  if (wrong !== undefined) return { ok: false, why: wrong as string }
  const [minute, hour, dom, month, dow] = read5 as [Said, Said, Said, Said, Said]
  // A step longer than what it steps through is valid and comes to something, which nobody
  // who typed it meant: no words for it.
  if ([minute, hour, dom, month, dow].some((field) => field.over)) return { ok: true }
  const none = never(dom, month, dow)
  if (none) return { ok: true, never: none }
  const when = times(minute, hour)
  const which = days(dom, month, dow)
  if (!when || !which) return { ok: true }
  const either = which.either ? ' (cron runs on either when both are set)' : ''
  // "Every day at 02:30"; "On the 13th of every month and on every Friday, at 00:00".
  if (when.startsWith('at ')) {
    return { ok: true, words: sentence(`${which.text}${either ? ',' : ''} ${when}${either}`) }
  }
  // "Every minute", for every day; "Every 15 minutes, Monday to Friday"; "…, every day in
  // December"; "…, on the 1st of every month".
  return {
    ok: true,
    words: sentence(
      which.text === 'every day'
        ? when
        : `${when}, ${which.text.startsWith('every day') ? which.text : which.text.replace(/^every /, '')}${either}`,
    ),
  }
}

/**
 * Where a person's logs start, as they type it: a time ago ("90m", "2h", "3d", "1h30m"), or a
 * date and time ("14:30" is today; "2026-10-11 09:00"), in their own time zone. Read here, said
 * back in words, and named for the picker.
 */
import { withTime } from '@renderer/lib/time'

/** A since: so long ago (counted from when the logs are asked for), or from a moment. */
export type Since = { seconds: number } | { at: number }

const UNITS: Record<string, number> = { d: 86_400, h: 3600, m: 60, s: 1 }
const DURATION = /^(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/i
const CLOCK = /^(\d{1,2}):(\d{2})$/
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/

/** What a person typed, read: a since, or why it can't be one (nothing typed: nothing). */
export function readSince(
  text: string,
  now: number,
): { since: Since } | { problem: 'unread' | 'future' } | undefined {
  const typed = text.trim()
  if (!typed) return undefined
  const duration = DURATION.exec(typed)
  if (duration && duration.slice(1).some(Boolean)) {
    const [, d, h, m, s] = duration
    const seconds = [d, h, m, s].reduce(
      (sum, value, i) => sum + Number(value ?? 0) * Object.values(UNITS)[i]!,
      0,
    )
    return seconds > 0 ? { since: { seconds } } : { problem: 'unread' }
  }
  let at: number | undefined
  const clock = CLOCK.exec(typed)
  if (clock) {
    const [hours, minutes] = [Number(clock[1]), Number(clock[2])]
    if (hours > 23 || minutes > 59) return { problem: 'unread' }
    const day = new Date(now)
    day.setHours(hours, minutes, 0, 0)
    at = day.getTime()
  }
  const dated = DATE_TIME.exec(typed)
  if (dated) {
    const [year, month, date, hours = 0, minutes = 0] = dated.slice(1).map((n) => Number(n ?? 0))
    const day = new Date(year!, month! - 1, date!, hours, minutes)
    // (A date that rolled over, like the 31st of a month that has 30, isn't one.)
    if (day.getMonth() !== month! - 1 || day.getDate() !== date || hours > 23 || minutes > 59) {
      return { problem: 'unread' }
    }
    at = day.getTime()
  }
  if (at === undefined) return { problem: 'unread' }
  return at > now ? { problem: 'future' } : { since: { at } }
}

/** When a since starts, at `now`. */
export const startOf = (since: Since, now: number) =>
  'at' in since ? since.at : now - since.seconds * 1000

const pad = (n: number) => String(n).padStart(2, '0')
const clockOf = (at: Date) => `${pad(at.getHours())}:${pad(at.getMinutes())}`
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

/** A span in words, biggest two units: "90 minutes", "1 day 5 hours", "3 days". */
export function spanOf(seconds: number): string {
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return [plural(days, 'day'), hours ? plural(hours, 'hour') : ''].join(' ').trim()
  if (hours > 0 && minutes > 0 && hours < 2) return plural(hours * 60 + minutes, 'minute')
  if (hours > 0)
    return [plural(hours, 'hour'), minutes ? plural(minutes, 'minute') : ''].join(' ').trim()
  return plural(Math.max(1, minutes), 'minute')
}

/** A moment in words, as the rest of the page says them: "14:30", "09:00 yesterday", "11 Oct 09:00". */
export function momentOf(at: number, now: number, { today = '' } = {}): string {
  const moment = new Date(at)
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  const midnight = day.getTime()
  if (at >= midnight) return `${clockOf(moment)}${today ? ` ${today}` : ''}`
  if (at >= midnight - 86_400_000) return `${clockOf(moment)} yesterday`
  const date = moment.toLocaleDateString(
    'en-GB',
    withTime({
      day: 'numeric',
      month: 'short',
      ...(moment.getFullYear() !== day.getFullYear() && { year: 'numeric' }),
    }),
  )
  return `${date} ${clockOf(moment)}`
}

/** The person's own zone, as "UTC+2" (or "UTC" where it's that). */
export function zoneOf(at: number): string {
  const offset = -new Date(at).getTimezoneOffset()
  if (offset === 0) return 'UTC'
  const hours = Math.floor(Math.abs(offset) / 60)
  const minutes = Math.abs(offset) % 60
  return `UTC${offset > 0 ? '+' : '−'}${hours}${minutes ? `:${pad(minutes)}` : ''}`
}

/** What Lumovi read, said under the field: "From 12:58 today, 90 minutes ago, your time (UTC+2)." */
export function readBack(since: Since, now: number): string {
  const start = startOf(since, now)
  const ago = spanOf(Math.round((now - start) / 1000))
  return `From ${momentOf(start, now, { today: 'today' })}, ${ago} ago, your time (${zoneOf(start)}).`
}

/** What the picker says of a since: "Last 90 minutes", "Since 14:30", "Since 09:00 yesterday". */
export function labelOf(since: Since, now: number): string {
  return 'seconds' in since ? `Last ${spanOf(since.seconds)}` : `Since ${momentOf(since.at, now)}`
}

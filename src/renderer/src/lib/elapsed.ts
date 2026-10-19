const DAY_MINUTES = 24 * 60

/** A duration as Lumovi says one: 42s, 1m 05s, 12m 30s, 1h 02m; from a day, 1d 0h, 15d 17h. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const two = (n: number) => String(n).padStart(2, '0')
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${two(seconds % 60)}s`
  if (minutes < DAY_MINUTES) return `${Math.floor(minutes / 60)}h ${two(minutes % 60)}m`
  return `${Math.floor(minutes / DAY_MINUTES)}d ${Math.floor((minutes % DAY_MINUTES) / 60)}h`
}

/**
 * The same, as it's spoken, in whole minutes: "1 minute", "less than a minute"; from a day, in
 * days and hours: "15 days 17 hours". (A name that changed every second would be said every
 * second to whoever has it in focus: the seconds are on screen and in the tooltip.)
 */
export function spokenElapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const both = (a: string, b: string | false) => [a, b].filter(Boolean).join(' ')
  const [d, h, m] = [
    Math.floor(minutes / DAY_MINUTES),
    Math.floor((minutes % DAY_MINUTES) / 60),
    minutes % 60,
  ]
  if (d > 0) return both(unit(d, 'day'), h > 0 && unit(h, 'hour'))
  if (h > 0) return both(unit(h, 'hour'), m > 0 && unit(m, 'minute'))
  return m > 0 ? unit(m, 'minute') : 'less than a minute'
}

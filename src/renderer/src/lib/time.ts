/**
 * Where and how times are said (Settings' Time): the zone events, logs and the audit read in, and
 * the clock. Each date Lumovi writes asks for these (withTime), as the person's settings have them
 * now. Ages ("2h", "3d") don't depend on either.
 */
import type { Preferences } from '@shared/preferences'

let zone = 'local'
let clock: Preferences['clock'] = 'system'

/** As the person's settings are now (set as they're read, and as they change). */
export function setTimeSettings(preferences: Pick<Preferences, 'timeZone' | 'clock'>): void {
  zone = preferences.timeZone
  clock = preferences.clock
}

/** A date's options, with the zone and clock the person chose over what's asked. */
export function withTime(options: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormatOptions {
  return {
    ...options,
    ...(zone !== 'local' ? { timeZone: zone } : {}),
    ...(clock !== 'system' && (options.timeStyle || options.hour)
      ? { hour12: clock === '12' }
      : {}),
  }
}

/** This device's own zone, as Settings names it, its offset first (what a cut must keep): "UTC+2, Europe/Budapest". */
export function localZone(at = new Date()): string {
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone
  const offset = -at.getTimezoneOffset()
  const hours = Math.trunc(Math.abs(offset) / 60)
  const minutes = Math.abs(offset) % 60
  return `UTC${offset < 0 ? '−' : '+'}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}, ${name}`
}

/** Whether this device's clock is 12-hour, as its locale has it. */
export function localClockIs12(): boolean {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 === true
}

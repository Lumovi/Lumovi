import { Cron } from 'croner'
import cronstrue from 'cronstrue'

/** "0 2 * * *" → "At 02:00 AM". Falls back to the expression if it can't be read. */
export function describeSchedule(schedule: string): string {
  try {
    return cronstrue.toString(schedule, { verbose: false })
  } catch {
    return schedule
  }
}

/** When a CronJob fires next, in its time zone (UTC unless the spec says otherwise). */
export function nextRun(schedule: string, timeZone = 'Etc/UTC'): Date | null {
  try {
    return new Cron(schedule, { timezone: timeZone }).nextRun()
  } catch {
    return null
  }
}

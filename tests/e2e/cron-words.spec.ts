/**
 * A CronJob's schedule, read back in words (`lib/cron-words`): what Create's form says under
 * the schedule as it's typed, so it can be seen to mean what was meant.
 */
import { scheduleWords } from '../../src/renderer/src/lib/cron-words.ts'
import { expect, test } from './fixtures.ts'

const words = (schedule: string) => {
  const read = scheduleWords(schedule)
  return read.ok ? (read.words ?? read.never ?? '(no words)') : `not a schedule: ${read.why}`
}

test('a schedule is read back in words', () => {
  for (const [schedule, said] of [
    ['30 2 * * *', 'Every day at 02:30'],
    ['0 0 * * *', 'Every day at 00:00'],
    ['* * * * *', 'Every minute'],
    ['*/15 * * * *', 'Every 15 minutes'],
    ['0 * * * *', 'Every hour, on the hour'],
    ['5 * * * *', 'Every hour, at 5 minutes past'],
    ['0 */6 * * *', 'Every 6 hours, on the hour'],
    ['30 */2 * * *', 'Every 2 hours, at 30 minutes past'],
    // A run of days is said as one, without "every"; a list of them, with.
    ['0 9 * * 1-5', 'Monday to Friday at 09:00'],
    ['0 9 * * mon-fri', 'Monday to Friday at 09:00'],
    ['0 9 * * MON-FRI', 'Monday to Friday at 09:00'],
    ['0 9 * * 1,3,5', 'Every Monday, Wednesday and Friday at 09:00'],
    // Said from Monday, though cron counts from Sunday; a run that ends on Sunday is one.
    ['0 9 * * 6,0', 'Every Saturday and Sunday at 09:00'],
    ['0 9 * * 5,6,0', 'Friday to Sunday at 09:00'],
    ['0 9 * * 0-2', 'Sunday to Tuesday at 09:00'],
    ['0 9 * * 0,3', 'Every Wednesday and Sunday at 09:00'],
    ['0 0 * * 0', 'Every Sunday at 00:00'],
    ['0 8 * * SUN', 'Every Sunday at 08:00'],
    ['0 9,13,17 * * *', 'Every day at 09:00, 13:00 and 17:00'],
    ['0 9-17 * * 1-5', 'Every hour from 09:00 to 17:00, Monday to Friday'],
    ['0 0-23 * * *', 'Every hour from 00:00 to 23:00'],
    ['*/10 9-17 * * *', 'Every 10 minutes from 09:00 to 17:59'],
    ['* 3 * * *', 'Every minute from 03:00 to 03:59'],
    ['0 0 1 * *', 'On the 1st of every month at 00:00'],
    ['15 6 1,15 * *', 'On the 1st and 15th of every month at 06:15'],
    ['0 0 22-24 * *', 'From the 22nd to the 24th of every month at 00:00'],
    // A day of one month is a date.
    ['0 0 1 1 *', 'On 1 January at 00:00'],
    ['59 23 31 12 *', 'On 31 December at 23:59'],
    ['0 0 1,15 jan *', 'On 1 and 15 January at 00:00'],
    ['0 12 * 6-8 *', 'Every day from June to August at 12:00'],
    ['0 12 * jan,jul *', 'Every day in January and July at 12:00'],
    ['0 6 * JAN *', 'Every day in January at 06:00'],
    ['*/15 * * 12 *', 'Every 15 minutes, every day in December'],
    ['*/5 * * * 1-5', 'Every 5 minutes, Monday to Friday'],
    ['*/30 * 1 * *', 'Every 30 minutes, on the 1st of every month'],
    // Both a day of the month and a day of the week: cron runs on either, and that's said.
    [
      '0 0 13 * 5',
      'On the 13th of every month and on every Friday, at 00:00 (cron runs on either when both are set)',
    ],
    [
      '*/15 * 1 * 1',
      'Every 15 minutes, on the 1st of every month and on every Monday (cron runs on either when both are set)',
    ],
    ['0 4 ? * *', 'Every day at 04:00'],
    // A step that doesn't divide the day is the hours it comes to, which is what's true.
    ['0 */5 * * *', 'Every day at 00:00, 05:00, 10:00, 15:00 and 20:00'],
    // Kubernetes' own names for the common ones.
    ['@hourly', 'Every hour, on the hour'],
    ['@daily', 'Every day at 00:00'],
    ['@midnight', 'Every day at 00:00'],
    ['@weekly', 'Every Sunday at 00:00'],
    ['@monthly', 'On the 1st of every month at 00:00'],
    ['@yearly', 'On 1 January at 00:00'],
    ['  30   2 * * *  ', 'Every day at 02:30'],
    // A day no month named has never comes, and that's said in place of when.
    ['0 0 31 2 *', 'It never runs: February has no 31st.'],
    ['0 0 30,31 2 *', 'It never runs: February has no 30th or 31st.'],
    ['0 0 31 4,6 *', 'It never runs: none of those months has a 31st.'],
    // (The 29th of February does, some years; and one month that has the day is enough.)
    ['0 0 29 2 *', 'On 29 February at 00:00'],
    ['0 0 31 1,2 *', 'On the 31st of January and February at 00:00'],
  ] as const) {
    expect(words(schedule), schedule).toBe(said)
  }
})

test('a schedule that’s right but involved gets no words put in its mouth', () => {
  for (const schedule of [
    // "Every 7 minutes" isn't true: it starts over at each hour. Nor are these short to say:
    // steps within a range, lists of minutes, every other day.
    '*/7 * * * *',
    // A step longer than what it steps through comes to something nobody meant.
    '*/90 * * * *',
    '0 */30 * * *',
    // Every so long, from when its controller starts: valid, and not a time of day.
    '@every 1h',
    '@every 1h30m',
    '@every 90s',
    '10-40/5 * * * *',
    '0,20,40 * * * *',
    '0 0 */2 * *',
    '0 0 * */3 *',
    '15,45 9-17/2 * * *',
    '0 1,2,3,4,5,6,7 * * *',
  ]) {
    expect(scheduleWords(schedule), schedule).toEqual({ ok: true })
  }
})

test('what isn’t a schedule is said to be wrong, and where', () => {
  for (const [schedule, why] of [
    ['', 'A schedule is five fields, like 30 2 * * * for every day at 02:30.'],
    [
      '30 2 * *',
      'A schedule is five fields (minute, hour, day of the month, month, day of the week), and this has 4.',
    ],
    [
      '0 30 2 * * *',
      'A schedule is five fields (minute, hour, day of the month, month, day of the week), and this has 6.',
    ],
    ['60 2 * * *', 'The minute is “60”, and minutes go from 0 to 59.'],
    ['30 24 * * *', 'The hour is “24”, and hours go from 0 to 23.'],
    ['30 25 * * *', 'The hour is “25”, and hours go from 0 to 23.'],
    ['0 0 0 * *', 'The day of the month is “0”, and days of the month go from 1 to 31.'],
    ['0 0 * 13 *', 'The month is “13”, and months go from 1 to 12, or jan to dec.'],
    [
      '0 0 * * 8',
      'The day of the week is “8”, and days of the week go from 0 to 6, or sun to sat.',
    ],
    // Sunday is 0 only: Kubernetes' cron has no 7.
    [
      '0 0 * * 7',
      'The day of the week is “7”, and days of the week go from 0 to 6, or sun to sat.',
    ],
    [
      '0 0 * * 0-7',
      'The day of the week is “0-7”, and days of the week go from 0 to 6, or sun to sat.',
    ],
    [
      '0 0 * * funday',
      'The day of the week is “funday”, and days of the week go from 0 to 6, or sun to sat.',
    ],
    ['a 2 * * *', 'The minute is “a”, and minutes go from 0 to 59.'],
    ['*/0 * * * *', 'The minute is “*/0”, and a step is a number from 1.'],
    ['*/x * * * *', 'The minute is “*/x”, and a step is a number from 1.'],
    ['5-1 * * * *', 'The minute is “5-1”, and a range goes from the lower to the higher.'],
    ['1-2-3 * * * *', 'The minute is “1-2-3”, and minutes go from 0 to 59.'],
    ['1,,2 * * * *', 'The minute has nothing between two of its commas.'],
    [
      '@every soon',
      '“@every soon” isn’t a schedule Kubernetes names: it has @hourly, @daily, @weekly, @monthly, @yearly, and @every with a length of time (@every 1h30m).',
    ],
    [
      '@fortnightly',
      '“@fortnightly” isn’t a schedule Kubernetes names: it has @hourly, @daily, @weekly, @monthly, @yearly, and @every with a length of time (@every 1h30m).',
    ],
  ] as const) {
    expect(scheduleWords(schedule), JSON.stringify(schedule)).toEqual({ ok: false, why })
  }
})

/**
 * Lumovi's waits a test may lengthen (LMV-410): a window's keys that aren't answers yet, a
 * search waiting for typing to stop, a read polled again. A slow machine runs a test's steps
 * slower than these windows are long, and a step meant to land inside one lands after it.
 *
 * In the tests' build alone, a test sets `window.__lumoviTimings` (in ms), read each time a wait
 * starts; a release build has none of it.
 */

declare const LUMOVI_TEST_BUILD: boolean

export type Timing = 'answerAfter' | 'typing' | 'poll'

/** How long a wait is: Lumovi's own, or (in the tests' build) what a test set. */
export function timing(name: Timing, own: number): number {
  return (
    (typeof LUMOVI_TEST_BUILD !== 'undefined' &&
      LUMOVI_TEST_BUILD &&
      (globalThis as { __lumoviTimings?: Partial<Record<Timing, number>> }).__lumoviTimings?.[
        name
      ]) ||
    own
  )
}

/**
 * Keeping screens still, so the same screen comes out the same, pixel for
 * pixel, whenever it's taken: one moment in time, and nothing in motion.
 */

/**
 * The moment every screenshot is taken at. Ages, times and charts depend on
 * the clock, so the mock clusters and the page share this one, stopped.
 */
export const EPOCH = Date.UTC(2026, 8, 16, 14, 20)

/**
 * Stops the clock at `epoch` for `new Date()` and `Date.now()`; timers still
 * run. Self-contained, as it's also sent to pages (`addInitScript`).
 */
export function stopClock(epoch: number): void {
  const RealDate = Date
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args, newTarget) =>
      Reflect.construct(target, args.length === 0 ? [epoch] : args, newTarget),
    // Date() called as a function: the time as text.
    apply: () => new RealDate(epoch).toString(),
    get: (target, key, receiver) =>
      key === 'now' ? () => epoch : Reflect.get(target, key, receiver),
  })
}

/**
 * Turns off a page's animations and transitions, so things show as they end
 * up, and hides the blinking text cursor. (An animation that has finished but
 * holds its last frame, as entrances do, leaves what it animated on a layer
 * of its own, drawn a pixel off now and then; the editor's cursor blinks.)
 * A constructed style sheet, which a Content Security Policy doesn't stop.
 * For `addInitScript`.
 */
export function stopAnimations(): void {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(
    '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }',
  )
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
}

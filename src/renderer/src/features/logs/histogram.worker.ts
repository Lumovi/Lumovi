/**
 * The histogram's counting: how many lines in each step of time, and how many of them errors and
 * warnings. Apart from the page, so a long log is counted without holding it.
 */

export interface CountRequest {
  id: number
  /** When each line was written (ms), and its level: 0 info, 1 a warning, 2 an error. */
  ats: Float64Array
  levels: Uint8Array
  start: number
  step: number
  bars: number
}

export interface CountAnswer {
  id: number
  all: Uint32Array
  warnings: Uint32Array
  errors: Uint32Array
}

// (Only what the page that made it sends, through the worker's own port: a message with no origin.
// Any other is dropped.)
self.onmessage = ({ data, origin }: MessageEvent<CountRequest>) => {
  if (origin !== '') return
  const { id, ats, levels, start, step, bars } = data
  const all = new Uint32Array(bars)
  const warnings = new Uint32Array(bars)
  const errors = new Uint32Array(bars)
  for (let i = 0; i < ats.length; i++) {
    const bar = Math.floor((ats[i]! - start) / step)
    if (bar < 0 || bar >= bars) continue
    all[bar]!++
    if (levels[i] === 1) warnings[bar]!++
    else if (levels[i] === 2) errors[bar]!++
  }
  const answer: CountAnswer = { id, all, warnings, errors }
  self.postMessage(answer, { transfer: [all.buffer, warnings.buffer, errors.buffer] })
}

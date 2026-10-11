/**
 * A sentence with a name in it, in a number of lines at most: where it would take more, it's
 * the name that's shortened, in its middle with its end kept, and nothing else. The name is
 * given by its place (what's before it and after it), so whatever characters it holds it is
 * itself, and a word like it elsewhere in the sentence isn't taken for it.
 */

/** How much of a name's end is kept when its middle is cut. */
export const NAME_END = 6

export function cutToFit({
  before,
  name,
  after,
  fits,
}: {
  before: string
  name: string
  after: string
  /** Whether a candidate fits: it's put where it will show, and measured there. */
  fits: (candidate: string) => boolean
}): string {
  const whole = `${before}${name}${after}`
  if (fits(whole) || name.length <= NAME_END + 2) return whole
  const cut = (kept: number) => `${before}${name.slice(0, kept)}…${name.slice(-NAME_END)}${after}`
  // The most of the name's start that still fits.
  let low = 1
  let high = name.length - NAME_END - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(cut(middle))) low = middle
    else high = middle - 1
  }
  return cut(low)
}

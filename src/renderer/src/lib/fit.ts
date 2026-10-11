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

/** The least of an object's name that's left when its middle is cut: its start and its end. */
const NAME_LEAST = [4, NAME_END] as const
/** And of the name of where it is: more of its end, which is what tells one from another. */
const WHERE_LEAST = [6, 16] as const

/**
 * A sentence about an object somewhere (`before` `name` `after` `where` `end`), cut to fit:
 * first the object's name in its middle, as far as it must and no further than its least; then
 * the name of where it is, likewise. Nothing else is cut. Says whether what it came to fits.
 */
export function cutSentence({
  before,
  name,
  after,
  where,
  end,
  fits,
}: {
  before: string
  name: string
  after: string
  where: string
  end: string
  fits: (candidate: string) => boolean
}): { text: string; fits: boolean } {
  const whole = `${before}${name}${after}${where}${end}`
  if (fits(whole)) return { text: whole, fits: true }
  const middleCut = (text: string, start: number, last: number) =>
    `${text.slice(0, start)}…${text.slice(-last)}`
  /** The most of `text`'s start that fits, its end kept; undefined if its least doesn't. */
  const most = (
    text: string,
    [least, last]: readonly [number, number],
    sentence: (cut: string) => string,
  ) => {
    if (text.length <= least + last + 1) return undefined
    if (!fits(sentence(middleCut(text, least, last)))) return undefined
    let low = least
    let high = text.length - last - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (fits(sentence(middleCut(text, middle, last)))) low = middle
      else high = middle - 1
    }
    return sentence(middleCut(text, low, last))
  }
  const byName = most(name, NAME_LEAST, (cut) => `${before}${cut}${after}${where}${end}`)
  if (byName) return { text: byName, fits: true }
  const least = (text: string, [start, last]: readonly [number, number]) =>
    text.length > start + last + 1 ? middleCut(text, start, last) : text
  const shortName = least(name, NAME_LEAST)
  const byWhere = most(where, WHERE_LEAST, (cut) => `${before}${shortName}${after}${cut}${end}`)
  if (byWhere) return { text: byWhere, fits: true }
  return { text: `${before}${shortName}${after}${least(where, WHERE_LEAST)}${end}`, fits: false }
}

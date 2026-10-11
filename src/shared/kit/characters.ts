/**
 * The characters of a plugin's text that nobody sees, and what Lumovi does with them. A text of
 * a plugin's sits in Lumovi's own parts, beside names and ages Lumovi draws, and its words can
 * be quoted in a line of Lumovi's: a character that turns the direction of text, has no width,
 * or isn't text at all could make one read as the other.
 *
 * The same characters a plugin's file may not have in its texts (`plugins.ts`), said here by
 * what they are and not one by one.
 */

/**
 * Not seen, or not text: control characters, format characters (those that turn a text's
 * direction, the ones with no width and the joiner among them), half of a pair, a code point
 * only someone's own font would draw, the breaks that aren't a line's end, and the letters that
 * are drawn as nothing.
 */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}͏ᅟᅠㅤﾠ]/u
/** And what only looks like a space, or is nothing yet: for words shown as someone else's. */
const UNSEEN_OR_ODD = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}͏ᅟᅠㅤﾠ]|(?! )\p{Zs}/gu

export const codePoint = (character: string) =>
  `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`

/**
 * The first character of `text` a plugin's text can't have, as its code point; nothing if it has
 * none. A line's end and a tab are text where `lines` says so, and nowhere else.
 */
export function unseenIn(text: string, lines = false): string | undefined {
  for (const character of text) {
    if (lines && (character === '\n' || character === '\t')) continue
    if (UNSEEN.test(character)) return codePoint(character)
  }
  return undefined
}

/**
 * `text` with every character that can't be seen written as its code point ("<U+200B>"), cut at
 * `most` characters first (by code points: half of a pair is never left, and what's spelled out
 * can't push the rest out of sight).
 */
export function spelledOut(text: string, most: number): string {
  const all = Array.from(String(text))
  const cut = all.slice(0, most).join('')
  return (
    cut.replace(UNSEEN_OR_ODD, (unseen) => `<${codePoint(unseen)}>`) +
    (all.length > most ? '…' : '')
  )
}

/** How much of what a plugin wrote is quoted back in a line about it. */
const QUOTED = 40

/** What a plugin wrote, quoted in a line of Lumovi's about it: short, one line, nothing unseen. */
export const quotedBack = (text: string) => `"${spelledOut(text, QUOTED).replaceAll('"', '\\"')}"`

/** A piece of someone else's words: text as it is, or a character that can't be seen, named. */
export type Piece = string | { unseen: string }

/** The lines someone else's words are shown in, at most. */
const LINES = 5

/**
 * `text` in pieces, for showing as someone else's words: what can be seen as text, each character
 * that can't as its own piece (drawn as a mark no text could be). A line's end stays one (`\n`
 * in a piece of text) up to five lines; past that, and wherever lines are empty, it's a space,
 * so a short text can't be made a tall one. `most` characters at most.
 */
export function inPieces(text: string, most: number): Piece[] {
  let lines = 1
  const flowing = String(text)
    .trim()
    .replace(/[ \t]*(?:\r\n|[\n\r\u2028\u2029])[\s\u2028\u2029]*/g, () =>
      ++lines <= LINES ? '\n' : ' ',
    )
  const pieces: Piece[] = []
  let run = ''
  for (const character of Array.from(flowing).slice(0, most)) {
    UNSEEN_OR_ODD.lastIndex = 0
    if (character === '\n' || !UNSEEN_OR_ODD.test(character)) {
      run += character
      continue
    }
    if (run) pieces.push(run)
    run = ''
    pieces.push({ unseen: codePoint(character) })
  }
  if (run) pieces.push(run)
  return pieces
}

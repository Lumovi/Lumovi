/**
 * A text that isn't Lumovi's, made safe to draw: a plugin's text on its page, a property of a
 * part, what a plugin said as it failed. Most of what a plugin's page shows is what's in the
 * cluster, written by whoever may write there, so a character is never a reason to refuse a
 * text or to stop a plugin. Instead every part of Lumovi's draws such a text from its pieces,
 * made here and nowhere else: runs of text, and marks of Lumovi's for the characters that would
 * turn text round, aren't text, or draw as nothing where a letter should be.
 *
 * In pieces, and never one text with the marks written into it: whatever a mark is spelled as,
 * a plugin could have typed.
 */

/**
 * What's drawn as a mark and never acts:
 * - an escape sequence (the colours in an error), as one;
 * - what turns text round (the embeddings, overrides and isolates; the three weak marks that
 *   right-to-left writing uses are text);
 * - control characters, but a line's end and a tab;
 * - the format characters that aren't what writing is joined and broken with, the tags among
 *   them (but the tags of a flag, after its flag, two to six and closed);
 * - letters that draw as blank, and the placeholder for an object;
 * - private use, noncharacters, and half of a pair.
 * Everything else is text, as written: every script, emoji, every space, the joiners, the soft
 * hyphen, the byte order mark, and a code point this browser has no glyph for.
 */
/* eslint-disable no-control-regex */
const MARKED =
  /(\u{1f3f4}[\u{e0030}-\u{e0039}\u{e0061}-\u{e007a}]{2,6}\u{e007f})|\u001b\[[\u0020-\u003f]{0,16}[\u0040-\u007e]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u0084\u0086-\u009f\u202a-\u202e\u2066-\u2069\u180e\u206a-\u206f\ufff9-\ufffc\u{1d173}-\u{1d17a}\u{e0001}\u{e0020}-\u{e007f}\u115f\u1160\u3164\uffa0\ue000-\uf8ff\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}\ufdd0-\ufdef\ufffe\uffff\u{1FFFE}\u{1FFFF}\u{2FFFE}\u{2FFFF}\u{3FFFE}\u{3FFFF}\u{4FFFE}\u{4FFFF}\u{5FFFE}\u{5FFFF}\u{6FFFE}\u{6FFFF}\u{7FFFE}\u{7FFFF}\u{8FFFE}\u{8FFFF}\u{9FFFE}\u{9FFFF}\u{AFFFE}\u{AFFFF}\u{BFFFE}\u{BFFFF}\u{CFFFE}\u{CFFFF}\u{DFFFE}\u{DFFFF}\u{EFFFE}\u{EFFFF}\u{FFFFE}\u{FFFFF}\u{10FFFE}\u{10FFFF}\p{Cs}]/gu

/* eslint-enable no-control-regex */

/** A line's end, however it was written. */
const LINE_END = /\r\n|[\r\u0085\u2028\u2029]/g

/** The most marks drawn in one text: past them, one last piece says how many more there were. */
export const MARKS_AT_MOST = 20

export const codePoint = (character: string) =>
  `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`

/**
 * A piece of a text that isn't Lumovi's: text as it is (a line's end in it is `\n`), a
 * character drawn as a mark, named by its code point, or how many more marks there were.
 */
export type Piece = string | { unseen: string } | { more: number }

/** `text` in pieces, for drawing. */
export function inPieces(text: string): Piece[] {
  const lines = String(text).replace(LINE_END, '\n')
  const pieces: Piece[] = []
  let from = 0
  let marks = 0
  for (const marked of lines.matchAll(MARKED)) {
    // (A flag made with tags, whole and closed, is text; a tag anywhere else is a mark.)
    if (marked[1] !== undefined) continue
    if (marked.index > from) pieces.push(lines.slice(from, marked.index))
    from = marked.index + marked[0].length
    if (++marks <= MARKS_AT_MOST) pieces.push({ unseen: codePoint(marked[0]) })
  }
  if (from < lines.length) pieces.push(lines.slice(from))
  if (marks > MARKS_AT_MOST) pieces.push({ more: marks - MARKS_AT_MOST })
  return pieces
}

/**
 * Someone else's short words (what a plugin said as it failed), in pieces: `most` characters at
 * most, by code points, so half of a pair is never left; a line's end stays one up to `lines`
 * lines, and past that, and wherever lines are empty, it's a space, so a short text can't be
 * made a tall one.
 */
export function shortInPieces(text: string, most: number, lines: number): Piece[] {
  let line = 1
  // (Only plain white space is trimmed and folded: what can't be seen is shown, not dropped.)
  const flowing = String(text)
    .replace(LINE_END, '\n')
    .replace(/^[ \t\n]+|[ \t\n]+$/g, '')
    .replace(/[ \t]*\n[ \t\n]*/g, () => (++line <= lines ? '\n' : ' '))
  return inPieces(Array.from(flowing).slice(0, most).join(''))
}

/**
 * `text` as plain text, where a mark can't be drawn (a tooltip, a name read out, a log's line):
 * each character that would be a mark spelled as its code point, the rest as written.
 */
export const spelled = (text: string) =>
  inPieces(text)
    .map((piece) =>
      typeof piece === 'string'
        ? piece
        : 'unseen' in piece
          ? ` ${piece.unseen} `
          : ` and ${piece.more.toLocaleString('en-US')} more `,
    )
    .join('')

/** How much of what a plugin wrote is quoted back in a line about it. */
const QUOTED = 40

/** What a plugin wrote, quoted in a line of Lumovi's about it: short, and on one line. */
export function quotedBack(text: string): string {
  const all = Array.from(String(text))
  const shown = spelled(all.slice(0, QUOTED).join('')).replace(/\s+/g, ' ').trim()
  return `"${shown.replaceAll('"', '\\"')}${all.length > QUOTED ? '…' : ''}"`
}

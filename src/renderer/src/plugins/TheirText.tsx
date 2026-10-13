/**
 * A text that isn't Lumovi's, drawn: a plugin's text on its page, a property of a part, what a
 * plugin said. Every part of Lumovi's draws such a text with this and with nothing else, from
 * its pieces (`@shared/kit/characters`): what would turn text round or isn't text is a mark of
 * Lumovi's, drawn as no text can be.
 *
 * And each is an island: its direction is its own (from its first strong letter) and changes
 * the order of nothing outside it, while its block starts at the left like every other text of
 * a row; and it's clipped to its own box, so marks stacked on a letter can't draw over the row
 * above.
 */
import { inPieces, type Piece } from '@shared/kit/characters'
import type { Their } from '@shared/kit/declare'
import { cn } from '@renderer/lib/cn'

/** A mark's look: what a part that measures one (a column's width) draws it with too. */
export const MARK_CLASS =
  'mx-px inline-block rounded border border-line px-0.5 font-mono text-[0.92em] leading-[1.25] text-ink-3'

/** The mark for a character that can't be seen or would act: its code point, in a hairline box. */
function Mark({ label, children }: { label: string; children: string }) {
  return (
    <span role="img" aria-label={label} data-mark="" className={MARK_CLASS}>
      <span aria-hidden>{children}</span>
    </span>
  )
}

/** Pieces, drawn. With `oneLine`, a line's end and a tab are each a space. */
export function Pieces({ pieces, oneLine }: { pieces: readonly Piece[]; oneLine?: boolean }) {
  return pieces.map((piece, i) =>
    typeof piece === 'string' ? (
      oneLine ? (
        piece.replace(/[\n\t]/g, ' ')
      ) : (
        piece
      )
    ) : 'unseen' in piece ? (
      <Mark key={i} label={`invisible character ${piece.unseen}`}>
        {piece.unseen}
      </Mark>
    ) : (
      <Mark key={i} label={`and ${piece.more.toLocaleString('en-US')} more invisible characters`}>
        {`and ${piece.more.toLocaleString('en-US')} more`}
      </Mark>
    ),
  )
}

/**
 * A text of someone else's, as a block of its own. `lines` keeps its lines' ends (and wraps);
 * without it the text is one line's worth, a line's end a space.
 */
export function TheirText({
  text,
  pieces = inPieces(typeof text === 'string' ? text : (text?.their ?? '')),
  lines,
  inline,
  className,
}: {
  /** A text a part was handed, or (for the page's own texts) the text itself. */
  text?: Their | string
  /** Pieces already made (a plugin's last words are cut before they're pieces). */
  pieces?: readonly Piece[]
  lines?: boolean
  /** One of several texts that run on in a part: the part that holds them clips them. */
  inline?: boolean
  className?: string
}) {
  return (
    <bdi
      dir="auto"
      data-their-text=""
      className={cn(
        // Its own direction inside; but it starts where Lumovi's layout puts it, like any text.
        inline ? 'text-left' : 'block max-w-full overflow-clip text-left',
        '[overflow-wrap:anywhere]',
        lines && 'whitespace-pre-wrap',
        className,
      )}
    >
      <Pieces pieces={pieces} oneLine={!lines} />
    </bdi>
  )
}

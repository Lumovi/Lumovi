/**
 * A plugin's name on one line, cut in its middle where it doesn't fit, as `MiddleTruncate` cuts
 * Lumovi's own: but drawn in pieces, and what's cut is letters, never a mark. A mark is how a
 * person sees what can't be seen, so those of the part that was cut stand right after the
 * ellipsis, and the cut takes more letters to make room for them. Where the marks alone don't
 * fit, the name ends in an ellipsis after the last of them that does.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { inPieces, spelled, type Piece } from '@shared/kit/characters'
import type { Their } from '@shared/kit/declare'
import { KEPT_END } from '@renderer/components/MiddleTruncate'
import { cn } from '@renderer/lib/cn'
import { TheirText } from '@renderer/plugins/TheirText'

/** As much of a plugin's text as a tooltip shows: what Lumovi quotes back of one (`quotedBack`). */
const TIP = 40

/**
 * A plugin's text in a tooltip, where a mark can't be drawn: spelled, on one line, and no longer
 * than Lumovi quotes back.
 */
export function tooltip(text: string): string {
  const all = Array.from(text)
  const shown = spelled(all.slice(0, TIP).join('')).replace(/\s+/g, ' ').trim()
  return all.length > TIP ? `${shown}…` : shown
}

let canvas: CanvasRenderingContext2D | null | undefined

/** How wide a text is as `element` sets it (in capitals, where it's set in them: a heading). */
function widthIn(element: HTMLElement): (text: string) => number {
  canvas ??= document.createElement('canvas').getContext('2d')
  const style = getComputedStyle(element)
  const spacing = Number.parseFloat(style.letterSpacing) || 0
  const upper = style.textTransform === 'uppercase'
  if (canvas) {
    canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  }
  return (text) =>
    (canvas ? canvas.measureText(upper ? text.toUpperCase() : text).width : 0) +
    spacing * text.length
}

/** One of a text's letters (a grapheme: a letter and what's on it are one), or its nth mark. */
type Unit = string | number

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** A text's pieces as a cut takes them: its letters one by one, and its marks, numbered. */
function unitsOf(pieces: readonly Piece[]): { units: Unit[]; marks: Piece[] } {
  const units: Unit[] = []
  const marks: Piece[] = []
  for (const piece of pieces) {
    if (typeof piece !== 'string') {
      units.push(marks.push(piece) - 1)
      continue
    }
    // (On one line a line's end and a tab are each a space, as they're drawn.)
    for (const { segment } of graphemes.segment(piece.replace(/[\n\t]/g, ' '))) units.push(segment)
  }
  return { units, marks }
}

/** Units as pieces again, to draw: letters that follow each other are one text. */
function piecesOf(units: readonly Unit[], marks: readonly Piece[]): Piece[] {
  const pieces: Piece[] = []
  for (const unit of units) {
    const last = pieces.at(-1)
    if (typeof unit !== 'string') pieces.push(marks[unit]!)
    else if (typeof last === 'string') pieces[pieces.length - 1] = last + unit
    else pieces.push(unit)
  }
  return pieces
}

/** A letter an ellipsis is never put after: a hyphen, a dot or a space left hanging. */
const hanging = (unit: Unit | undefined) => typeof unit === 'string' && /^[-. ]$/.test(unit)

/**
 * `pieces` cut to fit `room`, or nothing where they fit whole. `width` measures letters, and
 * `marks` says how wide each mark is as it's drawn. As much of the start as there's room for in
 * whole letters, an ellipsis, the marks of the part that was cut, and the last `end` letters with
 * the marks among them (none: it's cut at its end, as a value is, and still keeps its marks).
 * Where even one letter of the start doesn't leave room, it ends in an ellipsis after the last
 * mark that fits (none fits: the least it can be, clipped).
 */
export function middleCutPieces(
  pieces: readonly Piece[],
  room: number,
  width: (text: string) => number,
  marks: readonly number[],
  end = KEPT_END,
): Piece[] | undefined {
  const { units, marks: drawn } = unitsOf(pieces)
  /** How wide units are as they're drawn: their letters run on, and their marks. */
  const across = (some: readonly Unit[]) => {
    let total = 0
    let run = ''
    for (const unit of some) {
      if (typeof unit === 'string') {
        run += unit
        continue
      }
      total += width(run) + (marks[unit] ?? 0)
      run = ''
    }
    return total + width(run)
  }
  // (Half a pixel: what measuring and laying out may differ by.)
  const fits = (some: readonly Unit[]) => across(some) <= room + 0.5
  if (fits(units)) return undefined
  const letters = units.flatMap((unit, at) => (typeof unit === 'string' ? [at] : []))
  let most = units
  if (letters.length > end + 1) {
    // Where the kept end starts: with none kept, after the last unit.
    const endsAt = end > 0 ? letters[letters.length - end]! : units.length
    const head = units.slice(0, endsAt)
    const tail = units.slice(endsAt)
    for (let kept = letters.length - end - 1; kept >= 1; kept--) {
      let to = letters[kept - 1]! + 1
      while (to > 0 && hanging(head[to - 1])) to--
      most = [
        ...head.slice(0, to),
        '…',
        ...head.slice(to).filter((unit) => typeof unit === 'number'),
        ...tail,
      ]
      if (fits(most)) return piecesOf(most, drawn)
    }
  }
  // The marks alone don't fit: it ends after the last of them that does, the rest given up.
  for (let at = most.length - 1; at >= 0; at--) {
    if (typeof most[at] !== 'number') continue
    const ending = [...most.slice(0, at + 1), '…']
    if (fits(ending)) return piecesOf(ending, drawn)
  }
  return piecesOf(most, drawn)
}

/**
 * A name of a plugin's, cut by measuring as it's laid out and whenever its room changes. All of
 * it is there for a screen reader, spelled, and in its tooltip (as much as a tooltip shows) once
 * it's cut: but for `tip={false}`, where what it's in has a tooltip of its own that says all of it.
 */
export function MiddleCut({
  text,
  end = KEPT_END,
  tip = true,
  className,
}: {
  text?: Their
  /** How many of its last letters it keeps; none cuts it at its end. */
  end?: number
  tip?: boolean
  className?: string
}) {
  const written = text?.their ?? ''
  const all = useMemo(() => inPieces(written), [written])
  const element = useRef<HTMLSpanElement>(null)
  const whole = useRef<HTMLSpanElement>(null)
  const [cut, setCut] = useState<Piece[]>()
  useLayoutEffect(() => {
    const span = element.current!
    const unseen = whole.current!
    const fit = () => {
      // How wide each mark is, from the whole name as it's drawn unseen: in its order, in its face.
      const marks = Array.from(unseen.querySelectorAll<HTMLElement>('[data-mark]'), (mark) => {
        const style = getComputedStyle(mark)
        return (
          mark.getBoundingClientRect().width +
          Number.parseFloat(style.marginLeft) +
          Number.parseFloat(style.marginRight)
        )
      })
      const next = middleCutPieces(all, span.clientWidth, widthIn(span), marks, end)
      setCut((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(span)
    // Measured again once the page's own fonts are in.
    void document.fonts.ready.then(fit)
    return () => observer.disconnect()
  }, [all, end])
  return (
    <span
      ref={element}
      title={cut && tip ? tooltip(written) : undefined}
      className={cn('relative block min-w-0 overflow-hidden whitespace-nowrap', className)}
    >
      {/* All of it, unseen: how wide it would like to be, and how wide each of its marks is. */}
      <span ref={whole} className="invisible">
        <TheirText pieces={all} inline />
      </span>
      {/* All of it for a screen reader, its marks spelled. */}
      <span className="sr-only">{spelled(written)}</span>
      <span aria-hidden className="absolute inset-0 select-none">
        <TheirText pieces={cut ?? all} inline />
      </span>
    </span>
  )
}

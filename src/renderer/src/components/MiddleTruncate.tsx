import { useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@renderer/lib/cn'

/** How much of a name's end always shows: what tells one pod of a ReplicaSet from the next. */
export const KEPT_END = 6

let canvas: CanvasRenderingContext2D | null | undefined

/** How wide a text is as `element` sets it. */
function widthIn(element: HTMLElement): (text: string) => number {
  canvas ??= document.createElement('canvas').getContext('2d')
  const style = getComputedStyle(element)
  const spacing = Number.parseFloat(style.letterSpacing) || 0
  if (canvas) {
    canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  }
  return (text) => (canvas ? canvas.measureText(text).width : 0) + spacing * text.length
}

/**
 * A name cut to fit `room`: as much of its start as there's room for in whole characters, an
 * ellipsis right against it (never after a hyphen or a dot left hanging), and its last
 * characters. Whole, where it fits.
 */
export function middleCut(
  text: string,
  room: number,
  width: (text: string) => number,
  end = KEPT_END,
): string {
  // (Half a pixel: what measuring and laying out may differ by.)
  if (width(text) <= room + 0.5 || text.length <= end + 1) return text
  const tail = text.slice(-end)
  const head = text.slice(0, -end)
  let kept = head.length
  let cut: string
  do cut = `${head.slice(0, --kept).replace(/[-. ]+$/, '')}…${tail}`
  while (kept > 1 && width(cut) > room + 0.5)
  return cut
}

/**
 * A name on one line that's cut in its middle where it doesn't fit, keeping its last characters:
 * `payments-worker-7c8d…-tuvwx` stays apart from `payments-worker-7c8d…-yzabc`, where a name cut
 * at its end would make them one. It's cut by measuring, as it's laid out and whenever its room
 * changes, so the ellipsis and the kept end meet. All of it is there for a screen reader, and
 * in its title.
 */
export function MiddleTruncate({ text, className }: { text: string; className?: string }) {
  const element = useRef<HTMLSpanElement>(null)
  const [shown, setShown] = useState(text)
  useLayoutEffect(() => {
    const span = element.current!
    const fit = () => setShown(middleCut(text, span.clientWidth, widthIn(span)))
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(span)
    // Measured again once the page's own fonts are in.
    void document.fonts.ready.then(fit)
    return () => observer.disconnect()
  }, [text])
  return (
    <span
      ref={element}
      title={shown === text ? undefined : text}
      className={cn('relative block min-w-0 overflow-hidden whitespace-nowrap', className)}
    >
      {/* All of it, unseen: what a screen reader reads, and how wide it would like to be. */}
      <span className="text-transparent">{text}</span>
      <span aria-hidden className="absolute inset-0">
        {shown}
      </span>
    </span>
  )
}

import { useLayoutEffect, useRef } from 'react'
import { cutToFit } from '@renderer/lib/fit'

/** How many lines a phone's title takes at most. */
const TITLE_LINES = 3

/**
 * A sheet's title on a phone (an assistant's request, or one of Lumovi's own dialogs): wrapped, whole, in up to three lines. Where it would take
 * more, it's the object's name that's shortened, in its middle (the whole name is in the body):
 * what's asked, and the number in it, are never cut.
 */
export function WithinLines({ text, name }: { text: string; name?: string }) {
  const element = useRef<HTMLSpanElement>(null)
  // (Its text is written here, not by React: it's measured as it's tried.)
  useLayoutEffect(() => {
    const span = element.current!
    const fit = () => {
      const most = parseFloat(getComputedStyle(span).lineHeight) * TITLE_LINES + 1
      const fits = (candidate: string) => {
        span.textContent = candidate
        return span.offsetHeight <= most
      }
      // (Where the name is, by its place: it may hold any characters, and the kind's word
      // before it may be the same as it.)
      const at = name ? text.lastIndexOf(name) : -1
      const fitted =
        name && at >= 0
          ? cutToFit({
              before: text.slice(0, at),
              name,
              after: text.slice(at + name.length),
              fits,
            })
          : text
      span.textContent = fitted
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(span.parentElement!)
    void document.fonts.ready.then(fit)
    return () => observer.disconnect()
  }, [text, name])
  return (
    <>
      {/* All of it, for a screen reader and the dialog's name. */}
      <span className="sr-only">{text}</span>
      <span ref={element} aria-hidden className="block" />
    </>
  )
}

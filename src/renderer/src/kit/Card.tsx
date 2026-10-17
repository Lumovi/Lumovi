/**
 * A card a plugin's page names: Lumovi's own card, with the plugin's title and a quiet note at its
 * right (words too, "20 · 3 still starting"), cut at its end; and the one part it holds (a Table,
 * a Graph or Counts), drawn bare inside it, so there's one frame and one title.
 */
import { createContext, useRef, useState, type ReactNode } from 'react'
import type { Their } from '@shared/kit/declare'
import type { CardProps } from '@shared/kit/page'
import { Card as Framed } from '@renderer/components/Card'
import { Tooltip } from '@renderer/components/Tooltip'
import { TheirText } from '@renderer/plugins/TheirText'

/**
 * Whether a part is drawn inside a card: it then draws no frame or heading of its own. Lumovi's
 * own to say, never a plugin's: nothing a plugin sends sets it.
 */
export const InCard = createContext(false)

/**
 * The place at the end of a card's heading, after its note, where the part it holds puts what
 * it has to press (a Table's Download CSV). Lumovi's own, as the heading is.
 */
export const CardHeadingEnd = createContext<HTMLElement | null>(null)

export function Card({ title, note, about, children }: CardProps & { children?: ReactNode }) {
  const [end, setEnd] = useState<HTMLElement | null>(null)
  return (
    <Framed
      title={<TheirText text={title} inline />}
      {...(about?.their ? { about: <About text={about} /> } : {})}
      action={
        <span className="flex min-w-0 items-center gap-3">
          {note?.their && (
            <span className="min-w-0 truncate text-xs text-ink-3 tabular-nums">
              <TheirText text={note} inline />
            </span>
          )}
          <span ref={setEnd} className="contents" />
        </span>
      }
    >
      <InCard.Provider value>
        <CardHeadingEnd.Provider value={end}>{children}</CardHeadingEnd.Provider>
      </InCard.Provider>
    </Framed>
  )
}

/**
 * Where a card's data came from, in the plugin's words: quiet, card-wide, two lines and then cut
 * at its end, whole in Lumovi's tooltip while it's cut. Under a finger, where there's no tooltip,
 * it isn't cut: it wraps whole. No mark and no colour: it's said, not warned.
 */
function About({ text }: { text: Their }) {
  const line = useRef<HTMLParagraphElement>(null)
  return (
    <Tooltip
      content={<TheirText text={text} inline />}
      when={() => {
        const shown = line.current
        return shown !== null && shown.scrollHeight > shown.clientHeight + 1
      }}
    >
      <p
        ref={line}
        data-about=""
        // (Under a finger nothing hovers: it wraps whole, all it may be.)
        className="line-clamp-2 text-xs leading-[18px] text-ink-3 touch:line-clamp-none"
      >
        <TheirText text={text} inline />
      </p>
    </Tooltip>
  )
}

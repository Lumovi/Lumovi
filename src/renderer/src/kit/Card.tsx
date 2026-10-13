/**
 * A card a plugin's page names: Lumovi's own card, with the plugin's title and a quiet note at its
 * right (words too, "20 · 3 still starting"), cut at its end; and the one part it holds (a Table,
 * a Graph or Counts), drawn bare inside it, so there's one frame and one title.
 */
import { createContext, type ReactNode } from 'react'
import type { CardProps } from '@shared/kit/page'
import { Card as Framed } from '@renderer/components/Card'
import { TheirText } from '@renderer/plugins/TheirText'

/**
 * Whether a part is drawn inside a card: it then draws no frame or heading of its own. Lumovi's
 * own to say, never a plugin's: nothing a plugin sends sets it.
 */
export const InCard = createContext(false)

export function Card({ title, note, children }: CardProps & { children?: ReactNode }) {
  return (
    <Framed
      title={<TheirText text={title} inline />}
      action={
        note?.their ? (
          <span className="min-w-0 truncate text-xs text-ink-3 tabular-nums">
            <TheirText text={note} inline />
          </span>
        ) : undefined
      }
    >
      <InCard.Provider value>{children}</InCard.Provider>
    </Framed>
  )
}

import { Tooltip as TooltipPrimitive } from 'radix-ui'
import { useState, type ReactNode } from 'react'
import { useTouch } from '@renderer/lib/layout'

export const TooltipProvider = TooltipPrimitive.Provider

/** A tooltip's look: what anything that says a short thing beside what it's about draws. */
export const TIP =
  // (A mark in a text that isn't Lumovi's is drawn in the tooltip's own ink, quieter. Closed, it
  // goes at once: closed while it's still fading in, Radix would keep it until the fade ends, beside
  // the next one.)
  'z-50 max-w-xs animate-fade-in rounded-md bg-ink-1 px-2 py-1 text-xs font-medium text-surface shadow-pop data-[state=closed]:hidden [&_[data-mark]]:border-surface/35 [&_[data-mark]]:text-surface/70'

export function Tooltip({
  content,
  children,
  side = 'bottom',
  shown,
  when,
}: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  /**
   * Shown by what it's in as well, while this is true: a table's row with the keyboard on it
   * shows what its cells hold whole. (Hovered, it shows anyway.)
   */
  shown?: boolean
  /**
   * Asked as it would open: whether it has anything to say then (a text that's cut, say). While
   * it hasn't, it stays closed.
   */
  when?: () => boolean
}) {
  const [hovered, setHovered] = useState(false)
  // Nothing hovers under a finger, and a tooltip shown on focus would take the Escape meant for
  // what it's in. What it says is in its button's name.
  const touch = useTouch()
  if (touch) return children
  return (
    <TooltipPrimitive.Root
      {...(shown === undefined && when === undefined
        ? {}
        : {
            open: (shown ?? false) || hovered,
            onOpenChange: (open: boolean) => setHovered(open && (when?.() ?? true)),
          })}
    >
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side={side} sideOffset={6} className={TIP}>
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

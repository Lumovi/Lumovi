import { Tooltip as TooltipPrimitive } from 'radix-ui'
import type { ReactNode } from 'react'
import { useTouch } from '@renderer/lib/layout'

export const TooltipProvider = TooltipPrimitive.Provider

export function Tooltip({
  content,
  children,
  side = 'bottom',
}: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
}) {
  // Nothing hovers under a finger, and a tooltip shown on focus would take the Escape meant for
  // what it's in. What it says is in its button's name.
  const touch = useTouch()
  if (touch) return children
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-xs animate-fade-in rounded-md bg-ink-1 px-2 py-1 text-xs font-medium text-surface shadow-pop"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

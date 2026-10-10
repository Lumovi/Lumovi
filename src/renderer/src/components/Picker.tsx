import { Popover } from 'radix-ui'
import type { ReactElement, ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'
import { useLayout } from '@renderer/lib/layout'
import { menuContent } from '@renderer/features/shell/menu-styles'
import { Sheet } from './Sheet'
import { Tooltip } from './Tooltip'

/**
 * What a button opens to choose from: a popover by its button where there's room, and a sheet
 * from the bottom on a phone, with its name on top. The same button and the same content.
 */
export function Picker({
  open,
  onOpenChange,
  title,
  trigger,
  align = 'start',
  className,
  collisionPadding,
  onOpenAutoFocus,
  tooltip,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What it's for: a sheet's title. */
  title: string
  /** The button that opens it. */
  trigger: ReactElement
  align?: 'start' | 'end'
  /** The popover's own width and padding. */
  className?: string
  collisionPadding?: number
  /** For a popover that says itself where the focus goes. */
  onOpenAutoFocus?: (event: Event) => void
  /** What the button says under a pointer. */
  tooltip?: ReactNode
  children: ReactNode
}) {
  const phone = useLayout() === 'phone'
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      {tooltip ? (
        <Tooltip content={tooltip}>
          <Popover.Trigger asChild>{trigger}</Popover.Trigger>
        </Tooltip>
      ) : (
        <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      )}
      {phone ? (
        open && (
          <Sheet title={title} onClose={() => onOpenChange(false)}>
            {children}
          </Sheet>
        )
      ) : (
        <Popover.Portal>
          <Popover.Content
            align={align}
            sideOffset={6}
            collisionPadding={collisionPadding}
            onOpenAutoFocus={onOpenAutoFocus}
            aria-label={title}
            className={cn(menuContent, className)}
          >
            {children}
          </Popover.Content>
        </Popover.Portal>
      )}
    </Popover.Root>
  )
}

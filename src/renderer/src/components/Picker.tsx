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
  onEscapeKeyDown,
  tooltip,
  sheetHeader,
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
  /** For a popover whose Escape can mean less than closing it (a name being typed). */
  onEscapeKeyDown?: (event: KeyboardEvent) => void
  /** What the button says under a pointer. */
  tooltip?: ReactNode
  /** A phone's sheet's own top bar, in place of its title and Close (it closes itself). */
  sheetHeader?: ReactNode
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
          <Sheet title={title} header={sheetHeader} onClose={() => onOpenChange(false)}>
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
            onEscapeKeyDown={onEscapeKeyDown}
            aria-label={title}
            // (Over the page: what it half covers there is pressed on it, not under it.)
            data-over
            className={cn(menuContent, className)}
          >
            {children}
          </Popover.Content>
        </Popover.Portal>
      )}
    </Popover.Root>
  )
}

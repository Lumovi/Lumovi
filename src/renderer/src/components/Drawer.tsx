import { Dialog } from 'radix-ui'
import type { ReactNode } from 'react'

/**
 * What's beside the page where there's room (the sidebar), behind a button where there isn't:
 * in from the left over a scrim. A dialog: focus goes in and stays in, Escape and the scrim
 * close it, and focus goes back to the button that opened it.
 */
export function Drawer({
  open,
  onOpenChange,
  label,
  opener,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Its name, as the region it holds is named where it's always there. */
  label: string
  /** Finds the button that opens it, which has the focus again once it's closed. */
  opener: () => HTMLElement | null
  children: ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/30 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-label={label}
          aria-describedby={undefined}
          // (Said here: a tap doesn't always leave the focus on what was tapped, to go back to.)
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            opener()?.focus()
          }}
          // Its open edge has a hairline and the pop shadow: what sets it apart from the page in dark.
          className="fixed inset-y-0 left-0 z-50 flex w-[min(320px,calc(100%-56px))] animate-slide-from-left flex-col border-r border-line-strong bg-app shadow-pop outline-none"
        >
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

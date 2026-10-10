import { X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useRef, type PointerEvent, type ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'

/** How far down a sheet is dragged by its grabber before letting go closes it. */
const DISMISS_DISTANCE = 96

/** A top bar's button, and a sheet's Close: 44 px each way, its icon 20. */
export const barButton =
  'grid size-11 shrink-0 place-items-center rounded-lg text-ink-2 outline-offset-[-2px] transition-colors hover:bg-surface-3 hover:text-ink-1 [&_svg]:size-5'

/**
 * What a dialog's own frame adds on a phone, where it's a sheet: from the bottom, the screen's
 * width, to within 24 px of its top, clear of the home bar. With `SheetGrabber` first in it.
 */
export const sheetFrame =
  'phone:top-auto phone:bottom-[var(--keyboard,0px)] phone:left-0 phone:max-h-[calc(100dvh-24px-var(--keyboard,0px))] phone:w-full phone:max-w-none phone:translate-x-0 phone:translate-y-0 phone:animate-slide-from-bottom phone:rounded-t-2xl phone:rounded-b-none phone:border-b-0 phone:pb-[env(safe-area-inset-bottom)]'
/** A dialog's header, body and footer, as a sheet's. */
export const sheetHeader = 'phone:pt-2 phone:pr-1 phone:pl-4'
export const sheetBody = 'phone:px-4'
/**
 * The quiet button at the left edge (its label in line with the body), the one that acts at the
 * right, at least 120 px wide, both a finger's height, and the gap between them left empty.
 */
export const sheetFooter =
  'phone:justify-between phone:px-4 phone:[&_button]:h-11 phone:[&_button]:px-4 phone:[&_button:first-child]:-ml-4 phone:[&_button:last-child]:min-w-[120px]'

/**
 * The bar at a sheet's top that says it can be dragged down, and does it: let go far enough
 * down, it closes (whatever closing means to who opened it). It moves the dialog it's in.
 */
export function SheetGrabber({ onClose, className }: { onClose: () => void; className?: string }) {
  const drag = useRef<{ from: number; pointer: number; sheet: HTMLElement }>(undefined)
  const down = (event: PointerEvent<HTMLDivElement>) => {
    const sheet = event.currentTarget.closest<HTMLElement>('[role="dialog"]')!
    drag.current = { from: event.clientY, pointer: event.pointerId, sheet }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return
    const by = Math.max(0, event.clientY - drag.current.from)
    drag.current.sheet.style.transform = `translateY(${by}px)`
  }
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return
    const { from, sheet } = drag.current
    drag.current = undefined
    sheet.style.transform = ''
    if (event.clientY - from > DISMISS_DISTANCE) onClose()
  }
  return (
    <div
      data-sheet-grabber
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      className={cn('shrink-0 touch-none pt-2 pb-1', className)}
    >
      <span aria-hidden className="mx-auto block h-1 w-9 rounded-full bg-line-strong" />
    </div>
  )
}

/**
 * A menu, a picker or a dialog on a phone: up from the bottom over the scrim, as tall as what
 * it holds up to 85% of the screen (a `dialog`: to within 24 px of its top), clear of the home
 * bar, with what's in `footer` pinned under what scrolls and above the keyboard.
 *
 * Focus goes in and stays in. Escape, the scrim, its Close and dragging its grabber down all
 * close it, which is never an answer: whoever opens it says what closing means (`onClose`).
 */
export function Sheet({
  title,
  header,
  dialog = false,
  footer,
  onClose,
  className,
  children,
}: {
  /** Its name, shown at its top beside Close. */
  title: string
  /** In place of the title's row: a dialog's own header (it has Close in it). */
  header?: ReactNode
  dialog?: boolean
  footer?: ReactNode
  onClose: () => void
  className?: string
  children: ReactNode
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/30 backdrop-blur-[2px]" />
        <Dialog.Content
          data-sheet
          aria-describedby={undefined}
          className={cn(
            // (It stands on the keyboard, where there is one: see lib/layout.ts.)
            'fixed inset-x-0 bottom-[var(--keyboard,0px)] z-50 flex animate-slide-from-bottom flex-col rounded-t-2xl border border-b-0 border-line-strong bg-surface-2 pb-[env(safe-area-inset-bottom)] shadow-pop outline-none',
            dialog
              ? 'max-h-[calc(100dvh-24px-var(--keyboard,0px))]'
              : 'max-h-[calc(85dvh-var(--keyboard,0px))]',
            className,
          )}
        >
          <SheetGrabber onClose={onClose} />
          {header ? (
            <>
              <Dialog.Title className="sr-only">{title}</Dialog.Title>
              {header}
            </>
          ) : (
            <div className="flex h-11 shrink-0 items-center pr-1 pl-4">
              <Dialog.Title className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink-1">
                {title}
              </Dialog.Title>
              <Dialog.Close aria-label="Close" className={barButton}>
                <X />
              </Dialog.Close>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
          {footer}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

import { Dialog } from 'radix-ui'
import { useRef, type PointerEvent, type ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'

/** How far down a sheet is dragged by its grabber before letting go closes it. */
const DISMISS_DISTANCE = 96

/**
 * A dialog on a phone: up from the bottom over a scrim, as tall as what it holds up to nearly
 * the screen (or `tall`: nearly the screen, whatever it holds), with what's in `footer` pinned
 * under what scrolls and above the keyboard. Focus goes in and stays in. Escape, the scrim and
 * dragging its grabber down all close it, which is never an answer: whoever opens it says what
 * closing means (`onClose`).
 */
export function Sheet({
  title,
  label,
  tall = false,
  footer,
  onClose,
  className,
  children,
}: {
  /** Shown at its top, and its name. */
  title?: ReactNode
  /** Its name, where its title isn't one (or it shows none). */
  label?: string
  tall?: boolean
  footer?: ReactNode
  onClose: () => void
  className?: string
  children: ReactNode
}) {
  const content = useRef<HTMLDivElement>(null)
  const drag = useRef<{ from: number; pointer: number }>(undefined)
  const down = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = { from: event.clientY, pointer: event.pointerId }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return
    const by = Math.max(0, event.clientY - drag.current.from)
    content.current!.style.transform = `translateY(${by}px)`
  }
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return
    const by = event.clientY - drag.current.from
    drag.current = undefined
    content.current!.style.transform = ''
    if (by > DISMISS_DISTANCE) onClose()
  }
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/30 backdrop-blur-[2px]" />
        <Dialog.Content
          ref={content}
          aria-label={label}
          aria-describedby={undefined}
          className={cn(
            // As tall as the screen that shows, less the keyboard (dvh), and clear of the home bar.
            'fixed inset-x-0 bottom-0 z-50 flex max-h-[calc(100dvh-28px)] animate-slide-from-bottom flex-col overflow-hidden rounded-t-2xl border-t border-line-strong bg-surface-2 pb-[env(safe-area-inset-bottom)] shadow-pop outline-none',
            tall && 'h-[calc(100dvh-28px)]',
            className,
          )}
        >
          <div
            data-sheet-grabber
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            className="flex h-6 shrink-0 touch-none items-center justify-center"
          >
            <span aria-hidden className="h-1 w-9 rounded-full bg-line-strong" />
          </div>
          {title !== undefined && (
            <Dialog.Title className="shrink-0 px-4 pb-2 text-[15px] font-semibold text-ink-1">
              {title}
            </Dialog.Title>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
          {footer && <div className="shrink-0 border-t border-line bg-surface">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

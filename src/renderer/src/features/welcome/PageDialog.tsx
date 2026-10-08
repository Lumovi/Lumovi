/**
 * The frame of the clusters page's dialogs (adding a cluster, a cluster's settings): as every
 * action dialog's, without a cluster to be in. What went wrong stays in view, just above the
 * buttons; Escape closes.
 */
import { CircleAlert, X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import type { FormEvent, ReactNode } from 'react'
import { IconButton } from '@renderer/components/Button'
import { cn } from '@renderer/lib/cn'

export function PageDialog({
  leading,
  title,
  subtitle,
  top = 'top-[12vh]',
  error,
  footer,
  onSubmit,
  onClose,
  children,
}: {
  /** The header's tile: an icon's, or the cluster's. */
  leading: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  /** Where it sits: lower for short ones, higher for tall ones. */
  top?: string
  error?: string
  footer: ReactNode
  onSubmit?: () => void
  onClose: () => void
  children?: ReactNode
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSubmit?.()
  }
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/30 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          // Escape in the editor's search closes the search, not the dialog (and what was pasted).
          onEscapeKeyDown={(event) => {
            if ((event.target as HTMLElement | null)?.closest?.('.cm-panel')) {
              event.preventDefault()
            }
          }}
          // Closed: back to the list's search, where its keys are (what opened it may be gone).
          onCloseAutoFocus={(event) => {
            const search = document.querySelector<HTMLElement>('[data-hotkey-target="filter"]')
            if (!search) return
            event.preventDefault()
            search.focus()
          }}
          onOpenAutoFocus={(event) => {
            // The first field, or what's marked to start on.
            event.preventDefault()
            const dialog = event.currentTarget as HTMLElement
            const target =
              dialog.querySelector<HTMLElement>('[data-autofocus]') ??
              dialog.querySelector<HTMLElement>('input, textarea, [contenteditable=true]') ??
              dialog.querySelector<HTMLElement>('button[type=submit]')
            target?.focus()
          }}
          className={cn(
            'fixed left-1/2 z-50 flex max-h-[86vh] w-[600px] max-w-[calc(100vw-48px)] -translate-x-1/2 animate-pop-in flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface-2 shadow-pop outline-none',
            top,
          )}
        >
          <form onSubmit={submit} className="flex min-h-0 flex-col">
            <header className="flex items-start gap-3 px-5 pt-5 pb-1">
              {leading}
              <div className="min-w-0 flex-1">
                <Dialog.Title className="truncate text-[15px] leading-snug font-semibold text-ink-1">
                  {title}
                </Dialog.Title>
                {subtitle && <div className="mt-0.5 truncate text-xs text-ink-3">{subtitle}</div>}
              </div>
              <Dialog.Close asChild>
                <IconButton label="Close" className="-mt-1 -mr-1.5 size-7">
                  <X />
                </IconButton>
              </Dialog.Close>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-5">{children}</div>
            {error && (
              <div className="max-h-[25vh] shrink-0 overflow-y-auto border-t border-line px-5 py-3">
                <div
                  role="alert"
                  className="flex gap-2.5 rounded-lg border border-critical/25 bg-critical/8 px-3 py-2.5 text-[13px] leading-relaxed text-critical-text"
                >
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  <p className="min-w-0 break-words selectable">{error}</p>
                </div>
              </div>
            )}
            <footer className="flex items-center gap-2 border-t border-line bg-surface px-5 py-3">
              {footer}
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** The header's tile for an icon. */
export function DialogIcon({ children, tone }: { children: ReactNode; tone?: 'good' }) {
  return (
    <div
      className={cn(
        'grid size-9 shrink-0 place-items-center rounded-xl [&_svg]:size-[18px]',
        tone === 'good' ? 'bg-good/10 text-good-text' : 'bg-surface-3 text-ink-2',
      )}
    >
      {children}
    </div>
  )
}

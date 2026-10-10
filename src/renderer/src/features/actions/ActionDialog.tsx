import {
  CircleAlert,
  LoaderCircle,
  SquareTerminal,
  TriangleAlert,
  type LucideIcon,
  X,
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Button, IconButton } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import {
  barButton,
  sheetBody,
  sheetFooter,
  sheetFrame,
  sheetHeader,
  SheetGrabber,
} from '@renderer/components/Sheet'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { useProduction } from '@renderer/hooks/settings'
import { useCluster } from '@renderer/state/cluster'
import { useDock } from '../terminal/dock'

export interface ActionDialogProps {
  icon: LucideIcon
  title: string
  /** Where the change happens, e.g. "Deployment · shop". The cluster is added. */
  subject: string
  /** The kubectl command that does the same, kept in sync with the form. */
  command: string
  confirmLabel: string
  tone?: 'default' | 'danger'
  /** A name the user types before a destructive change goes through. */
  typeToConfirm?: string
  /** False while the form can't be submitted (nothing changed, invalid input…). */
  ready?: boolean
  pending: boolean
  error?: string
  /** Wider dialogs for lists (drains, revisions). */
  wide?: boolean
  /** Replaces the confirm button, e.g. with "Done" once a drain has run. */
  footer?: ReactNode
  onSubmit: () => void
  onClose: () => void
  children?: ReactNode
}

/**
 * The frame every action dialog shares: what is about to change and where,
 * the form, the equivalent kubectl command, errors from the API server (always
 * in view, above the buttons), and a clear way to confirm or back out. Enter
 * confirms, Escape cancels.
 */
export function ActionDialog({
  icon: Icon,
  title,
  subject,
  command,
  confirmLabel,
  tone = 'default',
  typeToConfirm,
  ready = true,
  pending,
  error,
  wide = false,
  footer,
  onSubmit,
  onClose,
  children,
}: ActionDialogProps) {
  const { context } = useCluster()
  const [typed, setTyped] = useState('')
  const production = useProduction(context)
  const confirmed = typeToConfirm === undefined || typed === typeToConfirm
  const canSubmit = ready && confirmed && !pending

  // Enter can't submit while the confirm button is disabled; while it's pending (only marked
  // so, to keep the focus), it does nothing.
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (canSubmit) onSubmit()
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/30 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const dialog = event.currentTarget as HTMLElement
            const find = (selector: string) => dialog.querySelector<HTMLElement>(selector)
            // Destructive changes start on the confirmation field or on Cancel, so a stray
            // Enter never deletes anything; other dialogs start on their first field.
            const target =
              tone === 'danger'
                ? (find('[data-type-to-confirm]') ?? find('[data-cancel]'))
                : (find('input, select, textarea') ?? find('[data-confirm]'))
            target!.focus()
          }}
          className={cn(
            'fixed top-[12vh] left-1/2 z-50 flex max-h-[76vh] -translate-x-1/2 animate-pop-in flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface-2 shadow-pop outline-none',
            wide ? 'w-[600px]' : 'w-[480px]',
            'max-w-[calc(100vw-48px)]',
            // On a phone it's a sheet, as tall as what it holds.
            sheetFrame,
          )}
        >
          <SheetGrabber onClose={onClose} className="hidden phone:block" />
          <form onSubmit={submit} className="flex min-h-0 flex-col">
            <header className={cn('flex items-start gap-3 px-5 pt-5 pb-1', sheetHeader)}>
              <div
                className={cn(
                  'grid size-9 shrink-0 place-items-center rounded-xl',
                  tone === 'danger'
                    ? 'bg-critical/10 text-critical-text'
                    : 'bg-surface-3 text-ink-2',
                )}
              >
                <Icon className="size-[18px]" />
              </div>
              <div className="min-w-0 flex-1">
                <Dialog.Title className="truncate text-[15px] leading-snug font-semibold text-ink-1">
                  {title}
                </Dialog.Title>
                {/* On a phone the cluster and its Production mark are never cut short: they wrap. */}
                <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-3 phone:flex-wrap">
                  <span className="truncate phone:whitespace-normal">
                    {subject} · <span className="font-medium text-ink-2">{context}</span>
                  </span>
                  {production && (
                    <span className="shrink-0 rounded bg-critical/10 px-1.5 py-px text-2xs font-semibold tracking-wide text-critical-text uppercase">
                      Production
                    </span>
                  )}
                </p>
              </div>
              <Dialog.Close aria-label="Close" className={cn(barButton, 'hidden phone:grid')}>
                <X />
              </Dialog.Close>
            </header>

            <div
              className={cn('min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pt-4 pb-5', sheetBody)}
            >
              {children}

              {typeToConfirm !== undefined && (
                <label className="block">
                  {/* One sentence, however long the name: it wraps within it. */}
                  <span className="mb-1.5 block text-xs text-ink-2">
                    {production && (
                      <TriangleAlert className="mr-1.5 inline size-3.5 align-[-2px] text-critical-text" />
                    )}
                    Type{' '}
                    <span className="font-mono font-medium wrap-anywhere text-ink-1 select-all">
                      {typeToConfirm}
                    </span>{' '}
                    to confirm
                  </span>
                  <input
                    data-type-to-confirm
                    aria-label={`Type ${typeToConfirm} to confirm`}
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="h-9 w-full rounded-lg border border-line-strong bg-surface px-3 font-mono text-[13px] text-ink-1 outline-none focus:border-critical focus:ring-3 focus:ring-critical/15 phone:h-11"
                  />
                </label>
              )}

              <div className="group relative rounded-lg bg-surface-3/70 px-3 py-2.5 touch:pr-11">
                <p className="mb-1 text-2xs font-medium tracking-wider text-ink-3 uppercase">
                  Equivalent command
                </p>
                <code className="block font-mono text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap text-ink-2 selectable">
                  {command}
                </code>
                <span className="absolute top-1.5 right-1.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 touch:opacity-100">
                  {api.host === 'desktop' && (
                    <IconButton
                      label="Paste in terminal"
                      className="size-7"
                      onClick={() => {
                        // Typed, not run: Enter in the terminal runs it.
                        useDock.getState().paste(context, command)
                        onClose()
                      }}
                    >
                      <SquareTerminal />
                    </IconButton>
                  )}
                  <CopyButton text={command} label="Copy command" />
                </span>
              </div>
            </div>

            {/* Outside what scrolls, just above the buttons: in view wherever the form was scrolled
                to, where the button was just pressed. A long one scrolls on its own. */}
            {error && (
              <div
                className={cn(
                  'max-h-[25vh] shrink-0 overflow-y-auto border-t border-line px-5 py-3',
                  sheetBody,
                )}
              >
                <div
                  role="alert"
                  className="flex gap-2.5 rounded-lg border border-critical/25 bg-critical/8 px-3 py-2.5 text-[13px] leading-relaxed text-critical-text"
                >
                  <CircleAlert className="mt-0.5 size-4 shrink-0" />
                  <p className="min-w-0 break-words selectable">{error}</p>
                </div>
              </div>
            )}

            <footer
              className={cn(
                'flex items-center justify-end gap-2 border-t border-line bg-surface px-5 py-3',
                sheetFooter,
              )}
            >
              {footer ?? (
                <>
                  <Button variant="ghost" data-cancel onClick={onClose}>
                    Cancel
                  </Button>
                  {/* Pending, it keeps the focus (a disabled button drops it to the page, where a
                      keyboard or screen reader's user would be as the error comes): it's only
                      marked disabled, and does nothing until the answer comes. */}
                  <Button
                    type="submit"
                    data-confirm
                    variant={tone === 'danger' ? 'danger' : 'primary'}
                    disabled={!canSubmit && !pending}
                    aria-disabled={pending || undefined}
                    className="min-w-20 aria-disabled:pointer-events-none aria-disabled:opacity-50"
                  >
                    {pending && <LoaderCircle className="animate-spin" />}
                    {confirmLabel}
                  </Button>
                </>
              )}
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * Runs a dialog's change, tracking whether it is pending and what went wrong;
 * `onDone` runs after it succeeds.
 */
export function useSubmit(onDone: () => void) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async (run: () => Promise<{ ok: boolean; error?: { message: string } }>) => {
    setPending(true)
    setError(undefined)
    try {
      const result = await run()
      if (result.ok) onDone()
      else setError(result.error!.message)
    } finally {
      // Even if the call itself fails, the dialog stays usable.
      setPending(false)
    }
  }
  return { pending, error, submit }
}

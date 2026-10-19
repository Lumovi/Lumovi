import { Dialog } from 'radix-ui'
import { X } from 'lucide-react'
import { Kbd } from '@renderer/components/Kbd'
import { keepMovedFocus } from '@renderer/lib/focus-back'
import { useUi } from '@renderer/state/ui'
import { useSheet } from './sheet'

export function ShortcutsDialog() {
  const open = useUi((ui) => ui.shortcuts)
  const setOpen = useUi((ui) => ui.setShortcuts)
  const sections = useSheet()
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content
          // (Closed: the keyboard back where it was, unless the person has put it elsewhere since.)
          onCloseAutoFocus={keepMovedFocus}
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[80vh] w-[720px] max-w-[calc(100vw-48px)] -translate-1/2 animate-pop-in flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface-2 shadow-pop outline-none"
        >
          <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <Dialog.Title className="text-[15px] font-semibold">Keyboard shortcuts</Dialog.Title>
            {/* A plain button: a tooltip opening on autofocus would swallow the first Escape. */}
            <Dialog.Close
              aria-label="Close"
              className="grid size-8 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink-1"
            >
              <X className="size-4" />
            </Dialog.Close>
          </header>
          <div className="grid gap-x-10 gap-y-6 overflow-y-auto px-5 py-5 sm:grid-cols-2">
            {sections.map((section) => (
              <section
                key={section.title}
                className={section.title === 'Go to' ? 'sm:row-span-2' : ''}
              >
                <h3 className="mb-2 text-2xs font-medium tracking-wider text-ink-3 uppercase">
                  {section.title}
                </h3>
                <dl className="space-y-1.5">
                  {section.rows.map((row) => (
                    <div
                      key={row.label}
                      className="flex items-center justify-between gap-4 text-[13px]"
                    >
                      <dt className="text-ink-2">{row.label}</dt>
                      <dd className="flex shrink-0 items-center gap-1">
                        {row.keys.length === 0 && <span className="text-xs text-ink-3">None</span>}
                        {row.keys.map((caps, i) => (
                          <span key={caps.join('')} className="flex items-center gap-1">
                            {i > 0 &&
                              (row.apart ? (
                                <span className="w-0.5" />
                              ) : (
                                <span className="px-1 text-xs text-ink-3">or</span>
                              ))}
                            {caps.map((key) => (
                              <Kbd key={key}>{key}</Kbd>
                            ))}
                          </span>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
                {section.note && (
                  <p className="mt-2.5 text-xs leading-snug text-ink-3">{section.note}</p>
                )}
              </section>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

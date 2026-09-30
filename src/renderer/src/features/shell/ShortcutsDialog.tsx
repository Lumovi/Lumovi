import { Dialog } from 'radix-ui'
import { X } from 'lucide-react'
import { GO_KEYS, QUICK_NAV, type NavTarget } from '@shared/navigation'
import { resourceByKind } from '@shared/resources'
import { Kbd, MOD_KEY } from '@renderer/components/Kbd'
import { useUi } from '@renderer/state/ui'

const label = (target: NavTarget) =>
  target === 'overview' ? 'Overview' : resourceByKind(target).label

const SECTIONS: {
  title: string
  shortcuts: { keys: string[]; label: string; alt?: string[] }[]
}[] = [
  {
    title: 'General',
    shortcuts: [
      { keys: [MOD_KEY, 'K'], label: 'Command palette' },
      { keys: ['/'], label: 'Filter the list' },
      { keys: [MOD_KEY, 'R'], label: 'Refresh' },
      { keys: [MOD_KEY, '['], label: 'Back' },
      { keys: [MOD_KEY, ']'], label: 'Forward' },
      { keys: ['?'], label: 'Keyboard shortcuts' },
    ],
  },
  {
    title: 'Lists',
    shortcuts: [
      { keys: ['↑', '↓'], label: 'Move through rows (or J / K)' },
      { keys: ['↵'], label: 'Open the selected row' },
      { keys: ['←', '→'], label: 'Previous / next page' },
      { keys: ['Home', 'End'], label: 'First / last row' },
      { keys: ['Esc'], label: 'Close the detail panel' },
    ],
  },
  {
    title: 'Open object',
    shortcuts: [
      { keys: ['.'], label: 'Actions: scale, restart, edit…' },
      { keys: [MOD_KEY, '⌫'], label: 'Delete' },
      { keys: [MOD_KEY, 'S'], label: 'Review a YAML edit' },
    ],
  },
  {
    title: 'Go to',
    shortcuts: GO_KEYS.map(({ key, target }) => {
      const quick = QUICK_NAV.indexOf(target)
      return {
        label: label(target),
        keys: ['G', key.toUpperCase()],
        alt: quick >= 0 ? [MOD_KEY, String(quick + 1)] : undefined,
      }
    }),
  },
]

export function ShortcutsDialog() {
  const open = useUi((ui) => ui.shortcuts)
  const setOpen = useUi((ui) => ui.setShortcuts)
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content
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
            {SECTIONS.map((section) => (
              <section
                key={section.title}
                className={section.title === 'Go to' ? 'sm:row-span-2' : ''}
              >
                <h3 className="mb-2 text-2xs font-medium tracking-wider text-ink-3 uppercase">
                  {section.title}
                </h3>
                <dl className="space-y-1.5">
                  {section.shortcuts.map((shortcut) => (
                    <div
                      key={shortcut.label}
                      className="flex items-center justify-between gap-4 text-[13px]"
                    >
                      <dt className="text-ink-2">{shortcut.label}</dt>
                      <dd className="flex shrink-0 items-center gap-1">
                        {shortcut.alt && (
                          <>
                            {shortcut.alt.map((key) => (
                              <Kbd key={key}>{key}</Kbd>
                            ))}
                            <span className="px-1 text-xs text-ink-3">or</span>
                          </>
                        )}
                        {shortcut.keys.map((key) => (
                          <Kbd key={key}>{key}</Kbd>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

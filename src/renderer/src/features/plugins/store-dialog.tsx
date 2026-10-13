/**
 * The one dialog for installing a plugin from Lumovi-plugins, updating one, going back to one,
 * and removing one: what it may do in the Plugins page's own lines, an update's new ones first,
 * and one button. Nothing is written without it; Escape and Cancel leave everything as it was.
 */
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Code,
  Info,
  LoaderCircle,
  Lock,
  Plug,
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useState, type ReactNode } from 'react'
import type { Plugin } from '@shared/plugins'
import { Button } from '@renderer/components/Button'
import { PluginIcon } from '@renderer/components/KindIcon'
import { SheetGrabber, sheetFrame, sheetFooter, sheetHeader } from '@renderer/components/Sheet'
import { cn } from '@renderer/lib/cn'
import { askLines, type AskLine, type KindNames } from './ask-lines'
import { compared, isEmpty, type Granted } from './granted'

/** Where Lumovi-plugins' releases are compared, tag to tag. */
const COMPARE = 'https://github.com/Lumovi/Lumovi-plugins/compare'

/** The copy in use: its version, and where it's from. */
export interface InUse {
  version: string
  granted: Granted
  /** The release it came from: Lumovi's own, the one Lumovi was built with. */
  release: string
  /** It came with Lumovi (not installed). */
  lumovis: boolean
}

export type StoreDialogIs =
  | { kind: 'install'; plugin: Plugin; granted: Granted; release: string }
  | { kind: 'update'; plugin: Plugin; granted: Granted; release: string; inUse: InUse }
  | { kind: 'back'; plugin: Plugin; granted: Granted; release: string; inUse: InUse }
  | { kind: 'remove'; plugin: Plugin; version: string }

const label = (plugin: Plugin) => plugin.place?.label ?? plugin.name

/** A release's number, as the bar has it. */
const release = (version: string) => (
  <span className="font-mono font-medium text-ink-2">{version}</span>
)

function Line({ line, gone = false }: { line: AskLine; gone?: boolean }) {
  const Icon = line.icon
  // (Red where it's asked; one no longer asked is struck, as any.)
  const red = line.red && !gone
  return (
    <li
      data-ask={line.key}
      {...(red ? { 'data-red': '' } : {})}
      className={cn(
        'flex gap-2.5 py-1.5 text-[13px] leading-[19px]',
        gone ? 'text-ink-3' : red ? 'text-critical-text' : 'text-ink-1',
      )}
    >
      <Icon
        className={cn('mt-0.5 size-[15px] shrink-0', red ? 'text-critical-text' : 'text-ink-3')}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className={cn(gone && 'line-through decoration-line-strong')}>{line.text}</span>
        {line.note && <span className="mt-0.5 block text-xs text-ink-3">{line.note}</span>}
      </span>
    </li>
  )
}

function Part({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-t border-line px-5 py-3.5 first:border-t-0">
      <h3 className="mb-2 flex items-center gap-2 text-2xs font-medium tracking-wider text-ink-3 uppercase">
        {title}
        {count !== undefined && (
          <span className="rounded-full bg-surface-3 px-1.5 text-2xs tracking-normal text-ink-1 normal-case">
            {count}
          </span>
        )}
      </h3>
      {children}
    </section>
  )
}

/** "Its code changed.", and where to see how: the release it's in use from to the one offered. */
function CodeChanged({ name, from, to }: { name: string; from: string; to: string }) {
  return (
    <div className="flex gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-[12.5px] leading-[18px] text-ink-2">
      <Code className="mt-0.5 size-[15px] shrink-0 text-ink-3" aria-hidden />
      <div className="min-w-0">
        <p>
          <span className="font-semibold text-ink-1">Its code changed.</span>
          {from !== to && (
            <>
              {' '}
              <a
                href={`${COMPARE}/v${from}...v${to}`}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-accent-strong hover:underline"
              >
                See what changed on GitHub ↗
              </a>
            </>
          )}
        </p>
        {from !== to && (
          <p className="mt-0.5 text-xs text-ink-3">
            Lumovi-plugins release {release(from)} to {release(to)}, every plugin’s changes. This
            one’s are under {release(`plugins/${name}`)} and {release(`src/${name}`)}.
          </p>
        )}
      </div>
    </div>
  )
}

/** What it asks as before: folded, with how many, and opened in place. */
function AsBefore({ lines, title }: { lines: AskLine[]; title: string }) {
  const [open, setOpen] = useState(false)
  if (lines.length === 0) return null
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink-1"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {title} ({lines.length})
      </button>
      {open && (
        <ul className="mt-1">
          {lines.map((line) => (
            <Line key={line.key} line={line} />
          ))}
        </ul>
      )}
    </div>
  )
}

export function StoreDialog({
  is,
  names,
  refused,
  onConfirm,
  onClose,
}: {
  is: StoreDialogIs
  names: KindNames
  /** Why the organization's policy doesn't allow it, and its key: then it has only Close. */
  refused?: { line: string; key: string }
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const { plugin } = is
  const tool = label(plugin)
  const confirm = async () => {
    setPending(true)
    setError(undefined)
    try {
      await onConfirm()
    } catch (failed) {
      setError(said(failed))
      setPending(false)
    }
  }

  const title =
    is.kind === 'install'
      ? `Install ${tool} ${plugin.version}?`
      : is.kind === 'update'
        ? `Update ${tool} to ${plugin.version}?`
        : is.kind === 'back'
          ? `Go back to ${tool} ${plugin.version}?`
          : `Remove ${tool}?`
  const button =
    is.kind === 'install'
      ? `Install ${plugin.version}`
      : is.kind === 'update'
        ? `Update to ${plugin.version}`
        : is.kind === 'back'
          ? `Go back to ${plugin.version}`
          : 'Remove'

  let body: ReactNode
  let note: ReactNode
  if (is.kind === 'remove') {
    body = (
      <div className="flex gap-2 px-5 py-3.5 text-[12.5px] text-ink-2">
        <Info className="mt-0.5 size-[15px] shrink-0 text-ink-3" aria-hidden />
        It goes back under Not here yet, where Install… brings it back, with this dialog’s questions
        again.
      </div>
    )
  } else if (refused) {
    body = (
      <div className="px-5 py-3.5">
        <p
          data-store-refused={refused.key}
          className="flex gap-2.5 rounded-xl border border-line bg-surface p-3 text-[13px] leading-[19px] text-ink-2"
        >
          <Lock className="mt-0.5 size-[15px] shrink-0 text-ink-3" aria-hidden />
          <span>
            <span className="font-semibold text-ink-1">{refused.line}</span> (
            <code className="font-mono text-xs text-ink-1">{refused.key}</code>).{' '}
            {is.kind === 'install' ? 'Nothing is installed.' : `${is.inUse.version} stays in use.`}
          </span>
        </p>
      </div>
    )
  } else if (is.kind === 'install') {
    body = (
      <Part title="What it may do">
        <ul>
          {askLines(is.granted, names, tool).map((line) => (
            <Line key={line.key} line={line} />
          ))}
        </ul>
      </Part>
    )
    note = 'Nothing changes until you press Install.'
  } else {
    const { added, gone, same } = compared(is.inUse.granted, is.granted)
    // (What's new and red comes first, before even its code.)
    const newLines = askLines(added, names, tool).sort((a, b) => Number(!!b.red) - Number(!!a.red))
    const goneLines = askLines(gone, names, tool)
    const sameLines = askLines(same, names, tool)
    // (Code is new whatever it asks: said wherever the one offered has some, but going back
    // within one release.)
    const codeChanged = is.granted.code && is.kind === 'update'
    body = (
      <>
        {isEmpty(added) ? (
          <div className="flex items-center gap-1.5 px-5 py-3.5 text-[12.5px] text-ink-2">
            <CircleCheck className="size-[15px] shrink-0 text-good-text" aria-hidden />
            It asks for nothing it doesn’t already have.
          </div>
        ) : (
          <Part title={`New in ${plugin.version}`} count={newLines.length}>
            <ul>
              {newLines.map((line) => (
                <Line key={line.key} line={line} />
              ))}
            </ul>
          </Part>
        )}
        {goneLines.length > 0 && (
          <Part title="No longer">
            <ul>
              {goneLines.map((line) => (
                <Line key={line.key} line={line} gone />
              ))}
            </ul>
          </Part>
        )}
        <div className="border-t border-line px-5 py-3.5">
          {codeChanged && (
            <CodeChanged name={plugin.name} from={is.inUse.release} to={is.release} />
          )}
          <AsBefore
            lines={sameLines}
            title={isEmpty(added) ? 'What it may do' : 'Everything else it may do, as before'}
          />
        </div>
      </>
    )
    note = `Nothing changes until you press ${is.kind === 'update' ? 'Update' : 'Go back'}.`
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && !pending && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/30 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          data-store-dialog={is.kind}
          onOpenAutoFocus={(event) => {
            // (Removing starts on Cancel, so a stray Enter never removes anything.)
            if (is.kind === 'remove' || refused) {
              event.preventDefault()
              ;(event.currentTarget as HTMLElement)
                .querySelector<HTMLElement>('[data-cancel]')
                ?.focus()
            }
          }}
          className={cn(
            'fixed top-[10vh] left-1/2 z-50 flex max-h-[80vh] w-[560px] max-w-[calc(100vw-48px)] -translate-x-1/2 animate-pop-in flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface-2 shadow-pop outline-none',
            sheetFrame,
          )}
        >
          <SheetGrabber kind="other" onClose={onClose} className="hidden phone:block" />
          <header
            className={cn('flex gap-3 border-b border-line px-5 pt-[18px] pb-3.5', sheetHeader)}
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-3 text-ink-2">
              {/* (The mark of the row that was pressed: its own, or a plugin's.) */}
              {plugin.place ? (
                <PluginIcon plugin={plugin.place} className="size-[18px]" />
              ) : (
                <Plug className="size-[18px]" aria-hidden />
              )}
            </span>
            <div className="min-w-0">
              <Dialog.Title className="text-[15px] leading-[21px] font-semibold text-ink-1">
                {title}
              </Dialog.Title>
              {is.kind === 'remove' ? (
                <p className="mt-0.5 text-xs text-ink-3">
                  Its pages and lists go, and nothing in your cluster changes.
                </p>
              ) : (
                <>
                  <p className="mt-0.5 text-xs leading-4 text-ink-3">
                    From Lumovi-plugins release {release(is.release)}, signed by its release
                    workflow. What it reads and changes, it does as you.
                  </p>
                  {is.kind !== 'install' && (
                    <p className="text-xs leading-4 text-ink-3">
                      In use: {is.inUse.version},{' '}
                      {is.inUse.lumovis ? (
                        'which comes with Lumovi.'
                      ) : (
                        <>installed from Lumovi-plugins release {release(is.inUse.release)}.</>
                      )}
                    </p>
                  )}
                </>
              )}
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
          {error && (
            <p
              role="alert"
              className="border-t border-line bg-critical/8 px-5 py-2.5 text-[12.5px] text-critical-text selectable"
            >
              {error}
            </p>
          )}
          <footer
            className={cn(
              'flex items-center justify-end gap-2 border-t border-line bg-surface px-5 py-3',
              sheetFooter,
            )}
          >
            {note && !refused && <span className="mr-auto text-xs text-ink-3">{note}</span>}
            <Button variant="ghost" data-cancel onClick={onClose} disabled={pending}>
              {refused ? 'Close' : 'Cancel'}
            </Button>
            {!refused && (
              <Button
                data-confirm
                variant={is.kind === 'remove' ? 'danger' : 'primary'}
                aria-disabled={pending || undefined}
                onClick={() => void (pending || confirm())}
                className="min-w-20 aria-disabled:pointer-events-none aria-disabled:opacity-50"
              >
                {pending && <LoaderCircle className="animate-spin" />}
                {button}
              </Button>
            )}
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** What went wrong, as the main process said it: without Electron's words around it. */
export function said(error: unknown): string {
  return (error as Error).message.replace(
    /^Error invoking remote method '[^']+': (?:\w*Error: )?/,
    '',
  )
}

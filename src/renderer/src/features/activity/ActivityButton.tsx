import { CircleCheck, CircleX, History, LoaderCircle } from 'lucide-react'
import { Popover } from 'radix-ui'
import { IconButton } from '@renderer/components/Button'
import { CopyButton } from '@renderer/components/CopyButton'
import { useOpenObject } from '@renderer/hooks/open-object'
import { useGo } from '@renderer/hooks/go'
import { cn } from '@renderer/lib/cn'
import { age } from '@renderer/lib/format'
import { currentPath, kindPath } from '@renderer/lib/routes'
import { useActivity, type ActivityEntry } from '@renderer/state/activity'
import { useCluster } from '@renderer/state/cluster'
import { menuContent } from '../shell/menu-styles'

const STATUS = {
  running: { icon: LoaderCircle, label: 'In progress', className: 'animate-spin text-accent' },
  done: { icon: CircleCheck, label: 'Done', className: 'text-good-text' },
  failed: { icon: CircleX, label: 'Failed', className: 'text-critical-text' },
}

/** The changes made from KubeStacks in this session, with the kubectl command for each. */
export function ActivityButton() {
  const entries = useActivity((state) => state.entries)
  const unseen = useActivity((state) => state.unseen)
  const markSeen = useActivity((state) => state.markSeen)
  const clear = useActivity((state) => state.clear)
  return (
    <Popover.Root onOpenChange={(open) => open && markSeen()}>
      <Popover.Trigger asChild>
        <IconButton label="Activity" className="relative">
          <History />
          {unseen > 0 && (
            <span
              aria-label={`${unseen} new`}
              className="absolute top-0.5 right-0.5 grid h-3.5 min-w-3.5 animate-pop-in place-items-center rounded-full bg-accent px-1 text-[9px] font-semibold text-white tabular-nums"
            >
              {unseen}
            </span>
          )}
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          aria-label="Activity"
          className={cn(menuContent, 'flex max-h-[70vh] w-[420px] flex-col p-0')}
        >
          <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h2 className="text-[13px] font-semibold text-ink-1">Changes this session</h2>
            {entries.length > 0 && (
              <button
                type="button"
                onClick={clear}
                className="rounded-md px-1.5 py-0.5 text-xs text-ink-3 hover:bg-surface-3 hover:text-ink-1"
              >
                Clear
              </button>
            )}
          </header>
          {entries.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] leading-relaxed text-ink-3">
              Changes you make from KubeStacks show up here, with the kubectl command for each.
            </p>
          ) : (
            <ol className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
              {entries.map((entry) => (
                <Entry key={entry.id} entry={entry} />
              ))}
            </ol>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function Entry({ entry }: { entry: ActivityEntry }) {
  const { context } = useCluster()
  const openObject = useOpenObject()
  const go = useGo()
  const status = STATUS[entry.status]
  const { target } = entry
  // Objects from this cluster can be opened; the list's view is opened first when needed.
  const open =
    target && entry.context === context
      ? () => {
          if (!currentPath().includes(kindPath(context, target.kind))) {
            go(kindPath(context, target.kind))
          }
          openObject(target.kind, target.name, target.namespace)
        }
      : undefined
  return (
    <li className="flex gap-3 px-4 py-3">
      <status.icon
        aria-label={status.label}
        className={cn('mt-0.5 size-4 shrink-0', status.className)}
      />
      <div className="min-w-0 flex-1">
        {open ? (
          <Popover.Close asChild>
            <button
              type="button"
              onClick={open}
              className="text-left text-[13px] leading-snug font-medium text-ink-1 hover:text-accent-strong hover:underline"
            >
              {entry.title}
            </button>
          </Popover.Close>
        ) : (
          <p className="text-[13px] leading-snug font-medium text-ink-1">{entry.title}</p>
        )}
        <p className="mt-0.5 text-xs text-ink-3">
          {age(new Date(entry.at).toISOString())} ago
          {entry.context !== context && ` · ${entry.context}`}
        </p>
        {entry.error && (
          <p className="mt-1 text-xs leading-relaxed break-words text-critical-text selectable">
            {entry.error}
          </p>
        )}
        <div className="mt-1.5 flex items-center gap-1 rounded-md bg-surface-3/70 py-0.5 pr-0.5 pl-2">
          <code
            className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-2"
            title={entry.command}
          >
            {entry.command}
          </code>
          <CopyButton text={entry.command} label="Copy command" />
        </div>
      </div>
    </li>
  )
}

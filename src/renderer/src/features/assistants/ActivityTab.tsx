/**
 * The AI assistants page's Activity tab: what assistants changed, or asked
 * to and were refused, while this page has been open (the activity log's
 * entries that came from one).
 */
import { Ban, CircleCheck, CircleX, LoaderCircle } from 'lucide-react'
import { Link } from 'react-router'
import { CopyButton } from '@renderer/components/CopyButton'
import { cn } from '@renderer/lib/cn'
import { age } from '@renderer/lib/format'
import { useActivity } from '@renderer/state/activity'
import { Card } from './PageParts'

const STATUS = {
  running: { icon: LoaderCircle, label: 'In progress', className: 'animate-spin text-ink-3' },
  done: { icon: CircleCheck, label: 'Made', className: 'text-good-text' },
  failed: { icon: CircleX, label: 'Failed', className: 'text-critical-text' },
  rejected: { icon: Ban, label: 'Rejected', className: 'text-ink-3' },
}

export function ActivityTab() {
  const entries = useActivity((state) => state.entries).filter((entry) => entry.via)
  return (
    <Card as="section" aria-label="What assistants did">
      <header className="border-b border-line px-5 py-4">
        <h2 className="text-[15px] font-semibold text-ink-1">What assistants did</h2>
        <p className="mt-0.5 text-xs text-ink-3">
          Their changes, made or not, since Lumovi opened: with the kubectl command for each.{' '}
          <Link
            to="/audit?via=assistant"
            className="font-medium text-accent-strong hover:underline"
          >
            Everything they did, kept, is in the audit log.
          </Link>
        </p>
      </header>
      {entries.length === 0 ? (
        <p className="px-5 py-8 text-center text-[13px] text-ink-3">
          Nothing yet: what assistants change, or ask to, shows here.
        </p>
      ) : (
        <ol className="divide-y divide-line">
          {entries.map((entry) => {
            const status = STATUS[entry.status]
            return (
              <li key={entry.id} className="flex gap-3 px-5 py-3">
                <status.icon
                  aria-label={status.label}
                  className={cn('mt-0.5 size-4 shrink-0', status.className)}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-ink-1">{entry.title}</p>
                  <p className="mt-0.5 text-xs text-ink-3">
                    {age(new Date(entry.at).toISOString())} ago · {entry.context}
                    {entry.target?.namespace && ` / ${entry.target.namespace}`} ·{' '}
                    {entry.status === 'rejected' ? 'rejected, asked by ' : 'via '}
                    <span className="font-medium text-ink-2">{entry.via}</span>
                  </p>
                  {entry.note && (
                    <p className="mt-1 text-xs break-words text-ink-2 italic selectable">
                      “{entry.note}”
                    </p>
                  )}
                  {entry.error && (
                    <p className="mt-1 text-xs break-words text-critical-text selectable">
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
          })}
        </ol>
      )}
    </Card>
  )
}

import { Activity, Info, TriangleAlert } from 'lucide-react'
import type { KubeObject } from '@shared/api'
import { EmptyState, ErrorState, Loading } from '@renderer/components/States'
import { useList } from '@renderer/hooks/queries'
import type { KubeApiError } from '@renderer/lib/api'
import { age, formatDateTime } from '@renderer/lib/format'
import { lastSeen } from '../resources/columns'

/** Events about one object, newest first — the same lookup `kubectl describe` does. */
export function EventsTab({ object }: { object: KubeObject }) {
  const events = useList('Event', {
    namespace: object.metadata.namespace ?? null,
    fieldSelector: `involvedObject.kind=${object.kind},involvedObject.name=${object.metadata.name}`,
  })

  if (events.isPending) return <Loading label="Loading events…" />
  if (events.data === undefined)
    return <ErrorState error={events.error as KubeApiError} onRetry={() => void events.refetch()} />
  if (events.data.length === 0) {
    return (
      <EmptyState icon={Activity} title="No recent events">
        Kubernetes keeps events for about an hour by default.
      </EmptyState>
    )
  }

  const sorted = [...events.data].sort((a, b) => Date.parse(lastSeen(b)) - Date.parse(lastSeen(a)))
  return (
    <ol aria-label="Events" className="relative space-y-1 px-5 py-4">
      {sorted.map((event) => {
        const warning = event.type === 'Warning'
        const Icon = warning ? TriangleAlert : Info
        return (
          <li
            key={event.metadata.name}
            className="flex gap-3 rounded-xl px-3 py-2.5 hover:bg-surface-2"
          >
            <Icon
              className={
                warning ? 'mt-0.5 size-4 shrink-0 text-warn' : 'mt-0.5 size-4 shrink-0 text-ink-3'
              }
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="font-semibold text-ink-1">{event.reason as string}</span>
                {(event.count as number) > 1 && (
                  <span className="rounded-full bg-surface-3 px-1.5 text-2xs font-medium text-ink-2 tabular-nums">
                    ×{event.count as number}
                  </span>
                )}
                <span className="flex-1" />
                <time
                  className="shrink-0 text-xs text-ink-3"
                  dateTime={lastSeen(event)}
                  title={formatDateTime(lastSeen(event))}
                >
                  {age(lastSeen(event))} ago
                </time>
              </div>
              <p className="mt-0.5 text-[13px] leading-relaxed break-words text-ink-2 selectable">
                {event.message as string}
              </p>
              <p className="mt-0.5 text-xs text-ink-3">
                {(event.source as { component?: string } | undefined)?.component}
              </p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

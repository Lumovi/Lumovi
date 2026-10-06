/**
 * An object's own audit log, in its detail panel: who changed it (or read
 * it, or opened a shell in it), when, how, and how it went. Its kind and
 * name's, so what was there before it, under its name, shows too.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ScrollText } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { Link } from 'react-router'
import { matches, type AuditQuery } from '@shared/audit'
import type { ResourceKind } from '@shared/resources'
import { EmptyState, Loading } from '@renderer/components/States'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { age } from '@renderer/lib/format'
import { ACTIONS, OUTCOME_STYLES, paramsOf, filtersOf } from './audit-model'

export function ObjectAudit({
  context,
  kind,
  name,
  namespace,
}: {
  context: string
  kind: ResourceKind
  name: string
  namespace?: string
}) {
  const queryClient = useQueryClient()
  const query = useMemo<AuditQuery>(
    () => ({
      clusters: [context],
      target: { kind, name, ...(namespace ? { namespace } : {}) },
      limit: 50,
    }),
    [context, kind, name, namespace],
  )
  const key = useMemo(() => ['audit-object', query], [query])
  const found = useQuery({ queryKey: key, queryFn: () => api.audit.query(query) })
  // What's recorded about it while it's open: shown as it is.
  useEffect(
    () =>
      api.audit.onEvent((event) => {
        if (matches(query, event, [])) void queryClient.invalidateQueries({ queryKey: key })
      }),
    [query, key, queryClient],
  )
  const all = `/audit?${paramsOf({
    ...filtersOf(new URLSearchParams()),
    range: 'all',
    clusters: [context],
    target: query.target,
  })}`
  if (found.isPending) return <Loading label="Looking in the audit log…" />
  if (found.isError) {
    return (
      <EmptyState icon={ScrollText} title="The audit log couldn’t be searched">
        {found.error.message}
      </EmptyState>
    )
  }
  const { events } = found.data
  if (events.length === 0) {
    return (
      <EmptyState icon={ScrollText} title="Nothing recorded">
        Nobody has changed it through Lumovi (or opened, or read it) in what the audit log keeps.
      </EmptyState>
    )
  }
  return (
    <div className="px-5 py-4">
      <ol aria-label="Audit log" className="space-y-1">
        {events.map((event) => {
          const action = ACTIONS[event.action]
          const outcome = OUTCOME_STYLES[event.outcome]
          return (
            <li key={event.id} className="flex gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
              <action.icon className={cn('mt-0.5 size-4 shrink-0', outcome.className)} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] leading-snug text-ink-1">
                  {event.summary}
                  {event.outcome !== 'success' && (
                    <span
                      className={cn(
                        'ml-2 rounded-md px-1.5 py-px text-2xs font-semibold',
                        outcome.badge,
                      )}
                    >
                      {outcome.label}
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-ink-3">
                  <span className="text-ink-2">{event.actor.user}</span>
                  {event.actor.via === 'assistant' && ` through ${event.actor.assistant}`} ·{' '}
                  <time dateTime={event.time} title={new Date(event.time).toLocaleString()}>
                    {age(event.time)} ago
                  </time>
                </p>
              </div>
            </li>
          )
        })}
      </ol>
      <Link
        to={all}
        className="mt-3 inline-block px-2 text-xs font-medium text-accent hover:underline"
      >
        Open in the audit log
      </Link>
    </div>
  )
}

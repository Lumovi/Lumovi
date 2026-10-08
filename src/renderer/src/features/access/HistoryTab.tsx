/**
 * Every change to who may do what: by whom, from where, and what it was
 * before. Kept in the audit log, with everything else, and read from it.
 */
import { useInfiniteQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router'
import type { AuditEvent } from '@shared/audit'
import { Button } from '@renderer/components/Button'
import { Loading } from '@renderer/components/States'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { formatDateTime } from '@renderer/lib/format'
import { SectionHead } from './parts'

export function HistoryTab() {
  const history = useInfiniteQuery({
    queryKey: ['access', 'history'],
    queryFn: ({ pageParam }) => api.access!.history(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next,
    gcTime: 0,
  })
  const events = history.data?.pages.flatMap((page) => page.events) ?? []
  return (
    <section aria-labelledby="history-heading" className="flex flex-col gap-2.5">
      <SectionHead
        id="history-heading"
        title="History"
        action={
          <Link
            to="/audit?category=settings&q=access.changed&range=all"
            className="text-[13px] font-medium text-accent-strong hover:underline"
          >
            Open in the audit log
          </Link>
        }
      >
        Every change to who may do what: by whom, and what it was before. Kept in the audit log,
        with everything else.
      </SectionHead>
      {history.isPending ? (
        <Loading label="Reading the audit log…" className="py-16" />
      ) : events.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong px-5 py-8 text-center text-[13px] text-ink-2">
          No changes yet, as far back as the audit log goes. Saved changes show here, with who made
          them.
        </div>
      ) : (
        <ol className="overflow-hidden rounded-xl border border-line bg-surface">
          {events.map((event, i) => (
            <Change key={event.id} event={event} first={i === 0} />
          ))}
        </ol>
      )}
      {history.hasNextPage && (
        <Button
          variant="secondary"
          className="self-center"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          Earlier changes
        </Button>
      )}
    </section>
  )
}

/**
 * "Changed the profile “Developer”: Helm: Off → Upgrade, roll back; Shells: Off → Open them":
 * what changed, and each part of it, to show.
 */
function partsOf(change: string) {
  const split = /^(.*?(?:”|may do)): (.*)$/s.exec(change)
  return split ? { head: split[1]!, parts: split[2]!.split('; ') } : { head: change, parts: [] }
}

function Change({ event, first }: { event: AuditEvent; first: boolean }) {
  const changes = event.details!.changes as string[]
  // Changed by hand, where it's kept (a ConfigMap, a file), not on this page: nobody's to name.
  const who = event.details!.outside
    ? 'Outside Lumovi, where it’s kept'
    : [event.actor.user, event.actor.forwardedFor ?? event.actor.address]
        .filter(Boolean)
        .join(', from ')
  return (
    <li
      className={cn(
        'flex flex-wrap items-start gap-3.5 px-4 py-3',
        !first && 'border-t border-line',
      )}
    >
      <time
        dateTime={event.time}
        className="w-[150px] shrink-0 pt-0.5 font-mono text-2xs whitespace-nowrap text-ink-3"
      >
        {formatDateTime(event.time)}
      </time>
      <span
        aria-hidden
        className="grid size-[22px] shrink-0 place-items-center rounded-full bg-surface-3 text-[10px] font-semibold text-ink-2"
      >
        {event.actor.user.slice(0, 1).toUpperCase()}
      </span>
      <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-1.5">
        <span className="text-xs text-ink-3">{who}</span>
        <ul className="flex flex-col gap-1">
          {changes.map((change) => {
            const { head, parts } = partsOf(change)
            return (
              <li key={change} className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium text-ink-1">{head}</span>
                {parts.length > 0 && (
                  <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                    {parts.map((part) => {
                      const [before, to] = part.split(' → ')
                      const at = before!.indexOf(': ')
                      const [label, from] =
                        at < 0 ? ['', before!] : [before!.slice(0, at), before!.slice(at + 2)]
                      return to === undefined ? (
                        <span key={part} className="text-xs text-ink-2">
                          {part}
                        </span>
                      ) : (
                        <span key={part} className="inline-flex items-center gap-1.5 text-xs">
                          {label && <span className="text-ink-2">{label}</span>}
                          <span className="text-ink-3 line-through">{from}</span>
                          <ArrowRight aria-label="to" className="size-3 text-ink-3" />
                          <span className="font-medium text-ink-1">{to}</span>
                        </span>
                      )
                    })}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </li>
  )
}

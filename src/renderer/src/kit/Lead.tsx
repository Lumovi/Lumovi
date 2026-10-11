/** What the kit's lists share: the card they stand in, a small heading, and the row's lead. */
import type { TableLead } from '@shared/kit/table'
import { MiddleTruncate } from '@renderer/components/MiddleTruncate'
import { StatusDot } from '@renderer/components/Status'
import { cn } from '@renderer/lib/cn'

export const CARD = 'overflow-hidden rounded-xl border border-line bg-surface-2 shadow-panel'
export const HEADING =
  'text-[11px] font-medium tracking-wider whitespace-nowrap text-ink-3 uppercase'

/** What a row is called: a dot in a level (or none, and the name keeps its place), a name, a quiet word, a line under. */
export function Lead({
  lead,
  top = false,
}: {
  lead: TableLead
  /** Its dot stands on the name's line, not in the middle: where a note runs under the row. */
  top?: boolean
}) {
  const { level, name, beside, under } = lead
  return (
    <span className={cn('flex min-w-0 flex-1 items-center gap-2.5', top && 'items-start')}>
      {level ? (
        <StatusDot health={level} className={cn(top && 'mt-1.5')} />
      ) : (
        <span className="w-2 shrink-0" />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          {/* A name is never cut at its end: it loses its middle and keeps its last characters. */}
          <MiddleTruncate text={name} className="font-medium text-ink-1" />
          {/* The word beside it gives way first, to 40% of the lead at most. */}
          {beside && (
            <span
              // (A short word stays whole; a long one keeps its first few characters.)
              style={{ minWidth: `${Math.min(beside.length, 5)}ch` }}
              className="max-w-[40%] shrink-[99] truncate text-xs text-ink-3"
            >
              {beside}
            </span>
          )}
        </span>
        {under && <span className="block truncate text-xs leading-4 text-ink-3">{under}</span>}
      </span>
    </span>
  )
}

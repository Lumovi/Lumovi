/**
 * Shares of a whole, as bars: groups, each a title in a card's small capitals, then its values,
 * the largest first, each with a bar of its share of the group's whole and its count. Never a
 * meter: a bar is drawn in the first series colour only, and never says a level. A group shows up
 * to five values; past five, four and "N more", which opens the rest in place. Groups stand three
 * across where there's room, and one under another in a pair's side or on a phone.
 */
import { ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'
import { spelled } from '@shared/kit/characters'
import type { Going } from '@shared/kit/declare'
import { COUNTS_SHOWN, type CountsGroup, type CountsProps } from '@shared/kit/page'
import { cn } from '@renderer/lib/cn'
import { TheirText } from '@renderer/plugins/TheirText'
import { HEADING } from './Lead'
import { MiddleCut } from './MiddleCut'

export function Counts({
  groups,
  go,
}: CountsProps & {
  /** Opens where a row says: Lumovi's own to do, never the plugin's (and not declared). */
  go?: (to: Going) => void
}) {
  return (
    <div className="@container min-w-0">
      <div className="grid grid-cols-1 gap-3.5 @[720px]:grid-cols-3 @[720px]:gap-5">
        {groups.map((group, index) => (
          <Group key={index} group={group} {...(go ? { go } : {})} />
        ))}
      </div>
    </div>
  )
}

function Group({ group, go }: { group: CountsGroup; go?: (to: Going) => void }) {
  const [open, setOpen] = useState(false)
  // The largest first; among equals, as they were given.
  const rows = useMemo(
    () =>
      group.rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => b.row.count - a.row.count || a.index - b.index)
        .map(({ row }) => row),
    [group.rows],
  )
  const whole = rows.reduce((sum, row) => sum + row.count, 0)
  const folded = !open && rows.length > COUNTS_SHOWN
  const shown = folded ? rows.slice(0, COUNTS_SHOWN - 1) : rows
  return (
    <section aria-label={spelled(group.title.their)} className="min-w-0">
      <h4 className={cn(HEADING, 'mb-1.5 leading-4')}>
        <TheirText text={group.title} inline />
      </h4>
      <ul>
        {shown.map((row, index) => {
          const count = row.count
          // (The smallest share there is is still a dot; none is no bar at all.)
          const share = count > 0 && whole > 0 ? Math.max(2, Math.round((count / whole) * 100)) : 0
          const opens = row.opens
          const grid =
            'grid min-h-[26px] grid-cols-[minmax(0,1.4fr)_minmax(40px,1fr)_28px] items-center gap-2.5 text-[12.5px] phone:min-h-8 phone:grid-cols-[minmax(0,1.4fr)_minmax(32px,0.6fr)_28px]'
          const cells = (
            <>
              <MiddleCut
                text={row.value}
                className={cn('text-ink-1', group.code && 'font-mono text-xs')}
              />
              <span
                aria-hidden
                data-bar=""
                className="h-1.5 overflow-hidden rounded-full bg-series-1/20"
              >
                <span
                  className="block h-full rounded-full bg-series-1"
                  style={{ width: `${share}%` }}
                />
              </span>
              <span className="text-right text-xs text-ink-2 tabular-nums">
                {count.toLocaleString('en-US')}
                <span className="sr-only"> of {whole.toLocaleString('en-US')}</span>
              </span>
            </>
          )
          // One that opens is pressed whole: Lumovi opens where it says (a finger's height on a phone).
          return opens && go ? (
            <li key={index}>
              <button
                type="button"
                onClick={() => go(opens)}
                className={cn(
                  grid,
                  '-mx-1.5 w-[calc(100%+12px)] rounded-md px-1.5 text-left hover:bg-surface-3/60 phone:min-h-11',
                )}
              >
                {cells}
              </button>
            </li>
          ) : (
            <li key={index} className={grid}>
              {cells}
            </li>
          )
        })}
      </ul>
      {folded && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex min-h-[26px] items-center gap-1.5 text-xs text-ink-3 hover:text-ink-2 phone:min-h-11"
        >
          <ChevronDown className="size-3.5" aria-hidden />
          {(rows.length - shown.length).toLocaleString('en-US')} more
        </button>
      )}
    </section>
  )
}

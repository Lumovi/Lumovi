/** What the kit's lists share: the card they stand in, a small heading, and the row's lead. */
import { spelled } from '@shared/kit/characters'
import type { Their } from '@shared/kit/declare'
import type { TableLead, WrittenTableLead } from '@shared/kit/table'
import { StatusDot } from '@renderer/components/Status'
import { cn } from '@renderer/lib/cn'
import { TheirText } from '@renderer/plugins/TheirText'
import { MiddleCut } from './MiddleCut'

export const CARD = 'overflow-hidden rounded-xl border border-line bg-surface-2 shadow-panel'
/** A heading, uppercased: but not its marks, which stay as they're built. */
export const HEADING =
  'text-[11px] font-medium tracking-wider whitespace-nowrap text-ink-3 uppercase [&_[data-mark]]:tracking-normal [&_[data-mark]]:normal-case'

/**
 * A text of the plugin's as it was written: one handed over (a `Their`), or one a part's own
 * description still holds as text (a frame's).
 */
export const said = (text: Their | string | undefined) =>
  typeof text === 'string' ? text : (text?.their ?? '')

/** A text of the plugin's, as a `Their` to draw in pieces, however it was given. */
const theirs = (text: Their | string | undefined): Their | undefined =>
  typeof text === 'string' ? { their: text } : text

/**
 * What a row is called: a dot in a level (or none, and the name keeps its place), a name, a quiet
 * word, a line under. All of them the plugin's, drawn in pieces.
 */
export function Lead({
  lead,
  top = false,
  quiet = false,
}: {
  lead?: TableLead | WrittenTableLead
  /** Its dot stands on the name's line, not in the middle: where a note runs under the row. */
  top?: boolean
  /** Its name quieter: a row that stands for one listed already (a graph's table). */
  quiet?: boolean
}) {
  const { level, name, beside, under } = lead ?? {}
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
          <MiddleCut
            text={theirs(name)}
            className={quiet ? 'text-ink-2' : 'font-medium text-ink-1'}
          />
          {/* The word beside it gives way first, to 40% of the lead at most. */}
          {said(beside) && (
            <span
              // (A short word stays whole, marks and all; a long one keeps its first few characters.)
              style={{ minWidth: `${Math.min(spelled(said(beside)).length, 5)}ch` }}
              className="max-w-[40%] shrink-[99] truncate text-xs text-ink-3"
            >
              <TheirText text={beside} inline />
            </span>
          )}
        </span>
        {said(under) && (
          <span className="block truncate text-xs leading-4 text-ink-3">
            <TheirText text={under} inline />
          </span>
        )}
      </span>
    </span>
  )
}

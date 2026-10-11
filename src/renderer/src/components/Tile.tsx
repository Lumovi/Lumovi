import { ChevronRight, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Health } from '@shared/health'
import { cn } from '@renderer/lib/cn'
import { MiddleTruncate } from './MiddleTruncate'
import { StatusDot } from './Status'

/**
 * A headline: what it's of, a value, and one line under it. The Overview's tile, and what a
 * plugin's page is given for one. One that opens something is a button, with a chevron under
 * the pointer (always, on touch); one that opens nothing has neither.
 */
export function Tile({
  icon: Icon,
  label,
  value,
  words = false,
  detail,
  status,
  cut = false,
  onOpen,
}: {
  icon?: LucideIcon
  label: string
  value?: ReactNode
  /** The value is words or a name, not a figure: set smaller on the same line, its middle cut. */
  words?: boolean
  detail?: ReactNode
  status?: Health
  /** The label and the line under are cut at their ends, at every width. */
  cut?: boolean
  onOpen?: () => void
}) {
  const body = (
    <>
      {/* On a phone the tiles are two across, and a label has its line to itself: the chevron
          sits in the tile's corner, out of its way. */}
      <div className="flex items-center gap-2 text-[13px] text-ink-2 phone:gap-1.5 phone:whitespace-nowrap">
        {Icon && <Icon className="size-4 shrink-0 text-ink-3" />}
        {/* (At a larger text size it's cut short, rather than making one tile taller.) */}
        <span className={cn('min-w-0 phone:truncate', cut && 'truncate')}>{label}</span>
        {onOpen && (
          <ChevronRight className="ml-auto size-4 shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 phone:absolute phone:top-2 phone:right-2 phone:size-3.5 touch:opacity-100" />
        )}
      </div>
      {words && typeof value === 'string' ? (
        <div className="mt-2.5 flex h-7 items-center text-[15px] font-semibold text-ink-1">
          <MiddleTruncate text={value} />
        </div>
      ) : (
        <div
          className={cn(
            'mt-2.5 text-[28px] leading-none font-semibold tracking-[-0.02em] text-ink-1',
            // (Kept in its tile, however long: cut at its end, and only sideways, so no letter's
            // tail is.)
            cut && '[overflow-x:clip] text-ellipsis whitespace-nowrap',
          )}
        >
          {value ?? '—'}
        </div>
      )}
      <div className="mt-2 flex h-5 items-center gap-1.5 text-xs text-ink-3">
        {status && <StatusDot health={status} />}
        {cut ? <span className="min-w-0 truncate">{detail}</span> : detail}
      </div>
    </>
  )
  const box = 'rounded-xl border border-line bg-surface-2 p-4 text-left shadow-panel'
  return (
    <section aria-label={label} className="animate-rise">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className={cn(
            'group relative block w-full transition-colors hover:border-line-strong hover:bg-surface-3/40',
            box,
          )}
        >
          {body}
        </button>
      ) : (
        <div className={cn('relative', box)}>{body}</div>
      )}
    </section>
  )
}

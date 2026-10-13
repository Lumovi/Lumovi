import { ChevronRight, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Health } from '@shared/health'
import { spelled } from '@shared/kit/characters'
import type { Their } from '@shared/kit/declare'
import { MiddleCut } from '@renderer/kit/MiddleCut'
import { cn } from '@renderer/lib/cn'
import { TheirText } from '@renderer/plugins/TheirText'
import { MiddleTruncate } from './MiddleTruncate'
import { StatusDot } from './Status'

/** Lumovi's own text, or a plugin's (drawn in pieces). */
type Said = string | Their
const drawn = (text: Said) => (typeof text === 'string' ? text : <TheirText text={text} inline />)

/**
 * A headline: what it's of, a value, and one line under it. The Overview's tile, and what a
 * plugin's page is given for one (its texts the plugin's: drawn in pieces, said spelled). One
 * that opens something is a button, with a chevron under the pointer (always, on touch); one that
 * opens nothing has neither.
 */
export function Tile({
  icon: Icon,
  label,
  value,
  words = false,
  detail,
  status,
  cut = false,
  wraps = false,
  onOpen,
  opensTip,
}: {
  icon?: LucideIcon
  label: Said
  value?: ReactNode | Their
  /** The value is words or a name, not a figure: set smaller on the same line, its middle cut. */
  words?: boolean
  detail?: ReactNode
  status?: Health
  /** The label and the line under are cut at their ends, at every width. */
  cut?: boolean
  /**
   * The line under is Lumovi's own (where a count stops): never cut, it wraps instead, and the
   * row's tiles take the taller height together.
   */
  wraps?: boolean
  onOpen?: () => void
  /** Where it opens, in Lumovi's words, where that's one of Lumovi's own places for an object. */
  opensTip?: string
}) {
  const body = (
    <>
      {/* On a phone the tiles are two across, and a label has its line to itself: the chevron
          sits in the tile's corner, out of its way. */}
      <div className="flex items-center gap-2 text-[13px] text-ink-2 phone:gap-1.5 phone:whitespace-nowrap">
        {Icon && <Icon className="size-4 shrink-0 text-ink-3" />}
        {/* (At a larger text size it's cut short, rather than making one tile taller.) */}
        <span className={cn('min-w-0 phone:truncate', cut && 'truncate')}>{drawn(label)}</span>
        {onOpen && (
          <ChevronRight className="ml-auto size-4 shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 phone:absolute phone:top-2 phone:right-2 phone:size-3.5 touch:opacity-100" />
        )}
      </div>
      {words && (typeof value === 'string' || isTheirs(value)) ? (
        <div className="mt-2.5 flex h-7 min-w-0 items-center text-[15px] font-semibold text-ink-1">
          {typeof value === 'string' ? (
            <MiddleTruncate text={value} />
          ) : (
            <MiddleCut text={value} className="flex-1" />
          )}
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
          {isTheirs(value) ? drawn(value) : (value ?? '—')}
        </div>
      )}
      <div
        className={cn(
          'mt-2 flex items-center gap-1.5 text-xs text-ink-3',
          wraps ? 'min-h-5 leading-4' : 'h-5',
        )}
      >
        {status && <StatusDot health={status} />}
        {cut && !wraps ? <span className="min-w-0 truncate">{detail}</span> : detail}
      </div>
    </>
  )
  const box = 'rounded-xl border border-line bg-surface-2 p-4 text-left shadow-panel'
  return (
    <section
      aria-label={typeof label === 'string' ? label : spelled(label.their)}
      // (As tall as its row's tallest: a tile's cell, filled.)
      className="h-full animate-rise"
    >
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          title={opensTip}
          className={cn(
            'group relative block h-full w-full transition-colors hover:border-line-strong hover:bg-surface-3/40',
            box,
          )}
        >
          {body}
        </button>
      ) : (
        <div className={cn('relative h-full', box)}>{body}</div>
      )}
    </section>
  )
}

/** Whether a value is a plugin's text, handed over by the door. */
function isTheirs(value: unknown): value is Their {
  return typeof value === 'object' && value !== null && 'their' in value
}

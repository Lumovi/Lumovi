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
  also,
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
   * The line under is never cut: it wraps instead (onto a second line in a narrow tile), and the
   * row's tiles take the taller height together.
   */
  wraps?: boolean
  onOpen?: () => void
  /** Where it opens, in Lumovi's words, where that's one of Lumovi's own places for an object. */
  opensTip?: string
  /**
   * A part of its line that opens a place of its own ("3 alerts firing"), after what the line
   * says: the tile still opens its place, everywhere but there.
   */
  also?: { text: string; onOpen: () => void }
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
          'mt-2 flex gap-1.5 text-xs text-ink-3',
          // (Wrapped, its dot stands by its first line.)
          wraps ? 'min-h-5 items-start py-0.5 leading-4' : 'h-5 items-center',
        )}
      >
        {status && <StatusDot health={status} className={cn(wraps && 'mt-1')} />}
        {cut && !wraps ? <span className="min-w-0 truncate">{detail}</span> : detail}
        {also && (
          <>
            <span aria-hidden>·</span>
            <button
              type="button"
              onClick={also.onOpen}
              className="pointer-events-auto relative z-10 shrink-0 rounded font-medium text-accent-strong hover:underline focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none touch:finger"
            >
              {also.text}
            </button>
          </>
        )}
      </div>
    </>
  )
  const box = 'rounded-xl border border-line bg-surface-2 p-4 text-left shadow-panel'
  // Two places to open: the tile's own, a button over the whole of it (first, as the keys come),
  // and its line's, above that. (A button can't hold another.)
  if (onOpen && also) {
    const said = (part: unknown) =>
      typeof part === 'string' || typeof part === 'number' ? String(part) : ''
    return (
      <section
        aria-label={typeof label === 'string' ? label : spelled(label.their)}
        className="h-full animate-rise"
      >
        <div
          className={cn(
            'group relative flex h-full w-full flex-col transition-colors hover:border-line-strong hover:bg-surface-3/40',
            box,
          )}
        >
          <button
            type="button"
            onClick={onOpen}
            title={opensTip}
            aria-label={[said(label), said(value), said(detail)].filter(Boolean).join(' ')}
            className="absolute inset-0 rounded-xl focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          />
          <div className="pointer-events-none relative flex h-full flex-col">{body}</div>
        </div>
      </section>
    )
  }
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
            // (Its content at its top, as a tile that opens nothing has it: in a taller row, the
            // spare height falls below its line.)
            'group relative flex h-full w-full flex-col transition-colors hover:border-line-strong hover:bg-surface-3/40',
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

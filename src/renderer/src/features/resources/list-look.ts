/**
 * How Lumovi's lists look, in one place: its own lists (ResourceTable, ListBar) and a plugin's
 * table that is its page's list (the kit's Table) are drawn from these, so a person can't tell
 * one from the other, and a change to the one is a change to both.
 */
import { cn } from '@renderer/lib/cn'

/** A row of a list: a name and the line under it, at most. */
export const LIST_ROW_HEIGHT = 46

/** The headings' band: it stays as the list scrolls under it. */
export const listHead = 'sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur'
export const listHeadRow = 'grid h-9 items-center px-3 touch:h-11'
export const listHeadCell = 'group/head relative flex h-full min-w-0 items-center px-3'
const headWords = 'text-2xs font-medium tracking-wider whitespace-nowrap uppercase'
/** A heading that sorts: its words, and its arrow while it's what the list is sorted by. */
export const listHeadButton = (sorted: boolean) =>
  cn(
    'flex min-w-0 items-center gap-1',
    headWords,
    'transition-colors hover:text-ink-1 touch:finger touch:h-11',
    sorted ? 'text-ink-1' : 'text-ink-3',
  )
/** A heading that doesn't sort. */
export const listHeadWords = cn('flex min-w-0', headWords, 'text-ink-3')

/**
 * A row: under the pointer, picked, the one open and the keyboard's, each as the list's own.
 * (The list is `group/grid`.)
 */
export const listRow =
  'group/row grid cursor-default items-center border-b border-line px-3 transition-colors duration-75 hover:bg-surface-3/50 aria-selected:bg-accent-soft group-focus/grid:data-[active=true]:bg-surface-3/70 group-focus/grid:data-[active=true]:shadow-[inset_2px_0_0_var(--accent)] data-[picked=true]:bg-accent-soft/60'
/** A row's cell: what it can't fit is cut at its edge, never drawn over the next. */
export const listCell = 'flex min-w-0 items-center overflow-hidden px-3'
/** The room a row's cell keeps each side of what it holds (`listCell`'s px-3). */
export const LIST_CELL_SIDE = 12
/** The room each side of a row (`listRow`'s px-3). */
export const LIST_ROW_SIDE = 12

/** The list's bar, above it: its count, chips and filter. */
export const listBar = 'flex shrink-0 flex-col gap-2 border-b border-line px-5 py-3 touch:gap-4'
/** How many there are, at the start of the bar. */
export const listCount = 'mr-1 shrink-0 text-[13px] whitespace-nowrap text-ink-2 tabular-nums'
/** A chip of the bar: on, it's filled. */
export const listChip = (on: boolean) =>
  cn(
    'flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs whitespace-nowrap transition-colors touch:finger',
    on
      ? 'border-transparent bg-ink-1 text-surface'
      : 'border-line text-ink-2 hover:border-line-strong hover:text-ink-1',
  )
/** A chip's count, after its word. */
export const listChipCount = 'font-semibold tabular-nums'

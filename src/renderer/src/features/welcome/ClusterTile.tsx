import type { Health } from '@renderer/lib/health'
import { cn } from '@renderer/lib/cn'
import { HEALTH_STYLE } from '@renderer/components/Status'

/**
 * A cluster's tile: its letters in its color (one of the eight data colors), or gray with none,
 * and its status on the corner. In a row of a cmdk list, it steps with the row when selected.
 */
export function ClusterTile({
  letters,
  color,
  health,
  small,
  large,
}: {
  letters: string
  /** 1 to 8: `--series-n`. */
  color?: number
  /** None: no dot (a dialog's header). */
  health?: Health
  /** Recent's: one line, a smaller tile. */
  small?: boolean
  /** A dialog's header. */
  large?: boolean
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative grid shrink-0 place-items-center font-semibold',
        small
          ? 'size-6 rounded-[7px] text-[10px]'
          : large
            ? 'size-9 rounded-xl text-[13px]'
            : 'size-8 rounded-[9px] text-xs',
        !color &&
          'bg-surface-3 text-ink-2 ring-1 ring-line ring-inset group-data-[selected=true]:bg-surface-2',
      )}
      style={
        color
          ? {
              background: `color-mix(in srgb, var(--series-${color}) var(--tile-tint), transparent)`,
              color: `color-mix(in srgb, var(--series-${color}), var(--tile-ink))`,
            }
          : undefined
      }
    >
      {letters}
      {health && (
        <span
          className={cn(
            'absolute -right-[3px] -bottom-[3px] rounded-full border-2 border-surface-2 group-data-[selected=true]:border-surface-3',
            small ? 'size-2.5' : 'size-3',
            // Being checked: neutral, as everything under way is.
            health === 'progressing' ? 'animate-pulse-dot bg-neutral' : HEALTH_STYLE[health].dot,
          )}
        />
      )}
    </span>
  )
}

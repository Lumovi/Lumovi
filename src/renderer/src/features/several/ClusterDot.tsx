import { useClusterSettings } from '@renderer/hooks/settings'
import { cn } from '@renderer/lib/cn'

/** A cluster's colour (one of the eight data colors), or gray. */
export function ClusterDot({ context, className }: { context: string; className?: string }) {
  const color = useClusterSettings(context)?.color
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2.5 shrink-0 rounded-[3px]', className)}
      style={{ background: color ? `var(--series-${color})` : 'var(--ink-4, #9ca3af)' }}
    />
  )
}

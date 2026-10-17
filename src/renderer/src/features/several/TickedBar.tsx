import { X } from 'lucide-react'
import { Button } from '@renderer/components/Button'
import { cn } from '@renderer/lib/cn'

/**
 * The clusters ticked to open together: how many, how many of them sign in when opened, Open
 * together, and × to stop ticking. `className` places it (at the bottom of what it floats over).
 */
export function TickedBar({
  count,
  signIn,
  onOpen,
  onLeave,
  className,
}: {
  count: number
  signIn: number
  onOpen: () => void
  onLeave: () => void
  className?: string
}) {
  return (
    <div
      role="toolbar"
      aria-label="Clusters ticked"
      className={cn(
        'left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-line bg-surface py-1.5 pr-1.5 pl-3.5 text-[13px] shadow-panel',
        className,
      )}
    >
      <span className="font-medium whitespace-nowrap text-ink-1">
        {count === 1 ? '1 cluster' : `${count} clusters`}
      </span>
      {signIn > 0 && (
        <span className="whitespace-nowrap text-ink-3">{signIn} sign in when opened</span>
      )}
      <Button variant="primary" className="h-7 px-3 text-[13px]" onClick={onOpen}>
        Open together
      </Button>
      <button
        type="button"
        aria-label="Stop picking several clusters"
        onClick={onLeave}
        className="grid size-7 place-items-center rounded-lg text-ink-3 hover:bg-surface-3 hover:text-ink-1"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}

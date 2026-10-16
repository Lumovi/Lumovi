import { ArrowUpCircle } from 'lucide-react'
import { cn } from '@renderer/lib/cn'

/** "Update available: 2.5.0", in Lumovi's accent: a newer chart where the release came from. */
export function UpdatePill({ version, className }: { version: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-accent-soft px-2 text-xs font-medium whitespace-nowrap text-accent-strong',
        className,
      )}
    >
      <ArrowUpCircle className="size-3.5" />
      Update available: {version}
    </span>
  )
}

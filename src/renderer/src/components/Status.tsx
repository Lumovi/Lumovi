import {
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import type { Health, Status } from '@renderer/lib/health'
import { cn } from '@renderer/lib/cn'

export const HEALTH_STYLE: Record<
  Health,
  { dot: string; text: string; soft: string; icon: LucideIcon }
> = {
  healthy: {
    dot: 'bg-good',
    text: 'text-good-text',
    soft: 'bg-good/12',
    icon: CircleCheck,
  },
  // In progress is neutral, not blue (blue is for what can be acted on): it moves instead.
  progressing: {
    dot: 'bg-neutral',
    text: 'text-neutral-text',
    soft: 'bg-neutral/12',
    icon: CircleDashed,
  },
  warning: {
    dot: 'bg-warn',
    text: 'text-warn-text',
    soft: 'bg-warn/12',
    icon: TriangleAlert,
  },
  critical: {
    dot: 'bg-critical',
    text: 'text-critical-text',
    soft: 'bg-critical/12',
    icon: CircleX,
  },
  neutral: {
    dot: 'bg-neutral',
    text: 'text-neutral-text',
    soft: 'bg-neutral/12',
    icon: CircleMinus,
  },
}

export function StatusDot({ health, className }: { health: Health; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-2 shrink-0 rounded-full ring-2 ring-surface',
        HEALTH_STYLE[health].dot,
        health === 'progressing' && 'animate-pulse-dot',
        className,
      )}
    />
  )
}

/** Icon + label, so the status never relies on color alone. */
export function StatusPill({ status, className }: { status: Status; className?: string }) {
  const style = HEALTH_STYLE[status.health]
  const Icon = style.icon
  return (
    <span
      data-health={status.health}
      className={cn(
        'inline-flex h-[22px] max-w-full items-center gap-1 rounded-full pr-2 pl-1.5 text-xs font-medium',
        style.soft,
        style.text,
        className,
      )}
    >
      <Icon
        className={cn('size-3.5 shrink-0', status.health === 'progressing' && 'animate-turn')}
        strokeWidth={2.25}
      />
      <span className="truncate" title={status.label}>
        {status.label}
      </span>
    </span>
  )
}

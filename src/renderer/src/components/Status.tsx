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
    soft: 'bg-good/10',
    icon: CircleCheck,
  },
  progressing: {
    dot: 'bg-accent',
    text: 'text-accent-strong',
    soft: 'bg-accent-soft',
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
    soft: 'bg-critical/10',
    icon: CircleX,
  },
  neutral: {
    dot: 'bg-neutral',
    text: 'text-ink-2',
    soft: 'bg-surface-3',
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
      <Icon className="size-3.5 shrink-0" strokeWidth={2.25} />
      <span className="truncate">{status.label}</span>
    </span>
  )
}

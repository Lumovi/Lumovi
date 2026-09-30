import { cn } from '@renderer/lib/cn'
import { percent } from '@renderer/lib/format'

type Severity = 'normal' | 'good' | 'warn' | 'critical'

const FILL: Record<Severity, string> = {
  normal: 'bg-accent',
  good: 'bg-good',
  warn: 'bg-warn',
  critical: 'bg-critical',
}
const TRACK: Record<Severity, string> = {
  normal: 'bg-accent-track',
  good: 'bg-good/20',
  warn: 'bg-warn/20',
  critical: 'bg-critical/20',
}

export function severity(ratio: number): Severity {
  if (ratio >= 0.9) return 'critical'
  return ratio >= 0.75 ? 'warn' : 'normal'
}

/** For progress toward a goal, like ready replicas: full is good. */
function readiness(ratio: number): Severity {
  if (ratio >= 1) return 'good'
  return ratio > 0 ? 'warn' : 'critical'
}

/**
 * A ratio against a limit. The fill carries severity and the track is a light
 * step of the same hue, so the state reads across the whole bar. An optional
 * marker shows a second ratio (e.g. requests) as a tick.
 */
export function Meter({
  value,
  label,
  marker,
  className,
  variant = 'usage',
}: {
  value: number
  label: string
  marker?: { value: number; label: string }
  className?: string
  /** `usage` warns as it fills up; `readiness` is good when full. */
  variant?: 'usage' | 'readiness'
}) {
  const level = variant === 'usage' ? severity(value) : readiness(value)
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      aria-valuetext={percent(value)}
      data-severity={level}
      className={cn('relative h-1.5 w-full rounded-full', TRACK[level], className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500 ease-out', FILL[level])}
        style={{ width: `${Math.min(100, value * 100)}%` }}
      />
      {marker && (
        <div
          title={marker.label}
          aria-label={marker.label}
          className="absolute -top-1 -bottom-1 w-0.5 rounded-full bg-ink-1/70 ring-2 ring-surface-2"
          style={{ left: `calc(${Math.min(100, marker.value * 100)}% - 1px)` }}
        />
      )}
    </div>
  )
}

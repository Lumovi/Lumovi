import { cn } from '@renderer/lib/cn'
import { percent } from '@renderer/lib/format'

type Severity = 'normal' | 'good' | 'warn' | 'critical'

const FILL: Record<Severity, string> = {
  normal: 'bg-series-1',
  good: 'bg-good',
  warn: 'bg-warn',
  critical: 'bg-critical',
}
const TRACK: Record<Severity, string> = {
  normal: 'bg-series-1/20',
  good: 'bg-good/20',
  warn: 'bg-warn/20',
  critical: 'bg-critical/20',
}

export function severity(ratio: number): Severity {
  if (ratio >= 0.9) return 'critical'
  return ratio >= 0.75 ? 'warn' : 'normal'
}

/**
 * A quota's: nothing to say until it's nearly full (90%), and critical once full. By its % floored,
 * as it's written: 99.6% is 99%, still nearly full.
 */
function quotaLevel(ratio: number): Severity {
  const floored = Math.floor(ratio * 100 + 1e-9)
  if (floored >= 100) return 'critical'
  return floored >= 90 ? 'warn' : 'normal'
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
  /**
   * `usage` warns as it fills up; `readiness` is good when full; `quota` says nothing until it's
   * nearly full, its % floored (spoken as it's written, the real one past 100).
   */
  variant?: 'usage' | 'readiness' | 'quota'
}) {
  const level =
    variant === 'usage'
      ? severity(value)
      : variant === 'quota'
        ? quotaLevel(value)
        : readiness(value)
  const floored = Math.floor(value * 100 + 1e-9)
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={variant === 'quota' ? Math.min(100, floored) : Math.round(value * 100)}
      aria-valuetext={variant === 'quota' ? `${floored}%` : percent(value)}
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

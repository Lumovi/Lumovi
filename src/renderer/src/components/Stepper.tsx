import { Minus, Plus } from 'lucide-react'
import { cn } from '@renderer/lib/cn'

/**
 * A whole-number field with − and + buttons. The arrow keys step it too, and
 * it never goes below `min` or above `max`.
 */
export function Stepper({
  label,
  value,
  onChange,
  min = 0,
  max = 1_000,
  size = 'md',
  autoFocus,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  size?: 'md' | 'lg'
  autoFocus?: boolean
}) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next))
  // An emptied field counts as the minimum for stepping.
  const base = Number.isNaN(value) ? min : value
  const button =
    'grid shrink-0 place-items-center rounded-lg border border-line-strong bg-surface text-ink-2 shadow-xs transition-colors hover:bg-surface-3 hover:text-ink-1 disabled:opacity-40 disabled:hover:bg-surface'
  const large = size === 'lg'
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        aria-label={`Decrease ${label.toLowerCase()}`}
        disabled={base <= min}
        onClick={() => onChange(clamp(base - 1))}
        className={cn(button, large ? 'size-10' : 'size-8')}
      >
        <Minus className="size-4" />
      </button>
      <input
        aria-label={label}
        inputMode="numeric"
        autoFocus={autoFocus}
        value={Number.isNaN(value) ? '' : value}
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, '')
          onChange(digits === '' ? Number.NaN : clamp(Number(digits)))
        }}
        onKeyDown={(event) => {
          const step = { ArrowUp: 1, ArrowDown: -1 }[event.key]
          if (step) {
            event.preventDefault()
            onChange(clamp(base + step))
          }
        }}
        onFocus={(event) => event.currentTarget.select()}
        className={cn(
          'rounded-lg border border-line-strong bg-surface text-center font-semibold text-ink-1 tabular-nums outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft',
          large ? 'h-12 w-24 text-2xl' : 'h-8 w-16 text-[13px]',
        )}
      />
      <button
        type="button"
        aria-label={`Increase ${label.toLowerCase()}`}
        disabled={base >= max}
        onClick={() => onChange(clamp(base + 1))}
        className={cn(button, large ? 'size-10' : 'size-8')}
      >
        <Plus className="size-4" />
      </button>
    </div>
  )
}

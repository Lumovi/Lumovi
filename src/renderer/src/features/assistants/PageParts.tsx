/** What the AI assistants page's tabs are made of: cards, and choices of one of a few. */
import type { HTMLAttributes } from 'react'
import { cn } from '@renderer/lib/cn'

/** A white card on the page's gray, as the page's sections are. */
export function Card({
  as: Tag = 'div',
  className,
  ...props
}: { as?: 'div' | 'section' | 'article' } & HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn('overflow-hidden rounded-xl border border-line bg-surface', className)}
      {...props}
    />
  )
}

export interface Choice<T> {
  value: T
  label: string
  /** Looser than most would want: shown in the warning's color once chosen. */
  warn?: boolean
}

/** One of a few, side by side: the chosen one raised (a group of toggles, for assistive tech). */
export function Segmented<T>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string
  value: T
  choices: Choice<T>[]
  onChange: (value: T) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex flex-wrap gap-0.5 rounded-lg bg-surface-3 p-0.5"
    >
      {choices.map((choice) => {
        const chosen = choice.value === value
        return (
          <button
            key={choice.label}
            type="button"
            aria-pressed={chosen}
            onClick={() => onChange(choice.value)}
            className={cn(
              'h-7 rounded-md px-2.5 text-xs whitespace-nowrap transition-colors',
              chosen
                ? 'bg-surface font-semibold text-ink-1 shadow-xs ring-1 ring-line'
                : 'font-medium text-ink-2 hover:text-ink-1',
              chosen && choice.warn && 'text-warn-text',
            )}
          >
            {choice.label}
          </button>
        )
      })}
    </div>
  )
}

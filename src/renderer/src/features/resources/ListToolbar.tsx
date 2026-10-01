import { Tag } from 'lucide-react'
import { useState, type Ref } from 'react'
import { HEALTH_STYLE } from '@renderer/components/Status'
import { cn } from '@renderer/lib/cn'
import { HEALTH_RANK, type Health } from '@renderer/lib/health'

const HEALTH_ORDER = (Object.keys(HEALTH_RANK) as Health[]).sort(
  (a, b) => HEALTH_RANK[a] - HEALTH_RANK[b],
)

/** A filter chip per health level a list has, most urgent first, with how many are at it. */
export function HealthChips({
  counts,
  active,
  onToggle,
  name,
}: {
  counts: Map<Health, number>
  active: Health[]
  onToggle: (health: Health) => void
  /** What the level is called in this list ("Running", "Deployed"…). */
  name: (health: Health) => string
}) {
  return HEALTH_ORDER.filter((h) => counts.has(h)).map((health) => {
    const on = active.includes(health)
    return (
      <button
        key={health}
        type="button"
        aria-pressed={on}
        onClick={() => onToggle(health)}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors',
          on
            ? 'border-transparent bg-ink-1 text-surface'
            : 'border-line text-ink-2 hover:border-line-strong hover:text-ink-1',
        )}
      >
        <span aria-hidden className={cn('size-1.5 rounded-full', HEALTH_STYLE[health].dot)} />
        {name(health)}
        <span className="font-semibold tabular-nums">{counts.get(health)}</span>
      </button>
    )
  })
}

/** A server-side label selector, applied with Enter. */
export function LabelSelector({
  value,
  onApply,
  ref,
}: {
  value: string
  onApply: (labels: string) => void
  ref?: Ref<HTMLInputElement>
}) {
  const [draft, setDraft] = useState(value)
  return (
    <label
      className={cn(
        'flex h-8 w-52 items-center gap-2 rounded-lg border bg-surface px-2.5 text-ink-3 transition-colors no-drag focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft',
        value ? 'border-accent/60' : 'border-line',
      )}
    >
      <Tag className="size-3.5 shrink-0" />
      <input
        ref={ref}
        aria-label="Label selector"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onApply(draft.trim())
        }}
        onBlur={() => setDraft(value)}
        placeholder="Label selector, e.g. app=web"
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent font-mono text-xs text-ink-1 outline-none placeholder:font-sans placeholder:text-[13px] placeholder:text-ink-3"
      />
    </label>
  )
}

/** Counts items by a key of theirs (a health level, a namespace…). */
export function countBy<T, K>(items: T[], key: (item: T) => K): Map<K, number> {
  const counts = new Map<K, number>()
  for (const item of items) {
    const k = key(item)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return counts
}

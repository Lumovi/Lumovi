import { cn } from '@renderer/lib/cn'

/** How much of a name's end always shows: what tells one pod of a ReplicaSet from the next. */
export const KEPT_END = 6

/** A name's two parts: what gives way where there's no room, and the end that stays. */
export function middleParts(text: string, end = KEPT_END): [start: string, end: string] {
  if (text.length <= end) return [text, '']
  return [text.slice(0, -end), text.slice(-end)]
}

/**
 * A name on one line that's cut in its middle where it doesn't fit, keeping its last characters:
 * `payments-worker-7c8d9…-tuvwx` stays apart from `payments-worker-7c8d9…-yzabc`. All of it is
 * there for a screen reader, for copying, and in its title.
 */
export function MiddleTruncate({ text, className }: { text: string; className?: string }) {
  const [start, end] = middleParts(text)
  return (
    <span title={text} className={cn('flex min-w-0 whitespace-nowrap', className)}>
      <span className="min-w-0 truncate">{start}</span>
      {end && <span className="shrink-0 whitespace-pre">{end}</span>}
    </span>
  )
}

import { LoaderCircle } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'
import { buttonClass } from './Button'
import { Tooltip } from './Tooltip'

/** A duration as Lumovi says one: 42s, 1m 05s, 12m 30s, 1h 02m. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const two = (n: number) => String(n).padStart(2, '0')
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${two(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h ${two(minutes % 60)}m`
}

/** The same, as it's spoken: "1 minute 5 seconds". */
export function spokenElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const [h, m, s] = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
  if (h > 0) return [unit(h, 'hour'), m > 0 && unit(m, 'minute')].filter(Boolean).join(' ')
  if (m > 0) return [unit(m, 'minute'), s > 0 && unit(s, 'second')].filter(Boolean).join(' ')
  return unit(s, 'second')
}

/** The time now, again each second while `on`: for what counts how long something has run. */
export function useTicking(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

/**
 * What an action that's at work is drawn as, where the action was: Lumovi's turning mark, the
 * word for what's happening and, where it's known, how long. It can't be pressed; the keyboard
 * reaches it, and it says what it's busy with, in Lumovi's words.
 */
export function BusyButton({
  name,
  word,
  since,
  timed = true,
  className,
  children,
}: {
  /** The action's own name: "Sync". */
  name: string
  word: string
  /** When what it's busy with started, where that's known. */
  since?: number
  /** Whether it says how long itself (not where a status beside it does). */
  timed?: boolean
  className?: string
  /** The word as it's drawn, where it's another's (a plugin's, in pieces). */
  children?: ReactNode
}) {
  const now = useTicking(since !== undefined)
  const elapsed = since === undefined ? undefined : now - since
  const doing = word.toLowerCase()
  const said =
    elapsed === undefined
      ? `${word}. ${name} can be pressed again when it’s done.`
      : `${word} for ${formatElapsed(elapsed)}. ${name} can be pressed again when it’s done.`
  return (
    <Tooltip content={said}>
      <button
        type="button"
        aria-disabled="true"
        aria-label={`${name}, busy: ${doing}${elapsed === undefined ? '' : `, ${spokenElapsed(elapsed)}`}`}
        data-busy=""
        onClick={(event) => event.preventDefault()}
        className={cn(
          buttonClass('secondary'),
          'cursor-default text-ink-2 shadow-none hover:bg-surface-2 active:translate-y-0',
          className,
        )}
      >
        <LoaderCircle aria-hidden className="animate-spin text-ink-3" />
        <span>{children ?? word}</span>
        {timed && elapsed !== undefined && (
          <span className="text-ink-3 tabular-nums">{formatElapsed(elapsed)}</span>
        )}
      </button>
    </Tooltip>
  )
}

/** How long since `since`, counted each second, as Lumovi says a duration. */
export function Elapsed({ since }: { since: number }) {
  const now = useTicking(true)
  return <>{formatElapsed(now - since)}</>
}

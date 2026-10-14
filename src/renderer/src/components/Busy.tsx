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

/**
 * The same, as it's spoken, in whole minutes: "1 minute", "less than a minute". (A name that
 * changed every second would be said every second to whoever has it in focus: the seconds are on
 * screen and in the tooltip.)
 */
export function spokenElapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const [h, m] = [Math.floor(minutes / 60), minutes % 60]
  if (h > 0) return [unit(h, 'hour'), m > 0 && unit(m, 'minute')].filter(Boolean).join(' ')
  return m > 0 ? unit(m, 'minute') : 'less than a minute'
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
  focusKey,
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
  /**
   * Which button it stands in for, as that one says it (`data-focus-key`): where a dialog opened
   * from that one closes, the keyboard comes here (lib/focus-back.ts).
   */
  focusKey?: string
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
        {...(focusKey === undefined ? {} : { 'data-focus-key': focusKey })}
        // (Its tooltip on focus only where the focus shows, from the keyboard: given it after a
        // pointer's press, it says nothing the button doesn't, over what wasn't pointed at.)
        onFocus={(event) => {
          if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
        }}
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

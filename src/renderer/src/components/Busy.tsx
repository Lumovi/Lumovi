import { LoaderCircle } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'
import { formatElapsed, spokenElapsed } from '@renderer/lib/elapsed'
import { buttonClass } from './Button'
import { Tooltip } from './Tooltip'

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

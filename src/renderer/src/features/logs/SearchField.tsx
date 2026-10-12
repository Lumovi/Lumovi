/**
 * The Logs view's search: the text, and inside the field how many it found, up and down between
 * matches, and three toggles: a regular expression, match case, and the lines without a match. Their
 * keys work with the focus in the field, where a layout doesn't type a letter with them.
 */
import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  CircleMinus,
  Regex,
  Search,
  type LucideIcon,
} from 'lucide-react'
import { useState, type KeyboardEvent } from 'react'
import { Tooltip } from '@renderer/components/Tooltip'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import type { LogQuery } from '@renderer/lib/log-search'

type Toggled = 'regex' | 'matchCase' | 'exclude'

/** Each toggle: its words, its icon, its key, and what that key types on a US Mac with ⌥. */
const TOGGLES: Record<
  Toggled,
  { label: string; icon: LucideIcon; code: string; letter: string; mac: string }
> = {
  regex: { label: 'Regular expression', icon: Regex, code: 'KeyR', letter: 'R', mac: '®' },
  matchCase: { label: 'Match case', icon: CaseSensitive, code: 'KeyC', letter: 'C', mac: 'ç' },
  exclude: {
    label: 'Show lines without a match',
    icon: CircleMinus,
    code: 'KeyX',
    letter: 'X',
    mac: '≈',
  },
}

/** The keys that type a letter here, rather than turn a toggle: their tooltips don't name them. */
const typing = new Set<Toggled>()

/**
 * The toggle a key press turns, if any: Option (Alt) and its letter, with nothing else held, where
 * it would type only the letter (Alt off a Mac types nothing) or what it does on a US Mac. Where a
 * layout types another letter with it (ć, ź), it's that letter's: it types it, as always.
 * (AltGr comes with Ctrl held, so it never turns one.)
 */
export function toggleOf(
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'code' | 'key'>,
): Toggled | undefined {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined
  const found = (Object.keys(TOGGLES) as Toggled[]).find((t) => TOGGLES[t].code === event.code)
  if (!found) return undefined
  const { letter, mac } = TOGGLES[found]
  if (event.key.toUpperCase() === letter || event.key === mac) return found
  typing.add(found)
  return undefined
}

const keyName = (t: Toggled) => `${api.platform === 'darwin' ? '⌥' : 'Alt+'}${TOGGLES[t].letter}`

/** How many the search found: matches, and which is current; or, without, how many lines. */
export type Count = { current: number; total: number } | { lines: number }

/** What the count says. */
export function countSaid(count: Count): string {
  if ('lines' in count)
    return `${count.lines.toLocaleString()} ${count.lines === 1 ? 'line' : 'lines'}`
  if (count.total === 0) return 'No matches'
  // (None is current until the person steps to one.)
  if (count.current < 0)
    return `${count.total.toLocaleString()} ${count.total === 1 ? 'match' : 'matches'}`
  return `${(count.current + 1).toLocaleString()} of ${count.total.toLocaleString()}`
}

function FieldToggle({
  toggled,
  query,
  onQuery,
  big = false,
}: {
  toggled: Toggled
  query: LogQuery
  onQuery: (query: LogQuery) => void
  big?: boolean
}) {
  const { label, icon: Icon } = TOGGLES[toggled]
  return (
    <Tooltip content={typing.has(toggled) ? label : `${label} ${keyName(toggled)}`}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={query[toggled]}
        onClick={() => onQuery({ ...query, [toggled]: !query[toggled] })}
        className={cn(
          'grid shrink-0 place-items-center rounded text-ink-3 transition-colors hover:text-ink-1 aria-pressed:bg-accent-soft aria-pressed:text-accent aria-pressed:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_40%,transparent)]',
          big
            ? 'size-11 rounded-lg [&_svg]:size-5'
            : 'size-[22px] touch:size-11 touch:rounded-lg [&_svg]:size-3.5 touch:[&_svg]:size-5',
        )}
      >
        <Icon />
      </button>
    </Tooltip>
  )
}

/** The count, and up and down between matches (none when nothing shown matches). */
function Steps({
  count,
  stale,
  onStep,
  big = false,
}: {
  count: Count | undefined
  stale: boolean
  onStep: (by: 1 | -1) => void
  big?: boolean
}) {
  if (!count) return null
  const stepping = !('lines' in count) && count.total > 0
  const step = (by: 1 | -1, label: string, key: string, Icon: LucideIcon) => (
    <Tooltip content={`${label} ${key}`}>
      <button
        type="button"
        aria-label={label}
        onClick={() => onStep(by)}
        className={cn(
          'grid shrink-0 place-items-center rounded text-ink-3 hover:text-ink-1',
          big
            ? 'size-11 rounded-lg [&_svg]:size-5'
            : 'size-[22px] touch:size-11 touch:rounded-lg [&_svg]:size-3.5 touch:[&_svg]:size-5',
        )}
      >
        <Icon />
      </button>
    </Tooltip>
  )
  return (
    <>
      <span
        aria-live="polite"
        className={cn(
          'shrink-0 px-0.5 text-[11.5px] whitespace-nowrap text-ink-3 tabular-nums',
          stale && 'opacity-55',
        )}
      >
        {countSaid(count)}
      </span>
      {stepping && step(-1, 'Previous match', '⇧↵', ChevronUp)}
      {stepping && step(1, 'Next match', '↵', ChevronDown)}
    </>
  )
}

/** The three toggles, as the phone's third row draws them (and the field's end, elsewhere). */
export function SearchToggles(props: {
  query: LogQuery
  onQuery: (query: LogQuery) => void
  big?: boolean
}) {
  return (
    <>
      <FieldToggle toggled="regex" {...props} />
      <FieldToggle toggled="matchCase" {...props} />
      <FieldToggle toggled="exclude" {...props} />
    </>
  )
}

export { Steps as SearchSteps }

export function SearchField({
  query,
  onQuery,
  count,
  stale,
  trouble,
  onStep,
  phone = false,
  onFocusChange,
}: {
  query: LogQuery
  onQuery: (query: LogQuery) => void
  count: Count | undefined
  /** The count is the last search's that worked, not this one's. */
  stale: boolean
  /** What's typed can't be used: not an expression, or too slow. */
  trouble?: 'bad' | 'slow'
  onStep: (by: 1 | -1) => void
  /** A phone: the toggles, the count and the steps are a row of their own under the field. */
  phone?: boolean
  onFocusChange?: (focused: boolean) => void
}) {
  // (Redrawn when a key turns out to type a letter here, so its tooltip stops naming it.)
  const [, setTyped] = useState(0)
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      // Clear the text, not the toggles; and not close the panel.
      event.stopPropagation()
      onQuery({ ...query, text: '' })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      onStep(event.shiftKey ? -1 : 1)
      return
    }
    const known = typing.size
    const toggled = toggleOf(event)
    if (toggled) {
      event.preventDefault()
      onQuery({ ...query, [toggled]: !query[toggled] })
    } else if (typing.size !== known) setTyped((n) => n + 1)
  }
  return (
    <label
      className={cn(
        'flex flex-1 items-center gap-1 border bg-surface focus-within:border-accent',
        // (Never narrower than what's in it: the toolbar's other parts give way first.)
        phone ? 'mr-1 h-11 min-w-0 rounded-lg px-3' : 'h-7 rounded-md pr-0.5 pl-2 touch:h-11',
        trouble === 'bad' &&
          'border-critical shadow-[0_0_0_1px_var(--critical)] focus-within:border-critical',
        trouble === 'slow' && 'border-warn shadow-[0_0_0_1px_var(--warn)] focus-within:border-warn',
        !trouble && 'border-line',
      )}
    >
      <Search className={cn('shrink-0 text-ink-3', phone ? 'size-4' : 'size-3.5')} />
      {query.exclude && (
        <span className="shrink-0 rounded bg-surface-3 px-1.5 text-[11px] leading-[18px] font-medium text-ink-1">
          Without
        </span>
      )}
      <input
        aria-label="Search logs"
        aria-invalid={trouble === 'bad' || undefined}
        value={query.text}
        onChange={(event) => onQuery({ ...query, text: event.target.value })}
        onKeyDown={keyDown}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        placeholder="Search"
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        className={cn(
          'min-w-16 flex-1 bg-transparent text-ink-1 outline-none placeholder:font-sans placeholder:text-ink-3',
          query.text && 'font-mono',
          phone ? 'text-[13px]' : 'text-xs',
        )}
      />
      {!phone && (
        <>
          <Steps count={count} stale={stale} onStep={onStep} />
          <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-line" />
          <SearchToggles query={query} onQuery={onQuery} />
        </>
      )}
    </label>
  )
}

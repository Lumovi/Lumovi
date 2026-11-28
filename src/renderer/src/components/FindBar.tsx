/**
 * The find bar (LMV-404): one for YAML, diffs and editors alike. What it looks for, how many it
 * found and which is current, up and down between them, the logs' toggles (match case, a regular
 * expression), and, in an editor that can be changed, what to replace them with. Whoever holds it
 * finds: `Findable` in what's drawn, an editor in its document.
 */
import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Regex,
  Search,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { KeyboardEvent, Ref } from 'react'
import { toggleOf } from '@renderer/features/logs/SearchField'
import { cn } from '@renderer/lib/cn'
import { useLayout } from '@renderer/lib/layout'
import { MOST_FOUND, type FindControl, type FindQuery } from '@renderer/lib/find'
import { MAC, useKeys } from '@renderer/lib/shortcuts'
import { Button, IconButton } from './Button'
import { Tooltip } from './Tooltip'

/** What the count says: "3 of 12"; before a step, how many; "No matches". */
export function foundSaid({ at, total }: { at: number; total: number }): string {
  if (total === 0) return 'No matches'
  const all = `${total.toLocaleString()}${total >= MOST_FOUND ? '+' : ''}`
  // (None is current until the person steps to one, as in the logs.)
  if (at < 0) return `${all} ${total === 1 ? 'match' : 'matches'}`
  return `${(at + 1).toLocaleString()} of ${all}`
}

const STEP_KEYS = MAC
  ? { next: '↵ or ⌘G', previous: '⇧↵ or ⇧⌘G' }
  : { next: '↵ or F3', previous: '⇧↵ or ⇧F3' }

/** The keys a person steps with in an app's find: Enter, and ⌘G (F3 off a Mac). */
function stepOf(event: KeyboardEvent): 1 | -1 | undefined {
  if (event.key === 'Enter' && !event.altKey && !event.metaKey && !event.ctrlKey) {
    return event.shiftKey ? -1 : 1
  }
  const g = MAC
    ? event.metaKey && !event.ctrlKey && !event.altKey && event.code === 'KeyG'
    : event.key === 'F3' && !event.ctrlKey && !event.altKey && !event.metaKey
  return g ? (event.shiftKey ? -1 : 1) : undefined
}

type Toggled = 'matchCase' | 'regex'

const TOGGLES: Record<Toggled, { label: string; icon: LucideIcon; key: string }> = {
  matchCase: { label: 'Match case', icon: CaseSensitive, key: 'C' },
  regex: { label: 'Regular expression', icon: Regex, key: 'R' },
}

export function FindBar({
  label,
  query,
  onQuery,
  found,
  problem,
  onStep,
  onClose,
  replace,
  framed = true,
  stickAt,
  fieldRef,
  fieldProps,
  id,
}: {
  /** What's searched: "YAML", "Changes". */
  label: string
  query: FindQuery
  onQuery: (query: FindQuery) => void
  /** How many it found, and which is current (-1 before a step); none while nothing's typed. */
  found: { at: number; total: number } | undefined
  /** Why what's typed can't be looked for. */
  problem?: string
  onStep: (by: 1 | -1) => void
  onClose: () => void
  /** An editor that can be changed: what replaces a match, and the two ways to. */
  replace?: {
    text: string
    onText: (text: string) => void
    onReplace: () => void
    onReplaceAll: () => void
  }
  /** Its own ground and edge (an editor's panel has them already). */
  framed?: boolean
  /** It stays this far (px) from the top of what scrolls round it. */
  stickAt?: number
  fieldRef?: Ref<HTMLInputElement>
  /** More for the field: an editor's mark for the field it puts the keyboard in. */
  fieldProps?: Record<string, string>
  /** For the button that opens it (its toolbar's Find). */
  id?: string
}) {
  const toggle = (toggled: Toggled) => onQuery({ ...query, [toggled]: !query[toggled] })
  const keyDown = (event: KeyboardEvent<HTMLInputElement>, field: 'find' | 'replace') => {
    if (event.key === 'Escape') {
      // (Its own: not the panel's or the dialog's round it.)
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (field === 'replace' && event.key === 'Enter' && replace) {
      event.preventDefault()
      replace.onReplace()
      return
    }
    const by = stepOf(event)
    if (by) {
      event.preventDefault()
      onStep(by)
      return
    }
    const toggled = toggleOf(event)
    if (toggled === 'matchCase' || toggled === 'regex') {
      event.preventDefault()
      toggle(toggled)
    }
  }
  const none = !found || found.total === 0
  const altKey = MAC ? '⌥' : 'Alt+'
  // A phone's bar is the whole width: the field and its close, then a row of the toggles and the
  // steps (as the logs' search has them there).
  const phone = useLayout() === 'phone'
  const toggles = (['matchCase', 'regex'] as const).map((toggled) => {
    const { label, icon: Icon, key } = TOGGLES[toggled]
    return (
      <Tooltip key={toggled} content={`${label} ${altKey}${key}`}>
        <button
          type="button"
          aria-label={label}
          aria-pressed={query[toggled]}
          onClick={() => toggle(toggled)}
          className="grid size-[22px] shrink-0 place-items-center rounded text-ink-3 transition-colors hover:text-ink-1 aria-pressed:bg-accent-soft aria-pressed:text-accent aria-pressed:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_40%,transparent)] phone:size-11 phone:rounded-lg touch:size-11 touch:rounded-lg [&_svg]:size-3.5 phone:[&_svg]:size-5 touch:[&_svg]:size-5"
        >
          <Icon />
        </button>
      </Tooltip>
    )
  })
  const steps = (
    <>
      <IconButton
        label="Previous match"
        tip={`Previous match ${STEP_KEYS.previous}`}
        disabled={none}
        onClick={() => onStep(-1)}
        className="size-7 disabled:opacity-40 phone:size-11 [&_svg]:size-3.5 phone:[&_svg]:size-5"
      >
        <ChevronUp />
      </IconButton>
      <IconButton
        label="Next match"
        tip={`Next match ${STEP_KEYS.next}`}
        disabled={none}
        onClick={() => onStep(1)}
        className="size-7 disabled:opacity-40 phone:size-11 [&_svg]:size-3.5 phone:[&_svg]:size-5"
      >
        <ChevronDown />
      </IconButton>
    </>
  )
  return (
    <div
      id={id}
      data-find-bar=""
      role="search"
      aria-label={`Find in ${label}`}
      className={cn(
        // (Its sides as the toolbar's above it: their boxes and buttons line up.)
        'flex shrink-0 flex-col gap-1.5 px-5 py-1.5 font-sans phone:px-4',
        framed && 'border-b border-line bg-surface-2',
        stickAt !== undefined && 'sticky z-10',
      )}
      style={stickAt !== undefined ? { top: stickAt } : undefined}
    >
      <div className="flex items-center gap-1.5">
        <label
          className={cn(
            'flex h-7 max-w-96 min-w-0 flex-1 items-center gap-1 rounded-md border bg-surface pr-0.5 pl-2 focus-within:border-accent phone:h-11 phone:max-w-none phone:rounded-lg phone:px-3 touch:h-11',
            problem
              ? 'border-critical shadow-[0_0_0_1px_var(--critical)] focus-within:border-critical'
              : 'border-line',
          )}
        >
          <Search className="size-3.5 shrink-0 text-ink-3 phone:size-4" />
          <input
            ref={fieldRef}
            {...fieldProps}
            aria-label={`Find in ${label}`}
            aria-invalid={problem ? true : undefined}
            value={query.text}
            onChange={(event) => onQuery({ ...query, text: event.target.value })}
            onKeyDown={(event) => keyDown(event, 'find')}
            placeholder="Find"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className={cn(
              'min-w-16 flex-1 bg-transparent text-xs text-ink-1 outline-none placeholder:font-sans placeholder:text-ink-3 phone:text-[13px]',
              query.text && 'font-mono',
            )}
          />
          {found && !problem && (
            <span
              aria-live="polite"
              className="shrink-0 px-0.5 text-[11.5px] whitespace-nowrap text-ink-3 tabular-nums"
            >
              {foundSaid(found)}
            </span>
          )}
          {!phone && (
            <>
              <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-line" />
              {toggles}
            </>
          )}
        </label>
        {!phone && steps}
        <IconButton
          label="Close find"
          tip="Close find Esc"
          onClick={onClose}
          className="ml-auto size-7 phone:size-11 [&_svg]:size-3.5 phone:[&_svg]:size-5"
        >
          <X />
        </IconButton>
      </div>
      {phone && (
        // (Pressing here keeps the field's focus, and the keyboard up.)
        <div className="flex items-center gap-1" onPointerDown={(event) => event.preventDefault()}>
          {toggles}
          <span className="flex-1" />
          {steps}
        </div>
      )}
      {replace && (
        <div className="flex items-center gap-1.5">
          <label className="flex h-7 max-w-96 min-w-0 flex-1 items-center rounded-md border border-line bg-surface px-2 focus-within:border-accent touch:h-11">
            <input
              aria-label="Replace with"
              value={replace.text}
              onChange={(event) => replace.onText(event.target.value)}
              onKeyDown={(event) => keyDown(event, 'replace')}
              placeholder="Replace with"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className={cn(
                'min-w-16 flex-1 bg-transparent text-xs text-ink-1 outline-none placeholder:font-sans placeholder:text-ink-3 phone:text-[13px]',
                replace.text && 'font-mono',
              )}
            />
          </label>
          <Button variant="ghost" disabled={none} onClick={replace.onReplace}>
            Replace
          </Button>
          <Button variant="ghost" disabled={none} onClick={replace.onReplaceAll}>
            Replace all
          </Button>
        </div>
      )}
      {problem && (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-critical-text">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{problem}</span>
        </p>
      )}
    </div>
  )
}

/**
 * A toolbar's Find, over YAML or a diff: opens its view's bar, or (pressed) closes it. With a
 * mouse or a finger it's the way in; its tooltip says the key.
 */
export function FindButton({ control }: { control: FindControl }) {
  const keys = useKeys()
  const key = keys.text('find')
  return (
    <IconButton
      label="Find"
      tip={key ? `Find ${key}` : 'Find'}
      aria-expanded={control.open}
      aria-controls={control.open ? control.barId : undefined}
      data-state={control.open ? 'open' : 'closed'}
      onClick={(event) => control.press(event.currentTarget)}
      className="phone:size-11 phone:[&_svg]:size-5"
    >
      <Search />
    </IconButton>
  )
}

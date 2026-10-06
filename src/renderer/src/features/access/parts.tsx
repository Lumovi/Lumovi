/**
 * What the Access pages are made of: their frame (header, title, tabs), notes,
 * chips, and a field of chips that suggests what to add as it's typed.
 */
import { ChevronDown, Info, Lock, TriangleAlert, X } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { cn } from '@renderer/lib/cn'
import { useSession } from '@renderer/state/session'
import { Commands } from '../shell/Commands'
import { PageHeader } from '../shell/PageHeader'
import { plural } from './access-model'
import { useClusters } from './use-access'

export interface FrameTab {
  path: string
  label: string
  count?: number
}

/** A page of its own: where it is (and who), its title, and its tabs. */
export function Frame({
  title,
  subtitle,
  intro,
  tabs,
  current,
  base,
  children,
  footer,
}: {
  title: string
  subtitle: string
  intro: ReactNode
  tabs?: FrameTab[]
  current?: string
  /** Where the tabs are: /access. */
  base?: string
  children: ReactNode
  /** Kept at the bottom of the page: what isn't saved yet. */
  footer?: ReactNode
}) {
  // (A server's pages: someone is signed in.)
  const session = useSession()!
  const clusters = useClusters()
  return (
    <div className="vt-page flex h-full flex-col overflow-hidden bg-app">
      <PageHeader
        scope={session.fleet ? 'Fleet' : session.cluster!}
        scopeLine={session.fleet ? plural(clusters.length, 'cluster', 'clusters') : undefined}
        end={
          <span className="flex min-w-0 items-center gap-2 text-xs text-ink-2">
            <Initial name={session.user.name} className="size-6 text-[11px]" />
            <span className="truncate">{session.user.name}</span>
          </span>
        }
      />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1240px] px-5 pt-8 pb-24">
          <div className="flex flex-wrap items-start gap-4">
            <h1 className="flex-[1_1_420px] text-[28px] leading-[1.15] headline text-ink-1">
              <span className="block">{title}</span>
              <span className="block text-ink-3">{subtitle}</span>
            </h1>
            <div className="flex max-w-[520px] flex-[1_1_360px] flex-col gap-2 pt-0.5 text-[13px] text-ink-2">
              {intro}
            </div>
          </div>
          {tabs && (
            <nav aria-label={title} className="mt-6 flex flex-wrap gap-5 border-b border-line">
              {tabs.map(({ path, label, count }) => (
                <Link
                  key={path}
                  to={`${base}/${path}`}
                  replace
                  aria-current={path === current ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-1.5 py-2.5 text-[13px] transition-colors',
                    path === current
                      ? 'font-semibold text-ink-1 shadow-[inset_0_-2px_0_var(--color-ink-1)]'
                      : 'text-ink-2 hover:text-ink-1',
                  )}
                >
                  {label}
                  {count !== undefined && (
                    <span className="rounded-full bg-surface-3 px-1.5 text-2xs text-ink-2 tabular-nums">
                      {count}
                    </span>
                  )}
                </Link>
              ))}
            </nav>
          )}
          <div className="mt-6">{children}</div>
        </div>
      </main>
      {footer}
      <Commands />
    </div>
  )
}

/** A round initial, for someone. */
export function Initial({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-9 shrink-0 place-items-center rounded-full bg-ink-1 font-semibold text-surface',
        className,
      )}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

/** A heading for a section, with how many it holds and what it's about. */
export function SectionHead({
  id,
  title,
  count,
  children,
  action,
}: {
  id?: string
  title: string
  count?: number
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="min-w-0 flex-[1_1_340px]">
        <h2 id={id} className="text-[15px] font-semibold tracking-[-0.01em] text-ink-1">
          {title}
          {count !== undefined && (
            <span className="ml-1.5 font-mono text-xs font-normal text-ink-3">{count}</span>
          )}
        </h2>
        {children && <p className="mt-1 max-w-[720px] text-[13px] text-ink-2">{children}</p>}
      </div>
      {action}
    </div>
  )
}

/** Something to know: about the provider's groups, or what's set elsewhere. */
export function Note({
  tone,
  title,
  children,
  className,
}: {
  tone: 'info' | 'warn' | 'locked'
  title?: string
  children: ReactNode
  className?: string
}) {
  const Icon = tone === 'warn' ? TriangleAlert : tone === 'locked' ? Lock : Info
  return (
    <div
      role="note"
      className={cn(
        'flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-[13px]',
        tone === 'warn' && 'border border-warn/30 bg-warn/10',
        tone === 'info' && 'border border-accent/25 bg-accent-soft',
        tone === 'locked' && 'bg-surface-2 text-xs text-ink-2',
        className,
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tone === 'warn'
            ? 'text-warn-text'
            : tone === 'info'
              ? 'text-accent-strong'
              : 'text-ink-3',
          tone === 'locked' && 'size-3.5',
        )}
      />
      <div className="min-w-0 flex-1">
        {/* (Only what's to know has a title: what's set elsewhere doesn't.) */}
        {title && (
          <p
            className={cn(
              'font-semibold',
              tone === 'warn' ? 'text-warn-text' : 'text-accent-strong',
            )}
          >
            {title}
          </p>
        )}
        <div className={cn(title && 'text-ink-2')}>{children}</div>
      </div>
    </div>
  )
}

/** A small label: a profile a grant gives (dark), what a limit holds back (warm), or plain. */
export function Pill({
  tone = 'plain',
  children,
  className,
}: {
  tone?: 'plain' | 'strong' | 'limit' | 'empty'
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs whitespace-nowrap',
        tone === 'plain' && 'bg-surface-3 text-ink-1',
        tone === 'strong' && 'bg-ink-1 font-medium text-surface',
        tone === 'limit' && 'bg-warn/10 text-warn-text',
        tone === 'empty' && 'border border-line text-ink-3',
        className,
      )}
    >
      {children}
    </span>
  )
}

/** Set by the Helm chart: changed there, not here. */
export function LockedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line-strong px-1.5 py-px text-2xs text-ink-2">
      <Lock aria-hidden className="size-2.5" /> Helm chart
    </span>
  )
}

/** A card that opens to edit what it is. */
export function Expandable({
  label,
  open,
  onToggle,
  head,
  children,
  muted,
}: {
  label: string
  open: boolean
  onToggle: () => void
  head: ReactNode
  children: ReactNode
  /** Its head on gray: set elsewhere. */
  muted?: boolean
}) {
  const id = useId()
  return (
    <article
      aria-label={label}
      className={cn(
        'overflow-hidden rounded-xl border bg-surface transition-[border-color,box-shadow] duration-150',
        open ? 'border-line-strong shadow-sm' : 'border-line',
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className={cn(
          'flex w-full flex-wrap items-center gap-3.5 px-4 py-3 text-left transition-colors hover:bg-surface-2',
          muted && 'bg-surface-2',
        )}
      >
        {head}
        <ChevronDown
          aria-hidden
          className={cn(
            'size-4 shrink-0 text-ink-2 transition-transform duration-150',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <div id={id} className="flex animate-fade-in flex-col gap-4.5 border-t border-line p-4">
          {children}
        </div>
      )}
    </article>
  )
}

/** A suggestion for a chip field: what's added, how it reads, and what it'd match. */
export interface Suggestion {
  value: string
  text: string
  kind: string
  note?: string
  /** Its note in the warning's color: it'd match nothing yet. */
  warn?: boolean
  mono?: boolean
}

export interface ChipView {
  value: string
  text: string
  kind?: string
  sub?: string
  mono?: boolean
  /** Something to know about it: "not seen yet". */
  note?: string
}

/**
 * Chips, and a field that suggests more as it's typed: arrows choose one, Enter adds it,
 * Escape clears, Backspace on an empty field takes the last chip off.
 */
export function ChipField({
  label,
  chips,
  onRemove,
  onAdd,
  suggest,
  placeholder,
  help,
  error,
  locked,
  empty,
}: {
  label: string
  chips: ChipView[]
  onRemove: (value: string) => void
  onAdd: (value: string) => void
  suggest: (typed: string) => Suggestion[]
  placeholder: string
  help?: ReactNode
  /** What's wrong with what's typed, if it's typed wrong. */
  error?: (typed: string) => string | undefined
  /** Set by the chart: shown, not changed. */
  locked?: boolean
  /** What none means: "All clusters". */
  empty?: string
}) {
  const id = useId()
  const [typed, setTyped] = useState('')
  const [active, setActive] = useState(0)
  const [focused, setFocused] = useState(false)
  const found = locked || !focused ? [] : suggest(typed.trim())
  const chosen = Math.min(active, Math.max(found.length - 1, 0))
  const problem = typed.trim() ? error?.(typed.trim()) : undefined
  const add = (value: string) => {
    onAdd(value)
    setTyped('')
    setActive(0)
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      <div
        className={cn(
          'flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-line-strong px-1.5 py-1',
          locked
            ? 'bg-surface-2'
            : 'bg-surface focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft',
        )}
      >
        {chips.map((chip) => (
          <span
            key={chip.value}
            className={cn(
              'inline-flex h-6 max-w-full items-center gap-1.5 rounded-md bg-surface-3 pl-2 text-xs text-ink-1',
              locked ? 'pr-2' : 'pr-0.5',
            )}
          >
            {chip.kind && <span className="font-sans text-2xs text-ink-3">{chip.kind}</span>}
            <span className={cn('truncate', chip.mono && 'font-mono')}>{chip.text}</span>
            {chip.sub && <span className="truncate font-mono text-2xs text-ink-3">{chip.sub}</span>}
            {chip.note && (
              <span className="text-2xs whitespace-nowrap text-warn-text">{chip.note}</span>
            )}
            {!locked && (
              <button
                type="button"
                aria-label={`Remove ${chip.text}`}
                onClick={() => onRemove(chip.value)}
                className="grid size-5 shrink-0 place-items-center rounded text-ink-2 hover:bg-line"
              >
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        {locked ? (
          chips.length === 0 && (
            <span id={id} className="px-1 text-xs text-ink-3">
              {empty}
            </span>
          )
        ) : (
          <input
            id={id}
            role="combobox"
            aria-expanded={found.length > 0}
            aria-controls={`${id}-list`}
            aria-activedescendant={found.length ? `${id}-${chosen}` : undefined}
            aria-invalid={problem ? true : undefined}
            autoComplete="off"
            value={typed}
            placeholder={chips.length ? 'Add another' : placeholder}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(event) => {
              setTyped(event.target.value)
              setActive(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' && found.length) {
                event.preventDefault()
                setActive((chosen + 1) % found.length)
              } else if (event.key === 'ArrowUp' && found.length) {
                event.preventDefault()
                setActive((chosen - 1 + found.length) % found.length)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                if (found.length) add(found[chosen]!.value)
              } else if (event.key === 'Escape' && typed) {
                event.stopPropagation()
                setTyped('')
              } else if (event.key === 'Backspace' && !typed && chips.length) {
                onRemove(chips.at(-1)!.value)
              }
            }}
            className="h-6 min-w-[140px] flex-1 bg-transparent text-[13px] text-ink-1 outline-none placeholder:text-ink-3"
          />
        )}
      </div>
      {problem && (
        <p role="alert" className="text-xs text-critical-text">
          {problem}
        </p>
      )}
      {found.length > 0 && (
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label={`Suggestions for ${label}`}
          className="flex animate-fade-in flex-col rounded-lg border border-line-strong bg-surface p-1 shadow-pop"
        >
          {found.map((suggestion, i) => (
            <div
              key={suggestion.value}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === chosen}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => add(suggestion.value)}
              onMouseMove={() => setActive(i)}
              className={cn(
                'flex min-h-8 cursor-default items-center gap-2 rounded-md px-2',
                i === chosen && 'bg-accent-soft',
              )}
            >
              <span className="w-24 shrink-0 truncate text-2xs text-ink-3">{suggestion.kind}</span>
              <span
                className={cn(
                  'min-w-0 flex-1 truncate text-xs text-ink-1',
                  suggestion.mono && 'font-mono',
                )}
              >
                {suggestion.text}
              </span>
              {suggestion.note && (
                <span
                  className={cn(
                    'text-xs whitespace-nowrap',
                    suggestion.warn ? 'text-warn-text' : 'text-ink-3',
                  )}
                >
                  {suggestion.note}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {help && <p className="text-xs text-ink-3">{help}</p>}
    </div>
  )
}

/** Deleting something: quiet until pointed at, in the critical color. */
export function DeleteButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center rounded-lg px-3 text-[13px] font-medium text-critical-text transition-colors hover:bg-critical/10"
    >
      {children}
    </button>
  )
}

/** Numbers that say how far something reaches: "12 people get it". */
export function Reach({ items }: { items: { value: number; label: string }[] }) {
  return (
    <div className="flex flex-wrap gap-px overflow-hidden rounded-[10px] border border-line bg-line">
      {items.map((item) => (
        <div key={item.label} className="flex-[1_1_180px] bg-surface-2 px-3.5 py-2.5">
          <div className="font-mono text-base font-medium text-ink-1 tabular-nums">
            {item.value.toLocaleString('en-US')}
          </div>
          <div className="text-xs text-ink-2">{item.label}</div>
        </div>
      ))}
    </div>
  )
}

/** A text field with its label above. */
export function TextField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  className,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
}) {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-xs font-medium text-ink-2">{label}</span>
      <input
        type="text"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-[34px] rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] text-ink-1 outline-none placeholder:text-ink-3 focus:border-accent focus:ring-3 focus:ring-accent-soft disabled:bg-surface-2 disabled:text-ink-2"
      />
    </label>
  )
}

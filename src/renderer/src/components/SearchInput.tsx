import { Search, X } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@renderer/lib/cn'
import { Kbd } from './Kbd'

/**
 * A list's filter box. `/` focuses it from anywhere (see useHotkeys), ↓ moves
 * into the list, and Escape leaves it.
 */
export function SearchInput({
  value,
  onChange,
  onArrowDown,
  placeholder,
  className,
}: {
  value: string
  onChange: (value: string) => void
  onArrowDown: () => void
  placeholder: string
  className?: string
}) {
  // The field shows what was typed right away, even if `value` catches up a
  // moment later (e.g. through the URL); changes made elsewhere replace it.
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    setDraft(value)
  }
  const change = (next: string) => {
    setDraft(next)
    onChange(next)
  }

  return (
    <label
      className={cn(
        'flex h-8 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-ink-3 transition-colors no-drag focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft',
        className,
      )}
    >
      <Search className="size-3.5 shrink-0" />
      <input
        data-hotkey-target="filter"
        value={draft}
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            // Leave the field without also closing the detail panel.
            event.stopPropagation()
            event.currentTarget.blur()
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            onArrowDown()
          }
        }}
        placeholder={placeholder}
        spellCheck={false}
        className="peer min-w-0 flex-1 bg-transparent text-[13px] text-ink-1 outline-none placeholder:text-ink-3"
      />
      {draft ? (
        <button
          type="button"
          aria-label="Clear filter"
          onClick={() => change('')}
          className="grid size-4 place-items-center rounded-full bg-ink-3/30 text-ink-1 hover:bg-ink-3/50"
        >
          <X className="size-3" />
        </button>
      ) : (
        <span className="peer-focus:hidden">
          <Kbd>/</Kbd>
        </span>
      )}
    </label>
  )
}

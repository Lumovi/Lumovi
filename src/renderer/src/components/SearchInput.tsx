import { Search, X } from 'lucide-react'
import { forwardRef } from 'react'
import { cn } from '@renderer/lib/cn'

export const SearchInput = forwardRef<
  HTMLInputElement,
  { value: string; onChange: (value: string) => void; placeholder: string; className?: string }
>(function SearchInput({ value, onChange, placeholder, className }, ref) {
  return (
    <label
      className={cn(
        'flex h-8 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-ink-3 transition-colors no-drag focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft',
        className,
      )}
    >
      <Search className="size-3.5 shrink-0" />
      <input
        ref={ref}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.blur()
        }}
        placeholder={placeholder}
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-ink-1 outline-none placeholder:text-ink-3"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear filter"
          onClick={() => onChange('')}
          className="grid size-4 place-items-center rounded-full bg-ink-3/30 text-ink-1 hover:bg-ink-3/50"
        >
          <X className="size-3" />
        </button>
      )}
    </label>
  )
})

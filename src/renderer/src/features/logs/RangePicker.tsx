/**
 * How far back the logs start: each container's last lines, a span of time, or a since a person
 * types ("90m", "2h", "14:30", "2026-10-11 09:00"), read back to them in words before it's used.
 */
import { Check, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { Picker } from '@renderer/components/Picker'
import { cn } from '@renderer/lib/cn'
import { labelOf, readBack, readSince, type Since } from '@renderer/lib/log-since'

/** Where the logs start: each container's last lines, or a span of time. */
export const RANGES = [
  { value: '100', label: 'Last 100 lines', tailLines: 100 },
  { value: '500', label: 'Last 500 lines', tailLines: 500 },
  { value: '2000', label: 'Last 2,000 lines', tailLines: 2000 },
  { value: '5m', label: 'Last 5 minutes', sinceSeconds: 300 },
  { value: '1h', label: 'Last hour', sinceSeconds: 3600 },
  { value: '1d', label: 'Last day', sinceSeconds: 86_400 },
] as const

/** What's picked: one of the ranges, or a since that was typed. */
export type Picked = { range: (typeof RANGES)[number]['value'] } | { since: Since }

/** On a phone, what a tap fills the field with. */
const QUICK = [
  ['15m', '15m'],
  ['2h', '2h'],
  ['6h', '6h'],
  ['Today 00:00', '00:00'],
] as const

const UNREAD = 'Not a duration or a time Lumovi reads. Try 90m, 2h, 14:30 or 2026-10-11 09:00.'
const FUTURE = 'That’s still to come: pick a time before now.'
const HINT = 'A duration, like 90m, 2h or 3d, or a date and time, like 14:30 or 2026-10-11 09:00.'

export function pickedLabel(picked: Picked, now: number): string {
  return 'range' in picked
    ? RANGES.find((r) => r.value === picked.range)!.label
    : labelOf(picked.since, now)
}

export function RangePicker({
  picked,
  onPick,
  phone,
}: {
  picked: Picked
  onPick: (picked: Picked) => void
  phone: boolean
}) {
  const [open, setOpen] = useState(false)
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState('')
  // (Read when it opens and as it's typed in: what "today" and "ago" are counted from.)
  const [now, setNow] = useState(() => Date.now())
  const type = (typed: string) => {
    setText(typed)
    setNow(Date.now())
  }
  const read = readSince(text, now)
  const close = () => {
    setOpen(false)
    setTyping(false)
    setText('')
  }
  const show = () => {
    if (!read || !('since' in read)) return
    onPick({ since: read.since })
    close()
  }
  const item = phone ? 'h-11 text-[13px]' : 'h-8 text-[13px] touch:h-11'
  return (
    <Picker
      open={open}
      onOpenChange={(next) => {
        if (!next) return close()
        setNow(Date.now())
        setOpen(true)
      }}
      title="Show"
      className={typing ? 'w-72 p-3' : 'min-w-44'}
      trigger={
        <button
          type="button"
          aria-label="Show"
          className={cn(
            'flex min-w-16 shrink items-center gap-1 rounded-md border border-line bg-surface-2 text-ink-1 data-[state=open]:border-accent',
            phone ? 'h-11 flex-1 rounded-lg px-3 text-[13px]' : 'h-7 px-1.5 text-xs touch:h-11',
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">{pickedLabel(picked, now)}</span>
          <ChevronDown className="size-3.5 shrink-0 text-ink-3" />
        </button>
      }
    >
      {!typing ? (
        <div role="listbox" aria-label="Show" className={phone ? 'px-2 pb-3' : undefined}>
          {[...RANGES.map((r) => [r.value, r.label] as const), ['since', 'Since…'] as const].map(
            ([value, label]) => {
              const chosen =
                value === 'since' ? 'since' in picked : 'range' in picked && picked.range === value
              return (
                <button
                  key={value}
                  type="button"
                  role="option"
                  aria-selected={chosen}
                  onClick={() => {
                    if (value === 'since') setTyping(true)
                    else {
                      onPick({ range: value })
                      close()
                    }
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2 text-left text-ink-1 hover:bg-surface-3',
                    item,
                  )}
                >
                  <span className="flex-1">{label}</span>
                  {chosen && <Check className="size-3.5 text-accent" />}
                </button>
              )
            },
          )}
        </div>
      ) : (
        <form
          className={cn('flex flex-col gap-2', phone && 'px-4 pb-4')}
          onSubmit={(event) => {
            event.preventDefault()
            show()
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            Since
            <input
              // (It opens to be typed in.)
              autoFocus
              value={text}
              onChange={(event) => type(event.target.value)}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              aria-invalid={(read && 'problem' in read) || undefined}
              className={cn(
                'rounded-md border bg-surface px-2 font-mono text-[13px] text-ink-1 outline-none',
                phone ? 'h-11' : 'h-8 touch:h-11',
                read && 'problem' in read
                  ? 'border-critical shadow-[0_0_0_1px_var(--critical)]'
                  : 'border-line focus:border-accent',
              )}
            />
          </label>
          {read && 'since' in read && (
            <p aria-live="polite" className="text-xs text-ink-2">
              {readBack(read.since, now)}
            </p>
          )}
          {read && 'problem' in read && (
            <p aria-live="polite" className="text-xs text-critical-text">
              {read.problem === 'future' ? FUTURE : UNREAD}
            </p>
          )}
          <p className="text-xs text-ink-3">{HINT}</p>
          {phone && (
            <div className="flex flex-wrap gap-2">
              {QUICK.map(([label, fill]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => type(fill)}
                  className="h-11 min-w-11 rounded-full border border-line px-3 text-[13px] text-ink-1"
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={close}
              className={cn(
                'rounded-md border border-line px-3 text-[13px] text-ink-1 hover:bg-surface-3',
                phone ? 'h-11' : 'h-8 touch:h-11',
              )}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!read || !('since' in read)}
              className={cn(
                'rounded-md bg-accent px-3 text-[13px] font-medium text-white hover:bg-accent-hover disabled:opacity-50',
                phone ? 'h-11' : 'h-8 touch:h-11',
              )}
            >
              Show
            </button>
          </div>
        </form>
      )}
    </Picker>
  )
}

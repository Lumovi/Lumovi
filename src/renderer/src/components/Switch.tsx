import { Switch as SwitchPrimitive } from 'radix-ui'

export function Switch({
  id,
  checked,
  onCheckedChange,
  label,
  disabled,
  locked,
  describedBy,
  autoFocus,
}: {
  /** For a label beside it that turns it too (`htmlFor`). */
  id?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
  disabled?: boolean
  /**
   * Set where this person can't change it (a server's or an organization's): shown dim, never
   * changed by a press, but it keeps its tab stop and says why by what describes it.
   */
  locked?: boolean
  /** The id of what says why it's as it is (its line, or why it's locked). */
  describedBy?: string
  autoFocus?: boolean
}) {
  return (
    <SwitchPrimitive.Root
      {...(id ? { id } : {})}
      aria-label={label}
      checked={checked}
      disabled={disabled}
      {...(locked ? { 'aria-disabled': true } : {})}
      {...(describedBy ? { 'aria-describedby': describedBy } : {})}
      {...(autoFocus ? { autoFocus: true } : {})}
      onCheckedChange={(next) => {
        if (!locked) onCheckedChange(next)
      }}
      className="relative inline-flex h-[18px] w-8 shrink-0 cursor-default items-center rounded-full bg-ink-3/40 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-accent-soft disabled:opacity-50 aria-disabled:opacity-50 data-[state=checked]:bg-accent"
    >
      <SwitchPrimitive.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[15px]" />
    </SwitchPrimitive.Root>
  )
}

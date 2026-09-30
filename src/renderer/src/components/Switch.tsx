import { Switch as SwitchPrimitive } from 'radix-ui'

export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <SwitchPrimitive.Root
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      className="relative inline-flex h-[18px] w-8 shrink-0 cursor-default items-center rounded-full bg-ink-3/40 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-accent-soft disabled:opacity-50 data-[state=checked]:bg-accent"
    >
      <SwitchPrimitive.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[15px]" />
    </SwitchPrimitive.Root>
  )
}

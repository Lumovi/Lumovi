import { useEffect, useRef, type ReactNode } from 'react'
import { useGo } from '@renderer/hooks/go'
import { cn } from '@renderer/lib/cn'

/**
 * Tabs that are pages of their own, like Workloads' and an add-on's. When
 * there are more than fit, they scroll sideways, keeping the current one in
 * view.
 */
export function LinkTabs({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav
      aria-label={label}
      // The line under the tabs is drawn inside, so scrolling doesn't clip the current tab's.
      className="flex shrink-0 [scrollbar-width:none] gap-1 overflow-x-auto px-5 pb-px shadow-[inset_0_-1px_0_var(--color-line)]"
    >
      {children}
    </nav>
  )
}

export function LinkTab({
  to,
  active,
  label,
  count,
}: {
  to: string
  active: boolean
  label: string
  count?: number
}) {
  const go = useGo()
  const ref = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    if (active) ref.current!.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
  return (
    <a
      ref={ref}
      href={`#${to}`}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        event.preventDefault()
        go(to)
      }}
      className={cn(
        'relative flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap text-ink-3 transition-colors outline-none hover:text-ink-1 focus-visible:bg-surface-3',
        active &&
          'text-ink-1 after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent',
      )}
    >
      {label}
      {count !== undefined && (
        <span className="text-xs font-normal text-ink-3 tabular-nums">{count}</span>
      )}
    </a>
  )
}

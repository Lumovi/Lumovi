import { useEffect, useRef, type ReactNode } from 'react'
import { useGo } from '@renderer/hooks/go'
import { cn } from '@renderer/lib/cn'
import { Tooltip } from './Tooltip'

/**
 * Tabs that are pages of their own, like Workloads' and a plugin's. When
 * there are more than fit, they scroll sideways, keeping the current one in
 * view.
 */
export function LinkTabs({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav
      aria-label={label}
      // The line under the tabs is drawn inside, so scrolling doesn't clip the current tab's.
      // (A strip of tabs scrolls inside itself, and says so.)
      data-scrolls-sideways
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
  icon,
  tooltip,
}: {
  to: string
  active: boolean
  label: string
  count?: number
  /** Before its name: what tells its kind of tab apart (a plugin's plug). */
  icon?: ReactNode
  /** Said on hover: whose tab it is. */
  tooltip?: string
}) {
  const go = useGo()
  const ref = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    if (active) ref.current!.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
  const tab = (
    <a
      ref={ref}
      href={`#${to}`}
      aria-current={active ? 'page' : undefined}
      onClick={(event) => {
        event.preventDefault()
        go(to)
      }}
      className={cn(
        'relative flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap text-ink-3 transition-colors outline-none hover:text-ink-1 focus-visible:bg-surface-3 phone:h-11',
        active &&
          'text-ink-1 after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent',
      )}
    >
      {icon}
      {label}
      {count !== undefined && (
        <span className="text-xs font-normal text-ink-3 tabular-nums">{count}</span>
      )}
    </a>
  )
  return tooltip ? <Tooltip content={tooltip}>{tab}</Tooltip> : tab
}

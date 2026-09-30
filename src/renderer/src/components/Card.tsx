import { useId, type ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'

export function Card({
  title,
  action,
  children,
  className,
}: {
  title: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className={cn(
        'flex min-w-0 flex-col rounded-xl border border-line bg-surface-2 p-4 shadow-panel',
        className,
      )}
    >
      <header className="mb-3 flex min-h-6 items-center justify-between gap-3">
        <h2 id={id} className="text-[13px] font-semibold text-ink-1">
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  )
}

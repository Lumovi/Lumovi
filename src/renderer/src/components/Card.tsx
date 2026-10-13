import { useId, type ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'

export function Card({
  title,
  action,
  about,
  children,
  className,
}: {
  title: ReactNode
  action?: ReactNode
  /** A quiet line under the title, before what it holds: read after the title, never as its name. */
  about?: ReactNode
  children: ReactNode
  className?: string
}) {
  const id = useId()
  const aboutId = useId()
  return (
    <section
      aria-labelledby={id}
      {...(about ? { 'aria-describedby': aboutId } : {})}
      className={cn(
        'flex min-w-0 flex-col rounded-xl border border-line bg-surface-2 p-4 shadow-panel',
        className,
      )}
    >
      <header
        className={cn('flex min-h-6 items-center justify-between gap-3', about ? 'mb-1' : 'mb-3')}
      >
        <h2 id={id} className="text-[13px] font-semibold text-ink-1">
          {title}
        </h2>
        {action}
      </header>
      {about && (
        <div id={aboutId} className="mb-2">
          {about}
        </div>
      )}
      {children}
    </section>
  )
}

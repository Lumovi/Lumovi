import { CircleAlert, CircleCheck, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '@renderer/lib/cn'
import { useToasts, type Toast } from '@renderer/state/toasts'

/** How long a toast stays; longer for errors, which take a moment to read. */
const DURATION = { success: 6_000, error: 10_000 }

/** Outcomes of changes, stacked in the bottom-right corner. */
export function Toaster() {
  const toasts = useToasts((state) => state.toasts)
  return (
    <section
      aria-label="Notifications"
      className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[380px] max-w-[calc(100vw-32px)] flex-col items-stretch gap-2"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </section>
  )
}

function ToastCard({ toast }: { toast: Toast }) {
  const dismiss = useToasts((state) => state.dismiss)
  const [paused, setPaused] = useState(false)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    if (paused) return
    const timer = setTimeout(() => setLeaving(true), DURATION[toast.tone])
    return () => clearTimeout(timer)
  }, [paused, toast.tone])

  const Icon = toast.tone === 'success' ? CircleCheck : CircleAlert
  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onAnimationEnd={() => {
        if (leaving) dismiss(toast.id)
      }}
      className={cn(
        'pointer-events-auto flex items-start gap-3 rounded-xl border border-line-strong bg-surface-2 py-3 pr-2 pl-3.5 shadow-pop',
        leaving ? 'animate-toast-out' : 'animate-toast-in',
      )}
    >
      <Icon
        className={cn(
          'mt-px size-[18px] shrink-0 animate-spin-once',
          toast.tone === 'success' ? 'text-good-text' : 'text-critical-text',
        )}
      />
      <div className="min-w-0 flex-1 py-px">
        <p className="text-[13px] leading-snug font-medium text-ink-1">{toast.title}</p>
        {toast.description && (
          <p className="mt-0.5 line-clamp-3 text-xs leading-relaxed text-ink-2 selectable">
            {toast.description}
          </p>
        )}
      </div>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action!.run()
            setLeaving(true)
          }}
          className="shrink-0 rounded-md px-2 py-0.5 text-[13px] font-medium text-accent-strong hover:bg-accent-soft"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setLeaving(true)}
        className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-3 hover:text-ink-1"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

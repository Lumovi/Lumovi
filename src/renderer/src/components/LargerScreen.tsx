import { MonitorSmartphone } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useLayout } from '@renderer/lib/layout'

/**
 * What a phone reads and doesn't do, said where someone would look for it: one calm line, never
 * a button that does nothing. (What a phone may change is web/phone-gate.ts's to say.)
 */
export function LargerScreenNote({ to }: { to: string }) {
  return (
    <p className="text-xs leading-relaxed text-ink-3">Open Lumovi on a larger screen to {to}.</p>
  )
}

/**
 * A page that's for changing how Lumovi is set up: on a phone, a note in its place, and the way
 * back.
 */
export function OnALargerScreen({
  title,
  to,
  says,
  children,
}: {
  /** What the page is. */
  title: string
  /** What's done there, after "Open Lumovi on a larger screen to". */
  to?: string
  /** Or all of what it says, where that sentence doesn't fit. */
  says?: string
  children: ReactNode
}) {
  if (useLayout() !== 'phone') return children
  return (
    <main className="mx-auto flex h-full max-w-sm flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 grid size-11 place-items-center rounded-2xl border border-line bg-surface-3 text-ink-3">
        <MonitorSmartphone className="size-5" />
      </div>
      <h1 className="text-[15px] font-semibold text-ink-1">{title}</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
        {says ??
          `Open Lumovi on a larger screen to ${to}. A phone reads, and does a few things: it answers an assistant’s change, restarts and scales workloads, and cordons nodes.`}
      </p>
      <Link
        to="/"
        className="mt-5 flex h-11 items-center rounded-lg border border-line-strong bg-surface-2 px-4 text-[13px] font-medium text-ink-1 shadow-xs"
      >
        Back to the cluster
      </Link>
    </main>
  )
}

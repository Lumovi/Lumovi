/**
 * Where a server's access doesn't let its person do what a place is for (a
 * shell, a node's shell, logs): what, why, who can change it, and the way to
 * their access. Said where it happens, so "why can't I?" is one click away.
 */
import { Lock } from 'lucide-react'
import { Link } from 'react-router'
import { buttonClass } from '@renderer/components/Button'
import { cn } from '@renderer/lib/cn'
import { useMyAccess } from './use-access'

export function NotAllowed({
  title,
  reason,
  className,
}: {
  /** What they can't do: "You can’t open shells here". */
  title: string
  /** Why, as useAccessHere says it. */
  reason: string
  className?: string
}) {
  // (Said only once their access is known: it's what says no.)
  const admins = useMyAccess()!.admins
  return (
    <div
      role="note"
      className={cn(
        'mx-auto flex max-w-[460px] animate-rise flex-col items-center gap-2.5 px-6 py-14 text-center',
        className,
      )}
    >
      <span
        aria-hidden
        className="mb-1 grid size-11 place-items-center rounded-2xl border border-line bg-surface-3 text-ink-3"
      >
        <Lock className="size-5" />
      </span>
      <h3 className="text-[15px] font-semibold text-ink-1">{title}</h3>
      <p className="text-[13px] leading-relaxed text-ink-2">{reason}</p>
      {admins.length > 0 && (
        <p className="text-xs text-ink-3">Lumovi’s admins can change it: {listed(admins)}.</p>
      )}
      <Link to="/your-access" className={buttonClass('primary', 'mt-1.5')}>
        See your access
      </Link>
    </div>
  )
}

/** "a, b and c". */
export const listed = (items: string[]) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

import { LogOut } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useState } from 'react'
import type { Session } from '@shared/server'
import { IconButton } from '@renderer/components/Button'
import { cn } from '@renderer/lib/cn'
import { toast } from '@renderer/state/toasts'
import { sessionEnded, signOut } from '@renderer/web/session'
import { menuContent, menuItem } from '../shell/menu-styles'

/** Groups shown by name; the rest are counted. */
const SHOWN_GROUPS = 4

/** Who is signed in to a KubeStacks server, and signing out. */
export function AccountMenu({ session }: { session: Session }) {
  const { user, auth, signOutUrl } = session
  const [leaving, setLeaving] = useState(false)
  const initials = user.name.replace(/@.*/, '').slice(0, 2).toUpperCase()
  // Everyone signed in is in system:authenticated: it says nothing.
  const groups = user.groups.filter((group) => group !== 'system:authenticated')
  const leave = async () => {
    setLeaving(true)
    try {
      await signOut()
      sessionEnded('signed-out')
    } catch (error) {
      setLeaving(false)
      toast({ tone: 'error', title: 'Couldn’t sign out', description: (error as Error).message })
    }
  }
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <IconButton label={`Signed in as ${user.name}`}>
          <span
            aria-hidden
            className="grid size-6 place-items-center rounded-full bg-accent-soft text-[10px] font-semibold text-accent-strong"
          >
            {initials}
          </span>
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          aria-label="Account"
          className={cn(menuContent, 'w-[272px] p-0')}
        >
          <div className="border-b border-line px-3.5 py-3">
            <p className="text-2xs font-medium tracking-wider text-ink-3 uppercase">Signed in as</p>
            <p
              className="mt-0.5 truncate text-[13px] font-medium text-ink-1 selectable"
              title={user.name}
            >
              {user.name}
            </p>
            {groups.length > 0 && (
              <ul aria-label="Groups" className="mt-2 flex flex-wrap gap-1">
                {groups.slice(0, SHOWN_GROUPS).map((group) => (
                  <li
                    key={group}
                    className="max-w-full truncate rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-2xs text-ink-2"
                  >
                    {group}
                  </li>
                ))}
                {groups.length > SHOWN_GROUPS && (
                  <li className="px-1 py-0.5 text-2xs text-ink-3">
                    +{groups.length - SHOWN_GROUPS} more
                  </li>
                )}
              </ul>
            )}
          </div>
          <div className="p-1">
            {auth !== 'proxy' ? (
              <button
                type="button"
                disabled={leaving}
                onClick={() => void leave()}
                className={cn(menuItem, 'w-full hover:bg-surface-3 disabled:opacity-60')}
              >
                <LogOut className="size-4 text-ink-3" /> {leaving ? 'Signing out…' : 'Sign out'}
              </button>
            ) : signOutUrl ? (
              <a href={signOutUrl} className={cn(menuItem, 'hover:bg-surface-3')}>
                <LogOut className="size-4 text-ink-3" /> Sign out
              </a>
            ) : (
              <p className="px-2.5 py-1.5 text-xs leading-relaxed text-ink-3">
                Signed in by the proxy in front of KubeStacks.
              </p>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

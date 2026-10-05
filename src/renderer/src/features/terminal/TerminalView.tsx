import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'
import type { Phase, TerminalSession } from './session'

/** Where a session is at, as the page re-renders it. */
export function usePhase(session: TerminalSession): Phase {
  return useSyncExternalStore(session.subscribe, session.getPhase)
}

/**
 * Ready to type once connected: focus the terminal unless focus has moved out of
 * the panel, or the tabs are being browsed with the keyboard (arrows would get
 * stuck). Focus is on the body when what had it went away, like Reconnect.
 */
function takeFocus(host: HTMLElement, session: TerminalSession) {
  const active = document.activeElement!
  const browsing = active.getAttribute('role') === 'tab' && active.matches(':focus-visible')
  const here = active === document.body || host.closest('aside')!.contains(active)
  if (here && !browsing) session.focus()
}

/**
 * A session's terminal, shown here while this is. `owned`: the session ends
 * when this goes away (a panel's shell); otherwise its owner ends it (a dock's).
 * `children` float over it: how the shell ended, say.
 */
export function TerminalView({
  session,
  label,
  owned = true,
  focusWhenOpen = false,
  dimmed,
  children,
}: {
  session: TerminalSession
  /** The terminal's accessible name: "Shell in app". */
  label: string
  owned?: boolean
  /** In a detail panel: takes focus once connected, as long as focus is in the panel. */
  focusWhenOpen?: boolean
  /** Faded, once its shell has ended (with a notice over it, saying so). */
  dimmed: boolean
  children?: ReactNode
}) {
  const host = useRef<HTMLDivElement>(null)
  const phase = usePhase(session)

  useEffect(() => {
    session.start()
    const detach = session.attach(host.current!)
    const release = owned ? session.hold() : undefined
    return () => {
      detach()
      release?.()
    }
  }, [session, owned])

  const open = phase.state === 'open'
  useEffect(() => {
    if (open && focusWhenOpen) takeFocus(host.current!, session)
  }, [open, focusWhenOpen, session])

  return (
    // The terminal keeps the keys it handles (Escape for vi, less…) from reaching the panel.
    <div className="relative flex min-h-0 flex-1 flex-col bg-surface-2">
      {/* The terminal sits on its own layer, so its size can't feed back into the layout. */}
      <div
        role="region"
        aria-label={label}
        aria-busy={phase.state === 'connecting'}
        className={cn('relative min-h-0 flex-1 transition-opacity', dimmed && 'opacity-60')}
      >
        <div ref={host} className="absolute inset-0 px-3 py-2" />
      </div>
      {children}
    </div>
  )
}

/** A card over a terminal: how its shell ended, and what can be done now. */
export function TerminalNotice({
  children,
  detail,
  actions,
}: {
  children: ReactNode
  detail?: ReactNode
  actions: ReactNode
}) {
  return (
    <div
      role="status"
      className="absolute inset-x-4 bottom-4 flex animate-rise items-center gap-3 rounded-xl border border-line-strong bg-surface px-4 py-3 shadow-pop"
    >
      <p className="min-w-0 flex-1 text-[13px] text-ink-1 selectable">
        {children}
        {detail && <span className="mt-0.5 block text-xs text-ink-3">{detail}</span>}
      </p>
      {actions}
    </div>
  )
}

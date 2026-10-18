import type { ReactNode } from 'react'
import { api } from '@renderer/lib/api'
import { useKeys } from '@renderer/lib/shortcuts'

export const MOD_KEY = api.platform === 'darwin' ? '⌘' : 'Ctrl'
/** The Option key, Alt off a Mac. */
export const ALT_KEY = api.platform === 'darwin' ? '⌥' : 'Alt'
/** The Control key itself, for shortcuts that use it on every platform (⌃` for the terminal). */
export const CTRL_KEY = api.platform === 'darwin' ? '⌃' : 'Ctrl'

/**
 * Whether ⌘N and ⌘1…6 are Lumovi's shortcuts: a browser keeps them for
 * itself (a new window, its tabs), so a served page goes without.
 */
export const WINDOW_SHORTCUTS = api.host === 'desktop'

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-line-strong bg-surface px-1 font-sans text-[11px] font-medium text-ink-3">
      {children}
    </kbd>
  )
}

/** A command's keys as Settings has them (shared/shortcuts.ts), or nothing where it has none. */
export function CommandKeys({ id }: { id: string }) {
  const caps = useKeys().caps(id)
  return caps ? caps.map((key) => <Kbd key={key}>{key}</Kbd>) : null
}

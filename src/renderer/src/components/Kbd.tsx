import type { ReactNode } from 'react'
import { api } from '@renderer/lib/api'

export const MOD_KEY = api.platform === 'darwin' ? '⌘' : 'Ctrl'

/**
 * Whether ⌘N and ⌘1…6 are KubeStacks' shortcuts: a browser keeps them for
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

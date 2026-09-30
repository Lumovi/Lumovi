import type { ReactNode } from 'react'

export const MOD_KEY = window.kubestacks.platform === 'darwin' ? '⌘' : 'Ctrl'

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-line-strong bg-surface px-1 font-sans text-[11px] font-medium text-ink-3">
      {children}
    </kbd>
  )
}

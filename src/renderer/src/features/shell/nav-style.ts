import { cn } from '@renderer/lib/cn'

/** A row of the sidebar: a kind's list, a page, a pinned object. */
export const navItem = (isActive: boolean) =>
  cn(
    // (A finger's height in the drawer.)
    'group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors duration-100 no-drag narrow:h-11 touch:h-11',
    isActive
      ? 'bg-surface-3 font-medium text-ink-1 shadow-[inset_0_0_0_1px_var(--line)]'
      : 'text-ink-2 hover:bg-surface-3/60 hover:text-ink-1',
  )

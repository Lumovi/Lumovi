import { Tabs as TabsPrimitive } from 'radix-ui'
import type { ReactNode } from 'react'

export const Tabs = TabsPrimitive.Root
export const TabContent = TabsPrimitive.Content

/**
 * Tab triggers with an underline that glides to the active tab. The underline
 * is anchored to the active trigger with CSS anchor positioning, so the
 * browser animates it without any measuring in JavaScript.
 */
export function TabList({ tabs }: { tabs: { value: string; label: ReactNode }[] }) {
  return (
    <TabsPrimitive.List className="relative flex gap-1 border-b border-line px-5">
      {tabs.map((tab) => (
        <TabsPrimitive.Trigger
          key={tab.value}
          value={tab.value}
          className="flex h-9 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-ink-3 transition-colors outline-none hover:text-ink-1 focus-visible:bg-surface-3 data-[state=active]:text-ink-1 data-[state=active]:[anchor-name:--active-tab]"
        >
          {tab.label}
        </TabsPrimitive.Trigger>
      ))}
      <span
        aria-hidden
        className="pointer-events-none absolute [right:calc(anchor(right)+8px)] -bottom-px [left:calc(anchor(left)+8px)] h-0.5 rounded-full bg-accent transition-[left,right] duration-300 ease-out [position-anchor:--active-tab]"
      />
    </TabsPrimitive.List>
  )
}

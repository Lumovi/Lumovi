import { Tabs as TabsPrimitive } from 'radix-ui'
import type { ReactNode } from 'react'

export const Tabs = TabsPrimitive.Root
export const TabContent = TabsPrimitive.Content

/**
 * Tab triggers with an underline that glides to the active tab. The underline
 * is anchored to the active trigger with CSS anchor positioning, so the
 * browser animates it without any measuring in JavaScript. When there are
 * more tabs than fit, they scroll sideways.
 */
export function TabList({ tabs }: { tabs: { value: string; label: ReactNode }[] }) {
  return (
    // The line under the tabs is drawn inside, so scrolling doesn't clip the underline.
    <TabsPrimitive.List className="relative flex [scrollbar-width:none] gap-1 overflow-x-auto px-5 pb-px shadow-[inset_0_-1px_0_var(--color-line)]">
      {tabs.map((tab) => (
        <TabsPrimitive.Trigger
          key={tab.value}
          value={tab.value}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap text-ink-3 transition-colors outline-none hover:text-ink-1 focus-visible:bg-surface-3 data-[state=active]:text-ink-1 data-[state=active]:[anchor-name:--active-tab]"
        >
          {tab.label}
        </TabsPrimitive.Trigger>
      ))}
      <span
        aria-hidden
        className="pointer-events-none absolute [right:calc(anchor(right)+8px)] bottom-0 [left:calc(anchor(left)+8px)] h-0.5 rounded-full bg-accent transition-[left,right] duration-300 ease-out [position-anchor:--active-tab]"
      />
    </TabsPrimitive.List>
  )
}

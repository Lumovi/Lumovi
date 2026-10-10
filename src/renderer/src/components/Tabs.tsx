import { Tabs as TabsPrimitive } from 'radix-ui'
import type { ReactNode } from 'react'

export const Tabs = TabsPrimitive.Root
export const TabContent = TabsPrimitive.Content

/**
 * Tab triggers with an underline that glides to the active tab. The underline
 * is anchored to the active trigger with CSS anchor positioning, so the
 * browser animates it without any measuring in JavaScript. When there are
 * more tabs than fit, they scroll sideways, fading out at the edges (inside
 * the padding, so nothing fades when they fit) to say there are more.
 */
export function TabList({ tabs }: { tabs: { value: string; label: ReactNode }[] }) {
  return (
    // The line under the tabs is the wrapper's, so it doesn't fade with them.
    // On a phone, where the page scrolls under them, they stay at its top.
    <div className="shadow-[inset_0_-1px_0_var(--color-line)] phone:sticky phone:top-0 phone:z-10 phone:bg-surface">
      <TabsPrimitive.List
        // The one thing on a narrow page that scrolls sideways, and says so.
        data-scrolls-sideways
        className="relative flex [scrollbar-width:none] gap-1 overflow-x-auto [mask-image:linear-gradient(to_right,transparent,black_1.25rem,black_calc(100%-1.25rem),transparent)] px-5 pb-px phone:[mask-image:linear-gradient(to_right,transparent,black_1rem,black_calc(100%-1rem),transparent)] phone:px-2"
      >
        {tabs.map((tab) => (
          <TabsPrimitive.Trigger
            key={tab.value}
            value={tab.value}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap text-ink-3 transition-colors outline-none hover:text-ink-1 focus-visible:bg-surface-3 data-[state=active]:text-ink-1 data-[state=active]:[anchor-name:--active-tab] phone:h-11"
          >
            {tab.label}
          </TabsPrimitive.Trigger>
        ))}
        <span
          aria-hidden
          className="pointer-events-none absolute [right:calc(anchor(right)+8px)] bottom-0 [left:calc(anchor(left)+8px)] h-0.5 rounded-full bg-accent transition-[left,right] duration-300 ease-out [position-anchor:--active-tab]"
        />
      </TabsPrimitive.List>
    </div>
  )
}

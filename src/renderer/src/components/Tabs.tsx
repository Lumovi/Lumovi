import { Tabs as TabsPrimitive } from 'radix-ui'
import type { ReactNode } from 'react'

export const Tabs = TabsPrimitive.Root
export const TabContent = TabsPrimitive.Content

export function TabList({ tabs }: { tabs: { value: string; label: ReactNode }[] }) {
  return (
    <TabsPrimitive.List className="flex gap-1 border-b border-line px-5">
      {tabs.map((tab) => (
        <TabsPrimitive.Trigger
          key={tab.value}
          value={tab.value}
          className="relative -mb-px flex h-9 items-center gap-1.5 px-2.5 text-[13px] font-medium text-ink-3 transition-colors hover:text-ink-1 data-[state=active]:text-ink-1 data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:bottom-0 data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-accent"
        >
          {tab.label}
        </TabsPrimitive.Trigger>
      ))}
    </TabsPrimitive.List>
  )
}

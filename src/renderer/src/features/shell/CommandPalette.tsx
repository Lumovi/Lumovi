import { Command } from 'cmdk'
import {
  CornerDownLeft,
  LayoutDashboard,
  LayoutGrid,
  Monitor,
  Moon,
  Server,
  Sun,
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { RESOURCES } from '@shared/resources'
import { KIND_ICONS } from '@renderer/components/KindIcon'
import { Kbd } from '@renderer/components/Kbd'
import { useContexts, useList } from '@renderer/hooks/queries'
import { matchWords } from '@renderer/lib/match'
import { clusterPath, kindPath } from '@renderer/lib/routes'
import { useCluster } from '@renderer/state/cluster'
import { CATEGORY_LABELS } from './Sidebar'
import { useSetTheme } from './ThemeMenu'

const THEMES = [
  { value: 'system', label: 'Use system theme', icon: Monitor },
  { value: 'light', label: 'Use light theme', icon: Sun },
  { value: 'dark', label: 'Use dark theme', icon: Moon },
] as const

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { context, setNamespace } = useCluster()
  const navigate = useNavigate()
  const contexts = useContexts().data?.contexts ?? []
  const namespaces = useList('Namespace', { namespace: null }).data ?? []
  const setTheme = useSetTheme()

  const run = (action: () => unknown) => () => {
    void action()
    onOpenChange(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 animate-fade-in bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[14vh] left-1/2 z-50 w-[640px] max-w-[calc(100vw-48px)] -translate-x-1/2 animate-pop-in overflow-hidden rounded-2xl border border-line-strong bg-surface-2 shadow-pop outline-none"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command loop filter={matchWords}>
            <Command.Input
              autoFocus
              placeholder="Jump to a resource, namespace, or cluster…"
              className="h-12 w-full border-b border-line bg-transparent px-4 text-[15px] text-ink-1 outline-none placeholder:text-ink-3"
            />
            <Command.List className="max-h-[420px] overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-3 [&_[cmdk-group-heading]]:uppercase">
              <Command.Empty className="py-10 text-center text-ink-3">No matches.</Command.Empty>
              <Command.Group heading="Go to">
                <Item
                  icon={<LayoutDashboard />}
                  onSelect={run(() => navigate(clusterPath(context)))}
                >
                  Overview
                </Item>
                {RESOURCES.map((resource) => {
                  const Icon = KIND_ICONS[resource.kind]
                  return (
                    <Item
                      key={resource.kind}
                      icon={<Icon />}
                      value={`${resource.label} ${CATEGORY_LABELS[resource.category]}`}
                      hint={CATEGORY_LABELS[resource.category]}
                      onSelect={run(() => navigate(kindPath(context, resource.kind)))}
                    >
                      {resource.label}
                    </Item>
                  )
                })}
              </Command.Group>
              <Command.Group heading="Namespace">
                <Item
                  icon={<LayoutGrid />}
                  value="All namespaces"
                  onSelect={run(() => setNamespace(null))}
                >
                  All namespaces
                </Item>
                {namespaces.map(({ metadata: { name } }) => (
                  <Item
                    key={name}
                    icon={<LayoutGrid />}
                    value={`${name} namespace`}
                    onSelect={run(() => setNamespace(name))}
                  >
                    {name}
                  </Item>
                ))}
              </Command.Group>
              <Command.Group heading="Clusters">
                {contexts.map(({ name }) => (
                  <Item
                    key={name}
                    icon={<Server />}
                    value={`${name} cluster`}
                    onSelect={run(() => navigate(clusterPath(name)))}
                  >
                    {name}
                  </Item>
                ))}
              </Command.Group>
              <Command.Group heading="Appearance">
                {THEMES.map(({ value, label, icon: Icon }) => (
                  <Item key={value} icon={<Icon />} onSelect={run(() => setTheme(value))}>
                    {label}
                  </Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
          <footer className="flex items-center gap-4 border-t border-line px-4 py-2 text-xs text-ink-3">
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> to navigate
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>
                <CornerDownLeft className="size-3" />
              </Kbd>{' '}
              to select
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>esc</Kbd> to close
            </span>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Item({
  icon,
  hint,
  value,
  onSelect,
  children,
}: {
  icon: ReactNode
  hint?: string
  value?: string
  onSelect: () => void
  children: ReactNode
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex h-10 cursor-default items-center gap-3 rounded-lg px-2.5 text-[13.5px] text-ink-1 select-none data-[selected=true]:bg-surface-3 [&_svg]:size-4 [&_svg]:text-ink-3"
    >
      {icon}
      <span className="flex-1 truncate">{children}</span>
      <span className="text-xs text-ink-3">{hint}</span>
    </Command.Item>
  )
}

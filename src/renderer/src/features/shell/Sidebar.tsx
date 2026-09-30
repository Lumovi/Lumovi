import { useQuery } from '@tanstack/react-query'
import { Command } from 'cmdk'
import { Check, ChevronsUpDown, LayoutDashboard, List } from 'lucide-react'
import { Popover } from 'radix-ui'
import { useState, type ReactNode } from 'react'
import { NavLink } from 'react-router'
import type { KubeContext } from '@shared/api'
import { GO_KEYS } from '@shared/navigation'
import { RESOURCES, type ResourceCategory } from '@shared/resources'
import { IconButton } from '@renderer/components/Button'
import { KIND_ICONS } from '@renderer/components/KindIcon'
import { GithubMark, Logo } from '@renderer/components/Logo'
import { StatusDot } from '@renderer/components/Status'
import { useGo } from '@renderer/hooks/go'
import { useContexts, useVersion } from '@renderer/hooks/queries'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { matchWords } from '@renderer/lib/match'
import { clusterPath, kindPath } from '@renderer/lib/routes'
import { useCluster } from '@renderer/state/cluster'
import { REPO_URL } from '../welcome/WelcomePage'
import { menuContent, menuItem } from './menu-styles'
import { ThemeMenu } from './ThemeMenu'

export const CATEGORY_LABELS: Record<ResourceCategory, string> = {
  cluster: 'Cluster',
  workloads: 'Workloads',
  network: 'Network',
  config: 'Configuration',
  storage: 'Storage',
}

const navItem = ({ isActive }: { isActive: boolean }) =>
  cn(
    'group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors duration-100 no-drag',
    isActive
      ? 'bg-surface-3 font-medium text-ink-1 shadow-[inset_0_0_0_1px_var(--line)]'
      : 'text-ink-2 hover:bg-surface-3/60 hover:text-ink-1',
  )

/** A sidebar link that navigates with a page transition. */
function NavItem({ to, end, children }: { to: string; end?: boolean; children: ReactNode }) {
  const go = useGo()
  return (
    <NavLink
      end={end}
      to={to}
      className={navItem}
      onClick={(event) => {
        event.preventDefault()
        go(to)
      }}
    >
      {children}
    </NavLink>
  )
}

/** The "g, then a letter" shortcut for a nav item, shown on hover. */
function GoHint({ target }: { target: string }) {
  const entry = GO_KEYS.find((e) => e.target === target)
  return (
    <span
      aria-hidden
      className="ml-auto font-mono text-2xs text-ink-3 opacity-0 transition-opacity group-hover:opacity-100"
    >
      {entry && `G ${entry.key.toUpperCase()}`}
    </span>
  )
}

export function Sidebar() {
  const { context } = useCluster()
  const go = useGo()
  const version = useQuery({ queryKey: ['app-info'], queryFn: () => api.app.info() }).data?.version
  return (
    <aside aria-label="Sidebar" className="flex w-[244px] shrink-0 flex-col drag">
      <div className="titlebar-leading flex h-[52px] shrink-0 items-center px-3">
        <button
          type="button"
          aria-label="All clusters"
          onClick={() => go('/')}
          className="flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors no-drag hover:bg-surface-3/60"
        >
          <Logo className="size-6" />
          <span className="text-[14px] font-semibold tracking-[-0.01em]">KubeStacks</span>
        </button>
      </div>
      <div className="px-3 pb-3">
        <ClusterSwitcher />
      </div>
      <nav aria-label="Resources" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 no-drag">
        <NavItem end to={clusterPath(context)}>
          <LayoutDashboard className="size-4 text-ink-3" /> Overview
          <GoHint target="overview" />
        </NavItem>
        {(Object.keys(CATEGORY_LABELS) as ResourceCategory[]).map((category) => (
          <div key={category} className="mt-4">
            <h3 className="mb-1 px-2.5 text-2xs font-medium tracking-wider text-ink-3 uppercase">
              {CATEGORY_LABELS[category]}
            </h3>
            {RESOURCES.filter((r) => r.category === category).map((resource) => {
              const Icon = KIND_ICONS[resource.kind]
              return (
                <NavItem key={resource.kind} to={kindPath(context, resource.kind)}>
                  <Icon className="size-4 text-ink-3" /> {resource.label}
                  <GoHint target={resource.kind} />
                </NavItem>
              )
            })}
          </div>
        ))}
      </nav>
      <div className="flex items-center gap-1 border-t border-line px-3 py-2 no-drag">
        <ThemeMenu />
        <IconButton label="KubeStacks on GitHub" onClick={() => api.app.openExternal(REPO_URL)}>
          <GithubMark />
        </IconButton>
        <span className="ml-auto pr-1 text-2xs text-ink-3 tabular-nums">
          {version && `v${version}`}
        </span>
      </div>
    </aside>
  )
}

function ClusterSwitcher() {
  const { context } = useCluster()
  const navigateTo = useGo()
  const [open, setOpen] = useState(false)
  const contexts = useContexts().data?.contexts ?? []
  const version = useVersion(context)
  const server = contexts.find((c) => c.name === context)?.server
  const health = version.isPending ? 'progressing' : version.isError ? 'critical' : 'healthy'
  const go = (path: string) => {
    setOpen(false)
    navigateTo(path)
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label="Switch cluster"
        className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-surface-2 px-3 py-2 text-left shadow-panel transition-colors no-drag hover:bg-surface-3 data-[state=open]:bg-surface-3"
      >
        <StatusDot health={health} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink-1">{context}</span>
          <span className="block truncate text-xs text-ink-3">
            {version.isSuccess
              ? `Kubernetes ${version.data.gitVersion}`
              : version.isError
                ? 'Unavailable'
                : (server ?? 'Connecting…')}
          </span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-ink-3" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className={cn(menuContent, 'w-[300px] p-0')}>
          <Command loop filter={matchWords} label="Clusters">
            <Command.Input
              placeholder="Switch to…"
              className="h-10 w-full border-b border-line bg-transparent px-3 text-[13px] text-ink-1 outline-none placeholder:text-ink-3"
            />
            <Command.List className="max-h-80 overflow-y-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-xs text-ink-3">
                No clusters match.
              </Command.Empty>
              {contexts.map((c) => (
                <SwitcherItem key={c.name} context={c} active={c.name === context} onSelect={go} />
              ))}
              <Command.Separator className="mx-1 my-1 h-px bg-line" />
              <Command.Item value="All clusters" onSelect={() => go('/')} className={menuItem}>
                <List className="size-4 text-ink-3" /> All clusters
              </Command.Item>
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function SwitcherItem({
  context,
  active,
  onSelect,
}: {
  context: KubeContext
  active: boolean
  onSelect: (path: string) => void
}) {
  const version = useVersion(context.name)
  const health = version.isPending ? 'progressing' : version.isError ? 'critical' : 'healthy'
  return (
    <Command.Item
      value={`${context.name} ${context.cluster}`}
      onSelect={() => onSelect(clusterPath(context.name))}
      className={cn(menuItem, 'h-auto py-1.5')}
    >
      <StatusDot health={health} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{context.name}</span>
      </span>
      {active && <Check className="size-4 text-accent" aria-label="Current cluster" />}
    </Command.Item>
  )
}

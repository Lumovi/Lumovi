import { useQuery } from '@tanstack/react-query'
import { Command } from 'cmdk'
import {
  Blocks,
  Boxes,
  ChartSpline,
  Check,
  ChevronsUpDown,
  LayoutDashboard,
  List,
  Lock,
  ShipWheel,
} from 'lucide-react'
import { Popover } from 'radix-ui'
import { useState, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router'
import type { KubeContext } from '@shared/api'
import { GO_KEYS } from '@shared/navigation'
import {
  isCustomGroup,
  RESOURCES,
  type ResourceCategory,
  type ResourceDefinition,
} from '@shared/resources'
import { IconButton } from '@renderer/components/Button'
import { KIND_ICONS, kindIcon } from '@renderer/components/KindIcon'
import { GithubMark } from '@renderer/components/Logo'
import { StatusDot } from '@renderer/components/Status'
import { Switch } from '@renderer/components/Switch'
import { useGo } from '@renderer/hooks/go'
import { useContexts, useVersion } from '@renderer/hooks/queries'
import { useResources } from '@renderer/hooks/resources'
import { useViews } from '@renderer/hooks/views'
import { useReadOnly } from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { matchWords } from '@renderer/lib/match'
import {
  apiResourcesPath,
  clusterPath,
  helmPath,
  kindPath,
  metricsPath,
  workloadsPath,
} from '@renderer/lib/routes'
import { useCluster } from '@renderer/state/cluster'
import { usePrefs } from '@renderer/state/prefs'
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

const SIDEBAR_CATEGORIES: ResourceCategory[] = ['cluster', 'network', 'config', 'storage']

const navItem = (isActive: boolean) =>
  cn(
    'group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors duration-100 no-drag',
    isActive
      ? 'bg-surface-3 font-medium text-ink-1 shadow-[inset_0_0_0_1px_var(--line)]'
      : 'text-ink-2 hover:bg-surface-3/60 hover:text-ink-1',
  )

/** The lists Workloads leads to: its tabs, and the kinds that run them. */
const WORKLOAD_PAGES = RESOURCES.filter((r) => r.category === 'workloads' && r.kind !== 'Pod').map(
  (r) => r.plural,
)

/**
 * A sidebar link that navigates with a page transition. It also shows as the
 * current page on the routes in `also`.
 */
function NavItem({
  to,
  end,
  also = [],
  children,
}: {
  to: string
  end?: boolean
  also?: string[]
  children: ReactNode
}) {
  const go = useGo()
  const page = useLocation().pathname.split('/')[3]!
  return (
    <NavLink
      end={end}
      to={to}
      className={({ isActive }) => navItem(isActive || also.includes(page))}
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
  const version = useQuery({ queryKey: ['app-info'], queryFn: () => api.app.info() }).data?.version
  return (
    <aside aria-label="Sidebar" className="flex w-[244px] shrink-0 flex-col drag">
      {/* Room for macOS's window controls, which sit above the cluster. */}
      <div aria-hidden className="traffic-lights h-10 shrink-0" />
      <div className="p-3">
        <ClusterSwitcher />
      </div>
      <nav aria-label="Resources" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 no-drag">
        <NavItem end to={clusterPath(context)}>
          <LayoutDashboard className="size-4 text-ink-3" /> Overview
          <GoHint target="overview" />
        </NavItem>
        <NavItem to={workloadsPath(context)} also={WORKLOAD_PAGES}>
          <Boxes className="size-4 text-ink-3" /> Workloads
          <GoHint target="workloads" />
        </NavItem>
        <NavItem to={kindPath(context, 'Pod')}>
          <KIND_ICONS.Pod className="size-4 text-ink-3" /> Pods
          <GoHint target="Pod" />
        </NavItem>
        <NavItem to={metricsPath(context)}>
          <ChartSpline className="size-4 text-ink-3" /> Metrics
          <GoHint target="metrics" />
        </NavItem>
        <NavItem to={helmPath(context)}>
          <ShipWheel className="size-4 text-ink-3" /> Helm releases
          <GoHint target="helm" />
        </NavItem>
        {/* Workloads and Pods lead to the workload kinds' lists. */}
        {SIDEBAR_CATEGORIES.map((category) => (
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
        <CustomResources />
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
  const readOnly = useReadOnly()
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
          <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink-1">
            <span className="truncate">{context}</span>
            {readOnly.readOnly && (
              <Lock aria-label="Read-only" className="size-3 shrink-0 text-ink-3" />
            )}
          </span>
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
          <div className="flex items-center gap-3 border-t border-line px-3 py-2.5">
            <Lock className="size-4 shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] text-ink-1">Read-only</span>
              <span className="block text-xs leading-snug text-ink-3">
                {readOnly.locked
                  ? 'Set by KUBESTACKS_READ_ONLY'
                  : `KubeStacks won’t change ${context}`}
              </span>
            </span>
            <Switch
              label="Read-only"
              checked={readOnly.readOnly}
              disabled={readOnly.locked}
              onCheckedChange={(checked) => void readOnly.set(checked)}
            />
          </div>
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

/**
 * Pinned kinds, and the custom kinds opened lately in this cluster: a few,
 * however many the cluster has. Browsing them all is what API resources is for.
 */
function CustomResources() {
  const { context } = useCluster()
  const resources = useResources().data
  // Views pick the kinds' icons.
  useViews()
  const pinnedKinds = usePrefs((prefs) => prefs.pinned)
  const recentKinds = usePrefs((prefs) => prefs.recentKinds[context])
  const served = new Map((resources ?? []).map((r) => [r.kind as string, r]))
  const pinned = pinnedKinds.flatMap((kind) => served.get(kind) ?? [])
  const recent = (recentKinds ?? [])
    .filter((kind) => !pinnedKinds.includes(kind))
    .flatMap((kind) => served.get(kind) ?? [])
    .filter((r) => isCustomGroup(r.group))
  const custom = (resources ?? []).filter((r) => isCustomGroup(r.group)).length
  const item = (resource: ResourceDefinition) => {
    const Icon = kindIcon(resource.kind)
    return (
      <NavItem key={resource.kind} to={kindPath(context, resource.kind)}>
        <Icon className="size-4 shrink-0 text-ink-3" />
        <span className="truncate">{resource.label}</span>
      </NavItem>
    )
  }
  return (
    <>
      {pinned.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1 px-2.5 text-2xs font-medium tracking-wider text-ink-3 uppercase">
            Pinned
          </h3>
          {pinned.map(item)}
        </div>
      )}
      <div className="mt-4">
        <h3 className="mb-1 px-2.5 text-2xs font-medium tracking-wider text-ink-3 uppercase">
          Custom resources
        </h3>
        <div aria-label="Opened lately" role="group">
          {recent.map(item)}
        </div>
        {resources && custom === 0 && (
          <p className="px-2.5 py-1 text-xs text-ink-3">None in this cluster</p>
        )}
        <NavItem to={apiResourcesPath(context)}>
          <Blocks className="size-4 text-ink-3" /> API resources
          {custom > 0 && (
            <span
              aria-label={`${custom} custom`}
              className="ml-auto text-2xs text-ink-3 tabular-nums"
            >
              {custom}
            </span>
          )}
        </NavItem>
      </div>
    </>
  )
}

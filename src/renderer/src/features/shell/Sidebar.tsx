import { ChevronsUpDown, LayoutDashboard, LogOut } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { NavLink, useNavigate } from 'react-router'
import { RESOURCES, type ResourceCategory } from '@shared/resources'
import { IconButton } from '@renderer/components/Button'
import { KIND_ICONS } from '@renderer/components/KindIcon'
import { GithubMark, Logo } from '@renderer/components/Logo'
import { StatusDot } from '@renderer/components/Status'
import { useContexts, useVersion } from '@renderer/hooks/queries'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
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
    'flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors duration-100 no-drag',
    isActive
      ? 'bg-surface-3 font-medium text-ink-1 shadow-[inset_0_0_0_1px_var(--line)]'
      : 'text-ink-2 hover:bg-surface-3/60 hover:text-ink-1',
  )

export function Sidebar() {
  const { context } = useCluster()
  return (
    <aside aria-label="Sidebar" className="flex w-[244px] shrink-0 flex-col drag">
      <div className="titlebar-leading flex h-[52px] shrink-0 items-center gap-2 px-4">
        <Logo className="size-6" />
        <span className="text-[14px] font-semibold tracking-[-0.01em]">KubeStacks</span>
      </div>
      <div className="px-3 pb-3">
        <ClusterSwitcher />
      </div>
      <nav aria-label="Resources" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 no-drag">
        <NavLink end to={clusterPath(context)} className={navItem}>
          <LayoutDashboard className="size-4 text-ink-3" /> Overview
        </NavLink>
        {(Object.keys(CATEGORY_LABELS) as ResourceCategory[]).map((category) => (
          <div key={category} className="mt-4">
            <h3 className="mb-1 px-2.5 text-2xs font-medium tracking-wider text-ink-3 uppercase">
              {CATEGORY_LABELS[category]}
            </h3>
            {RESOURCES.filter((r) => r.category === category).map((resource) => {
              const Icon = KIND_ICONS[resource.kind]
              return (
                <NavLink
                  key={resource.kind}
                  to={kindPath(context, resource.kind)}
                  className={navItem}
                >
                  <Icon className="size-4 text-ink-3" /> {resource.label}
                </NavLink>
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
      </div>
    </aside>
  )
}

function ClusterSwitcher() {
  const { context } = useCluster()
  const navigate = useNavigate()
  const contexts = useContexts().data?.contexts ?? []
  const version = useVersion(context)
  const health = version.isPending ? 'progressing' : version.isError ? 'critical' : 'healthy'
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
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
                : 'Connecting…'}
          </span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-ink-3" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className={cn(menuContent, 'w-[260px]')}>
          <DropdownMenu.Label className="px-2 py-1.5 text-2xs font-medium tracking-wide text-ink-3 uppercase">
            Clusters
          </DropdownMenu.Label>
          <div className="max-h-72 overflow-y-auto">
            {contexts.map((c) => (
              <DropdownMenu.Item
                key={c.name}
                className={menuItem}
                onSelect={() => navigate(clusterPath(c.name))}
              >
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    c.name === context ? 'bg-accent' : 'bg-transparent',
                  )}
                />
                <span className="truncate">{c.name}</span>
              </DropdownMenu.Item>
            ))}
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item className={menuItem} onSelect={() => navigate('/')}>
            <LogOut className="size-4 text-ink-3" /> All clusters
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowRight,
  Blocks,
  Boxes,
  ChartSpline,
  LayoutDashboard,
  Menu,
  Plus,
  Puzzle,
  RotateCw,
  Search,
  ShipWheel,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { apiKindOf, resourceByPlural } from '@shared/resources'
import { IconButton } from '@renderer/components/Button'
import { MiddleTruncate } from '@renderer/components/MiddleTruncate'
import { barButton } from '@renderer/components/Sheet'
import { pluginIcon, KindIcon } from '@renderer/components/KindIcon'
import { Kbd, MOD_KEY, WINDOW_SHORTCUTS } from '@renderer/components/Kbd'
import { useServedPlugins } from '@renderer/hooks/plugins'
import { useResource } from '@renderer/hooks/resources'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { useLayout, useShort } from '@renderer/lib/layout'
import { useClusterName } from '@renderer/hooks/settings'
import { useCluster } from '@renderer/state/cluster'
import { useUi } from '@renderer/state/ui'
import { ActivityButton } from '../activity/ActivityButton'
import { ForwardsButton } from '../activity/ForwardsButton'
import { NamespacePicker } from './NamespacePicker'
import { ClusterSwitcher } from './Sidebar'

const PAGES: Record<string, [string, LucideIcon]> = {
  '': ['Overview', LayoutDashboard],
  workloads: ['Workloads', Boxes],
  metrics: ['Metrics', ChartSpline],
  'api-resources': ['API resources', Blocks],
  helm: ['Helm releases', ShipWheel],
  // A plugin the cluster doesn't have (the others go by their own names).
  plugins: ['Plugins', Puzzle],
}

/**
 * A narrow page's context row: which cluster, and which namespace, each a chip that changes it.
 */
export function ContextRow({ clusterScoped }: { clusterScoped: boolean }) {
  return (
    <div
      data-context-row
      className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-4"
    >
      <ClusterSwitcher chip />
      <NamespacePicker chip clusterScoped={clusterScoped} />
    </div>
  )
}

/** What a page lists, by where it is: whether its kind (or all its plugin's) has no namespace. */
export function usePage() {
  const [page = '', custom] = useLocation().pathname.split('/').slice(3)
  // Custom kinds' pages are r/<kind>; built-in kinds' are their plural.
  const kind = page === 'r' ? decodeURIComponent(custom!) : resourceByPlural(page)?.kind
  const resource = useResource(kind).resource
  // A plugin's page is plugins/<name>; its kinds' are theirs.
  const served = useServedPlugins()
  const plugin =
    page === 'plugins'
      ? served.find((s) => s.plugin.name === decodeURIComponent(custom!))
      : undefined
  const clusterScoped = kind
    ? resource?.namespaced === false
    : Boolean(plugin?.kinds.every((r) => !r.namespaced))
  return { clusterScoped }
}

export function Header() {
  const { context } = useCluster()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const setPalette = useUi((ui) => ui.setPalette)
  const setCreate = useUi((ui) => ui.setCreate)
  const setSidebar = useUi((ui) => ui.setSidebar)
  const inside = useUi((ui) => ui.inside)
  const layout = useLayout()
  const short = useShort()
  const [refreshing, setRefreshing] = useState(false)
  const [page = '', custom] = useLocation().pathname.split('/').slice(3)
  // Custom kinds' pages are r/<kind>; built-in kinds' are their plural.
  const kind = page === 'r' ? decodeURIComponent(custom!) : resourceByPlural(page)?.kind
  const resource = useResource(kind).resource
  // A plugin's page is plugins/<name>; its kinds' are theirs.
  const served = useServedPlugins()
  const plugin =
    page === 'plugins'
      ? served.find((s) => s.plugin.name === decodeURIComponent(custom!))
      : undefined
  // Pages other than a kind's list go by their route (and anything unknown is the overview's).
  const [pageTitle, PageIcon] = plugin
    ? ([plugin.plugin.label, pluginIcon(plugin.plugin)] as const)
    : (PAGES[page] ?? PAGES['']!)
  const title = kind ? (resource?.label ?? apiKindOf(kind)) : pageTitle

  const clusterName = useClusterName()(context)
  useEffect(() => {
    // Shown in the Dock, the task switcher and Mission Control.
    document.title = `${title} · ${clusterName} — Lumovi`
  }, [title, clusterName])

  const refresh = async () => {
    setRefreshing(true)
    await queryClient.invalidateQueries()
    setRefreshing(false)
  }

  // Narrower than the desktop app's window gets: a top bar, and under it where you are.
  if (layout !== 'wide') {
    const clusterScoped = kind
      ? resource?.namespaced === false
      : Boolean(plugin?.kinds.every((r) => !r.namespaced))
    return (
      <>
        <header className="flex h-[52px] shrink-0 items-center border-b border-line bg-surface px-1">
          {/* A page inside the page has Back where the menu is, and its own name. */}
          {inside ? (
            <button type="button" aria-label="Back" onClick={inside.back} className={barButton}>
              <ArrowLeft />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Menu"
              data-opens="sidebar"
              onClick={() => setSidebar(true)}
              className={barButton}
            >
              <Menu />
            </button>
          )}
          <h1 className="min-w-0 flex-1 px-1 text-[15px] leading-5 font-semibold tracking-[-0.01em] [view-transition-name:page-title]">
            <MiddleTruncate text={inside?.title ?? title} />
          </h1>
          <button
            type="button"
            aria-label="Search"
            onClick={() => setPalette(true)}
            className={barButton}
          >
            <Search />
          </button>
          {/* Nothing is written on a phone: there, objects are read, and a few things done. */}
          {layout === 'tablet' && (
            <>
              <button
                type="button"
                aria-label="Create…"
                onClick={() => setCreate(true)}
                className={barButton}
              >
                <Plus />
              </button>
              {api.forwards && <ForwardsButton api={api.forwards} />}
              <ActivityButton />
            </>
          )}
          <button
            type="button"
            aria-label="Refresh"
            onClick={() => void refresh()}
            className={barButton}
          >
            <RotateCw className={cn(refreshing && 'animate-spin [animation-duration:0.8s]')} />
          </button>
        </header>
        {/* Where the screen is short it's the page's first thing, and scrolls away with it. */}
        {!short && <ContextRow clusterScoped={clusterScoped} />}
      </>
    )
  }

  return (
    <header className="titlebar-trailing flex h-[52px] shrink-0 items-center gap-2 border-b border-line pr-3 pl-3 drag">
      <div className="flex items-center">
        <IconButton label={`Back (${MOD_KEY}[)`} onClick={() => navigate(-1)}>
          <ArrowLeft />
        </IconButton>
        <IconButton label={`Forward (${MOD_KEY}])`} onClick={() => navigate(1)}>
          <ArrowRight />
        </IconButton>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2.5 pl-1 [view-transition-name:page-title]">
        {kind ? (
          <KindIcon kind={kind} className="size-4 shrink-0 text-ink-3" />
        ) : (
          <PageIcon className="size-4 shrink-0 text-ink-3" />
        )}
        <h1 className="truncate text-[14px] font-semibold tracking-[-0.01em]">{title}</h1>
      </div>
      <NamespacePicker
        clusterScoped={
          kind ? resource?.namespaced === false : Boolean(plugin?.kinds.every((r) => !r.namespaced))
        }
      />
      <button
        type="button"
        onClick={() => setPalette(true)}
        className="flex h-8 w-52 items-center gap-2 rounded-lg border border-line bg-surface-2 pr-1.5 pl-2.5 text-ink-3 transition-colors no-drag hover:border-line-strong hover:text-ink-2 touch:h-11"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">Search…</span>
        <Kbd>{MOD_KEY}</Kbd>
        <Kbd>K</Kbd>
      </button>
      <IconButton
        label={WINDOW_SHORTCUTS ? `Create… (${MOD_KEY}N)` : 'Create…'}
        onClick={() => setCreate(true)}
      >
        <Plus />
      </IconButton>
      {api.forwards && <ForwardsButton api={api.forwards} />}
      <ActivityButton />
      <IconButton label={`Refresh (${MOD_KEY}R)`} onClick={() => void refresh()}>
        <RotateCw className={cn(refreshing && 'animate-spin [animation-duration:0.8s]')} />
      </IconButton>
    </header>
  )
}

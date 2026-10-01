import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowRight,
  Blocks,
  ChartSpline,
  LayoutDashboard,
  Plus,
  RotateCw,
  Search,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { apiKindOf, resourceByPlural } from '@shared/resources'
import { IconButton } from '@renderer/components/Button'
import { KindIcon } from '@renderer/components/KindIcon'
import { Kbd, MOD_KEY } from '@renderer/components/Kbd'
import { useResource } from '@renderer/hooks/resources'
import { cn } from '@renderer/lib/cn'
import { useCluster } from '@renderer/state/cluster'
import { useUi } from '@renderer/state/ui'
import { ActivityButton } from '../activity/ActivityButton'
import { ForwardsButton } from '../activity/ForwardsButton'
import { NamespacePicker } from './NamespacePicker'

export function Header() {
  const { context } = useCluster()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const setPalette = useUi((ui) => ui.setPalette)
  const setCreate = useUi((ui) => ui.setCreate)
  const [refreshing, setRefreshing] = useState(false)
  const [page = '', custom] = useLocation().pathname.split('/').slice(3)
  // Custom kinds' pages are r/<kind>; built-in kinds' are their plural.
  const kind = page === 'r' ? decodeURIComponent(custom!) : resourceByPlural(page)?.kind
  const resource = useResource(kind).resource
  const metrics = page === 'metrics'
  const browse = page === 'api-resources'
  const PageIcon = metrics ? ChartSpline : browse ? Blocks : LayoutDashboard
  const title = kind
    ? (resource?.label ?? apiKindOf(kind))
    : metrics
      ? 'Metrics'
      : browse
        ? 'API resources'
        : 'Overview'

  useEffect(() => {
    // Shown in the Dock, the task switcher and Mission Control.
    document.title = `${title} · ${context} — KubeStacks`
  }, [title, context])

  const refresh = async () => {
    setRefreshing(true)
    await queryClient.invalidateQueries()
    setRefreshing(false)
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
      <NamespacePicker clusterScoped={Boolean(kind) && resource?.namespaced === false} />
      <button
        type="button"
        onClick={() => setPalette(true)}
        className="flex h-8 w-52 items-center gap-2 rounded-lg border border-line bg-surface-2 pr-1.5 pl-2.5 text-ink-3 transition-colors no-drag hover:border-line-strong hover:text-ink-2"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">Search…</span>
        <Kbd>{MOD_KEY}</Kbd>
        <Kbd>K</Kbd>
      </button>
      <IconButton label={`Create from YAML (${MOD_KEY}N)`} onClick={() => setCreate(true)}>
        <Plus />
      </IconButton>
      <ForwardsButton />
      <ActivityButton />
      <IconButton label={`Refresh (${MOD_KEY}R)`} onClick={() => void refresh()}>
        <RotateCw className={cn(refreshing && 'animate-spin [animation-duration:0.8s]')} />
      </IconButton>
    </header>
  )
}

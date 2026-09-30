import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, LayoutDashboard, RotateCw, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { resourceByPlural } from '@shared/resources'
import { IconButton } from '@renderer/components/Button'
import { KIND_ICONS } from '@renderer/components/KindIcon'
import { Kbd, MOD_KEY } from '@renderer/components/Kbd'
import { cn } from '@renderer/lib/cn'
import { useCluster } from '@renderer/state/cluster'
import { useUi } from '@renderer/state/ui'
import { ActivityButton } from '../activity/ActivityButton'
import { NamespacePicker } from './NamespacePicker'

export function Header() {
  const { context } = useCluster()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const setPalette = useUi((ui) => ui.setPalette)
  const [refreshing, setRefreshing] = useState(false)
  const resource = resourceByPlural(useLocation().pathname.split('/')[3] ?? '')
  const Icon = resource ? KIND_ICONS[resource.kind] : LayoutDashboard
  const title = resource?.label ?? 'Overview'

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
        <Icon className="size-4 shrink-0 text-ink-3" />
        <h1 className="truncate text-[14px] font-semibold tracking-[-0.01em]">{title}</h1>
      </div>
      <NamespacePicker clusterScoped={resource?.namespaced === false} />
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
      <ActivityButton />
      <IconButton label={`Refresh (${MOD_KEY}R)`} onClick={() => void refresh()}>
        <RotateCw className={cn(refreshing && 'animate-spin [animation-duration:0.8s]')} />
      </IconButton>
    </header>
  )
}

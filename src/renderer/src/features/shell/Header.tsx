import { useIsFetching, useQueryClient } from '@tanstack/react-query'
import { LayoutDashboard, RotateCw, Search } from 'lucide-react'
import { useLocation } from 'react-router'
import { resourceByPlural } from '@shared/resources'
import { IconButton } from '@renderer/components/Button'
import { KIND_ICONS } from '@renderer/components/KindIcon'
import { Kbd, MOD_KEY } from '@renderer/components/Kbd'
import { cn } from '@renderer/lib/cn'
import { NamespacePicker } from './NamespacePicker'

export function Header({ onSearch }: { onSearch: () => void }) {
  const queryClient = useQueryClient()
  const fetching = useIsFetching() > 0
  const resource = resourceByPlural(useLocation().pathname.split('/')[3] ?? '')
  const Icon = resource ? KIND_ICONS[resource.kind] : LayoutDashboard

  return (
    <header className="titlebar-trailing flex h-[52px] shrink-0 items-center gap-2 border-b border-line pr-3 pl-5 drag">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <Icon className="size-4 shrink-0 text-ink-3" />
        <h1 className="truncate text-[14px] font-semibold tracking-[-0.01em]">
          {resource?.label ?? 'Overview'}
        </h1>
      </div>
      <NamespacePicker />
      <button
        type="button"
        onClick={onSearch}
        className="flex h-8 w-52 items-center gap-2 rounded-lg border border-line bg-surface-2 pr-1.5 pl-2.5 text-ink-3 transition-colors no-drag hover:border-line-strong hover:text-ink-2"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">Search…</span>
        <Kbd>{MOD_KEY}</Kbd>
        <Kbd>K</Kbd>
      </button>
      <IconButton label="Refresh" onClick={() => void queryClient.invalidateQueries()}>
        <RotateCw className={cn(fetching && 'animate-spin [animation-duration:1.2s]')} />
      </IconButton>
    </header>
  )
}

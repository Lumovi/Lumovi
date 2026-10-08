/**
 * A cluster's actions on the clusters page: on its ⋯, on right-click, or on `.`. Open it, its
 * settings, the line for kubectl and its file (one added in Lumovi), hide it, or remove it from
 * Lumovi (one added in it).
 */
import {
  ArrowRight,
  CornerDownLeft,
  Ellipsis,
  Eye,
  EyeOff,
  FolderOpen,
  SlidersHorizontal,
  SquareTerminal,
  Trash2,
} from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import type { SyntheticEvent } from 'react'
import { IconButton } from '@renderer/components/Button'
import { Kbd, MOD_KEY } from '@renderer/components/Kbd'
import { useGo } from '@renderer/hooks/go'
import { cn } from '@renderer/lib/cn'
import { clusterPath } from '@renderer/lib/routes'
import { menuContent, menuItem } from '../shell/menu-styles'
import type { Cluster } from './ClusterPicker'
import { REVEAL } from './clusters'

/** What a cluster's actions do, as the page has them. */
export interface ClusterActionHandlers {
  settings: (cluster: Cluster) => void
  setHidden: (cluster: Cluster, hidden: boolean) => void
  /** Its file in Finder or Explorer. */
  show: (cluster: Cluster) => void
  /** One added in Lumovi: the line for a terminal. */
  copyForKubectl: (cluster: Cluster) => void
  /** One added in Lumovi: removed, its file with it (asked first). */
  remove: (cluster: Cluster) => void
}

/** Kept in the menu: not taken by the row it's in (React's events pass through portals). */
const kept = (event: SyntheticEvent) => event.stopPropagation()

export function ClusterActions({
  cluster,
  actions,
  open,
  onOpenChange,
}: {
  cluster: Cluster
  actions: ClusterActionHandlers
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const go = useGo()
  const item = (
    Icon: typeof ArrowRight,
    label: string,
    onSelect: () => void,
    keys?: React.ReactNode,
    danger = false,
  ) => (
    <DropdownMenu.Item className={cn(menuItem, danger && 'text-critical-text')} onSelect={onSelect}>
      <Icon className={cn('size-4', danger ? 'text-critical-text' : 'text-ink-2')} />
      {label}
      {keys && <span className="ml-auto flex gap-1">{keys}</span>}
    </DropdownMenu.Item>
  )
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild onClick={kept} onPointerDown={kept}>
        <IconButton
          label={`Actions for ${cluster.name}`}
          className="size-7 shrink-0 opacity-0 group-data-[selected=true]:opacity-100 data-[state=open]:opacity-100"
        >
          <Ellipsis />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className={cn(menuContent, 'w-64')}
          onClick={kept}
          onPointerDown={kept}
          onKeyDown={kept}
        >
          {item(
            ArrowRight,
            'Open',
            () => go(clusterPath(cluster.context.name)),
            <Kbd>
              <CornerDownLeft className="size-3" />
            </Kbd>,
          )}
          {item(
            SlidersHorizontal,
            'Settings…',
            () => actions.settings(cluster),
            <>
              <Kbd>{MOD_KEY}</Kbd>
              <Kbd>I</Kbd>
            </>,
          )}
          {cluster.own &&
            item(SquareTerminal, 'Copy for kubectl', () => actions.copyForKubectl(cluster))}
          {cluster.context.file && item(FolderOpen, REVEAL, () => actions.show(cluster))}
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          {cluster.hidden
            ? item(Eye, 'Show', () => actions.setHidden(cluster, false))
            : item(EyeOff, 'Hide', () => actions.setHidden(cluster, true))}
          {cluster.own &&
            item(
              Trash2,
              'Remove from Lumovi',
              () => actions.remove(cluster),
              <>
                <Kbd>{MOD_KEY}</Kbd>
                <Kbd>⌫</Kbd>
              </>,
              true,
            )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

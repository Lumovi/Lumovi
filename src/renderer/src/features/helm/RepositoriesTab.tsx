import { Ellipsis, Library, Lock, Pencil, Plus, RefreshCw, SearchX, Trash2 } from 'lucide-react'
import { DropdownMenu } from 'radix-ui'
import { useRef, useState, type SyntheticEvent } from 'react'
import type { HelmRepositories, HelmRepository, KubeObject } from '@shared/api'
import { IconButton } from '@renderer/components/Button'
import { EmptyState, ErrorState } from '@renderer/components/States'
import { StatusDot, StatusPill } from '@renderer/components/Status'
import { useHelmRepositories } from '@renderer/hooks/helm'
import type { KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { age } from '@renderer/lib/format'
import type { Health } from '@renderer/lib/health'
import { useLayout } from '@renderer/lib/layout'
import { toast } from '@renderer/state/toasts'
import { sortRows, type CellContext, type Column } from '../resources/columns'
import { countBy, HealthChips, ListBar } from '../resources/ListToolbar'
import { ResourceTable } from '../resources/ResourceTable'
import { TableSkeleton } from '../resources/TableSkeleton'
import { menuContent, menuItem } from '../shell/menu-styles'
import { api } from '@renderer/lib/api'
import { RemoveRepositoryDialog, RepositoryDialog } from './RepositoryDialogs'

/** A repository as a table row: the table lists objects by name. */
type Row = KubeObject & { repository: HelmRepository }

const repositoryOf = (o: KubeObject) => (o as Row).repository

/** Read, couldn't be read, or not read yet. */
export function repositoryHealth(repository: HelmRepository): Health {
  if (!repository.read) return 'progressing'
  return 'error' in repository.read ? 'critical' : 'healthy'
}

/**
 * Whether Lumovi could read it: when, or why not, in a list; on a phone, a status in the chips'
 * own words (why not comes under its address).
 */
function IndexCell({ repository, now }: { repository: HelmRepository; now: number }) {
  const phone = useLayout() === 'phone'
  const read = repository.read
  const health = repositoryHealth(repository)
  if (phone) return <StatusPill status={{ health, label: HEALTH_NAMES[health]! }} />
  if (!read) return <span className="text-ink-3">Reading…</span>
  return 'error' in read ? (
    <span title={read.error} className="truncate text-critical-text">
      {read.error}
    </span>
  ) : (
    <span className="truncate text-ink-2">Read {age(read.at, now)} ago</span>
  )
}

const HEALTH_NAMES: Partial<Record<Health, string>> = {
  critical: 'Can’t read',
  healthy: 'Read',
  progressing: 'Reading',
}

/** Kept in the menu: not taken by the row it's in (React's events pass through portals). */
const kept = (event: SyntheticEvent) => event.stopPropagation()

function columns(menu: ((repository: HelmRepository) => React.ReactNode) | undefined): Column[] {
  return [
    {
      id: 'name',
      header: 'Name',
      width: 'minmax(150px, 1fr)',
      priority: 1,
      cell: (o) => (
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot health={repositoryHealth(repositoryOf(o))} />
          <span className="truncate font-medium text-ink-1">{repositoryOf(o).name}</span>
        </span>
      ),
      text: (o) => repositoryOf(o).name,
      sort: (o) => repositoryOf(o).name,
    },
    {
      id: 'kind',
      header: 'Kind',
      width: '72px',
      priority: 2,
      cell: (o) => <span>{repositoryOf(o).kind === 'oci' ? 'OCI' : 'HTTP'}</span>,
      sort: (o) => repositoryOf(o).kind,
    },
    {
      id: 'address',
      header: 'Address',
      width: 'minmax(180px, 1.4fr)',
      priority: 1,
      cell: (o) => (
        <span className="truncate font-mono text-xs text-ink-2">{repositoryOf(o).url}</span>
      ),
      // On a phone, why it couldn't be read comes after it (its status says that it couldn't).
      fact: (o) => {
        const read = repositoryOf(o).read
        return (
          <>
            <span className="font-mono">{repositoryOf(o).url}</span>
            {read && 'error' in read && (
              <span className="block text-critical-text">{read.error}</span>
            )}
          </>
        )
      },
      sort: (o) => repositoryOf(o).url,
    },
    {
      id: 'sign-in',
      header: 'Sign-in',
      width: '96px',
      priority: 3,
      cell: (o) =>
        repositoryOf(o).username ? (
          <span className="flex items-center gap-1 text-ink-2">
            <Lock className="size-3.5 text-ink-3" /> Saved
          </span>
        ) : (
          <span className="text-ink-3">None</span>
        ),
      text: (o) => (repositoryOf(o).username ? 'Saved' : 'None'),
      sort: (o) => (repositoryOf(o).username ? 1 : 0),
    },
    {
      id: 'charts',
      header: 'Charts',
      width: '88px',
      align: 'right',
      priority: 2,
      cell: (o) => {
        const read = repositoryOf(o).read
        return <span className="tabular-nums">{read && 'charts' in read ? read.charts : '—'}</span>
      },
      fact: (o) => {
        const read = repositoryOf(o).read
        return read && 'charts' in read
          ? `${read.charts} ${read.charts === 1 ? 'chart' : 'charts'}`
          : undefined
      },
      sort: (o) => {
        const read = repositoryOf(o).read
        return read && 'charts' in read ? read.charts : -1
      },
    },
    {
      // (Its status: on a phone, the row's, on its right.)
      id: 'status',
      header: 'Index',
      width: 'minmax(150px, 1fr)',
      priority: 1,
      cell: (o, ctx) => <IndexCell repository={repositoryOf(o)} now={ctx.now} />,
      text: (o) => {
        const read = repositoryOf(o).read
        return !read ? 'Reading' : 'error' in read ? read.error : `Read at ${read.at}`
      },
      sort: (o) => repositoryHealth(repositoryOf(o)),
    },
    ...(menu
      ? [
          {
            id: 'actions',
            header: '',
            width: '40px',
            priority: 1 as const,
            cell: (o: KubeObject) => menu(repositoryOf(o)),
            fact: false as const,
            text: () => '',
          },
        ]
      : []),
  ]
}

/**
 * The Helm page's Repositories tab: every chart repository and registry Lumovi reads charts from,
 * whether it could read it, and (for whoever may) adding, editing, testing and removing them. A
 * phone reads them; a server's people who aren't its admins read them, and are told who may.
 */
export function RepositoriesTab() {
  const repositories = useHelmRepositories()
  const phone = useLayout() === 'phone'
  const [filter, setFilter] = useState('')
  const [health, setHealth] = useState<Health[]>([])
  const [sort, setSort] = useState({ id: 'name', desc: false })
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<HelmRepository>()
  const [removing, setRemoving] = useState<HelmRepository>()
  const [menuOpen, setMenuOpen] = useState<string>()
  const gridRef = useRef<HTMLDivElement>(null)
  const state = repositories.data
  const mayChange = Boolean(state?.mayChange) && !phone

  const test = async (repository: HelmRepository) => {
    const found = await api.helm.repositories.test({
      id: repository.id,
      name: repository.name,
      kind: repository.kind,
      url: repository.url,
      charts: repository.charts,
      signIn: repository.username ? { username: repository.username } : null,
    })
    if (!found.ok) {
      toast({
        tone: 'error',
        title: `Couldn’t connect to ${repository.name}`,
        description: found.error.message,
      })
      return
    }
    const what =
      'charts' in found.data
        ? `Its index lists ${found.data.charts} ${found.data.charts === 1 ? 'chart' : 'charts'}.`
        : found.data.found.map((each) => `${each.chart}: ${each.versions} versions`).join(', ')
    toast({ tone: 'success', title: `Connected to ${repository.name}`, description: what })
  }

  const menu = (repository: HelmRepository) => (
    <DropdownMenu.Root
      open={menuOpen === repository.id}
      onOpenChange={(open) => setMenuOpen(open ? repository.id : undefined)}
    >
      <DropdownMenu.Trigger asChild onClick={kept} onPointerDown={kept}>
        <IconButton
          label={`Actions for ${repository.name}`}
          className="size-7 data-[state=open]:bg-surface-2 data-[state=open]:text-ink-1"
        >
          <Ellipsis />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className={cn(menuContent, 'w-52')}
          onClick={kept}
          onPointerDown={kept}
          onKeyDown={kept}
        >
          <DropdownMenu.Item className={menuItem} onSelect={() => setEditing(repository)}>
            <Pencil className="size-4 text-ink-3" /> Edit…
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItem} onSelect={() => void test(repository)}>
            <RefreshCw className="size-4 text-ink-3" /> Test connection
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item
            className={cn(menuItem, 'text-critical-text')}
            onSelect={() => setRemoving(repository)}
          >
            <Trash2 className="size-4 text-critical-text" /> Remove…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )

  const shownColumns = columns(mayChange ? menu : undefined)
  const rows: Row[] = (state?.repositories ?? []).map((repository) => ({
    metadata: { name: repository.name, uid: repository.id },
    repository,
  }))
  const counts = countBy(rows, (row) => repositoryHealth(row.repository))
  const needle = filter.trim().toLowerCase()
  const ctx: CellContext = { now: repositories.dataUpdatedAt }
  const column =
    shownColumns.find((c) => c.id === sort.id && c.sort) ??
    shownColumns.find((c) => c.id === 'name')!
  const shown = sortRows(
    rows
      .filter((r) => health.length === 0 || health.includes(repositoryHealth(r.repository)))
      .filter((r) =>
        [r.repository.name, r.repository.url, ...r.repository.charts]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      ),
    column,
    sort.desc,
    ctx,
  )

  let body
  if (repositories.isPending) {
    body = <TableSkeleton columns={shownColumns} label="Loading repositories" />
  } else if (!state) {
    body = (
      <ErrorState
        error={repositories.error as KubeApiError}
        onRetry={() => void repositories.refetch()}
      />
    )
  } else if (rows.length === 0) {
    body = (
      <EmptyState icon={Library} title="No repositories">
        {state.mayChange
          ? 'Add a repository to browse its charts, and to see when a release has a newer one.'
          : 'Lumovi’s admins add repositories here.'}
      </EmptyState>
    )
  } else if (shown.length === 0) {
    body = (
      <EmptyState icon={SearchX} title="Nothing matches">
        No repositories match the current filters.
      </EmptyState>
    )
  } else {
    body = (
      <ResourceTable
        ref={gridRef}
        label="Helm repositories"
        columns={shownColumns}
        rows={shown}
        ctx={ctx}
        sort={{ id: column.id, desc: sort.desc }}
        onSort={(id) => setSort({ id, desc: sort.id === id ? !sort.desc : false })}
        onOpen={(o) => mayChange && setEditing(repositoryOf(o))}
        rowKey={(o) => repositoryOf(o).id}
        pins={false}
      />
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ListBar
        count={`${rows.length} ${rows.length === 1 ? 'repository' : 'repositories'}`}
        chips={
          counts.size > 0 && (
            <HealthChips
              counts={counts}
              active={health}
              onToggle={(h) =>
                setHealth(health.includes(h) ? health.filter((x) => x !== h) : [...health, h])
              }
              name={(h) => HEALTH_NAMES[h] ?? h}
            />
          )
        }
        action={
          mayChange
            ? { icon: <Plus />, label: 'Add repository', onPress: () => setAdding(true) }
            : undefined
        }
        filter={filter}
        noun="repositories"
        onFilter={setFilter}
        onArrowDown={() => gridRef.current?.focus()}
      />
      {state && !state.mayChange && state.kept === 'server' && (
        <p className="border-b border-line px-5 py-2 text-xs text-ink-2">
          {state.admins?.length
            ? `Only Lumovi’s admins add repositories here. The server names them: ${state.admins.join(', ')}.`
            : 'Lumovi’s admins add repositories here, and this server names none. Whoever runs it sets them with LUMOVI_ADMINS.'}
        </p>
      )}
      {body}
      {state && rows.length > 0 && (
        <p className="border-t border-line px-5 py-2 text-xs text-ink-3">
          Lumovi reads each repository every 30 minutes and when this page opens. Charts come only
          from repositories added here.
        </p>
      )}
      {state && adding && <RepositoryDialog state={state} onClose={() => setAdding(false)} />}
      {state && editing && (
        <RepositoryDialog
          state={state}
          repository={editing}
          onClose={() => setEditing(undefined)}
        />
      )}
      {state && removing && (
        <RemoveRepositoryDialog
          state={state}
          repository={removing}
          onClose={() => setRemoving(undefined)}
        />
      )}
    </div>
  )
}

/** The repositories' count, for the Helm page's tab. */
export const repositoryCount = (state?: HelmRepositories) => state?.repositories.length

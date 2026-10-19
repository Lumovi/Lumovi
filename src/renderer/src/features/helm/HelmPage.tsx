import { useLayout } from '@renderer/lib/layout'
import { ArrowUpCircle, PackagePlus, SearchX, ShipWheel } from 'lucide-react'
import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { HelmRelease, KubeObject } from '@shared/api'
import { releaseUpdate, type ReleaseUpdate } from '@shared/helm-repositories'
import { EmptyState, ErrorState, StaleNotice, UnreadNotice } from '@renderer/components/States'
import { StatusPill } from '@renderer/components/Status'
import { TabContent, TabList, Tabs } from '@renderer/components/Tabs'
import { Tooltip } from '@renderer/components/Tooltip'
import { useHelmReleases, useHelmRepositories } from '@renderer/hooks/helm'
import { cn } from '@renderer/lib/cn'
import { useUpdateParams } from '@renderer/hooks/update-params'
import type { KubeApiError } from '@renderer/lib/api'
import { readOf, scopeOf } from '@renderer/lib/namespaces'
import { age } from '@renderer/lib/format'
import { HEALTH_RANK, type Health } from '@renderer/lib/health'
import { releaseStatus } from '@renderer/lib/helm'
import { useCluster } from '@renderer/state/cluster'
import { useListColumns } from '../resources/ColumnsMenu'
import { nameColumn, sortRows, type CellContext, type Column } from '../resources/columns'
import { countBy, HealthChips, ListBar } from '../resources/ListToolbar'
import { listChip, listChipCount } from '../resources/list-look'
import { ResourceTable } from '../resources/ResourceTable'
import { TableSkeleton } from '../resources/TableSkeleton'
import { ChartsTab } from './ChartsTab'
import { DeployDialog } from './DeployDialog'
import { UpdatePill } from './UpdatePill'
import { RepositoriesTab } from './RepositoriesTab'

/** A release as a table row: the table lists objects by namespace and name. */
type Row = KubeObject & { release: HelmRelease; update: ReleaseUpdate }

const release = (o: KubeObject) => (o as Row).release
const updateOf = (o: KubeObject) => (o as Row).update

/** A newer chart, where Lumovi knows where it came from; else a dash, and why where it isn't sure. */
const UPDATE_COLUMN: Column = {
  id: 'update',
  header: 'Update',
  width: 'minmax(170px, 0.9fr)',
  priority: 3,
  cell: (o) => {
    const update = updateOf(o)
    if (update.version) return <UpdatePill version={update.version} />
    return update.why ? (
      <Tooltip content={update.why}>
        <span tabIndex={-1} className="text-ink-3">
          —
        </span>
      </Tooltip>
    ) : (
      <span className="text-ink-3">—</span>
    )
  },
  fact: (o) => (updateOf(o).version ? <UpdatePill version={updateOf(o).version!} /> : undefined),
  text: (o) => (updateOf(o).version ? `Update available: ${updateOf(o).version}` : ''),
  // Newest first by what's available; then those with none.
  sort: (o) => (updateOf(o).version ? 0 : 1),
}

const COLUMNS: Column[] = [
  { ...nameColumn(true), priority: 1 },
  {
    id: 'status',
    header: 'Status',
    width: 'minmax(150px, 0.8fr)',
    priority: 1,
    cell: (o) => (
      <span title={release(o).description} className="min-w-0">
        <StatusPill status={releaseStatus(release(o).status)} />
      </span>
    ),
    sort: (o) => HEALTH_RANK[releaseStatus(release(o).status).health],
  },
  {
    id: 'chart',
    header: 'Chart',
    width: 'minmax(170px, 1fr)',
    priority: 1,
    cell: (o) => (
      <span className="truncate">
        {release(o).chart}
        <span className="text-ink-3"> {release(o).chartVersion}</span>
      </span>
    ),
    sort: (o) => release(o).chart,
  },
  UPDATE_COLUMN,
  {
    id: 'app',
    header: 'App version',
    width: 'minmax(110px, 0.6fr)',
    priority: 2,
    cell: (o) => <span className="truncate">{release(o).appVersion ?? '—'}</span>,
    sort: (o) => release(o).appVersion ?? '',
  },
  {
    id: 'revision',
    header: 'Revision',
    width: '96px',
    align: 'right',
    priority: 3,
    cell: (o) => <span className="tabular-nums">{release(o).revision}</span>,
    sort: (o) => release(o).revision,
  },
  {
    id: 'updated',
    header: 'Updated',
    width: '96px',
    align: 'right',
    priority: 2,
    cell: (o, ctx) => (
      <span className="text-ink-2 tabular-nums">{age(release(o).updated!, ctx.now)}</span>
    ),
    csv: { value: (o) => release(o).updated },
    sort: (o) => Date.parse(release(o).updated!),
  },
]

/** The tabs of the Helm page, as its address names them (?tab=). */
const TABS = ['releases', 'charts', 'repositories'] as const
type Tab = (typeof TABS)[number]

/**
 * The Helm page: its releases (from Helm's records in the cluster), the charts in the repositories
 * Lumovi keeps, and those repositories. The repositories' indexes are read as it opens.
 */
export function HelmPage() {
  const [params] = useSearchParams()
  const updateParams = useUpdateParams()
  const releases = useHelmReleases()
  const repositories = useHelmRepositories({ opening: true })
  const asked = params.get('tab') as Tab | null
  const tab: Tab = asked && TABS.includes(asked) ? asked : 'releases'
  const setTab = (next: string) =>
    updateParams((p) => {
      if (next === 'releases') p.delete('tab')
      else p.set('tab', next)
      p.delete('release')
    })
  const count = (label: string, n: number | undefined) => (
    <>
      {label}
      {n !== undefined && <span className="text-xs font-normal text-ink-3 tabular-nums">{n}</span>}
    </>
  )
  return (
    <Tabs value={tab} onValueChange={setTab} className="flex h-full min-h-0 flex-col">
      <TabList
        tabs={[
          { value: 'releases', label: count('Releases', releases.data?.length) },
          { value: 'charts', label: count('Charts', repositories.data?.charts.length) },
          {
            value: 'repositories',
            label: count('Repositories', repositories.data?.repositories.length),
          },
        ]}
      />
      <TabContent value="releases" className="flex min-h-0 flex-1 flex-col">
        <ReleasesTab />
      </TabContent>
      <TabContent value="charts" className="flex min-h-0 flex-1 flex-col">
        <ChartsTab onRepositories={() => setTab('repositories')} />
      </TabContent>
      <TabContent value="repositories" className="flex min-h-0 flex-1 flex-col">
        <RepositoriesTab />
      </TabContent>
    </Tabs>
  )
}

/** Every Helm release in the cluster (or the namespaces picked), read from Helm's own records. */
function ReleasesTab() {
  const { namespaces } = useCluster()
  const [params] = useSearchParams()
  const updateParams = useUpdateParams()
  const releases = useHelmReleases()
  const repositories = useHelmRepositories()
  const [updatable, setUpdatable] = useState(false)
  const [filter, setFilter] = useState('')
  const [health, setHealth] = useState<Health[]>([])
  const [sort, setSort] = useState({ id: 'name', desc: false })
  const [installing, setInstalling] = useState(false)
  const phone = useLayout() === 'phone'
  const gridRef = useRef<HTMLDivElement>(null)

  const rows: Row[] = (releases.data ?? []).map((r) => ({
    metadata: { name: r.name, namespace: r.namespace, uid: `${r.namespace}/${r.name}` },
    release: r,
    update: repositories.data
      ? releaseUpdate(r, repositories.data.repositories, repositories.data.charts)
      : {},
  }))
  const updates = rows.filter((row) => row.update.version).length
  const counts = countBy(rows, (row) => releaseStatus(row.release.status).health)
  const needle = filter.trim().toLowerCase()
  const open = (o: KubeObject) =>
    updateParams((p) => p.set('release', `${o.metadata.namespace}/${o.metadata.name}`))
  const ctx: CellContext = { now: releases.dataUpdatedAt }
  // The columns as the person chose them for Helm releases in this cluster.
  const chosen = useListColumns({
    list: 'helm',
    columns: COLUMNS,
    listed: rows,
    ctx,
    title: 'Helm releases',
    count: (n) => `${n} ${n === 1 ? 'release' : 'releases'}`,
    namespaced: true,
    labelled: false,
  })
  // (Sorted by a column hidden since, it's sorted by name.)
  const column =
    chosen.columns.find((c) => c.id === sort.id && c.sort) ??
    chosen.columns.find((c) => c.id === 'name')!
  const shown = sortRows(
    rows
      .filter((r) => health.length === 0 || health.includes(releaseStatus(r.release.status).health))
      .filter((r) => !updatable || r.update.version)
      .filter((r) =>
        [r.release.name, r.release.namespace, r.release.chart, r.release.appVersion ?? '']
          .join(' ')
          .toLowerCase()
          .includes(needle),
      ),
    column,
    sort.desc,
    ctx,
  )

  let body
  if (releases.isPending) {
    body = <TableSkeleton columns={chosen.columns} label="Loading releases" />
  } else if (!releases.data) {
    body = (
      <ErrorState error={releases.error as KubeApiError} onRetry={() => void releases.refetch()} />
    )
  } else if (rows.length === 0) {
    body = (
      <>
        <UnreadNotice unread={releases.data?.unread} noun="Helm releases" />
        <EmptyState
          icon={ShipWheel}
          title={`No Helm releases ${scopeOf(readOf(namespaces, releases.data?.unread))}`}
        >
          Releases installed with Helm show up here, with their values, resources and history.
        </EmptyState>
      </>
    )
  } else if (shown.length === 0) {
    body = (
      <EmptyState icon={SearchX} title="Nothing matches">
        No releases match the current filters.
      </EmptyState>
    )
  } else {
    body = (
      <>
        {releases.isError && (
          <StaleNotice
            error={releases.error as KubeApiError}
            onRetry={() => void releases.refetch()}
          />
        )}
        <UnreadNotice unread={releases.data?.unread} noun="Helm releases" />
        <ResourceTable
          ref={gridRef}
          label="Helm releases"
          columns={chosen.columns}
          rows={shown}
          ctx={ctx}
          selected={params.get('release') ?? undefined}
          sort={{ id: column.id, desc: sort.desc }}
          onSort={(id) => setSort({ id, desc: sort.id === id ? !sort.desc : false })}
          onOpen={open}
          followSelection={params.has('release')}
          layout={chosen.layout}
        />
      </>
    )
  }

  return (
    <div className="relative flex h-full flex-col">
      <ListBar
        count={`${rows.length} ${rows.length === 1 ? 'release' : 'releases'}`}
        chips={
          counts.size > 0 && (
            <>
              <HealthChips
                counts={counts}
                active={health}
                onToggle={(h) =>
                  setHealth(health.includes(h) ? health.filter((x) => x !== h) : [...health, h])
                }
                name={(h) => RELEASE_HEALTH_NAMES[h]}
              />
              {(updates > 0 || updatable) && (
                <button
                  type="button"
                  aria-pressed={updatable}
                  onClick={() => setUpdatable(!updatable)}
                  className={cn(
                    listChip(updatable),
                    !updatable && 'border-accent/30 text-accent-strong',
                  )}
                >
                  <ArrowUpCircle className="size-3.5" />
                  Update available
                  <span className={listChipCount}>{updates}</span>
                </button>
              )}
            </>
          )
        }
        // A phone reads releases: charts are installed from a larger screen.
        action={
          phone
            ? undefined
            : { icon: <PackagePlus />, label: 'Install chart', onPress: () => setInstalling(true) }
        }
        filter={filter}
        noun="releases"
        onFilter={setFilter}
        onArrowDown={() => gridRef.current?.focus()}
        after={chosen.button(shown)}
      />
      {body}
      {installing && <DeployDialog onClose={() => setInstalling(false)} />}
    </div>
  )
}

/** What each health level means for a release, in the filter chips. */
const RELEASE_HEALTH_NAMES: Record<Health, string> = {
  healthy: 'Deployed',
  progressing: 'Pending',
  warning: 'Uninstalling',
  critical: 'Failed',
  neutral: 'Other',
}

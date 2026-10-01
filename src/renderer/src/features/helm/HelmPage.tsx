import { PackagePlus, SearchX, ShipWheel } from 'lucide-react'
import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { HelmRelease, KubeObject } from '@shared/api'
import { Button } from '@renderer/components/Button'
import { SearchInput } from '@renderer/components/SearchInput'
import { EmptyState, ErrorState, StaleNotice } from '@renderer/components/States'
import { HEALTH_STYLE, StatusPill } from '@renderer/components/Status'
import { useHelmReleases } from '@renderer/hooks/helm'
import { useUpdateParams } from '@renderer/hooks/update-params'
import type { KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { age } from '@renderer/lib/format'
import { HEALTH_RANK, type Health } from '@renderer/lib/health'
import { releaseStatus } from '@renderer/lib/helm'
import { useCluster } from '@renderer/state/cluster'
import { nameColumn, sortRows, type CellContext, type Column } from '../resources/columns'
import { ResourceTable } from '../resources/ResourceTable'
import { TableSkeleton } from '../resources/TableSkeleton'
import { DeployDialog } from './DeployDialog'

/** A release as a table row: the table lists objects by namespace and name. */
type Row = KubeObject & { release: HelmRelease }

const release = (o: KubeObject) => (o as Row).release

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
    sort: (o) => Date.parse(release(o).updated!),
  },
]

const HEALTH_ORDER = (Object.keys(HEALTH_RANK) as Health[]).sort(
  (a, b) => HEALTH_RANK[a] - HEALTH_RANK[b],
)

/** Every Helm release in the cluster (or the namespace picked), read from Helm's own records. */
export function HelmPage() {
  const { namespace } = useCluster()
  const [params] = useSearchParams()
  const updateParams = useUpdateParams()
  const releases = useHelmReleases()
  const [filter, setFilter] = useState('')
  const [health, setHealth] = useState<Health[]>([])
  const [sort, setSort] = useState({ id: 'name', desc: false })
  const [installing, setInstalling] = useState(false)
  const gridRef = useRef<HTMLDivElement>(null)

  const rows: Row[] = (releases.data ?? []).map((r) => ({
    metadata: { name: r.name, namespace: r.namespace, uid: `${r.namespace}/${r.name}` },
    release: r,
  }))
  const counts = new Map<Health, number>()
  for (const row of rows) {
    const h = releaseStatus(row.release.status).health
    counts.set(h, (counts.get(h) ?? 0) + 1)
  }
  const needle = filter.trim().toLowerCase()
  const open = (o: KubeObject) =>
    updateParams((p) => p.set('release', `${o.metadata.namespace}/${o.metadata.name}`))
  const ctx: CellContext = { now: releases.dataUpdatedAt }
  const column = COLUMNS.find((c) => c.id === sort.id)!
  const shown = sortRows(
    rows
      .filter((r) => health.length === 0 || health.includes(releaseStatus(r.release.status).health))
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
    body = <TableSkeleton columns={COLUMNS} label="Loading releases" />
  } else if (!releases.data) {
    body = (
      <ErrorState error={releases.error as KubeApiError} onRetry={() => void releases.refetch()} />
    )
  } else if (rows.length === 0) {
    body = (
      <EmptyState
        icon={ShipWheel}
        title={`No Helm releases ${namespace ? `in ${namespace}` : 'in this cluster'}`}
      >
        Releases installed with Helm show up here, with their values, resources and history.
      </EmptyState>
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
        <ResourceTable
          ref={gridRef}
          label="Helm releases"
          columns={COLUMNS}
          rows={shown}
          ctx={ctx}
          selected={params.get('release') ?? undefined}
          sort={sort}
          onSort={(id) => setSort({ id, desc: sort.id === id ? !sort.desc : false })}
          onOpen={open}
          followSelection={params.has('release')}
        />
      </>
    )
  }

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <span className="mr-1 text-[13px] text-ink-2 tabular-nums">
          {rows.length} {rows.length === 1 ? 'release' : 'releases'}
        </span>
        {HEALTH_ORDER.filter((h) => counts.has(h)).map((h) => {
          const active = health.includes(h)
          return (
            <button
              key={h}
              type="button"
              aria-pressed={active}
              onClick={() => setHealth(active ? health.filter((x) => x !== h) : [...health, h])}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors',
                active
                  ? 'border-transparent bg-ink-1 text-surface'
                  : 'border-line text-ink-2 hover:border-line-strong hover:text-ink-1',
              )}
            >
              <span aria-hidden className={cn('size-1.5 rounded-full', HEALTH_STYLE[h].dot)} />
              {RELEASE_HEALTH_NAMES[h]}
              <span className="font-semibold tabular-nums">{counts.get(h)}</span>
            </button>
          )
        })}
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => setInstalling(true)}>
          <PackagePlus /> Install chart
        </Button>
        <SearchInput
          value={filter}
          onChange={setFilter}
          onArrowDown={() => gridRef.current?.focus()}
          placeholder="Filter releases"
          className="w-60"
        />
      </div>
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

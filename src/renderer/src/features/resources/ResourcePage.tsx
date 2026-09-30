import { Gauge, SearchX } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import type { KubeObject } from '@shared/api'
import { resourceByKind, type ResourceKind } from '@shared/resources'
import { KIND_ICONS } from '@renderer/components/KindIcon'
import { SearchInput } from '@renderer/components/SearchInput'
import { EmptyState, ErrorState, Loading } from '@renderer/components/States'
import { HEALTH_STYLE } from '@renderer/components/Status'
import { useList, useMetrics } from '@renderer/hooks/queries'
import type { KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { pluralize } from '@renderer/lib/format'
import { HEALTH_RANK, hasHealth, statusOf, type Health } from '@renderer/lib/health'
import { formatRef } from '@renderer/lib/routes'
import { useCluster } from '@renderer/state/cluster'
import { columnsFor, metricsKey, sortRows, type CellContext } from './columns'
import { ResourceTable, type SortState } from './ResourceTable'

const METRICS_TARGET: Partial<Record<ResourceKind, 'pods' | 'nodes'>> = {
  Pod: 'pods',
  Node: 'nodes',
}

const HEALTH_ORDER = (Object.keys(HEALTH_RANK) as Health[]).sort(
  (a, b) => HEALTH_RANK[a] - HEALTH_RANK[b],
)

/** The text the filter box matches against. */
function searchText(object: KubeObject): string {
  const labels = Object.entries(object.metadata.labels ?? {}).map(([k, v]) => `${k}=${v}`)
  const event =
    object.kind === 'Event'
      ? [object.reason, object.message, (object.involvedObject as { name: string }).name]
      : []
  return [object.metadata.name, object.metadata.namespace, ...labels, ...event]
    .join(' ')
    .toLowerCase()
}

export function ResourcePage({ kind }: { kind: ResourceKind }) {
  const resource = resourceByKind(kind)
  const { namespace } = useCluster()
  const [params, setParams] = useSearchParams()
  const list = useList(kind, { namespace: resource.namespaced ? undefined : null })
  const metricsTarget = METRICS_TARGET[kind]
  const metrics = useMetrics(
    metricsTarget ?? 'pods',
    resource.namespaced ? namespace : null,
    metricsTarget !== undefined,
  )

  const [filter, setFilter] = useState('')
  const [healthFilter, setHealthFilter] = useState<Health | null>(null)
  const withHealth = hasHealth(kind)
  const showNamespace = resource.namespaced && namespace === null
  const { columns, defaultSort } = columnsFor(kind, { showNamespace, hasHealth: withHealth })
  const [sort, setSort] = useState<SortState>({ id: defaultSort, desc: false })

  const open: CellContext['open'] = (target, name, ns) =>
    setParams({ open: formatRef({ kind: target, name, namespace: ns }) })
  const ctx: CellContext = {
    // Ages are relative to the last refresh, which keeps rendering pure.
    now: list.dataUpdatedAt,
    open,
    metrics: metrics.data?.available
      ? new Map(
          metrics.data.items.map((sample) => [metricsKey(sample.namespace, sample.name), sample]),
        )
      : undefined,
  }

  const items = list.data ?? []
  const counts = new Map<Health, number>()
  if (withHealth) {
    for (const object of items) {
      const { health } = statusOf(kind, object)
      counts.set(health, (counts.get(health) ?? 0) + 1)
    }
  }

  const needle = filter.trim().toLowerCase()
  const column = columns.find((c) => c.id === sort.id)!
  const matching = items
    .filter((o) => !healthFilter || statusOf(kind, o).health === healthFilter)
    .filter((o) => !needle || searchText(o).includes(needle))
  const rows = sortRows(matching, column, sort.desc, ctx)

  const onSort = (id: string) =>
    setSort((current) => ({ id, desc: current.id === id ? !current.desc : false }))
  const scope = resource.namespaced && namespace ? `in ${namespace}` : 'in this cluster'

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <span className="mr-1 text-[13px] text-ink-2 tabular-nums">
          {pluralize(items.length, resource.kind === 'Event' ? 'event' : 'item')}
        </span>
        {HEALTH_ORDER.filter((h) => counts.has(h)).map((health) => {
          const style = HEALTH_STYLE[health]
          const active = healthFilter === health
          return (
            <button
              key={health}
              type="button"
              aria-pressed={active}
              onClick={() => setHealthFilter(active ? null : health)}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors',
                active
                  ? 'border-transparent bg-ink-1 text-surface'
                  : 'border-line text-ink-2 hover:border-line-strong hover:text-ink-1',
              )}
            >
              <span aria-hidden className={cn('size-1.5 rounded-full', style.dot)} />
              {style.name}
              <span className="font-semibold tabular-nums">{counts.get(health)}</span>
            </button>
          )
        })}
        <div className="flex-1" />
        {metrics.data?.available === false && (
          <span className="flex items-center gap-1.5 text-xs text-ink-3">
            <Gauge className="size-3.5" /> Live usage needs metrics-server
          </span>
        )}
        <SearchInput
          value={filter}
          onChange={setFilter}
          placeholder={`Filter ${resource.label.toLowerCase()}`}
          className="w-64"
        />
      </div>

      {list.isPending ? (
        <Loading label={`Loading ${resource.label.toLowerCase()}…`} />
      ) : list.isError ? (
        <ErrorState error={list.error as KubeApiError} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState icon={KIND_ICONS[kind]} title={`No ${resource.label.toLowerCase()} ${scope}`}>
          {resource.namespaced && namespace
            ? 'Try another namespace, or all namespaces.'
            : 'Nothing to show yet.'}
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState icon={SearchX} title="Nothing matches">
          No {resource.label.toLowerCase()} match the current filters.
        </EmptyState>
      ) : (
        <ResourceTable
          label={resource.label}
          columns={columns}
          rows={rows}
          ctx={ctx}
          selected={params.get('open')?.replace(`${kind}/`, '')}
          sort={sort}
          onSort={onSort}
          onOpen={(o) => open(kind, o.metadata.name, o.metadata.namespace)}
        />
      )}
    </div>
  )
}

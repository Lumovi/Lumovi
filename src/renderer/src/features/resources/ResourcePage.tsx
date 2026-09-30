import { Gauge, Info, SearchX, Tag } from 'lucide-react'
import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { KubeObject } from '@shared/api'
import { resourceByKind, type ResourceKind } from '@shared/resources'
import { KIND_ICONS } from '@renderer/components/KindIcon'
import { SearchInput } from '@renderer/components/SearchInput'
import { EmptyState, ErrorState, StaleNotice } from '@renderer/components/States'
import { HEALTH_STYLE } from '@renderer/components/Status'
import { useOpenObject } from '@renderer/hooks/open-object'
import { useList, useListTotals, useMetrics } from '@renderer/hooks/queries'
import type { KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { HEALTH_RANK, hasHealth, healthName, statusOf, type Health } from '@renderer/lib/health'
import { useCluster } from '@renderer/state/cluster'
import { columnsFor, metricsKey, sortRows, type CellContext } from './columns'
import { useListState } from './list-state'
import { Pagination } from './Pagination'
import { ResourceTable } from './ResourceTable'
import { TableSkeleton } from './TableSkeleton'

const METRICS_TARGET: Partial<Record<ResourceKind, 'pods' | 'nodes'>> = {
  Pod: 'pods',
  Node: 'nodes',
}

const HEALTH_ORDER = (Object.keys(HEALTH_RANK) as Health[]).sort(
  (a, b) => HEALTH_RANK[a] - HEALTH_RANK[b],
)

const number = new Intl.NumberFormat()

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
  const noun = resource.label.toLowerCase()
  const { namespace } = useCluster()
  const [params] = useSearchParams()
  const withHealth = hasHealth(kind)
  const showNamespace = resource.namespaced && namespace === null
  const { columns, defaultSort } = columnsFor(kind, { showNamespace, hasHealth: withHealth })
  const [state, update] = useListState(defaultSort)
  const gridRef = useRef<HTMLDivElement>(null)
  const labelsRef = useRef<HTMLInputElement>(null)
  const [labelDraft, setLabelDraft] = useState(state.labels)

  const query = {
    namespace: resource.namespaced ? undefined : null,
    labelSelector: state.labels || undefined,
  }
  const list = useList(kind, query)
  const totals = useListTotals(kind, query)
  const metricsTarget = METRICS_TARGET[kind]
  const metrics = useMetrics(
    metricsTarget ?? 'pods',
    resource.namespaced ? namespace : null,
    metricsTarget !== undefined,
  )

  const open = useOpenObject()
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

  const needle = state.q.trim().toLowerCase()
  const column = columns.find((c) => c.id === state.sort) ?? columns[0]!
  const matching = items
    .filter((o) => state.health.length === 0 || state.health.includes(statusOf(kind, o).health))
    .filter((o) => !needle || searchText(o).includes(needle))
  const rows = sortRows(matching, column, state.desc, ctx)
  const pages = Math.max(1, Math.ceil(rows.length / state.size))
  const page = Math.min(state.page, pages)
  const pageRows = rows.slice((page - 1) * state.size, page * state.size)

  const toggleHealth = (health: Health) =>
    update({
      health: state.health.includes(health)
        ? state.health.filter((h) => h !== health)
        : [...state.health, health],
    })
  const onSort = (id: string) => update({ sort: id, desc: state.sort === id ? !state.desc : false })
  const goToPage = (next: number) => update({ page: Math.max(1, Math.min(pages, next)) })
  const scope = resource.namespaced && namespace ? `in ${namespace}` : 'in this cluster'

  let body
  if (list.isPending) {
    body = <TableSkeleton columns={columns} label={`Loading ${noun}`} />
  } else if (!list.data) {
    body = <ErrorState error={list.error as KubeApiError} onRetry={() => void list.refetch()} />
  } else if (items.length === 0) {
    body = (
      <EmptyState icon={KIND_ICONS[kind]} title={`No ${noun} ${scope}`}>
        {state.labels
          ? `Nothing matches the label selector “${state.labels}”.`
          : resource.namespaced && namespace
            ? 'Try another namespace, or all namespaces.'
            : 'Nothing to show yet.'}
      </EmptyState>
    )
  } else if (rows.length === 0) {
    body = (
      <EmptyState icon={SearchX} title="Nothing matches">
        No {noun} match the current filters.
      </EmptyState>
    )
  } else {
    body = (
      <>
        {list.isError && (
          <StaleNotice error={list.error as KubeApiError} onRetry={() => void list.refetch()} />
        )}
        <ResourceTable
          resetKey={`${page}/${state.size}`}
          ref={gridRef}
          label={resource.label}
          columns={columns}
          rows={pageRows}
          ctx={ctx}
          selected={params.get('open')?.replace(`${kind}/`, '')}
          sort={{ id: column.id, desc: state.desc }}
          onSort={onSort}
          onOpen={(o) => open(kind, o.metadata.name, o.metadata.namespace)}
          onPage={(delta) => goToPage(page + delta)}
          followSelection={params.has('open')}
        />
        <Pagination
          page={page}
          size={state.size}
          count={rows.length}
          onPage={goToPage}
          onSize={(size) => update({ size })}
        />
      </>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <span className="mr-1 text-[13px] text-ink-2 tabular-nums">
          {number.format(items.length)} {items.length === 1 ? 'item' : 'items'}
        </span>
        {HEALTH_ORDER.filter((h) => counts.has(h)).map((health) => {
          const style = HEALTH_STYLE[health]
          const active = state.health.includes(health)
          return (
            <button
              key={health}
              type="button"
              aria-pressed={active}
              onClick={() => toggleHealth(health)}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors',
                active
                  ? 'border-transparent bg-ink-1 text-surface'
                  : 'border-line text-ink-2 hover:border-line-strong hover:text-ink-1',
              )}
            >
              <span aria-hidden className={cn('size-1.5 rounded-full', style.dot)} />
              {healthName(kind, health)}
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
        <label
          className={cn(
            'flex h-8 w-52 items-center gap-2 rounded-lg border bg-surface px-2.5 text-ink-3 transition-colors no-drag focus-within:border-accent focus-within:ring-3 focus-within:ring-accent-soft',
            state.labels ? 'border-accent/60' : 'border-line',
          )}
        >
          <Tag className="size-3.5 shrink-0" />
          <input
            ref={labelsRef}
            aria-label="Label selector"
            value={labelDraft}
            onChange={(event) => setLabelDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') update({ labels: labelDraft.trim() })
            }}
            onBlur={() => setLabelDraft(state.labels)}
            placeholder="Label selector, e.g. app=web"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-ink-1 outline-none placeholder:font-sans placeholder:text-[13px] placeholder:text-ink-3"
          />
        </label>
        <SearchInput
          value={state.q}
          onChange={(q) => update({ q })}
          onArrowDown={() => gridRef.current?.focus()}
          placeholder={`Filter ${noun}`}
          className="w-60"
        />
      </div>

      {totals?.truncated && (
        <p
          role="note"
          className="flex shrink-0 items-center gap-2 border-b border-line bg-accent-soft px-5 py-2 text-xs text-ink-2"
        >
          <Info className="size-3.5 shrink-0 text-accent-strong" />
          <span className="flex-1">
            Showing the first {number.format(totals.loaded)}
            {totals.total ? ` of ${number.format(totals.total)}` : ''} {noun}. Choose a namespace or
            use a label selector to see the rest.
          </span>
          <button
            type="button"
            onClick={() => labelsRef.current?.focus()}
            className="font-medium text-accent-strong hover:underline"
          >
            Filter by label
          </button>
        </p>
      )}

      {body}
    </div>
  )
}

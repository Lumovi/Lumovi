import { Gauge, Info, Pin, PinOff, SearchX, Tag } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'
import type { KubeObject } from '@shared/api'
import {
  apiKindOf,
  isBuiltinKind,
  type ResourceDefinition,
  type ResourceKind,
} from '@shared/resources'
import { IconButton } from '@renderer/components/Button'
import { kindIcon } from '@renderer/components/KindIcon'
import { SearchInput } from '@renderer/components/SearchInput'
import { EmptyState, ErrorState, Loading, StaleNotice } from '@renderer/components/States'
import { HEALTH_STYLE } from '@renderer/components/Status'
import { useOpenObject } from '@renderer/hooks/open-object'
import { objectKey, useListResponse, useListTotals, useMetrics } from '@renderer/hooks/queries'
import { useResource } from '@renderer/hooks/resources'
import { useViews } from '@renderer/hooks/views'
import type { KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import {
  HEALTH_RANK,
  hasHealth,
  healthName,
  statusFor,
  statusOf,
  type Health,
} from '@renderer/lib/health'
import { fieldValue, viewFor } from '@renderer/lib/views'
import { useCluster } from '@renderer/state/cluster'
import { usePrefs } from '@renderer/state/prefs'
import { SelectionBar } from '../actions/BulkActions'
import { columnsFor, customColumnsFor, metricsKey, sortRows, type CellContext } from './columns'
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

/** The text the filter box matches against, with what the server's columns show. */
function searchText(object: KubeObject, cells: unknown[] = []): string {
  const labels = Object.entries(object.metadata.labels ?? {}).map(([k, v]) => `${k}=${v}`)
  const event =
    object.kind === 'Event'
      ? [object.reason, object.message, (object.involvedObject as { name: string }).name]
      : []
  return [object.metadata.name, object.metadata.namespace, ...labels, ...event, ...cells]
    .join(' ')
    .toLowerCase()
}

/** The list of a kind the cluster serves beyond the built-in ones (`r/:kind`). */
export function CustomResourcePage() {
  const kind = useParams().kind!
  const { context } = useCluster()
  const { resource, pending, error, retry } = useResource(kind)
  if (resource) return <ResourcePage key={kind} resource={resource} />
  if (pending) return <Loading label={`Loading ${apiKindOf(kind)}…`} />
  if (error) return <ErrorState error={error as KubeApiError} onRetry={retry} />
  return (
    <EmptyState icon={kindIcon(kind)} title={`${context} doesn’t serve ${kind}`}>
      Its CustomResourceDefinition may have been removed, or never installed in this cluster.
    </EmptyState>
  )
}

export function ResourcePage({ resource }: { resource: ResourceDefinition }) {
  const kind = resource.kind
  const builtin = isBuiltinKind(kind)
  const noun = builtin ? resource.label.toLowerCase() : resource.label
  const { context, namespace } = useCluster()
  const touchKind = usePrefs((prefs) => prefs.touchKind)
  // Custom kinds opened lately stay at hand in the sidebar.
  useEffect(() => {
    if (!builtin) touchKind(context, kind)
  }, [builtin, context, kind, touchKind])
  const [params] = useSearchParams()
  // Views decide the columns, status and icon of the kinds they cover.
  useViews()
  const showNamespace = resource.namespaced && namespace === null
  // Built-in kinds know their columns; others learn them, and whether they have a status, from the list.
  const builtinColumns = builtin
    ? columnsFor(kind, { showNamespace, hasHealth: hasHealth(kind) })
    : undefined
  const [state, update] = useListState(builtinColumns?.defaultSort ?? 'status')
  const gridRef = useRef<HTMLDivElement>(null)
  // Rows picked for bulk actions, for this list only.
  const scopeKey = `${kind}/${namespace}`
  const [picked, setPicked] = useState<{ scope: string; keys: ReadonlySet<string> }>({
    scope: scopeKey,
    keys: new Set(),
  })
  if (picked.scope !== scopeKey) setPicked({ scope: scopeKey, keys: new Set() })
  const labelsRef = useRef<HTMLInputElement>(null)
  const [labelDraft, setLabelDraft] = useState(state.labels)

  const query = {
    namespace: resource.namespaced ? undefined : null,
    labelSelector: state.labels || undefined,
  }
  const response = useListResponse(kind, query)
  const list = { ...response, data: response.data?.items }
  const totals = useListTotals(kind, query)
  const table = response.data?.table
  const items = list.data ?? []
  const view = builtin ? undefined : viewFor(kind)
  const withHealth = builtin
    ? hasHealth(kind)
    : items.some((object) => statusFor(kind, object) !== null)
  const { columns } =
    builtinColumns ?? customColumnsFor({ kind, showNamespace, hasHealth: withHealth, view, table })
  const cells = table
    ? new Map(items.map((item, i) => [item, table.cells[i]!] as const))
    : undefined
  // The filter also matches what the view's or the server's columns show.
  const shownValues = (object: KubeObject): unknown[] | undefined =>
    view?.columns
      ? view.columns.map((column) => fieldValue(column, object).text)
      : cells?.get(object)
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
    cells,
    metrics: metrics.data?.available
      ? new Map(
          metrics.data.items.map((sample) => [metricsKey(sample.namespace, sample.name), sample]),
        )
      : undefined,
  }

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
    .filter((o) => !needle || searchText(o, shownValues(o)).includes(needle))
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
      <EmptyState icon={kindIcon(kind)} title={`No ${noun} ${scope}`}>
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
          picked={kind === 'Event' ? undefined : picked.keys}
          onPick={kind === 'Event' ? undefined : (keys) => setPicked({ scope: scopeKey, keys })}
        />
        <SelectionBar
          kind={kind}
          // Only what's on screen: rows hidden by a filter since stay out of it.
          objects={rows.filter((o) => picked.keys.has(objectKey(o)))}
          onClear={() => setPicked({ scope: scopeKey, keys: new Set() })}
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
    <div className="relative flex h-full flex-col">
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
        {!builtin && <PinButton kind={kind} label={resource.label} />}
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

/** Pins a kind to the sidebar, above the custom resources, in every cluster that has it. */
function PinButton({ kind, label }: { kind: ResourceKind; label: string }) {
  const pinned = usePrefs((prefs) => prefs.pinned.includes(kind))
  const setPinned = usePrefs((prefs) => prefs.setPinned)
  return (
    <IconButton
      label={pinned ? `Unpin ${label} from the sidebar` : `Pin ${label} to the sidebar`}
      onClick={() => setPinned(kind, !pinned)}
      aria-pressed={pinned}
    >
      {pinned ? <PinOff /> : <Pin />}
    </IconButton>
  )
}

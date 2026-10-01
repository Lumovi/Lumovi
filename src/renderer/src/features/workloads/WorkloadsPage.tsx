import { Boxes, Gauge, Info, SearchX } from 'lucide-react'
import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { KubeObject } from '@shared/api'
import { builtinResource, kindOf } from '@shared/resources'
import { SearchInput } from '@renderer/components/SearchInput'
import { EmptyState, ErrorState, StaleNotice } from '@renderer/components/States'
import { useOpenObject } from '@renderer/hooks/open-object'
import { useList, useListResponse, useMetrics } from '@renderer/hooks/queries'
import type { KubeApiError } from '@renderer/lib/api'
import { HEALTH_NAMES, statusOf } from '@renderer/lib/health'
import {
  autoscalers,
  containersOf,
  listedWorkloads,
  podWorkloads,
  workloadUsage,
  type WorkloadLists,
} from '@renderer/lib/workloads'
import { useCluster } from '@renderer/state/cluster'
import { SelectionBar } from '../actions/BulkActions'
import { sortRows, type CellContext } from '../resources/columns'
import { useListState } from '../resources/list-state'
import { countBy, HealthChips, LabelSelector } from '../resources/ListToolbar'
import { Pagination } from '../resources/Pagination'
import { ResourceTable } from '../resources/ResourceTable'
import { TableSkeleton } from '../resources/TableSkeleton'
import { rowKey, workloadColumns } from './columns'
import { WorkloadTabs } from './WorkloadTabs'

const number = new Intl.NumberFormat()

/** The text the filter box matches: names, namespaces, labels, kinds and images. */
function searchText(object: KubeObject): string {
  const labels = Object.entries(object.metadata.labels ?? {}).map(([k, v]) => `${k}=${v}`)
  const images = containersOf(object).map((c) => c.image)
  return [object.metadata.name, object.metadata.namespace, object.kind, ...labels, ...images]
    .join(' ')
    .toLowerCase()
}

/** Every workload in the cluster (or the namespace picked), whatever its kind, in one list. */
export function WorkloadsPage() {
  const { namespace } = useCluster()
  const [params] = useSearchParams()
  const [state, update] = useListState('status')
  const gridRef = useRef<HTMLDivElement>(null)
  const labelsRef = useRef<HTMLInputElement>(null)
  const open = useOpenObject()
  // Rows picked for bulk actions, for this namespace only.
  const [picked, setPicked] = useState<{ scope: string | null; keys: ReadonlySet<string> }>({
    scope: namespace,
    keys: new Set(),
  })
  if (picked.scope !== namespace) setPicked({ scope: namespace, keys: new Set() })

  const query = { labelSelector: state.labels || undefined }
  const queries = {
    Deployment: useListResponse('Deployment', query),
    StatefulSet: useListResponse('StatefulSet', query),
    DaemonSet: useListResponse('DaemonSet', query),
    CronJob: useListResponse('CronJob', query),
    Job: useListResponse('Job', query),
    ReplicaSet: useListResponse('ReplicaSet', query),
    Pod: useListResponse('Pod', query),
  }
  const all = Object.entries(queries) as [keyof WorkloadLists, (typeof queries)['Pod']][]
  const lists = Object.fromEntries(
    all.map(([kind, q]) => [kind, q.data?.items ?? []]),
  ) as unknown as WorkloadLists
  const hpas = useList('HorizontalPodAutoscaler').data ?? []
  const metrics = useMetrics('pods', namespace)
  const usage = metrics.data?.available
    ? workloadUsage(metrics.data.items, podWorkloads(lists))
    : undefined

  const workloads = listedWorkloads(lists)
  const columns = workloadColumns({
    showNamespace: namespace === null,
    usage: usage !== undefined,
    scalers: autoscalers(hpas),
  })
  const ctx: CellContext = {
    // Ages are relative to the last refresh, which keeps rendering pure.
    now: Math.max(...all.map(([, q]) => q.dataUpdatedAt)),
    metrics: usage,
  }
  const counts = countBy(workloads, (o) => statusOf(kindOf(o), o).health)
  const needle = state.q.trim().toLowerCase()
  const column = columns.find((c) => c.id === state.sort) ?? columns[0]!
  const matching = workloads
    .filter(
      (o) => state.health.length === 0 || state.health.includes(statusOf(kindOf(o), o).health),
    )
    .filter((o) => !needle || searchText(o).includes(needle))
  const rows = sortRows(matching, column, state.desc, ctx)
  const pages = Math.max(1, Math.ceil(rows.length / state.size))
  const page = Math.min(state.page, pages)
  const pageRows = rows.slice((page - 1) * state.size, page * state.size)
  const goToPage = (next: number) => update({ page: Math.max(1, Math.min(pages, next)) })

  // Lists that couldn't be read leave their kind out; ones that couldn't be refreshed keep it.
  const unread = all.filter(([, q]) => q.isError && !q.data)
  const stale = all.find(([, q]) => q.isError && q.data)?.[1]
  const truncated = all.some(([, q]) => q.data?.truncated)
  const retry = () => all.forEach(([, q]) => void q.refetch())
  const scope = namespace ? `in ${namespace}` : 'in this cluster'

  let body
  if (all.some(([, q]) => q.isPending)) {
    body = <TableSkeleton columns={columns} label="Loading workloads" />
  } else if (unread.length === all.length) {
    body = <ErrorState error={unread[0]![1].error as KubeApiError} onRetry={retry} />
  } else if (workloads.length === 0) {
    body = (
      <EmptyState icon={Boxes} title={`No workloads ${scope}`}>
        {state.labels
          ? `Nothing matches the label selector “${state.labels}”.`
          : 'Deployments, StatefulSets, DaemonSets, Jobs and CronJobs show up here.'}
      </EmptyState>
    )
  } else if (rows.length === 0) {
    body = (
      <EmptyState icon={SearchX} title="Nothing matches">
        No workloads match the current filters.
      </EmptyState>
    )
  } else {
    body = (
      <>
        <ResourceTable
          resetKey={`${page}/${state.size}`}
          ref={gridRef}
          label="Workloads"
          columns={columns}
          rows={pageRows}
          ctx={ctx}
          rowKey={rowKey}
          selected={params.get('open') ?? undefined}
          sort={{ id: column.id, desc: state.desc }}
          onSort={(id) => update({ sort: id, desc: state.sort === id ? !state.desc : false })}
          onOpen={(o) => open(kindOf(o), o.metadata.name, o.metadata.namespace)}
          onPage={(delta) => goToPage(page + delta)}
          followSelection={params.has('open')}
          picked={picked.keys}
          onPick={(keys) => setPicked({ scope: namespace, keys })}
        />
        <SelectionBar
          noun="workloads"
          // Only what's on screen: rows hidden by a filter since stay out of it.
          objects={rows.filter((o) => picked.keys.has(rowKey(o)))}
          onClear={() => setPicked({ scope: namespace, keys: new Set() })}
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
      <WorkloadTabs />
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <span className="mr-1 text-[13px] text-ink-2 tabular-nums">
          {number.format(workloads.length)} {workloads.length === 1 ? 'workload' : 'workloads'}
        </span>
        <HealthChips
          counts={counts}
          active={state.health}
          onToggle={(health) =>
            update({
              health: state.health.includes(health)
                ? state.health.filter((h) => h !== health)
                : [...state.health, health],
            })
          }
          name={(health) => HEALTH_NAMES[health]}
        />
        <div className="flex-1" />
        {metrics.data?.available === false && (
          <span className="flex items-center gap-1.5 text-xs text-ink-3">
            <Gauge className="size-3.5" /> Live usage needs metrics-server
          </span>
        )}
        <LabelSelector
          ref={labelsRef}
          value={state.labels}
          onApply={(labels) => update({ labels })}
        />
        <SearchInput
          value={state.q}
          onChange={(q) => update({ q })}
          onArrowDown={() => gridRef.current?.focus()}
          placeholder="Filter workloads"
          className="w-60"
        />
      </div>
      {unread.length > 0 && unread.length < all.length && (
        <div role="status" className="shrink-0 border-b border-warn/25 bg-warn/10 px-5 py-1.5">
          {unread.map(([kind, q]) => (
            <p key={kind} className="truncate text-xs text-warn-text">
              Couldn’t list {builtinResource(kind)!.label}: {(q.error as KubeApiError).message}
            </p>
          ))}
        </div>
      )}
      {stale && (
        <StaleNotice error={stale.error as KubeApiError} onRetry={() => void stale.refetch()} />
      )}
      {truncated && (
        <p
          role="note"
          className="flex shrink-0 items-center gap-2 border-b border-line bg-accent-soft px-5 py-2 text-xs text-ink-2"
        >
          <Info className="size-3.5 shrink-0 text-accent-strong" />
          <span className="flex-1">
            Some lists are too long to load whole, so some workloads may be missing. Choose a
            namespace or use a label selector to see them all.
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

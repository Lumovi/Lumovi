import { useState } from 'react'
import type { KubeObject } from '@shared/api'
import {
  apiKindOf,
  isBuiltinKind,
  kindOf,
  type ResourceDefinition,
  type ResourceKind,
} from '@shared/resources'
import { kindIcon } from '@renderer/components/KindIcon'
import { EmptyState, ErrorState, Loading } from '@renderer/components/States'
import { useOpenObject } from '@renderer/hooks/open-object'
import { useListResponse, useMetrics } from '@renderer/hooks/queries'
import { resourceFor, useResource } from '@renderer/hooks/resources'
import type { KubeApiError } from '@renderer/lib/api'
import { hasHealth, statusFor } from '@renderer/lib/health'
import { viewFor, viewRelated, type RelatedQuery } from '@renderer/lib/views'
import {
  columnsFor,
  customColumnsFor,
  metricsKey,
  sortRows,
  type CellContext,
} from '../resources/columns'
import { Pagination } from '../resources/Pagination'
import { ResourceTable } from '../resources/ResourceTable'

const PAGE_SIZE = 50

const METRICS_TARGET: Partial<Record<ResourceKind, 'pods' | 'nodes'>> = {
  Pod: 'pods',
  Node: 'nodes',
}

/** What a custom object's view relates it to, with its templates filled in. */
export function relatedOf(object: KubeObject): RelatedQuery[] {
  const kind = kindOf(object)
  const view = isBuiltinKind(kind) ? undefined : viewFor(kind)
  return view ? viewRelated(view, object, (k) => resourceFor(k)?.namespaced) : []
}

/**
 * Objects a view relates the open one to, with their kind's columns. (A
 * custom object opens once the cluster's kinds are known.)
 */
export function RelatedTab({ related }: { related: RelatedQuery }) {
  const { resource } = useResource(related.kind)
  if (resource) return <RelatedList resource={resource} related={related} />
  return (
    <EmptyState icon={kindIcon(related.kind)} title={`No ${related.name.toLowerCase()}`}>
      This cluster doesn’t serve {apiKindOf(related.kind)}.
    </EmptyState>
  )
}

function RelatedList({
  resource,
  related,
}: {
  resource: ResourceDefinition
  related: RelatedQuery
}) {
  const { kind } = resource
  const builtin = isBuiltinKind(kind)
  const open = useOpenObject()
  const [page, setPage] = useState(1)
  const [sorted, setSort] = useState<{ id: string; desc: boolean }>()
  const list = useListResponse(kind, {
    namespace: related.namespace,
    labelSelector: related.labelSelector,
    fieldSelector: related.fieldSelector,
  })
  const target = METRICS_TARGET[kind]
  const metrics = useMetrics(target ?? 'pods', related.namespace, target !== undefined)

  if (list.isPending) return <Loading label={`Loading ${related.name.toLowerCase()}…`} />
  if (!list.data) {
    return <ErrorState error={list.error as KubeApiError} onRetry={() => void list.refetch()} />
  }
  const items = list.data.items
  const noun = builtin ? resource.label.toLowerCase() : resource.label
  if (items.length === 0) {
    return (
      <EmptyState icon={kindIcon(kind)} title={`No ${related.name.toLowerCase()}`}>
        No {noun} match{' '}
        <span className="font-mono text-xs text-ink-2">
          {[related.labelSelector, related.fieldSelector].filter(Boolean).join(',')}
        </span>{' '}
        right now.
      </EmptyState>
    )
  }

  const showNamespace = resource.namespaced && related.namespace === null
  const { columns, defaultSort } = builtin
    ? columnsFor(kind, { showNamespace, hasHealth: hasHealth(kind) })
    : customColumnsFor({
        kind,
        showNamespace,
        hasHealth: items.some((object) => statusFor(kind, object) !== null),
        view: viewFor(kind),
        table: list.data.table,
      })
  const sort = sorted ?? { id: defaultSort, desc: false }
  const ctx: CellContext = {
    // Ages are relative to the last refresh, which keeps rendering pure.
    now: list.dataUpdatedAt,
    open,
    cells: list.data.table
      ? new Map(items.map((item, i) => [item, list.data.table!.cells[i]!] as const))
      : undefined,
    metrics: metrics.data?.available
      ? new Map(metrics.data.items.map((s) => [metricsKey(s.namespace, s.name), s]))
      : undefined,
  }
  const rows = sortRows(
    items,
    columns.find((c) => c.id === sort.id)!,
    sort.desc,
    ctx,
  )
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  return (
    <div className="flex h-full flex-col">
      <ResourceTable
        resetKey={page}
        label={related.name}
        columns={columns}
        rows={pageRows}
        ctx={ctx}
        sort={sort}
        onSort={(id) => setSort({ id, desc: sort.id === id ? !sort.desc : false })}
        onOpen={(object) => open(kind, object.metadata.name, object.metadata.namespace)}
      />
      {rows.length > PAGE_SIZE && (
        <Pagination page={page} size={PAGE_SIZE} count={rows.length} onPage={setPage} />
      )}
    </div>
  )
}

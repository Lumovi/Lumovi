import { useState } from 'react'
import { useSearchParams } from 'react-router'
import type { KubeObject } from '@shared/api'
import { EmptyState, ErrorState, Loading } from '@renderer/components/States'
import { KIND_ICONS } from '@renderer/components/KindIcon'
import { useList, useMetrics } from '@renderer/hooks/queries'
import type { KubeApiError } from '@renderer/lib/api'
import { formatRef } from '@renderer/lib/routes'
import {
  ageColumn,
  metricsKey,
  nameColumn,
  podSummaryColumns,
  sortRows,
  statusColumn,
  type CellContext,
} from '../resources/columns'
import { ResourceTable } from '../resources/ResourceTable'

export interface PodQuery {
  labelSelector?: string
  fieldSelector?: string
}

function labelQuery(labels: Record<string, string> | undefined): PodQuery | undefined {
  const pairs = Object.entries(labels ?? {})
  return pairs.length ? { labelSelector: pairs.map(([k, v]) => `${k}=${v}`).join(',') } : undefined
}

/** How to find the pods that belong to `object`, if it has any. */
export function podQuery(object: KubeObject): PodQuery | undefined {
  switch (object.kind) {
    case 'Node':
      return { fieldSelector: `spec.nodeName=${object.metadata.name}` }
    case 'Service':
      return labelQuery(object.spec.selector)
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'ReplicaSet':
    case 'Job':
      return labelQuery(object.spec.selector.matchLabels)
    default:
      return undefined
  }
}

export function PodsTab({ namespace, query }: { namespace?: string; query: PodQuery }) {
  const [, setParams] = useSearchParams()
  const pods = useList('Pod', { namespace: namespace ?? null, ...query })
  const metrics = useMetrics('pods', namespace)
  const [sort, setSort] = useState({ id: 'status', desc: false })

  if (pods.isPending) return <Loading label="Loading pods…" />
  if (pods.isError)
    return <ErrorState error={pods.error as KubeApiError} onRetry={() => void pods.refetch()} />
  if (pods.data.length === 0) {
    return (
      <EmptyState icon={KIND_ICONS.Pod} title="No pods">
        Nothing is running for this right now.
      </EmptyState>
    )
  }

  const columns = [nameColumn(!namespace), statusColumn('Pod'), ...podSummaryColumns, ageColumn]
  const open: CellContext['open'] = (kind, name, ns) =>
    setParams({ open: formatRef({ kind, name, namespace: ns }) })
  const ctx: CellContext = {
    // Ages are relative to the last refresh, which keeps rendering pure.
    now: pods.dataUpdatedAt,
    open,
    metrics: new Map((metrics.data?.items ?? []).map((s) => [metricsKey(s.namespace, s.name), s])),
  }
  const rows = sortRows(
    pods.data,
    columns.find((c) => c.id === sort.id)!,
    sort.desc,
    ctx,
  )

  return (
    <div className="flex h-full flex-col">
      <ResourceTable
        label="Pods"
        columns={columns}
        rows={rows}
        ctx={ctx}
        sort={sort}
        onSort={(id) => setSort((s) => ({ id, desc: s.id === id ? !s.desc : false }))}
        onOpen={(pod) => open('Pod', pod.metadata.name, pod.metadata.namespace)}
      />
    </div>
  )
}

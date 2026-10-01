import type { KubeObject } from '@shared/api'
import { kindOf } from '@shared/resources'
import { KindIcon } from '@renderer/components/KindIcon'
import { StatusPill } from '@renderer/components/Status'
import { formatBytes, formatCpu } from '@renderer/lib/format'
import { containerStatuses, HEALTH_RANK, replicaCounts, statusOf } from '@renderer/lib/health'
import { containersOf, workloadKey } from '@renderer/lib/workloads'
import {
  ageColumn,
  nameColumn,
  withPriorities,
  type CellContext,
  type Column,
} from '../resources/columns'

const none = <span className="text-ink-3">—</span>

/** A row's identity in the Workloads list: kinds share names. */
export const rowKey = (o: KubeObject) =>
  workloadKey(kindOf(o), o.metadata.namespace, o.metadata.name)

const usageOf = (o: KubeObject, ctx: CellContext) => ctx.metrics?.get(rowKey(o))

/** How many of its pods are ready (or done, for a Job), and how many it wants. */
function podCounts(o: KubeObject): { done: number; wanted: number; text?: string } {
  if (o.kind === 'CronJob') {
    // A CronJob's pods come and go with its runs.
    const active = o.status?.active?.length ?? 0
    return { done: active, wanted: active, text: active ? `${active} running` : undefined }
  }
  if (o.kind === 'Job') {
    const done = o.status.succeeded ?? 0
    const wanted = o.spec.completions ?? 1
    return { done, wanted, text: `${done}/${wanted} done` }
  }
  if (o.kind === 'Pod') {
    const ready = Number(o.status.phase === 'Running' && containerStatuses(o).every((c) => c.ready))
    return { done: ready, wanted: 1, text: `${ready}/1` }
  }
  const { ready, desired } = replicaCounts(o)
  return { done: ready, wanted: desired, text: `${ready}/${desired}` }
}

/** The columns of the Workloads list, where every kind of workload shares a table. */
export function workloadColumns(options: {
  showNamespace: boolean
  /** Whether pods' usage is known (metrics-server answers). */
  usage: boolean
  /** The autoscaler of each workload that has one, by row key. */
  scalers: Map<string, KubeObject>
}): Column[] {
  const { scalers } = options
  const columns: Column[] = [
    nameColumn(options.showNamespace),
    {
      id: 'type',
      header: 'Type',
      width: 'minmax(130px, 0.7fr)',
      cell: (o) => (
        <span className="flex min-w-0 items-center gap-2 text-ink-2">
          <KindIcon kind={kindOf(o)} className="size-3.5 shrink-0 text-ink-3" />
          <span className="truncate">{o.kind}</span>
        </span>
      ),
      sort: (o) => o.kind!,
    },
    {
      id: 'status',
      header: 'Status',
      width: 'minmax(168px, 1fr)',
      cell: (o) => {
        const status = statusOf(kindOf(o), o)
        return (
          <span title={status.detail} className="min-w-0">
            <StatusPill status={status} />
          </span>
        )
      },
      sort: (o) => HEALTH_RANK[statusOf(kindOf(o), o).health],
    },
    {
      id: 'pods',
      header: 'Pods',
      width: 'minmax(120px, 0.6fr)',
      cell: (o) => {
        const hpa = scalers.get(rowKey(o))
        return (
          <span className="flex min-w-0 items-center gap-1.5 tabular-nums">
            {podCounts(o).text ?? none}
            {hpa && (
              <span
                title={`${hpa.metadata.name} scales it between ${hpa.spec.minReplicas ?? 1} and ${hpa.spec.maxReplicas} replicas`}
                className="flex items-center gap-1 text-xs text-ink-3"
              >
                <KindIcon kind="HorizontalPodAutoscaler" className="size-3" />
                {hpa.spec.minReplicas ?? 1}–{hpa.spec.maxReplicas}
              </span>
            )}
          </span>
        )
      },
      // The least ready first, like the status.
      sort: (o) => {
        const { done, wanted } = podCounts(o)
        return wanted ? done / wanted : 1
      },
    },
    ...(options.usage
      ? [
          {
            id: 'cpu',
            header: 'CPU',
            width: '84px',
            align: 'right' as const,
            cell: (o: KubeObject, ctx: CellContext) => {
              const usage = usageOf(o, ctx)
              return usage ? <span className="tabular-nums">{formatCpu(usage.cpu)}</span> : none
            },
            sort: (o: KubeObject, ctx: CellContext) => usageOf(o, ctx)?.cpu ?? -1,
          },
          {
            id: 'memory',
            header: 'Memory',
            width: '92px',
            align: 'right' as const,
            cell: (o: KubeObject, ctx: CellContext) => {
              const usage = usageOf(o, ctx)
              return usage ? (
                <span className="tabular-nums">{formatBytes(usage.memory)}</span>
              ) : (
                none
              )
            },
            sort: (o: KubeObject, ctx: CellContext) => usageOf(o, ctx)?.memory ?? -1,
          },
        ]
      : []),
    {
      id: 'images',
      header: 'Images',
      width: 'minmax(180px, 1.6fr)',
      cell: (o) => {
        const images = containersOf(o).map((c) => c.image)
        return (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-xs text-ink-2">{images[0]}</span>
            {images.length > 1 && <span className="text-ink-3">+{images.length - 1}</span>}
          </span>
        )
      },
    },
    ageColumn,
  ]
  return withPriorities(columns)
}

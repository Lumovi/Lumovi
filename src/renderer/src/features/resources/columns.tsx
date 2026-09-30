import type { ReactNode } from 'react'
import type { KubeObject, UsageSample } from '@shared/api'
import type { ResourceKind } from '@shared/resources'
import { Meter } from '@renderer/components/Meter'
import { StatusPill } from '@renderer/components/Status'
import { age, formatBytes, formatCpu, percent } from '@renderer/lib/format'
import { containerStatuses, HEALTH_RANK, replicaCounts, statusOf } from '@renderer/lib/health'
import { describeSchedule, nextRun } from '@renderer/lib/cron'
import { allocatable } from '@renderer/lib/usage'

export interface CellContext {
  /** Live usage keyed by `metricsKey`, when the metrics API is available. */
  metrics?: Map<string, UsageSample>
  /** Opens another object in the detail panel. */
  open: (kind: ResourceKind, name: string, namespace?: string) => void
  now: number
}

export interface Column {
  id: string
  header: string
  /** CSS grid track size. */
  width: string
  align?: 'right'
  /** 1 is always shown; 2 and then 3 are dropped first when the table is narrow. */
  priority?: 1 | 2 | 3
  cell: (object: KubeObject, ctx: CellContext) => ReactNode
  sort?: (object: KubeObject, ctx: CellContext) => string | number
}

export function metricsKey(namespace: string | undefined, name: string): string {
  return `${namespace ?? ''}/${name}`
}

const usageOf = (object: KubeObject, ctx: CellContext) =>
  ctx.metrics?.get(metricsKey(object.metadata.namespace, object.metadata.name))

const muted = (text: ReactNode) => <span className="text-ink-3">{text}</span>
const mono = (text: ReactNode) => (
  <span className="truncate font-mono text-xs text-ink-2">{text}</span>
)
const none = muted('—')

/** When the object was last active; events are ordered by when they last happened. */
export function lastSeen(object: KubeObject): string {
  return (object.lastTimestamp ?? object.eventTime ?? object.metadata.creationTimestamp) as string
}

// ——— Columns shared by every kind ———

export const nameColumn = (showNamespace: boolean): Column => ({
  id: 'name',
  header: 'Name',
  width: 'minmax(220px, 1.8fr)',
  cell: (o) => (
    <span className="flex min-w-0 flex-col">
      <span className="truncate font-medium text-ink-1">{o.metadata.name}</span>
      {showNamespace && <span className="truncate text-xs text-ink-3">{o.metadata.namespace}</span>}
    </span>
  ),
  sort: (o) => o.metadata.name,
})

export const statusColumn = (kind: ResourceKind): Column => ({
  id: 'status',
  header: kind === 'Event' ? 'Type' : 'Status',
  width: 'minmax(168px, 1fr)',
  cell: (o) => {
    const status = statusOf(kind, o)
    return (
      <span title={status.detail} className="min-w-0">
        <StatusPill status={status} />
      </span>
    )
  },
  sort: (o) => HEALTH_RANK[statusOf(kind, o).health],
})

export const ageColumn: Column = {
  id: 'age',
  header: 'Age',
  width: '72px',
  align: 'right',
  cell: (o, ctx) => muted(age(o.metadata.creationTimestamp!, ctx.now)),
  sort: (o) => -Date.parse(o.metadata.creationTimestamp!),
}

// ——— Kind specific columns ———

const readyColumn: Column = {
  id: 'ready',
  header: 'Ready',
  width: '80px',
  cell: (o) => {
    const { ready, desired } = replicaCounts(o)
    return <span className="tabular-nums">{`${ready}/${desired}`}</span>
  },
}

const imagesColumn: Column = {
  id: 'images',
  header: 'Images',
  width: 'minmax(180px, 2fr)',
  cell: (o) => {
    const images: string[] = o.spec.template.spec.containers.map((c: { image: string }) => c.image)
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        {mono(images[0])}
        {images.length > 1 && muted(`+${images.length - 1}`)}
      </span>
    )
  },
}

function usageMeter(used: number, total: number, label: string, text: string) {
  return (
    <span className="flex w-full items-center gap-2.5">
      <Meter value={used / total} label={label} className="max-w-24" />
      <span className="w-12 shrink-0 text-right text-xs text-ink-2 tabular-nums">{text}</span>
    </span>
  )
}

const podColumns: Column[] = [
  {
    id: 'ready',
    header: 'Ready',
    width: '64px',
    cell: (o) => {
      const statuses = containerStatuses(o)
      return (
        <span className="tabular-nums">{`${statuses.filter((c) => c.ready).length}/${o.spec.containers.length}`}</span>
      )
    },
  },
  {
    id: 'restarts',
    header: 'Restarts',
    width: '84px',
    align: 'right',
    cell: (o) => {
      const restarts = podRestarts(o)
      return (
        <span
          className={
            restarts > 0 ? 'font-medium text-warn-text tabular-nums' : 'text-ink-3 tabular-nums'
          }
        >
          {restarts}
        </span>
      )
    },
    sort: (o) => podRestarts(o),
  },
  {
    id: 'cpu',
    header: 'CPU',
    width: '84px',
    align: 'right',
    cell: (o, ctx) => {
      const usage = usageOf(o, ctx)
      return usage ? <span className="tabular-nums">{formatCpu(usage.cpu)}</span> : none
    },
    sort: (o, ctx) => usageOf(o, ctx)?.cpu ?? -1,
  },
  {
    id: 'memory',
    header: 'Memory',
    width: '92px',
    align: 'right',
    cell: (o, ctx) => {
      const usage = usageOf(o, ctx)
      return usage ? <span className="tabular-nums">{formatBytes(usage.memory)}</span> : none
    },
    sort: (o, ctx) => usageOf(o, ctx)?.memory ?? -1,
  },
  {
    id: 'node',
    header: 'Node',
    width: 'minmax(120px, 1fr)',
    cell: (o) => (o.spec.nodeName ? mono(o.spec.nodeName) : none),
  },
]

/** The compact pod columns used where space is tight (e.g. a workload's Pods tab). */
export const podSummaryColumns = podColumns.filter((c) => c.id === 'ready' || c.id === 'restarts')

export function podRestarts(pod: KubeObject): number {
  return containerStatuses(pod).reduce((sum, c) => sum + c.restartCount, 0)
}

const nodeColumns: Column[] = [
  {
    id: 'roles',
    header: 'Roles',
    width: 'minmax(110px, 1fr)',
    cell: (o) => {
      const roles = nodeRoles(o)
      return roles.length ? <span className="truncate text-ink-2">{roles.join(', ')}</span> : none
    },
  },
  {
    id: 'cpu',
    header: 'CPU',
    width: 'minmax(150px, 1.2fr)',
    cell: (o, ctx) => {
      const usage = usageOf(o, ctx)
      if (!usage) return noUsage(ctx, `${formatCpu(allocatable(o).cpu)} cores`)
      const ratio = usage.cpu / allocatable(o).cpu
      return usageMeter(usage.cpu, allocatable(o).cpu, `${o.metadata.name} CPU`, percent(ratio))
    },
    sort: (o, ctx) => (usageOf(o, ctx)?.cpu ?? -1) / allocatable(o).cpu,
  },
  {
    id: 'memory',
    header: 'Memory',
    width: 'minmax(150px, 1.2fr)',
    cell: (o, ctx) => {
      const usage = usageOf(o, ctx)
      if (!usage) return noUsage(ctx, formatBytes(allocatable(o).memory))
      const ratio = usage.memory / allocatable(o).memory
      return usageMeter(
        usage.memory,
        allocatable(o).memory,
        `${o.metadata.name} memory`,
        percent(ratio),
      )
    },
    sort: (o, ctx) => (usageOf(o, ctx)?.memory ?? -1) / allocatable(o).memory,
  },
  {
    id: 'version',
    header: 'Version',
    width: '96px',
    cell: (o) => mono(o.status.nodeInfo.kubeletVersion),
  },
]

/**
 * Without the metrics API, show what can be allocated; with it, a node that
 * reports nothing (e.g. NotReady) has no usage to show.
 */
function noUsage(ctx: CellContext, allocatableText: string) {
  return ctx.metrics
    ? muted('No metrics')
    : muted(<span title="Allocatable">{allocatableText}</span>)
}

export function nodeRoles(node: KubeObject): string[] {
  const prefix = 'node-role.kubernetes.io/'
  return Object.keys(node.metadata.labels!)
    .filter((label) => label.startsWith(prefix))
    .map((label) => label.slice(prefix.length))
}

function servicePorts(service: KubeObject): string {
  return (service.spec.ports ?? [])
    .map(
      (p: { port: number; targetPort?: number | string; nodePort?: number; protocol: string }) => {
        const target =
          p.targetPort !== undefined && p.targetPort !== p.port ? `→${p.targetPort}` : ''
        const node = p.nodePort ? `:${p.nodePort}` : ''
        return `${p.port}${target}${node}/${p.protocol}`
      },
    )
    .join(', ')
}

/** Addresses assigned by a load balancer (Services of type LoadBalancer and Ingresses). */
export function loadBalancerAddress(object: KubeObject): string | undefined {
  const ingress: { ip?: string; hostname?: string }[] = object.status?.loadBalancer?.ingress ?? []
  return ingress.length ? ingress.map((i) => i.ip ?? i.hostname).join(', ') : undefined
}

export function externalAddress(service: KubeObject): string | undefined {
  return (
    loadBalancerAddress(service) ??
    service.spec.externalName ??
    (service.spec.type === 'LoadBalancer' ? 'Pending' : undefined)
  )
}

function selectorText(selector: { matchLabels?: Record<string, string> } | undefined): string {
  const pairs = Object.entries(selector?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`)
  return pairs.length ? pairs.join(', ') : 'All pods'
}

function dataKeys(object: KubeObject): number {
  return (
    Object.keys((object.data as object | undefined) ?? {}).length +
    Object.keys((object.binaryData as object | undefined) ?? {}).length
  )
}

const EXTRA_COLUMNS: Partial<Record<ResourceKind, Column[]>> = {
  Pod: podColumns,
  Node: nodeColumns,
  Deployment: [readyColumn, imagesColumn],
  StatefulSet: [readyColumn, imagesColumn],
  DaemonSet: [readyColumn, imagesColumn],
  ReplicaSet: [readyColumn, imagesColumn],
  Job: [
    {
      id: 'completions',
      header: 'Completions',
      width: '104px',
      cell: (o) => (
        <span className="tabular-nums">{`${o.status.succeeded ?? 0}/${o.spec.completions}`}</span>
      ),
    },
    {
      id: 'duration',
      header: 'Duration',
      width: '88px',
      cell: (o, ctx) =>
        // Suspended or just created jobs haven't started.
        o.status.startTime
          ? muted(
              age(
                o.status.startTime,
                o.status.completionTime ? Date.parse(o.status.completionTime) : ctx.now,
              ),
            )
          : muted('—'),
    },
  ],
  CronJob: [
    {
      id: 'schedule',
      header: 'Schedule',
      width: 'minmax(170px, 1.2fr)',
      cell: (o) => (
        <span className="truncate text-ink-2" title={o.spec.schedule}>
          {describeSchedule(o.spec.schedule)}
        </span>
      ),
    },
    {
      id: 'next',
      header: 'Next run',
      width: '96px',
      cell: (o, ctx) => {
        const next = nextRun(o.spec.schedule, o.spec.timeZone)
        return o.spec.suspend || !next
          ? none
          : muted(`in ${age(new Date(ctx.now).toISOString(), next.getTime())}`)
      },
    },
    {
      id: 'last',
      header: 'Last run',
      width: '88px',
      cell: (o, ctx) =>
        o.status.lastScheduleTime ? muted(`${age(o.status.lastScheduleTime, ctx.now)} ago`) : none,
    },
    {
      id: 'active',
      header: 'Active',
      width: '64px',
      align: 'right',
      cell: (o) => <span className="tabular-nums">{o.status.active?.length ?? 0}</span>,
    },
  ],
  HorizontalPodAutoscaler: [
    {
      id: 'target',
      header: 'Target',
      width: 'minmax(140px, 1.2fr)',
      cell: (o) => mono(`${o.spec.scaleTargetRef.kind}/${o.spec.scaleTargetRef.name}`),
    },
    {
      id: 'replicas',
      header: 'Replicas',
      width: '110px',
      cell: (o) => (
        <span className="tabular-nums">
          {o.status.currentReplicas} {muted(`(${o.spec.minReplicas}–${o.spec.maxReplicas})`)}
        </span>
      ),
    },
  ],
  Service: [
    {
      id: 'type',
      header: 'Type',
      width: '112px',
      cell: (o) => <span className="text-ink-2">{o.spec.type}</span>,
    },
    {
      id: 'clusterIP',
      header: 'Cluster IP',
      width: '120px',
      cell: (o) => (o.spec.clusterIP ? mono(o.spec.clusterIP) : none),
    },
    {
      id: 'external',
      header: 'External',
      width: '130px',
      cell: (o) => {
        const address = externalAddress(o)
        return address ? mono(address) : none
      },
    },
    {
      id: 'ports',
      header: 'Ports',
      width: 'minmax(140px, 1.2fr)',
      cell: (o) => {
        const ports = servicePorts(o)
        return ports ? mono(ports) : none
      },
    },
  ],
  Ingress: [
    {
      id: 'class',
      header: 'Class',
      width: '96px',
      cell: (o) => <span className="text-ink-2">{o.spec.ingressClassName}</span>,
    },
    {
      id: 'hosts',
      header: 'Hosts',
      width: 'minmax(160px, 1.6fr)',
      cell: (o) => mono(o.spec.rules.map((r: { host?: string }) => r.host ?? '*').join(', ')),
    },
    {
      id: 'address',
      header: 'Address',
      width: '130px',
      cell: (o) => {
        const address = loadBalancerAddress(o)
        return address ? mono(address) : none
      },
    },
  ],
  NetworkPolicy: [
    {
      id: 'selector',
      header: 'Pod selector',
      width: 'minmax(160px, 1.5fr)',
      cell: (o) => mono(selectorText(o.spec.podSelector)),
    },
    {
      id: 'types',
      header: 'Policy types',
      width: '140px',
      cell: (o) => <span className="text-ink-2">{o.spec.policyTypes.join(', ')}</span>,
    },
  ],
  ConfigMap: [
    {
      id: 'keys',
      header: 'Keys',
      width: '72px',
      align: 'right',
      cell: (o) => <span className="tabular-nums">{dataKeys(o)}</span>,
    },
  ],
  Secret: [
    {
      id: 'type',
      header: 'Type',
      width: 'minmax(160px, 1.4fr)',
      cell: (o) => mono(o.type as string),
    },
    {
      id: 'keys',
      header: 'Keys',
      width: '72px',
      align: 'right',
      cell: (o) => <span className="tabular-nums">{dataKeys(o)}</span>,
    },
  ],
  PersistentVolumeClaim: [
    {
      id: 'capacity',
      header: 'Capacity',
      width: '96px',
      cell: (o) => (
        <span className="tabular-nums">
          {o.status.capacity?.storage ?? o.spec.resources.requests.storage}
        </span>
      ),
    },
    {
      id: 'class',
      header: 'Storage class',
      width: '120px',
      cell: (o) => <span className="text-ink-2">{o.spec.storageClassName}</span>,
    },
    {
      id: 'volume',
      header: 'Volume',
      width: 'minmax(140px, 1.2fr)',
      cell: (o) => (o.spec.volumeName ? mono(o.spec.volumeName) : none),
    },
  ],
  PersistentVolume: [
    {
      id: 'capacity',
      header: 'Capacity',
      width: '96px',
      cell: (o) => <span className="tabular-nums">{o.spec.capacity.storage}</span>,
    },
    {
      id: 'claim',
      header: 'Claim',
      width: 'minmax(160px, 1.4fr)',
      cell: (o) =>
        o.spec.claimRef ? mono(`${o.spec.claimRef.namespace}/${o.spec.claimRef.name}`) : none,
    },
    {
      id: 'class',
      header: 'Storage class',
      width: '120px',
      cell: (o) => <span className="text-ink-2">{o.spec.storageClassName}</span>,
    },
    {
      id: 'reclaim',
      header: 'Reclaim',
      width: '90px',
      cell: (o) => <span className="text-ink-2">{o.spec.persistentVolumeReclaimPolicy}</span>,
    },
  ],
  StorageClass: [
    {
      id: 'default',
      header: 'Default',
      width: '76px',
      cell: (o) =>
        isDefaultStorageClass(o) ? <span className="text-accent-strong">Default</span> : none,
    },
    {
      id: 'provisioner',
      header: 'Provisioner',
      width: 'minmax(160px, 1.5fr)',
      cell: (o) => mono(o.provisioner as string),
    },
    {
      id: 'reclaim',
      header: 'Reclaim',
      width: '90px',
      cell: (o) => <span className="text-ink-2">{o.reclaimPolicy as string}</span>,
    },
    {
      id: 'binding',
      header: 'Binding',
      width: '150px',
      cell: (o) => <span className="text-ink-2">{o.volumeBindingMode as string}</span>,
    },
  ],
}

export function isDefaultStorageClass(object: KubeObject): boolean {
  return object.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true'
}

const eventColumns: Column[] = [
  {
    id: 'reason',
    header: 'Reason',
    width: '150px',
    cell: (o) => <span className="truncate font-medium">{o.reason as string}</span>,
  },
  {
    id: 'object',
    header: 'Object',
    width: 'minmax(180px, 1.4fr)',
    cell: (o, ctx) => {
      const target = o.involvedObject as { kind: ResourceKind; name: string; namespace?: string }
      return (
        <button
          type="button"
          className="truncate text-left font-mono text-xs text-accent-strong hover:underline"
          onClick={(event) => {
            event.stopPropagation()
            ctx.open(target.kind, target.name, target.namespace)
          }}
        >
          {target.kind}/{target.name}
        </button>
      )
    },
  },
  {
    id: 'message',
    header: 'Message',
    width: 'minmax(240px, 3fr)',
    cell: (o) => (
      <span className="truncate text-ink-2" title={o.message as string}>
        {o.message as string}
      </span>
    ),
  },
  {
    id: 'count',
    header: 'Count',
    width: '64px',
    align: 'right',
    cell: (o) => <span className="tabular-nums">{(o.count as number | undefined) ?? 1}</span>,
    sort: (o) => (o.count as number | undefined) ?? 1,
  },
  {
    id: 'lastSeen',
    header: 'Last seen',
    width: '84px',
    align: 'right',
    cell: (o, ctx) => muted(age(lastSeen(o), ctx.now)),
    sort: (o) => -Date.parse(lastSeen(o)),
  },
]

/** Which columns give way first when the table is narrow (by column id). */
const PRIORITY: Record<string, 2 | 3> = {
  age: 3,
  node: 3,
  version: 3,
  roles: 3,
  images: 3,
  clusterIP: 3,
  class: 3,
  reclaim: 3,
  binding: 3,
  types: 3,
  count: 3,
  volume: 3,
  active: 3,
  duration: 3,
  target: 3,
  next: 3,
  restarts: 2,
  cpu: 2,
  memory: 2,
  ready: 2,
  lastSeen: 2,
  ports: 2,
  external: 2,
  address: 2,
  hosts: 2,
  object: 2,
  claim: 2,
  capacity: 2,
  keys: 2,
  last: 2,
}

export function withPriorities(columns: Column[]): Column[] {
  return columns.map((column) => ({ ...column, priority: PRIORITY[column.id] ?? 1 }))
}

/** The columns for a kind, and the column it sorts by until the user picks one. */
export function columnsFor(
  kind: ResourceKind,
  options: { showNamespace: boolean; hasHealth: boolean },
): { columns: Column[]; defaultSort: string } {
  if (kind === 'Event') {
    return {
      columns: withPriorities([statusColumn(kind), ...eventColumns]),
      defaultSort: 'lastSeen',
    }
  }
  const columns = [
    nameColumn(options.showNamespace),
    ...(options.hasHealth ? [statusColumn(kind)] : []),
    ...(EXTRA_COLUMNS[kind] ?? []),
    ageColumn,
  ]
  return { columns: withPriorities(columns), defaultSort: options.hasHealth ? 'status' : 'name' }
}

/** Sorts by `column`, falling back to the name so equal rows keep a stable order. */
export function sortRows(
  rows: KubeObject[],
  column: Column,
  desc: boolean,
  ctx: CellContext,
): KubeObject[] {
  return [...rows].sort((a, b) => {
    const x = column.sort!(a, ctx)
    const y = column.sort!(b, ctx)
    const order = typeof x === 'number' ? x - (y as number) : x.localeCompare(y as string)
    return (desc ? -order : order) || a.metadata.name.localeCompare(b.metadata.name)
  })
}

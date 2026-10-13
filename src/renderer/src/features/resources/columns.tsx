import type { ReactNode } from 'react'
import { eventCount, lastSeen } from '@shared/events'
import type { KubeObject, TableColumn, UsageSample } from '@shared/api'
import { inPieces, spelled } from '@shared/kit/characters'
import type { BuiltinKind, ResourceKind } from '@shared/resources'
import { Meter } from '@renderer/components/Meter'
import { StatusPill } from '@renderer/components/Status'
import { Tail } from '@renderer/components/Tail'
import { cn } from '@renderer/lib/cn'
import { age, formatBytes, formatCpu, formatDateTime, percent } from '@renderer/lib/format'
import { containerStatuses, HEALTH_RANK, replicaCounts, statusOf } from '@renderer/lib/health'
import { describeSchedule, nextRun } from '@renderer/lib/cron'
import { roleRefOf, rulesOf, subjectsOf, subjectText } from '@renderer/lib/rbac'
import { allocatable } from '@renderer/lib/usage'
import { fieldValue, type View, type ViewField } from '@renderer/lib/plugins'
import { MiddleCut } from '@renderer/kit/MiddleCut'
import { TheirText } from '@renderer/plugins/TheirText'
import { managedBy, type Managers } from '@renderer/lib/managers'
import { ManagerCell, ManagerFact, managerText } from '@renderer/features/details/ManagedBy'

export interface CellContext {
  /** Live usage keyed by `metricsKey`, when the metrics API is available. */
  metrics?: Map<string, UsageSample>
  /** Each object's cells in the API server's columns, for kinds that use them. */
  cells?: Map<KubeObject, unknown[]>
  /** Opens another object in the detail panel (for columns that link to one, like events'). */
  open?: (kind: ResourceKind, name: string, namespace?: string) => void
  /** What manages each object, where plugins say what manages workloads (`useManagers`). */
  managers?: Managers
  now: number
}

export interface Column {
  id: string
  header: string
  /** A header that isn't Lumovi's words (a label's key): drawn in pieces, as cluster text is. */
  headerTheirs?: boolean
  /** What its header's tooltip says, if more than the header: drawn, so it can hold marks. */
  headerTip?: ReactNode
  /** A header that's a key's whole name is cut in its middle, where keys differ, not at its end. */
  headerCut?: 'middle'
  /** CSS grid track size. */
  width: string
  align?: 'right'
  /** 1 is always shown; 2 and then 3 are dropped first when the table is narrow. */
  priority?: 1 | 2 | 3
  cell: (object: KubeObject, ctx: CellContext) => ReactNode
  /**
   * How it reads in a phone's row, where a list is two lines an object and its columns are a
   * line of facts with no header over them: a number says what it counts ("3 restarts"). Its
   * cell, unless said here; `false` for what a line can't hold (a meter).
   */
  fact?: ((object: KubeObject, ctx: CellContext) => ReactNode) | false
  /**
   * Said in a phone's row whenever an object has it, after the kind's first fact: what manages a
   * workload, which a change made by hand would be undone by.
   */
  alwaysSaid?: boolean
  /**
   * Its words for an object, where its cell's text isn't them (a meter's, say): what a copied row
   * and a saved CSV hold.
   */
  text?: (object: KubeObject, ctx: CellContext) => string
  /**
   * What a saved CSV holds, where it isn't those words: a time whole, in UTC; a number bare, in
   * the unit its `header` names ("CPU (cores)"). Nothing is an empty cell.
   */
  csv?: {
    header?: string
    value: (object: KubeObject, ctx: CellContext) => string | number | undefined
  }
  /** The name column's: it says each object's namespace (every namespace is listed). */
  namespaced?: boolean
  sort?: (object: KubeObject, ctx: CellContext) => string | number
}

/**
 * A cell's text that isn't Lumovi's (the cluster's, a plugin's), in pieces on one line, cut at
 * its end where it doesn't fit. One with a mark is cut by measuring, so the marks of the part cut
 * away stand after the "…" and are never cut with it; one without is cut as any cell is. `title`:
 * what it says under a pointer, spelled.
 */
export function TheirCell({
  text,
  title,
  className,
}: {
  text: string
  title?: string
  className?: string
}) {
  if (inPieces(text).every((piece) => typeof piece === 'string')) {
    return (
      <span className={cn('min-w-0 truncate', className)} title={title}>
        <TheirText text={text} inline />
      </span>
    )
  }
  return (
    <span className="flex min-w-0" title={title}>
      <MiddleCut text={{ their: text }} end={0} tip={false} className={cn('flex-1', className)} />
    </span>
  )
}

/** "1 restart", "3 restarts": a count that says what it's of. */
const counted = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

export function metricsKey(namespace: string | undefined, name: string): string {
  return `${namespace ?? ''}/${name}`
}

const usageOf = (object: KubeObject, ctx: CellContext) =>
  ctx.metrics?.get(metricsKey(object.metadata.namespace, object.metadata.name))

const muted = (text: ReactNode) => <span className="truncate text-ink-3">{text}</span>
/** Text a cell may cut short, with all of it on hover. */
const plain = (text: string) => (
  <span className="truncate text-ink-2" title={text}>
    {text}
  </span>
)
const mono = (text: ReactNode) => (
  <span
    className="truncate font-mono text-xs text-ink-2"
    title={typeof text === 'string' ? text : undefined}
  >
    {text}
  </span>
)
const none = muted('—')

// Events are ordered by when they last happened.
export { lastSeen }

// ——— Columns shared by every kind ———

export const nameColumn = (showNamespace: boolean): Column => ({
  id: 'name',
  header: 'Name',
  width: 'minmax(220px, 1.8fr)',
  namespaced: showNamespace,
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
  // An event's is Normal or Warning: the room it doesn't need is the object's, on a narrow window.
  width: kind === 'Event' ? 'minmax(136px, 1fr)' : 'minmax(168px, 1fr)',
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
  // (An age and a time are different things: the file has the time it counts from.)
  csv: { header: 'Created', value: (o) => utc(o.metadata.creationTimestamp!) },
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
  fact: (o) => {
    const { ready, desired } = replicaCounts(o)
    return `${ready}/${desired} ready`
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
        {/* Its tag is what tells images apart: the start is what's cut. */}
        <Tail text={images[0]!} className="font-mono text-xs text-ink-2" />
        {images.length > 1 && muted(`+${images.length - 1}`)}
      </span>
    )
  },
}

/** A time for a file: in UTC, to the second where it has no less ("2026-10-12T07:41:09Z"). */
function utc(time: string | Date): string {
  const at = typeof time === 'string' ? Date.parse(time) : time.getTime()
  return Number.isNaN(at) ? String(time) : new Date(at).toISOString().replace('.000Z', 'Z')
}

/**
 * A share of what can be allocated, for a file: 0 to 100 (or more, as usage can pass it for a
 * while) to one place, as it's worked out from two measures; none without both.
 */
const shareOf = (used: number | undefined, total: number) =>
  used === undefined || !(total > 0) ? undefined : ((used / total) * 100).toFixed(1)

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
    fact: (o) =>
      `${containerStatuses(o).filter((c) => c.ready).length}/${o.spec.containers.length} ready`,
  },
  {
    id: 'restarts',
    header: 'Restarts',
    // Room for its header, and its arrow when it's sorted by.
    width: '108px',
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
    fact: (o) => {
      const restarts = podRestarts(o)
      return (
        <span className={restarts > 0 ? 'font-medium text-warn-text' : undefined}>
          {counted(restarts, 'restart')}
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
    csv: { header: 'CPU (cores)', value: (o, ctx) => usageOf(o, ctx)?.cpu },
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
    csv: { header: 'Memory (bytes)', value: (o, ctx) => usageOf(o, ctx)?.memory },
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
    csv: {
      header: 'CPU (% of allocatable)',
      value: (o, ctx) => shareOf(usageOf(o, ctx)?.cpu, allocatable(o).cpu),
    },
    fact: false,
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
    csv: {
      header: 'Memory (% of allocatable)',
      value: (o, ctx) => shareOf(usageOf(o, ctx)?.memory, allocatable(o).memory),
    },
    fact: false,
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

/** How many rules a role has: none allows nothing. */
const rulesColumn: Column = {
  id: 'rules',
  header: 'Rules',
  width: '72px',
  align: 'right',
  cell: (o) => <span className="tabular-nums">{rulesOf(o).length}</span>,
  sort: (o) => rulesOf(o).length,
}

/** A binding's role, which opens, and whom it's granted to. */
const bindingColumns: Column[] = [
  {
    id: 'role',
    header: 'Role',
    width: 'minmax(160px, 1.2fr)',
    cell: (o, ctx) => {
      const { kind, name } = roleRefOf(o)
      if (!name) return none
      if (kind !== 'Role' && kind !== 'ClusterRole') return mono(`${kind ?? 'Role'}/${name}`)
      return (
        <button
          type="button"
          className="truncate text-left font-mono text-xs text-accent-strong hover:underline"
          onClick={(event) => {
            event.stopPropagation()
            // Every page that lists bindings passes it.
            ctx.open!(kind, name, kind === 'Role' ? o.metadata.namespace : undefined)
          }}
        >
          {kind}/{name}
        </button>
      )
    },
    sort: (o) => `${roleRefOf(o).kind}/${roleRefOf(o).name}`,
  },
  {
    id: 'subjects',
    header: 'Subjects',
    width: 'minmax(180px, 1.6fr)',
    priority: 2,
    cell: (o) => {
      const subjects = subjectsOf(o)
      if (subjects.length === 0) return muted('Nobody')
      const more = subjects.length > 1 ? `, and ${subjects.length - 1} more` : ''
      return plain(`${subjectText(subjects[0]!, o)}${more}`)
    },
    sort: (o) => subjectsOf(o).length,
  },
]

const EXTRA_COLUMNS: Partial<Record<BuiltinKind, Column[]>> = {
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
      fact: (o) => `${o.status.succeeded ?? 0}/${o.spec.completions} completed`,
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
      csv: {
        value: (o) => {
          const next = nextRun(o.spec.schedule, o.spec.timeZone)
          return o.spec.suspend || !next ? undefined : utc(next)
        },
      },
    },
    {
      id: 'last',
      header: 'Last run',
      width: '88px',
      cell: (o, ctx) =>
        o.status.lastScheduleTime ? muted(`${age(o.status.lastScheduleTime, ctx.now)} ago`) : none,
      csv: { value: (o) => o.status.lastScheduleTime && utc(o.status.lastScheduleTime) },
    },
    {
      id: 'active',
      header: 'Active',
      width: '64px',
      align: 'right',
      cell: (o) => <span className="tabular-nums">{o.status.active?.length ?? 0}</span>,
      fact: (o) => `${o.status.active?.length ?? 0} active`,
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
      cell: (o) => plain(o.spec.type),
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
      cell: (o) => plain(o.spec.ingressClassName),
    },
    {
      id: 'hosts',
      header: 'Hosts',
      width: 'minmax(160px, 1.6fr)',
      // Without rules, its default backend takes every host.
      cell: (o) =>
        mono((o.spec.rules ?? [{}]).map((r: { host?: string }) => r.host ?? '*').join(', ')),
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
      cell: (o) => plain(o.spec.policyTypes.join(', ')),
    },
  ],
  ConfigMap: [
    {
      id: 'keys',
      header: 'Keys',
      width: '72px',
      align: 'right',
      cell: (o) => <span className="tabular-nums">{dataKeys(o)}</span>,
      fact: (o) => counted(dataKeys(o), 'key'),
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
      fact: (o) => counted(dataKeys(o), 'key'),
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
      width: '136px',
      cell: (o) => plain(o.spec.storageClassName),
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
      width: '136px',
      cell: (o) => plain(o.spec.storageClassName),
    },
    {
      id: 'reclaim',
      header: 'Reclaim',
      width: '90px',
      cell: (o) => plain(o.spec.persistentVolumeReclaimPolicy),
    },
  ],
  StorageClass: [
    {
      id: 'default',
      header: 'Default',
      width: '76px',
      cell: (o) => (isDefaultStorageClass(o) ? <span className="text-ink-1">Default</span> : none),
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
      cell: (o) => plain(o.reclaimPolicy as string),
    },
    {
      id: 'binding',
      header: 'Binding',
      width: '150px',
      cell: (o) => plain(o.volumeBindingMode as string),
    },
  ],
  Role: [rulesColumn],
  ClusterRole: [rulesColumn],
  RoleBinding: bindingColumns,
  ClusterRoleBinding: bindingColumns,
  ServiceAccount: [
    {
      id: 'secrets',
      header: 'Secrets',
      width: '84px',
      align: 'right',
      cell: (o) => (
        <span className="tabular-nums">{(o.secrets as unknown[] | undefined)?.length ?? 0}</span>
      ),
      sort: (o) => (o.secrets as unknown[] | undefined)?.length ?? 0,
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
            // Every page that lists events passes it.
            ctx.open!(target.kind, target.name, target.namespace)
          }}
        >
          {target.kind}/{target.name}
        </button>
      )
    },
    // (The row is the thing to tap: nothing in it is one of its own.)
    fact: (o) => {
      const target = o.involvedObject as { kind: string; name: string }
      return `${target.kind}/${target.name}`
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
    width: '88px',
    align: 'right',
    cell: (o) => <span className="tabular-nums">{eventCount(o)}</span>,
    fact: (o) => `×${eventCount(o)}`,
    sort: eventCount,
  },
  {
    id: 'lastSeen',
    header: 'Last seen',
    width: '108px',
    align: 'right',
    cell: (o, ctx) => muted(age(lastSeen(o), ctx.now)),
    csv: { value: (o) => utc(lastSeen(o)) },
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

/**
 * What manages each workload, as plugins say it (a Flux Kustomization, an Argo CD Application…):
 * its name, which opens it. `kindOf` says each row's kind.
 */
export function managedByColumn(kindOf: (object: KubeObject) => ResourceKind): Column {
  const of = (object: KubeObject, ctx: CellContext) =>
    ctx.managers ? managedBy(ctx.managers.of(object, kindOf(object))) : []
  return {
    id: 'managedBy',
    header: 'Managed by',
    width: 'minmax(140px, 1fr)',
    priority: 2,
    cell: (o, ctx) => {
      const by = of(o, ctx)
      return by.length ? <ManagerCell managers={by} /> : none
    },
    // (The row is the thing to tap: nothing in it is one of its own.)
    fact: (o, ctx) => {
      const by = of(o, ctx)
      return by.length ? <ManagerFact managers={by} /> : ''
    },
    alwaysSaid: true,
    text: (o, ctx) => of(o, ctx).map(managerText).join('; '),
    sort: (o, ctx) =>
      of(o, ctx)
        .map((manager) => manager.name)
        .join(', '),
  }
}

/** `columns` with what manages each workload, before its age. */
export function withManagedBy(
  columns: Column[],
  kindOf: (object: KubeObject) => ResourceKind,
): Column[] {
  const age = columns.findIndex((column) => column.id === 'age')
  const at = age === -1 ? columns.length : age
  return [...columns.slice(0, at), managedByColumn(kindOf), ...columns.slice(at)]
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
    ...(EXTRA_COLUMNS[kind as BuiltinKind] ?? []),
    ageColumn,
  ]
  return { columns: withPriorities(columns), defaultSort: options.hasHealth ? 'status' : 'name' }
}

// ——— Kinds without columns of their own ———

const number = new Intl.NumberFormat()
const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400, y: 31_536_000 }
/** Server columns we show our own way: the name, and the age (kept live). */
const OWN_COLUMNS = new Set(['Name', 'Age', 'Created At'])
const CONDITION_VALUES = new Set(['True', 'False', 'Unknown'])

/** Seconds in a duration the API server printed, like "3d4h" ("<invalid>" is a future time). */
function durationSeconds(text: string): number {
  let seconds = 0
  for (const [, amount, unit] of text.matchAll(/(\d+)([smhdy])/g)) {
    seconds += Number(amount) * UNITS[unit!]!
  }
  return text.startsWith('<') ? -1 : seconds
}

const isBlank = (value: unknown) => value === null || value === undefined || value === ''

/** One of the API server's columns, filled from the list's cells. */
function serverColumn(column: TableColumn, index: number): Column {
  const numeric = column.type === 'integer' || column.type === 'number'
  const value = (o: KubeObject, ctx: CellContext) => ctx.cells?.get(o)?.[index]
  return {
    id: `server:${column.name}`,
    header: column.name,
    headerTheirs: true,
    width: numeric ? 'minmax(88px, 0.5fr)' : 'minmax(120px, 1fr)',
    align: numeric ? 'right' : undefined,
    priority: 2,
    cell: (o, ctx) => {
      const cell = value(o, ctx)
      if (isBlank(cell)) return none
      return numeric ? (
        <span className="tabular-nums">{number.format(cell as number)}</span>
      ) : (
        <TheirCell text={String(cell)} title={spelled(String(cell))} />
      )
    },
    // A number as it came, without the list's separators; text, whatever the column says, as text.
    csv: {
      value: (o, ctx) => {
        const cell = value(o, ctx)
        return isBlank(cell) ? undefined : typeof cell === 'number' ? cell : String(cell)
      },
    },
    sort: (o, ctx) => {
      const cell = value(o, ctx)
      if (numeric) return isBlank(cell) ? -Infinity : (cell as number)
      if (column.type === 'date') return isBlank(cell) ? -1 : durationSeconds(String(cell))
      return isBlank(cell) ? '' : String(cell)
    },
  }
}

/** "in 80d", "12d ago": a time from now, either way. */
function fromNow(time: string, now: number): string {
  const then = Date.parse(time)
  return then > now ? `in ${age(new Date(now).toISOString(), then)}` : `${age(time, now)} ago`
}

/** A view's column: a value it reads from each object. */
function viewColumn(field: ViewField): Column {
  const numeric = field.type === 'number' || field.type === 'count'
  return {
    id: `view:${field.name}`,
    header: field.name,
    headerTheirs: true,
    width: numeric ? 'minmax(88px, 0.5fr)' : 'minmax(120px, 1fr)',
    align: numeric ? 'right' : undefined,
    priority: 2,
    cell: (o, ctx) => {
      const { text, time } = fieldValue(field, o)
      if (text === undefined) return none
      if (time) {
        return (
          <span className="truncate tabular-nums" title={formatDateTime(time)}>
            {fromNow(time, ctx.now)}
          </span>
        )
      }
      return (
        <TheirCell
          text={text}
          title={spelled(text)}
          className={numeric ? 'tabular-nums' : undefined}
        />
      )
    },
    csv: {
      value: (o) => {
        const { text, time } = fieldValue(field, o)
        return time ? utc(time) : text
      },
    },
    sort: (o) => fieldValue(field, o).sort,
  }
}

/**
 * Columns for kinds without their own: the name, the status when objects
 * have one, then the view's columns or else the API server's (`kubectl get`'s),
 * and the age.
 */
export function customColumnsFor(options: {
  kind: ResourceKind
  showNamespace: boolean
  hasHealth: boolean
  view?: View
  table?: { columns: TableColumn[]; cells: unknown[][] }
}): { columns: Column[]; defaultSort: string } {
  const { kind, showNamespace, hasHealth, view, table } = options
  const own =
    view?.columns?.map(viewColumn) ??
    (table?.columns ?? []).flatMap((column, index) => {
      if (column.priority > 0 || OWN_COLUMNS.has(column.name)) return []
      // A True/False Ready column says what the status already does.
      const conditionOnly =
        column.name === 'Ready' &&
        table!.cells.every(
          (cells) => isBlank(cells[index]) || CONDITION_VALUES.has(String(cells[index])),
        )
      return hasHealth && conditionOnly ? [] : [serverColumn(column, index)]
    })
  const columns = [
    { ...nameColumn(showNamespace), priority: 1 as const },
    ...(hasHealth ? [{ ...statusColumn(kind), priority: 1 as const }] : []),
    // The first few stay as the window narrows.
    ...own.map((column, i) => ({ ...column, priority: i < 2 ? (2 as const) : (3 as const) })),
    { ...ageColumn, priority: 1 as const },
  ]
  return { columns, defaultSort: hasHealth ? 'status' : 'name' }
}

/**
 * What a list is sorted by: the column its address asks for, if it has one that sorts; else its
 * default, ascending (an address can ask for anything: `?sort=ready`, or a column that's gone).
 * Where none of the columns shown sorts (an event's reason can be all that's left), its default
 * still does, hidden: `own` is every column the list has.
 */
export function sortedBy(
  shown: Column[],
  asked: { sort: string; desc: boolean },
  fallback: string,
  own: Column[] = shown,
): { column: Column; desc: boolean } {
  const sorting = (id: string) => shown.find((c) => c.id === id && c.sort)
  const column = sorting(asked.sort)
  if (column) return { column, desc: asked.desc }
  return {
    column:
      sorting(fallback) ??
      shown.find((c) => c.sort) ??
      own.find((c) => c.id === fallback && c.sort) ??
      // (Can't miss: the name is always shown and sorts; Events, without one, has Last seen.)
      own.find((c) => c.sort)!,
    desc: false,
  }
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

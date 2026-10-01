import { useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { ArrowRight, ChevronRight, CircleCheck, Gauge, type LucideIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { KubeObject, UsageSample } from '@shared/api'
import type { ResourceKind } from '@shared/resources'
import { Button } from '@renderer/components/Button'
import { Card } from '@renderer/components/Card'
import { KIND_ICONS } from '@renderer/components/KindIcon'
import { Meter } from '@renderer/components/Meter'
import { Sparkline } from '@renderer/components/Sparkline'
import { StackedBar } from '@renderer/components/StackedBar'
import { EmptyState, ErrorState, Loading, StaleNotice } from '@renderer/components/States'
import { HEALTH_STYLE, StatusDot, StatusPill } from '@renderer/components/Status'
import { useGo } from '@renderer/hooks/go'
import { timesOf, useHistorySource, useUsageRange } from '@renderer/hooks/history'
import { useOpenObject } from '@renderer/hooks/open-object'
import { useContexts, useList, useMetrics, useVersion } from '@renderer/hooks/queries'
import { useNodeUsage } from '@renderer/hooks/usage'
import type { KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { age, formatBytes, formatCpu, hostOf, percent, pluralize } from '@renderer/lib/format'
import { rateWindow, usageQuery } from '@renderer/lib/promql'
import { clusterPath, metricsPath } from '@renderer/lib/routes'
import {
  HEALTH_RANK,
  nodeStatus,
  podStatus,
  statusOf,
  type Health,
  type Status,
} from '@renderer/lib/health'
import {
  allocatable,
  podReservations,
  type NodeUsage,
  type Reservations,
} from '@renderer/lib/usage'
import { useCluster } from '@renderer/state/cluster'
import { useUsageHistory } from '@renderer/state/usage-history'
import { lastSeen, nodeRoles } from '../resources/columns'

const WORKLOAD_KINDS: ResourceKind[] = ['Deployment', 'StatefulSet', 'DaemonSet']
/** Rows in "Needs attention" before "Show all". */
const ATTENTION_ROWS = 6
const HOUR = 3_600_000

const useOpen = useOpenObject

export function OverviewPage() {
  const { context, namespace } = useCluster()
  const nodes = useList('Node', { namespace: null })
  const allPods = useList('Pod', { namespace: null })
  const pods = useList('Pod')
  const deployments = useList('Deployment')
  const statefulSets = useList('StatefulSet')
  const daemonSets = useList('DaemonSet')
  const events = useList('Event')
  const podMetrics = useMetrics('pods', namespace)
  const usage = useNodeUsage()
  const version = useVersion(context)
  const server = useContexts().data?.contexts.find((c) => c.name === context)?.server
  const go = useGo()
  const queryClient = useQueryClient()

  if (!nodes.data && nodes.isError) {
    return (
      <ErrorState
        error={nodes.error as KubeApiError}
        onRetry={() => void nodes.refetch()}
        className="py-24"
      >
        <Button onClick={() => go('/')}>Choose another cluster</Button>
      </ErrorState>
    )
  }

  // Keep showing what loaded before, but say when part of it could not be refreshed.
  const stale = [nodes, allPods, pods, deployments, statefulSets, daemonSets, events].find(
    (query) => query.isError && query.data,
  )

  const workloads = [deployments, statefulSets, daemonSets].flatMap((q, i) =>
    (q.data ?? []).map((object) => ({ kind: WORKLOAD_KINDS[i]!, object })),
  )

  return (
    <div className="@container space-y-4 px-6 py-5">
      {stale && (
        <div className="overflow-hidden rounded-xl border border-warn/25">
          <StaleNotice
            error={stale.error as KubeApiError}
            onRetry={() => void queryClient.invalidateQueries()}
          />
        </div>
      )}
      <p className="text-[13px] text-ink-3">
        <span className="font-mono text-ink-2 selectable">{hostOf(server)}</span>
        {version.data && <> · Kubernetes {version.data.gitVersion}</>}
        {namespace && (
          <>
            {' '}
            · Workloads, pods and events in{' '}
            <span className="font-medium text-ink-2">{namespace}</span>
          </>
        )}
      </p>

      <div className="grid grid-cols-2 gap-4 @4xl:grid-cols-4">
        <NodesTile nodes={nodes.data} />
        <PodsTile pods={pods.data} />
        <WorkloadsTile
          workloads={workloads.map((w) => statusOf(w.kind, w.object))}
          loaded={deployments.isSuccess}
        />
        <WarningsTile events={events.data} asOf={events.dataUpdatedAt} />
      </div>

      <div className="grid animate-rise gap-4 [animation-delay:60ms] @3xl:grid-cols-2">
        <CapacityCard
          resource="cpu"
          usage={usage}
          reservations={allPods.data && podReservations(allPods.data).cpu}
        />
        <CapacityCard
          resource="memory"
          usage={usage}
          reservations={allPods.data && podReservations(allPods.data).memory}
        />
      </div>

      <div className="grid animate-rise gap-4 [animation-delay:120ms] @4xl:grid-cols-12">
        <Card title="Pod health" className="@4xl:col-span-7">
          <Body query={pods}>{(data) => <PodHealth pods={data} />}</Body>
        </Card>
        <Card title="Nodes" className="@4xl:col-span-5">
          <Body query={nodes}>{(data) => <NodeList nodes={data} usage={usage} />}</Body>
        </Card>
      </div>

      <div className="grid animate-rise gap-4 [animation-delay:180ms] @4xl:grid-cols-12">
        <Card title="Needs attention" className="@4xl:col-span-7">
          <Body query={pods}>{(data) => <Attention pods={data} workloads={workloads} />}</Body>
        </Card>
        <Card title="Recent warnings" className="@4xl:col-span-5">
          <Body query={events}>{(data) => <Warnings events={data} />}</Body>
        </Card>
      </div>

      {/* A namespace without running pods has no usage to rank. */}
      {podMetrics.data?.available && podMetrics.data.items.length > 0 && (
        <div className="grid animate-rise gap-4 [animation-delay:240ms] @3xl:grid-cols-2">
          <TopPods
            title="Top CPU"
            samples={podMetrics.data.items}
            value={(s) => s.cpu}
            format={formatCpu}
          />
          <TopPods
            title="Top memory"
            samples={podMetrics.data.items}
            value={(s) => s.memory}
            format={formatBytes}
          />
        </div>
      )}
    </div>
  )
}

/** Renders a card body once its query has data, with loading and error states in place. */
function Body<T>({
  query,
  children,
}: {
  query: UseQueryResult<T>
  children: (data: T) => ReactNode
}) {
  if (query.isPending) return <Loading label="Loading…" className="py-8" />
  if (query.data === undefined) {
    return (
      <ErrorState
        error={query.error as KubeApiError}
        onRetry={() => void query.refetch()}
        className="py-6"
      />
    )
  }
  return children(query.data)
}

// ——— Stat tiles ———

/** A headline number; clicking it opens the list behind it, filtered to what matters. */
function Tile({
  icon: Icon,
  label,
  value,
  detail,
  status,
  to,
}: {
  icon: LucideIcon
  label: string
  value?: ReactNode
  detail?: ReactNode
  status?: Health
  /** Path within the cluster, e.g. `pods?health=critical`. */
  to: string
}) {
  const { context } = useCluster()
  const go = useGo()
  return (
    <section aria-label={label} className="animate-rise">
      <button
        type="button"
        onClick={() => go(`${clusterPath(context)}/${to}`)}
        className="group block w-full rounded-xl border border-line bg-surface-2 p-4 text-left shadow-panel transition-colors hover:border-line-strong hover:bg-surface-3/40"
      >
        <div className="flex items-center gap-2 text-[13px] text-ink-2">
          <Icon className="size-4 text-ink-3" />
          {label}
          <ChevronRight className="ml-auto size-4 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
        <div className="mt-2.5 text-[28px] leading-none font-semibold tracking-[-0.02em] text-ink-1">
          {value ?? '—'}
        </div>
        <div className="mt-2 flex h-5 items-center gap-1.5 text-xs text-ink-3">
          {status && <StatusDot health={status} />}
          {detail}
        </div>
      </button>
    </section>
  )
}

const UNHEALTHY = 'health=critical,warning'

function NodesTile({ nodes }: { nodes?: KubeObject[] }) {
  if (!nodes) return <Tile icon={KIND_ICONS.Node} label="Nodes ready" to="nodes" />
  const notReady = nodes.filter((n) => nodeStatus(n).health === 'critical').length
  return (
    <Tile
      icon={KIND_ICONS.Node}
      label="Nodes ready"
      value={`${nodes.length - notReady}/${nodes.length}`}
      status={notReady ? 'critical' : 'healthy'}
      detail={notReady ? `${notReady} not ready` : 'All ready'}
      to={notReady ? `nodes?${UNHEALTHY}` : 'nodes'}
    />
  )
}

function PodsTile({ pods }: { pods?: KubeObject[] }) {
  if (!pods) return <Tile icon={KIND_ICONS.Pod} label="Pods running" to="pods" />
  const statuses = pods.map(podStatus)
  const running = statuses.filter((s) => s.label === 'Running').length
  const issues = statuses.filter((s) => s.health === 'critical' || s.health === 'warning').length
  const detail =
    pods.length === 0
      ? 'No pods yet'
      : issues
        ? `${issues} unhealthy`
        : `${pods.length} total, all fine`
  return (
    <Tile
      icon={KIND_ICONS.Pod}
      label="Pods running"
      value={running}
      status={issues ? 'warning' : 'healthy'}
      detail={detail}
      to={issues ? `pods?${UNHEALTHY}` : 'pods'}
    />
  )
}

function WorkloadsTile({ workloads, loaded }: { workloads: Status[]; loaded: boolean }) {
  if (!loaded) return <Tile icon={KIND_ICONS.Deployment} label="Workloads healthy" to="workloads" />
  const healthy = workloads.filter((s) => s.health === 'healthy' || s.health === 'neutral').length
  const degraded = workloads.length - healthy
  return (
    <Tile
      icon={KIND_ICONS.Deployment}
      label="Workloads healthy"
      value={`${healthy}/${workloads.length}`}
      status={degraded ? 'warning' : 'healthy'}
      detail={
        workloads.length === 0
          ? 'No workloads yet'
          : degraded
            ? `${degraded} degraded`
            : 'All healthy'
      }
      to={degraded ? `workloads?${UNHEALTHY}` : 'workloads'}
    />
  )
}

function WarningsTile({ events, asOf }: { events?: KubeObject[]; asOf: number }) {
  if (!events) return <Tile icon={KIND_ICONS.Event} label="Warnings" to="events?health=warning" />
  const since = asOf - HOUR
  const recent = events.filter(
    (e) => e.type === 'Warning' && Date.parse(lastSeen(e)) > since,
  ).length
  return (
    <Tile
      icon={KIND_ICONS.Event}
      label="Warnings"
      value={recent}
      status={recent ? 'warning' : 'healthy'}
      detail="In the last hour"
      to="events?health=warning"
    />
  )
}

// ——— Capacity ———

const CAPACITY = {
  cpu: { title: 'CPU', format: (v: number) => `${formatCpu(v)} cores` },
  memory: { title: 'Memory', format: formatBytes },
}

function CapacityCard({
  resource,
  usage,
  reservations,
}: {
  resource: 'cpu' | 'memory'
  usage?: NodeUsage
  reservations?: Reservations
}) {
  const { context } = useCluster()
  const go = useGo()
  const history = useUsageHistory((state) => state.byContext[context])
  const ready = useHistorySource().data?.state === 'ready'
  // With Prometheus, the trend covers the last hour, not just this session.
  const trend = useUsageRange(
    ['overview', resource],
    ({ step }) => [{ id: 'total', expr: usageQuery(resource, [], [], rateWindow(step)) }],
    { range: '1h' },
  )
  const { title, format } = CAPACITY[resource]
  if (!usage || !reservations) {
    return (
      <Card title={title}>
        <Loading label="Measuring…" className="py-10" />
      </Card>
    )
  }
  const { used, total } = usage[resource]
  const requested = reservations.requests / total
  const live = usage.metricsAvailable
  const headline = live ? used / total : requested
  const recorded = ready ? trend.data?.results[0]!.series[0] : undefined
  const points = recorded
    ? timesOf(trend.data!)
        .map((at, i) => [at, recorded.values[i]] as const)
        .filter((p): p is readonly [number, number] => typeof p[1] === 'number')
        .map(([at, value]) => ({ at, value: value / total }))
    : (history ?? []).map((p) => ({ at: p.at, value: p[resource] }))

  return (
    <Card
      title={title}
      action={
        <span className="flex items-center gap-3">
          {!live && (
            <span className="flex items-center gap-1.5 text-xs text-ink-3">
              <Gauge className="size-3.5" /> Live usage needs metrics-server
            </span>
          )}
          {recorded && (
            <button
              type="button"
              onClick={() => go(`${metricsPath(context)}?metric=${resource}`)}
              className="flex items-center gap-1 text-xs font-medium text-accent-strong hover:underline"
            >
              History <ArrowRight className="size-3.5" />
            </button>
          )}
        </span>
      }
    >
      <div className="flex items-end justify-between gap-6">
        <div>
          <div className="text-[40px] leading-none font-semibold tracking-[-0.03em]">
            {percent(headline)}
          </div>
          <p className="mt-2 text-[13px] text-ink-2">
            {live
              ? `${format(used)} of ${format(total)} in use`
              : `${format(reservations.requests)} of ${format(total)} requested`}
          </p>
        </div>
        <div className="w-[46%] min-w-40">
          {points.length > 1 ? (
            <>
              <Sparkline
                label={`${title} usage`}
                values={points.map((p) => p.value)}
                times={points.map((p) => p.at)}
              />
              <p className="mt-1 text-right text-2xs text-ink-3">
                {recorded ? 'Last hour' : 'Since you opened it'}
              </p>
            </>
          ) : (
            <div className="flex h-12 flex-col justify-end gap-1.5 pb-1">
              <span className="block h-0.5 animate-shimmer rounded-full bg-accent-track" />
              <span className="text-right text-2xs text-ink-3">
                {live ? 'Collecting usage…' : 'No live usage'}
              </span>
            </div>
          )}
        </div>
      </div>
      <Meter
        className="mt-4"
        value={headline}
        label={`${title} ${live ? 'usage' : 'requested'}`}
        marker={live ? { value: requested, label: `Requests: ${percent(requested)}` } : undefined}
      />
      <dl className="mt-4 grid grid-cols-3 gap-4 border-t border-line pt-3 text-xs">
        <div>
          <dt className="text-ink-3">Requests</dt>
          <dd className="mt-0.5 text-ink-1 tabular-nums">
            {format(reservations.requests)}{' '}
            <span className="text-ink-3">· {percent(requested)}</span>
          </dd>
        </div>
        <div>
          <dt className="text-ink-3">Limits</dt>
          <dd className="mt-0.5 text-ink-1 tabular-nums">
            {format(reservations.limits)}{' '}
            <span className="text-ink-3">· {percent(reservations.limits / total)}</span>
          </dd>
        </div>
        <div>
          <dt className="text-ink-3">Allocatable</dt>
          <dd className="mt-0.5 text-ink-1 tabular-nums">{format(total)}</dd>
        </div>
      </dl>
    </Card>
  )
}

// ——— Health ———

const POD_GROUPS: { health: Health; label: string }[] = [
  { health: 'healthy', label: 'Running' },
  { health: 'progressing', label: 'Starting' },
  { health: 'warning', label: 'Warning' },
  { health: 'critical', label: 'Failing' },
  { health: 'neutral', label: 'Completed' },
]

function countByHealth(pods: KubeObject[]): Map<Health, number> {
  const counts = new Map<Health, number>()
  for (const pod of pods) {
    const { health } = podStatus(pod)
    counts.set(health, (counts.get(health) ?? 0) + 1)
  }
  return counts
}

function PodHealth({ pods }: { pods: KubeObject[] }) {
  const { setNamespace } = useCluster()
  const byNamespace = new Map<string, KubeObject[]>()
  for (const pod of pods) {
    const ns = pod.metadata.namespace!
    byNamespace.set(ns, [...(byNamespace.get(ns) ?? []), pod])
  }
  const namespaces = [...byNamespace.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 6)
  const counts = countByHealth(pods)
  if (pods.length === 0) {
    return (
      <EmptyState icon={KIND_ICONS.Pod} title="No pods yet" className="py-6">
        Pods will show up here as soon as something is scheduled.
      </EmptyState>
    )
  }
  return (
    <div className="flex flex-1 flex-col">
      <StackedBar
        label="Pods by status"
        segments={POD_GROUPS.map((group) => ({ ...group, value: counts.get(group.health) ?? 0 }))}
      />
      <h3 className="mt-5 mb-1.5 text-2xs font-medium tracking-wider text-ink-3 uppercase">
        By namespace
      </h3>
      <ul aria-label="Pods by namespace" className="-mx-2">
        {namespaces.map(([ns, nsPods]) => {
          const nsCounts = countByHealth(nsPods)
          const issues = (nsCounts.get('critical') ?? 0) + (nsCounts.get('warning') ?? 0)
          return (
            <li key={ns}>
              <button
                type="button"
                onClick={() => setNamespace(ns)}
                className="grid w-full grid-cols-[minmax(0,1fr)_minmax(80px,45%)_88px] items-center gap-4 rounded-lg px-2 py-1.5 text-left hover:bg-surface-3/60"
              >
                <span className="truncate font-medium">{ns}</span>
                <span className="flex h-1.5 gap-[2px] overflow-hidden rounded-full">
                  {POD_GROUPS.map(({ health }) => (
                    <span
                      key={health}
                      className={HEALTH_STYLE[health].dot}
                      style={{ flexGrow: nsCounts.get(health) ?? 0 }}
                    />
                  ))}
                </span>
                <span className="text-right text-xs text-ink-3 tabular-nums">
                  {nsPods.length}{' '}
                  {issues > 0 && (
                    <span className="text-warn-text">· {pluralize(issues, 'issue')}</span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function NodeList({ nodes, usage }: { nodes: KubeObject[]; usage?: NodeUsage }) {
  const open = useOpen()
  const nodeMetrics = useMetrics('nodes')
  const samples = new Map((nodeMetrics.data?.items ?? []).map((s) => [s.name, s]))
  return (
    <ul className="-mx-2 space-y-0.5">
      {nodes.map((node) => {
        const status = nodeStatus(node)
        const sample = samples.get(node.metadata.name)
        const alloc = allocatable(node)
        return (
          <li key={node.metadata.name}>
            <button
              type="button"
              onClick={() => open('Node', node.metadata.name)}
              className="grid w-full grid-cols-[minmax(0,1fr)_88px_88px] items-center gap-4 rounded-lg px-2 py-2 text-left hover:bg-surface-3/60"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <StatusDot health={status.health} />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{node.metadata.name}</span>
                  <span className="block truncate text-xs text-ink-3">
                    {[status.label, ...nodeRoles(node)].join(' · ')}
                  </span>
                </span>
              </span>
              {sample && usage?.metricsAvailable ? (
                <>
                  <MiniMeter label="CPU" value={sample.cpu / alloc.cpu} node={node.metadata.name} />
                  <MiniMeter
                    label="Mem"
                    value={sample.memory / alloc.memory}
                    node={node.metadata.name}
                  />
                </>
              ) : (
                <span className="col-span-2 text-right text-xs text-ink-3">
                  {formatCpu(alloc.cpu)} cores · {formatBytes(alloc.memory)}
                </span>
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function MiniMeter({ label, value, node }: { label: string; value: number; node: string }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="flex justify-between text-2xs text-ink-3">
        {label} <span className="text-ink-2 tabular-nums">{percent(value)}</span>
      </span>
      <Meter value={value} label={`${node} ${label}`} />
    </span>
  )
}

function Attention({
  pods,
  workloads,
}: {
  pods: KubeObject[]
  workloads: { kind: ResourceKind; object: KubeObject }[]
}) {
  const open = useOpen()
  const items = [...workloads, ...pods.map((object) => ({ kind: 'Pod' as ResourceKind, object }))]
    .map((item) => ({ ...item, status: statusOf(item.kind, item.object) }))
    .filter((item) => item.status.health === 'critical' || item.status.health === 'warning')
    .sort((a, b) => HEALTH_RANK[a.status.health] - HEALTH_RANK[b.status.health])

  const [expanded, setExpanded] = useState(false)
  if (items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-ink-3">
        <CircleCheck className="size-6 text-good" />
        Everything looks healthy.
      </div>
    )
  }
  const shown = expanded ? items : items.slice(0, ATTENTION_ROWS)
  return (
    <>
      <ul aria-label="Needs attention" className="-mx-2 space-y-0.5">
        {shown.map(({ kind, object, status }) => (
          <li key={`${kind}/${object.metadata.namespace}/${object.metadata.name}`}>
            <button
              type="button"
              onClick={() => open(kind, object.metadata.name, object.metadata.namespace)}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface-3/60"
            >
              <span className="w-40 shrink-0">
                <StatusPill status={status} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{object.metadata.name}</span>
                <span className="block truncate text-xs text-ink-3">
                  {kind} · {object.metadata.namespace}
                  {status.detail && ` · ${status.detail}`}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {items.length > ATTENTION_ROWS && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-2 self-start rounded-md px-2 py-1 text-xs font-medium text-accent-strong hover:bg-accent-soft"
        >
          {expanded ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </>
  )
}

function Warnings({ events }: { events: KubeObject[] }) {
  const open = useOpen()
  const warnings = events
    .filter((e) => e.type === 'Warning')
    .sort((a, b) => Date.parse(lastSeen(b)) - Date.parse(lastSeen(a)))
    .slice(0, 6)
  if (warnings.length === 0) {
    return (
      <p className="flex flex-1 items-center justify-center py-8 text-ink-3">No warnings. Nice.</p>
    )
  }
  return (
    <ul aria-label="Recent warnings" className="-mx-2 space-y-0.5">
      {warnings.map((event) => {
        const target = event.involvedObject as {
          kind: ResourceKind
          name: string
          namespace?: string
        }
        return (
          <li key={event.metadata.name}>
            <button
              type="button"
              onClick={() => open(target.kind, target.name, target.namespace)}
              className="flex w-full gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface-3/60"
            >
              <span
                aria-hidden
                className={cn('mt-1.5 size-2 shrink-0 rounded-full', HEALTH_STYLE.warning.dot)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="font-medium">{event.reason as string}</span>
                  <span className="truncate text-xs text-ink-3">
                    {target.kind}/{target.name}
                  </span>
                  <span className="flex-1" />
                  <span className="shrink-0 text-xs text-ink-3">{age(lastSeen(event))}</span>
                </span>
                <span className="line-clamp-2 text-xs leading-relaxed text-ink-2">
                  {event.message as string}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function TopPods({
  title,
  samples,
  value,
  format,
}: {
  title: string
  samples: UsageSample[]
  value: (sample: UsageSample) => number
  format: (value: number) => string
}) {
  const open = useOpen()
  const top = [...samples].sort((a, b) => value(b) - value(a)).slice(0, 5)
  const max = value(top[0]!)
  return (
    <Card title={title}>
      <ul aria-label={title} className="-mx-2 space-y-0.5">
        {top.map((sample) => (
          <li key={`${sample.namespace}/${sample.name}`}>
            <button
              type="button"
              onClick={() => open('Pod', sample.name, sample.namespace)}
              className="grid w-full grid-cols-[minmax(0,1fr)_minmax(80px,40%)_64px] items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-surface-3/60"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{sample.name}</span>
                <span className="block truncate text-xs text-ink-3">{sample.namespace}</span>
              </span>
              <span className="h-1.5 rounded-full bg-accent-track">
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${(value(sample) / max) * 100}%` }}
                />
              </span>
              <span className="text-right text-xs text-ink-2 tabular-nums">
                {format(value(sample))}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}

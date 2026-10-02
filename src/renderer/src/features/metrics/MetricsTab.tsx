import { useState } from 'react'
import type { KubeObject } from '@shared/api'
import { parseQuantity } from '@shared/quantity'
import type { ResourceKind } from '@shared/resources'
import type { ChartReference } from '@renderer/components/charts/TimeChart'
import { KIND_ICONS } from '@renderer/components/KindIcon'
import { EmptyState, ErrorState, Loading } from '@renderer/components/States'
import { SeriesColorScope, useUsageRange } from '@renderer/hooks/history'
import { useList } from '@renderer/hooks/queries'
import type { KubeApiError } from '@renderer/lib/api'
import {
  escapeRegex,
  nodeQuery,
  podPattern,
  rateWindow,
  usageQuery,
  zoomInto,
  type Matcher,
  type TimeSelection,
} from '@renderer/lib/promql'
import { usePrefs } from '@renderer/state/prefs'
import type { PodQuery } from '../details/PodsTab'
import { RangePicker } from './ChartCard'
import { HistoryGate, SourceChip } from './source'
import { pick, UsageChart } from './UsageChart'

const WORKLOADS: readonly ResourceKind[] = [
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'ReplicaSet',
  'Job',
  'CronJob',
]

/** Kinds with usage history: pods, the workloads that run them, and nodes. */
export function hasMetrics(kind: ResourceKind): boolean {
  return kind === 'Pod' || kind === 'Node' || WORKLOADS.includes(kind)
}

interface Container {
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> }
}

/** Requests and (when every container has one) the limit, added up over containers. */
function reservations(containers: Container[], resource: 'cpu' | 'memory'): ChartReference[] {
  const requests = containers.map((c) => c.resources?.requests?.[resource]).filter(Boolean)
  const limits = containers.map((c) => c.resources?.limits?.[resource])
  const total = (values: (string | undefined)[]) =>
    values.reduce((sum, value) => sum + parseQuantity(value), 0)
  return [
    ...(requests.length > 0 ? [{ label: 'Requests', value: total(requests) }] : []),
    ...(limits.every(Boolean) ? [{ label: 'Limit', value: total(limits) }] : []),
  ]
}

function templateOf(object: KubeObject): Container[] {
  return object.kind === 'CronJob'
    ? object.spec.jobTemplate.spec.template.spec.containers
    : object.spec.template.spec.containers
}

const CPU_EMPTY =
  'Prometheus has no cAdvisor samples for this in the time shown: it may not have been running, or cAdvisor isn’t scraped.'
const NETWORK_EMPTY =
  'cAdvisor reports network traffic per pod; there are no samples for this time.'
const RESTARTS_EMPTY = 'Restarts come from kube-state-metrics.'

/** Pods found by a view, for custom kinds; `null` looks in every namespace. */
export interface OwnPods {
  query: PodQuery
  namespace: string | null
}

/**
 * Usage history for a pod, a workload's pods, a node, or the pods a custom
 * object has, over a time the user picks.
 */
export function MetricsTab({ object, pods }: { object: KubeObject; pods?: OwnPods }) {
  const preset = usePrefs((prefs) => prefs.metricsRange)
  const setPreset = usePrefs((prefs) => prefs.setMetricsRange)
  const [selection, setSelection] = useState<TimeSelection>({ range: preset })
  const select = (next: TimeSelection) => {
    setSelection(next)
    if ('range' in next) setPreset(next.range)
  }
  const zoom = (from: number, to: number) => select(zoomInto(selection, from, to))
  const props = { object, selection, zoom }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <SeriesColorScope key={object.metadata.uid}>
        <HistoryGate compact>
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
            <RangePicker selection={selection} onChange={select} />
            <SourceChip />
          </div>
          <div className="space-y-3 px-5 pt-3 pb-5">
            {object.kind === 'Pod' ? (
              <PodCharts {...props} />
            ) : object.kind === 'Node' ? (
              <NodeCharts {...props} />
            ) : pods ? (
              <OwnPodCharts {...props} pods={pods} />
            ) : (
              <WorkloadCharts {...props} />
            )}
          </div>
        </HistoryGate>
      </SeriesColorScope>
    </div>
  )
}

interface ChartsProps {
  object: KubeObject
  selection: TimeSelection
  zoom: (from: number, to: number) => void
}

/** The queries every view asks for: CPU and memory by `by`, and network in and out. */
function useUsage(key: unknown[], matchers: Matcher[], by: string[], selection: TimeSelection) {
  return useUsageRange(
    key,
    ({ step }) => [
      { id: 'cpu', expr: usageQuery('cpu', matchers, by, rateWindow(step)) },
      { id: 'memory', expr: usageQuery('memory', matchers, by, rateWindow(step)) },
      { id: 'rx', expr: usageQuery('rx', matchers, [], rateWindow(step)) },
      { id: 'tx', expr: usageQuery('tx', matchers, [], rateWindow(step)) },
    ],
    selection,
  )
}

function useRestarts(key: unknown[], matchers: Matcher[], by: string, selection: TimeSelection) {
  return useUsageRange(
    [...key, 'restarts'],
    ({ step }) => [{ id: 'restarts', expr: usageQuery('restarts', matchers, [by], step / 1000) }],
    selection,
    { buckets: true },
  )
}

function NetworkChart({
  query,
  zoom,
}: {
  query: ReturnType<typeof useUsage>
  zoom: (from: number, to: number) => void
}) {
  return (
    <UsageChart
      title="Network"
      query={query}
      series={(result) => [
        ...pick(result, 'rx', () => 'Received'),
        ...pick(result, 'tx', () => 'Sent'),
      ]}
      unit="bytesPerSecond"
      kind="lines"
      summary="none"
      empty={NETWORK_EMPTY}
      onZoom={zoom}
    />
  )
}

function PodCharts({ object, selection, zoom }: ChartsProps) {
  const { namespace, name } = object.metadata
  const matchers: Matcher[] = [
    ['namespace', '=', namespace!],
    ['pod', '=', name],
  ]
  const key = ['pod', namespace, name]
  const usage = useUsage(key, matchers, ['container'], selection)
  const restarts = useRestarts(key, matchers, 'container', selection)
  const containers: Container[] = object.spec.containers
  const container = (labels: Record<string, string>) => labels.container!
  return (
    <>
      <UsageChart
        title="CPU"
        query={usage}
        series={(result) => pick(result, 'cpu', container)}
        unit="cores"
        kind="stacked"
        references={reservations(containers, 'cpu')}
        empty={CPU_EMPTY}
        onZoom={zoom}
      />
      <UsageChart
        title="Memory"
        query={usage}
        series={(result) => pick(result, 'memory', container)}
        unit="bytes"
        kind="stacked"
        references={reservations(containers, 'memory')}
        empty={CPU_EMPTY}
        onZoom={zoom}
      />
      <NetworkChart query={usage} zoom={zoom} />
      <UsageChart
        title="Restarts"
        query={restarts}
        series={(result) => pick(result, 'restarts', container)}
        unit="count"
        kind="bars"
        empty={RESTARTS_EMPTY}
        onZoom={zoom}
        height={140}
      />
    </>
  )
}

/** A workload's pods, one line each, against what each pod requests. */
function WorkloadCharts({ object, selection, zoom }: ChartsProps) {
  const { namespace, name } = object.metadata
  return (
    <PodSetCharts
      chartKey={['workload', object.kind, namespace, name]}
      matchers={[
        ['namespace', '=', namespace!],
        ['pod', '=~', podPattern(object.kind as ResourceKind, name)],
      ]}
      containers={templateOf(object)}
      selection={selection}
      zoom={zoom}
    />
  )
}

/**
 * The pods a custom object has now, by name: unlike a workload's, their
 * names follow no pattern KubeStacks knows.
 */
function OwnPodCharts({ object, pods: own, selection, zoom }: ChartsProps & { pods: OwnPods }) {
  const pods = useList('Pod', { namespace: own.namespace, ...own.query })
  if (pods.isPending) return <Loading label="Finding its pods…" />
  if (!pods.data) {
    return <ErrorState error={pods.error as KubeApiError} onRetry={() => void pods.refetch()} />
  }
  if (pods.data.length === 0) {
    return (
      <EmptyState icon={KIND_ICONS.Pod} title="No pods">
        Nothing is running for this right now, so there’s no usage to chart.
      </EmptyState>
    )
  }
  const names = pods.data.map((pod) => pod.metadata.name).sort()
  const namespaces = [...new Set(pods.data.map((pod) => pod.metadata.namespace!))]
  const { namespace, name } = object.metadata
  return (
    <PodSetCharts
      chartKey={['pods-of', object.kind, namespace, name, ...names]}
      matchers={[
        ['namespace', '=~', namespaces.map(escapeRegex).join('|')],
        ['pod', '=~', names.map(escapeRegex).join('|')],
      ]}
      containers={pods.data[0]!.spec.containers}
      selection={selection}
      zoom={zoom}
    />
  )
}

/** Pods, one line each, against what one of them requests. */
function PodSetCharts({
  chartKey: key,
  matchers,
  containers,
  selection,
  zoom,
}: {
  chartKey: unknown[]
  matchers: Matcher[]
  containers: Container[]
  selection: TimeSelection
  zoom: (from: number, to: number) => void
}) {
  const usage = useUsage(key, matchers, ['pod'], selection)
  const restarts = useRestarts(key, matchers, 'pod', selection)
  const pod = (labels: Record<string, string>) => labels.pod!
  const note = 'The busiest pods; each is compared with what one pod requests.'
  return (
    <>
      <UsageChart
        title="CPU per pod"
        query={usage}
        series={(result) => pick(result, 'cpu', pod)}
        unit="cores"
        kind="lines"
        other={false}
        references={reservations(containers, 'cpu')}
        empty={`${CPU_EMPTY} ${note}`}
        onZoom={zoom}
        summary="none"
      />
      <UsageChart
        title="Memory per pod"
        query={usage}
        series={(result) => pick(result, 'memory', pod)}
        unit="bytes"
        kind="lines"
        other={false}
        references={reservations(containers, 'memory')}
        empty={CPU_EMPTY}
        onZoom={zoom}
        summary="none"
      />
      <NetworkChart query={usage} zoom={zoom} />
      <UsageChart
        title="Restarts"
        query={restarts}
        series={(result) => pick(result, 'restarts', pod)}
        unit="count"
        kind="bars"
        empty={RESTARTS_EMPTY}
        onZoom={zoom}
        height={140}
      />
    </>
  )
}

/** What runs on a node, by namespace, against what it can allocate. */
function NodeCharts({ object, selection, zoom }: ChartsProps) {
  const { name } = object.metadata
  const usage = useUsageRange(
    ['node', name],
    ({ step }) => [
      { id: 'cpu', expr: nodeQuery('cpu', name, ['namespace'], rateWindow(step)) },
      { id: 'memory', expr: nodeQuery('memory', name, ['namespace'], rateWindow(step)) },
      { id: 'rx', expr: nodeQuery('rx', name, [], rateWindow(step)) },
      { id: 'tx', expr: nodeQuery('tx', name, [], rateWindow(step)) },
    ],
    selection,
  )
  const allocatable = (resource: 'cpu' | 'memory') => [
    { label: 'Allocatable', value: parseQuantity(object.status.allocatable[resource]) },
  ]
  const namespace = (labels: Record<string, string>) => labels.namespace!
  return (
    <>
      <UsageChart
        title="CPU by namespace"
        query={usage}
        series={(result) => pick(result, 'cpu', namespace)}
        unit="cores"
        kind="stacked"
        references={allocatable('cpu')}
        limit={5}
        empty={CPU_EMPTY}
        onZoom={zoom}
      />
      <UsageChart
        title="Memory by namespace"
        query={usage}
        series={(result) => pick(result, 'memory', namespace)}
        unit="bytes"
        kind="stacked"
        references={allocatable('memory')}
        limit={5}
        empty={CPU_EMPTY}
        onZoom={zoom}
      />
      <NetworkChart query={usage} zoom={zoom} />
    </>
  )
}

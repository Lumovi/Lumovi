import { ArrowRight } from 'lucide-react'
import type { KubeObject } from '@shared/api'
import { TimeChart, type ChartReference } from '@renderer/components/charts/TimeChart'
import { timesOf, useUsageRange } from '@renderer/hooks/history'
import { cn } from '@renderer/lib/cn'
import {
  CONTAINERS,
  overRange,
  selector,
  type Matcher,
  type TimeWindow,
} from '@renderer/lib/promql'
import {
  CPU_PERCENTILE,
  describeAmount,
  podRegex,
  RESOURCES,
  type ContainerAdvice,
  type Plan,
  type Resource,
  type WorkloadAdvice,
} from '@renderer/lib/rightsizing'

const NOUN: Record<Resource, string> = { cpu: 'CPU', memory: 'Memory' }

/**
 * A workload's recommendation, container by container: each resource's
 * request and limit, why, and its last week against them.
 */
export function AdviceDetail({
  workload,
  advice,
}: {
  workload: KubeObject
  advice: WorkloadAdvice
}) {
  if (advice.containers.length === 0) {
    return <p className="text-[13px] text-ink-2">{advice.note}</p>
  }
  return (
    <div className="space-y-4">
      {advice.containers.map((container) => (
        <section key={container.name} aria-label={`Container ${container.name}`}>
          {(advice.containers.length > 1 || advice.unmeasured.length > 0) && (
            <h3 className="mb-2 font-mono text-xs font-medium text-ink-1">{container.name}</h3>
          )}
          <div className="grid gap-3 @4xl:grid-cols-2">
            {RESOURCES.map((resource) => (
              <ResourcePanel
                key={resource}
                workload={workload}
                container={container}
                resource={resource}
              />
            ))}
          </div>
        </section>
      ))}
      {advice.unmeasured.length > 0 && (
        <p className="text-xs text-ink-3">
          No usage in the last 7 days, so left as they are:{' '}
          <span className="font-mono text-ink-2">{advice.unmeasured.join(', ')}</span>
        </p>
      )}
    </div>
  )
}

function ResourcePanel({
  workload,
  container,
  resource,
}: {
  workload: KubeObject
  container: ContainerAdvice
  resource: Resource
}) {
  const request = container.requests[resource]
  const limit = container.limits[resource]
  const { usage } = container
  const measured =
    resource === 'cpu'
      ? [
          ['95th percentile', usage.cpuP95],
          ['Peak', usage.cpuMax],
        ]
      : [['Peak', usage.memoryMax]]
  return (
    <div
      role="group"
      aria-label={`${container.name} ${NOUN[resource]}`}
      className="flex flex-col rounded-lg border border-line bg-surface-2 p-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-xs font-semibold text-ink-1">{NOUN[resource]}</h4>
        <p className="text-2xs text-ink-3 tabular-nums">
          {measured.map(([label, value], i) => (
            <span key={label as string}>
              {i > 0 && ' · '}
              {label}{' '}
              <span className="text-ink-2">{describeAmount(resource, value as number)}</span>
            </span>
          ))}
        </p>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-ink-3">Request</dt>
        <dd>
          <PlanText resource={resource} plan={request} />
        </dd>
        <dt className="text-ink-3">Limit</dt>
        <dd>
          <PlanText resource={resource} plan={limit} />
        </dd>
      </dl>
      <ul className="mt-2 space-y-1 text-xs leading-relaxed text-ink-2">
        {container.reasons[resource].map((reason) => (
          <li key={reason} className="flex gap-2">
            <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-3" />
            {reason}
          </li>
        ))}
      </ul>
      <UsageWeek workload={workload} container={container} resource={resource} />
    </div>
  )
}

function PlanText({ resource, plan }: { resource: Resource; plan: Plan }) {
  const amount = (value: number | undefined) =>
    value === undefined ? 'none' : describeAmount(resource, value)
  if (plan.change === 'keep') {
    return (
      <span className="text-ink-2 tabular-nums">
        {amount(plan.current)}
        {plan.current !== undefined && <span className="text-ink-3"> · stays</span>}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      <span className="text-ink-3">{amount(plan.current)}</span>
      <ArrowRight className="size-3 text-ink-3" aria-label="to" />
      <span className="font-medium text-ink-1">{amount(plan.recommended)}</span>
    </span>
  )
}

/** The busiest pod's use over the week, against the request, the recommendation and the limit. */
function UsageWeek({
  workload,
  container,
  resource,
}: {
  workload: KubeObject
  container: ContainerAdvice
  resource: Resource
}) {
  const { namespace, name } = workload.metadata
  const query = useUsageRange(
    ['rightsizing', namespace, workload.kind, name],
    (window) => weekQueries(workload, window),
    { range: '7d' },
  )
  const result = query.data
  const values =
    result?.results
      .find((r) => r.id === resource)
      ?.series.find((s) => s.labels.container === container.name)?.values ?? []
  const request = container.requests[resource]
  const limit = container.limits[resource]
  const lines: ChartReference[] = []
  if (request.current !== undefined) lines.push({ label: 'Request', value: request.current })
  if (request.change !== 'keep') lines.push({ label: 'Recommended', value: request.recommended! })
  if (limit.current !== undefined) lines.push({ label: 'Limit', value: limit.current })
  if (limit.change !== 'keep') lines.push({ label: 'New limit', value: limit.recommended! })
  // Lines at the same height share one label: "Request, Limit".
  const references = lines.reduce<ChartReference[]>((merged, line) => {
    const same = merged.find((r) => Math.abs(r.value - line.value) < 1e-9)
    if (same) same.label = `${same.label}, ${line.label.toLowerCase()}`
    else merged.push({ ...line })
    return merged
  }, [])
  return (
    // At the bottom, so the charts of a container's two resources line up.
    <div className="mt-auto pt-3">
      <p className="mb-1 text-2xs text-ink-3">
        {resource === 'cpu'
          ? `Busiest pod, the most in each half hour (the request covers its ${CPU_PERCENTILE * 100}th percentile)`
          : 'Busiest pod, the most in each half hour'}
      </p>
      <div className={cn('h-[132px]', !result && 'animate-pulse rounded-md bg-surface-3/60')}>
        {result && (
          <TimeChart
            label={`${container.name} ${NOUN[resource]} over the last 7 days`}
            times={timesOf(result)}
            series={[
              {
                key: container.name,
                label: container.name,
                color: 'var(--series-1)',
                values,
              },
            ]}
            unit={resource === 'cpu' ? 'cores' : 'bytes'}
            kind="lines"
            references={references}
            height={132}
            stale={query.isPlaceholderData}
          />
        )}
      </div>
    </div>
  )
}

/** Each container's use in the workload's busiest pod, at each step of the week. */
function weekQueries(workload: KubeObject, window: TimeWindow) {
  const step = window.step / 1000
  const pods: Matcher[] = [
    ...CONTAINERS,
    ['namespace', '=', workload.metadata.namespace!],
    ['pod', '=~', podRegex(workload)],
  ]
  return [
    {
      id: 'cpu',
      expr: overRange(
        'max',
        `max by (container) (rate(container_cpu_usage_seconds_total${selector(pods)}[300s]))`,
        step,
        300,
      ),
    },
    {
      id: 'memory',
      expr: `max by (container) (max_over_time(container_memory_working_set_bytes${selector(pods)}[${step}s]))`,
    },
  ]
}

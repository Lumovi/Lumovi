import {
  ArrowDown,
  ArrowRight,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  Clock,
  Cpu,
  Info,
  MemoryStick,
  Scale,
  TrendingDown,
  TriangleAlert,
  Wand2,
  type LucideIcon,
} from 'lucide-react'
import { Popover } from 'radix-ui'
import { useState, type MouseEvent } from 'react'
import { useSearchParams } from 'react-router'
import { builtinResource } from '@shared/resources'
import { Button } from '@renderer/components/Button'
import { KindIcon } from '@renderer/components/KindIcon'
import { SearchInput } from '@renderer/components/SearchInput'
import { EmptyState, ErrorState, Loading } from '@renderer/components/States'
import { HEALTH_STYLE } from '@renderer/components/Status'
import { Tooltip } from '@renderer/components/Tooltip'
import { useAccess } from '@renderer/hooks/access'
import { useOpenObject } from '@renderer/hooks/open-object'
import { useReadOnly } from '@renderer/hooks/settings'
import { useUpdateParams } from '@renderer/hooks/update-params'
import { cn } from '@renderer/lib/cn'
import type { Health } from '@renderer/lib/health'
import { matchWords } from '@renderer/lib/match'
import {
  changedContainers,
  describeAmount,
  describeHistory,
  RESOURCES,
  THROTTLED,
  type Resource,
  type Verdict,
  type WorkloadAdvice,
} from '@renderer/lib/rightsizing'
import { useCluster } from '@renderer/state/cluster'
import { MetricsTabs } from '../metrics/MetricsTabs'
import { HistoryGate, SourceChip } from '../metrics/source'
import { Tile } from '../overview/OverviewPage'
import { menuContent } from '../shell/menu-styles'
import { AdviceDetail } from './AdviceDetail'
import { ApplyDialog } from './ApplyDialog'
import { useRightsizing, type Advised } from './use-rightsizing'

const VERDICTS: Record<Verdict, { label: string; icon: LucideIcon; health?: Health }> = {
  under: { label: 'Needs more', icon: TriangleAlert, health: 'warning' },
  unset: { label: 'No requests', icon: CircleDashed },
  over: { label: 'Over-provisioned', icon: TrendingDown },
  fine: { label: 'Right-sized', icon: CircleCheck, health: 'healthy' },
  young: { label: 'Too new', icon: Clock },
  unknown: { label: 'No usage', icon: CircleMinus },
  managed: { label: 'Autoscaled', icon: Wand2 },
}

/** What needs attention first; workloads without a recommendation last. */
const ORDER: Verdict[] = ['under', 'unset', 'over', 'fine', 'young', 'unknown', 'managed']

type Show = 'all' | 'under' | 'over' | 'unset' | 'fine' | 'none'
const FILTERS: { id: Show; label: string; verdicts: Verdict[] }[] = [
  { id: 'all', label: 'All', verdicts: ORDER },
  { id: 'under', label: 'Needs more', verdicts: ['under'] },
  { id: 'over', label: 'Over-provisioned', verdicts: ['over'] },
  { id: 'unset', label: 'No requests', verdicts: ['unset'] },
  { id: 'fine', label: 'Right-sized', verdicts: ['fine'] },
  { id: 'none', label: 'No recommendation', verdicts: ['young', 'unknown', 'managed'] },
]

type Sort = 'impact' | 'cpu' | 'memory'

const MINUS = '−'

const APPLY = 'h-7 px-2 text-xs text-accent-strong hover:bg-accent-soft hover:text-accent-strong'

/** A change in a request: "−850m", "+1.5 GiB"; "No change" when there's none. */
function signed(resource: Resource, value: number): string {
  if (Math.abs(value) < (resource === 'cpu' ? 0.0005 : 2 ** 19)) return 'No change'
  return `${value < 0 ? MINUS : '+'}${describeAmount(resource, Math.abs(value))}`
}

export function RightsizingPage() {
  return (
    <div className="flex h-full flex-col">
      <MetricsTabs current="rightsizing" />
      <div className="@container min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-4 px-6 py-5">
          <HistoryGate>
            <Rightsizing />
          </HistoryGate>
        </div>
      </div>
    </div>
  )
}

function Rightsizing() {
  const { namespace } = useCluster()
  const { advised, capacity, error, failed, progress, retry } = useRightsizing()
  const [params] = useSearchParams()
  const update = useUpdateParams()
  const show = (FILTERS.find((f) => f.id === params.get('show'))?.id ?? 'all') as Show
  const sort = (
    ['cpu', 'memory'].includes(params.get('sort')!) ? params.get('sort') : 'impact'
  ) as Sort
  const q = params.get('q') ?? ''
  const set = (key: string, value: string | undefined) =>
    update((p) => {
      if (value) p.set(key, value)
      else p.delete(key)
    })

  if (!advised) {
    return error ? (
      <ErrorState error={error} onRetry={retry} />
    ) : (
      <Loading
        label={
          progress.total > 1
            ? `Looking at a week of usage… ${progress.settled} of ${progress.total} namespaces`
            : 'Looking at a week of usage…'
        }
      />
    )
  }
  if (advised.length === 0) {
    return (
      <EmptyState icon={Scale} title="Nothing to right-size">
        There are no Deployments, StatefulSets or DaemonSets
        {namespace ? ` in ${namespace}` : ' in this cluster'}.
      </EmptyState>
    )
  }

  // How much of the cluster a change is, so CPU and memory changes can be ranked together.
  const share = ({ advice }: Advised) =>
    Math.abs(advice.delta.cpu) / Math.max(capacity!.cpu, 1) +
    Math.abs(advice.delta.memory) / Math.max(capacity!.memory, 2 ** 30)
  const sorted = [...advised].sort((a, b) =>
    sort === 'impact'
      ? ORDER.indexOf(a.advice.verdict) - ORDER.indexOf(b.advice.verdict) ||
        share(b) - share(a) ||
        a.workload.metadata.name.localeCompare(b.workload.metadata.name)
      : a.advice.delta[sort] - b.advice.delta[sort] ||
        ORDER.indexOf(a.advice.verdict) - ORDER.indexOf(b.advice.verdict),
  )
  const filter = FILTERS.find((f) => f.id === show)!
  const rows = sorted.filter(
    ({ workload, advice }) =>
      filter.verdicts.includes(advice.verdict) &&
      matchWords(`${workload.metadata.name} ${workload.metadata.namespace} ${workload.kind}`, q) >
        0,
  )

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink-2">
          What each workload should request, from the last 7 days of its containers’ usage.
          <Method />
        </p>
        <SourceChip />
      </div>
      {failed.length > 0 && (
        <div
          role="alert"
          className="flex items-center gap-2.5 rounded-lg border border-warn/25 bg-warn/10 px-3 py-2 text-[13px] text-warn-text"
        >
          <TriangleAlert className="size-4 shrink-0" />
          <p className="min-w-0 flex-1">
            Prometheus couldn’t answer for {failed.map((f) => f.namespace).join(', ')}: no
            recommendations there. <span className="text-ink-2">{failed[0]!.error.message}</span>
          </p>
          <Button variant="ghost" onClick={retry} className="h-7 shrink-0 px-2 text-xs">
            Try again
          </Button>
        </div>
      )}
      <Summary advised={advised} />
      <section
        aria-label="Workloads"
        className="rounded-xl border border-line bg-surface-2 shadow-panel"
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <div role="group" aria-label="Show" className="flex flex-wrap items-center gap-1">
            {FILTERS.map((f) => {
              const count = advised.filter((a) => f.verdicts.includes(a.advice.verdict)).length
              if (count === 0 && f.id !== show && f.id !== 'all') return null
              return (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={show === f.id}
                  onClick={() => set('show', f.id === 'all' ? undefined : f.id)}
                  className="flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 text-xs font-medium text-ink-2 transition-colors hover:text-ink-1 aria-pressed:border-accent/40 aria-pressed:bg-accent-soft aria-pressed:text-accent-strong"
                >
                  {f.label}
                  <span className="font-normal text-ink-3 tabular-nums">{count}</span>
                </button>
              )
            })}
          </div>
          <div className="flex-1" />
          <SearchInput
            value={q}
            onChange={(value) => set('q', value || undefined)}
            onArrowDown={() => undefined}
            placeholder="Filter workloads…"
            className="w-56"
          />
        </header>
        {rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] text-ink-3">
            No workloads match.{' '}
            <button
              type="button"
              onClick={() =>
                update((p) => {
                  p.delete('show')
                  p.delete('q')
                })
              }
              className="font-medium text-accent-strong hover:underline"
            >
              Show all
            </button>
          </p>
        ) : (
          <AdviceTable
            rows={rows}
            sort={sort}
            onSort={(next) => set('sort', next === 'impact' ? undefined : next)}
          />
        )}
      </section>
    </>
  )
}

/** How recommendations are worked out, in a popover. */
function Method() {
  return (
    <Popover.Root>
      <Popover.Trigger className="ml-1.5 inline-flex items-center gap-1 align-baseline font-medium text-accent-strong hover:underline">
        <Info className="size-3.5 self-center" />
        How it’s worked out
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          aria-label="How right-sizing works"
          className={cn(menuContent, 'w-[420px] p-4 text-[13px] leading-relaxed text-ink-2')}
        >
          <ul className="space-y-2 [&_b]:font-medium [&_b]:text-ink-1">
            <li>
              <b>CPU</b> requests cover the 95th percentile of each container’s use, in its busiest
              pod, with 15% headroom. A container that needs more is only slowed down.
            </li>
            <li>
              <b>Memory</b> requests cover its peak, with 15% headroom: a container that runs out is
              killed. One that was OOM-killed gets a quarter more than its limit.
            </li>
            <li>
              <b>Limits</b> are never lowered, only raised when they throttle a container, or come
              close to killing it.
            </li>
            <li>
              Requests a <b>HorizontalPodAutoscaler</b> scales on stay as they are, and workloads a{' '}
              <b>VerticalPodAutoscaler</b> manages are left to it.
            </li>
            <li>
              Changes of less than 20% are left alone, and a workload needs <b>a day of history</b>{' '}
              (a week for full confidence).
            </li>
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function Summary({ advised }: { advised: Advised[] }) {
  // What over-provisioned workloads free, and what the others need more.
  const flows = (resource: Resource) => {
    const deltas = advised.map((a) => a.advice.delta[resource])
    return {
      freed: -deltas.filter((d) => d < 0).reduce((sum, d) => sum + d, 0),
      added: deltas.filter((d) => d > 0).reduce((sum, d) => sum + d, 0),
    }
  }
  const under = advised.filter((a) => a.advice.verdict === 'under')
  const containers = under.flatMap((a) => a.advice.containers)
  const oom = containers.filter((c) => c.usage.oomKilled).length
  const throttled = containers.filter((c) => c.usage.throttled >= THROTTLED).length
  const unset = advised.filter((a) =>
    a.advice.containers.some((c) => RESOURCES.some((r) => c.requests[r].change === 'set')),
  ).length
  const path = 'metrics/right-sizing'
  return (
    <div className="grid grid-cols-2 gap-4 @4xl:grid-cols-4">
      {RESOURCES.map((resource) => {
        const { freed, added } = flows(resource)
        return (
          <Tile
            key={resource}
            icon={resource === 'cpu' ? Cpu : MemoryStick}
            label={resource === 'cpu' ? 'CPU requests' : 'Memory requests'}
            value={signed(resource, added - freed)}
            detail={
              <span className="truncate tabular-nums">
                {[
                  freed > 0 && `${describeAmount(resource, freed)} to free`,
                  added > 0 && `${describeAmount(resource, added)} more needed`,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'Requests match use'}
              </span>
            }
            to={`${path}?sort=${resource}`}
          />
        )
      })}
      <Tile
        icon={TriangleAlert}
        label="Need more"
        value={under.length}
        status={under.length ? 'warning' : 'healthy'}
        detail={
          under.length === 0
            ? 'None OOM-killed or throttled'
            : [
                oom && `${oom} OOM-killed`,
                throttled && `${throttled} throttled`,
                oom + throttled === 0 && 'Use more than they request',
              ]
                .filter(Boolean)
                .join(' · ')
        }
        to={`${path}?show=under`}
      />
      <Tile
        icon={CircleDashed}
        label="Without requests"
        value={unset}
        detail={unset ? 'Placed as if they used nothing' : 'All request CPU and memory'}
        to={`${path}?show=unset`}
      />
    </div>
  )
}

function AdviceTable({
  rows,
  sort,
  onSort,
}: {
  rows: Advised[]
  sort: Sort
  onSort: (sort: Sort) => void
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [applying, setApplying] = useState<Advised>()
  const { readOnly } = useReadOnly()
  // Whether each kind can be changed in each namespace: one review each, not one a row.
  const checks = [
    ...new Map(
      rows
        .filter((r) => changedContainers(r.advice).length > 0)
        .map(({ workload: w }) => [
          `${w.kind}/${w.metadata.namespace}`,
          { verb: 'patch' as const, kind: w.kind!, namespace: w.metadata.namespace },
        ]),
    ).values(),
  ]
  const access = useAccess(checks)
  const refusal = ({ workload: w }: Advised) => {
    if (readOnly) return 'Changes are turned off for this cluster.'
    const i = checks.findIndex((c) => c.kind === w.kind && c.namespace === w.metadata.namespace)
    return access[i] === false
      ? `Your account can’t change ${builtinResource(w.kind!)!.label.toLowerCase()} in ${w.metadata.namespace}.`
      : undefined
  }
  const toggle = (key: string) => {
    const next = new Set(open)
    if (!next.delete(key)) next.add(key)
    setOpen(next)
  }
  const header = (label: string, id?: Sort, className?: string) => (
    <th
      aria-sort={id && sort === id ? 'ascending' : undefined}
      className={cn(
        'px-2 py-2 text-2xs font-medium tracking-wider text-ink-3 uppercase',
        className,
      )}
    >
      {id ? (
        <button
          type="button"
          onClick={() => onSort(sort === id ? 'impact' : id)}
          title={sort === id ? 'Back to the default order' : 'Most freed first'}
          className={cn(
            'inline-flex items-center gap-1 tracking-wider uppercase transition-colors hover:text-ink-1',
            sort === id && 'text-ink-1',
          )}
        >
          {label}
          {sort === id && <ArrowDown className="size-3" />}
        </button>
      ) : (
        label
      )}
    </th>
  )
  return (
    <>
      <table className="w-full table-fixed text-left text-xs">
        <thead>
          <tr className="border-b border-line">
            {header('Workload', undefined, 'w-[27%] pl-4')}
            {header('Status', undefined, 'w-[15%]')}
            {header('CPU request', 'cpu', 'w-[14%]')}
            {header('Memory request', 'memory', 'w-[16%]')}
            {header('Across replicas', undefined, 'w-[12%] text-right')}
            {header('Based on', undefined, 'w-[8%] text-right')}
            <th className="w-[8%] pr-4">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <AdviceRow
              key={row.key}
              row={row}
              open={open.has(row.key)}
              onToggle={() => toggle(row.key)}
              onApply={() => setApplying(row)}
              refusal={refusal(row)}
            />
          ))}
        </tbody>
      </table>
      {applying && (
        <ApplyDialog
          workload={applying.workload}
          advice={applying.advice}
          onClose={() => setApplying(undefined)}
        />
      )}
    </>
  )
}

function AdviceRow({
  row: { key, workload, advice },
  open,
  onToggle,
  onApply,
  refusal,
}: {
  row: Advised
  open: boolean
  onToggle: () => void
  onApply: () => void
  /** Why it can't be applied, if it can't. */
  refusal?: string
}) {
  const openObject = useOpenObject()
  const { name, namespace } = workload.metadata
  const changes = changedContainers(advice).length > 0
  const detailsId = `advice-${key}`
  // The row expands from anywhere but its buttons.
  const expand = (event: MouseEvent) => {
    if (!(event.target as HTMLElement).closest('button')) onToggle()
  }
  return (
    <>
      <tr
        aria-label={`${workload.kind} ${name}`}
        onClick={expand}
        className={cn(
          'group cursor-default border-b border-line last:border-0 hover:bg-surface-3/40',
          open && 'bg-surface-3/40',
        )}
      >
        <td className="py-2 pr-2 pl-2">
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={open ? detailsId : undefined}
              aria-label={`${open ? 'Hide' : 'Show'} recommendation for ${name}`}
              onClick={onToggle}
              className="grid size-6 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-1"
            >
              <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
            </button>
            <KindIcon kind={workload.kind!} className="size-4 shrink-0 text-ink-3" />
            <span className="ml-1 min-w-0">
              <button
                type="button"
                onClick={() => openObject(workload.kind!, name, namespace)}
                title={`Open ${name}`}
                className="block max-w-full truncate text-left text-[13px] font-medium text-ink-1 hover:underline"
              >
                {name}
              </button>
              <span className="block truncate text-2xs text-ink-3">
                {namespace} · {advice.replicas} {advice.replicas === 1 ? 'pod' : 'pods'}
              </span>
            </span>
          </div>
        </td>
        <td className="px-2 py-2">
          <VerdictBadge verdict={advice.verdict} />
        </td>
        {RESOURCES.map((resource) => (
          <td key={resource} className="px-2 py-2">
            <PodRequest advice={advice} resource={resource} />
          </td>
        ))}
        <td className="px-2 py-2 text-right tabular-nums">
          {RESOURCES.every((r) => Math.abs(advice.delta[r]) < 1e-6) ? (
            <span className="text-ink-3">—</span>
          ) : (
            RESOURCES.filter((r) => Math.abs(advice.delta[r]) >= 1e-6).map((resource) => (
              <span
                key={resource}
                className={cn('block', advice.delta[resource] < 0 ? 'text-ink-1' : 'text-ink-2')}
              >
                {signed(resource, advice.delta[resource])}
              </span>
            ))
          )}
        </td>
        <td className="px-2 py-2 text-right text-ink-2 tabular-nums">
          {advice.verdict === 'unknown' || advice.verdict === 'managed' ? (
            <span className="text-ink-3">—</span>
          ) : (
            <Tooltip
              content={
                advice.confidence === 'high'
                  ? 'A week of history: weekly cycles are in it.'
                  : advice.confidence
                    ? 'Less than a week of history: a busier day may not be in it yet.'
                    : 'Recommendations need a day of history.'
              }
            >
              <span className={cn(advice.confidence !== 'high' && 'text-ink-3')}>
                {describeHistory(advice.history)}
              </span>
            </Tooltip>
          )}
        </td>
        <td className="py-2 pr-4 pl-2 text-right">
          {changes &&
            (refusal ? (
              // Disabled buttons get no pointer events, so a wrapper carries the reason.
              <Tooltip content={refusal}>
                <span tabIndex={0}>
                  <Button variant="ghost" disabled className={APPLY}>
                    Apply…
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Button variant="ghost" onClick={onApply} className={APPLY}>
                Apply…
              </Button>
            ))}
        </td>
      </tr>
      {open && (
        <tr
          id={detailsId}
          aria-label={`Recommendation for ${workload.kind} ${name}`}
          className="border-b border-line bg-surface-3/25 last:border-0"
        >
          <td colSpan={7} className="px-4 pt-3 pb-4">
            <AdviceDetail workload={workload} advice={advice} />
          </td>
        </tr>
      )}
    </>
  )
}

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const { label, icon: Icon, health } = VERDICTS[verdict]
  const style = health ? HEALTH_STYLE[health] : undefined
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap',
        style ? [style.soft, style.text] : 'bg-surface-3 text-ink-2',
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </span>
  )
}

/**
 * A pod's request for one resource, all its containers together: now, and as
 * recommended. A limit that changes is under it.
 */
function PodRequest({ advice, resource }: { advice: WorkloadAdvice; resource: Resource }) {
  const { current, recommended } = advice.pod[resource]
  const amount = (value: number | undefined) =>
    value === undefined || value === 0 ? 'none' : describeAmount(resource, value)
  const limits = advice.containers.filter((c) => c.limits[resource].change !== 'keep')
  return (
    <>
      {Math.abs(recommended - current) < 1e-6 ? (
        <span
          className={cn(
            'block tabular-nums',
            advice.containers.length ? 'text-ink-2' : 'text-ink-3',
          )}
        >
          {amount(current)}
        </span>
      ) : (
        <span className="flex items-center gap-1 tabular-nums">
          <span className="text-ink-3">{amount(current)}</span>
          <ArrowRight className="size-3 shrink-0 text-ink-3" aria-label="to" />
          <span className="font-medium text-ink-1">{amount(recommended)}</span>
        </span>
      )}
      {limits.length === 1 && (
        <span className="mt-0.5 flex items-center gap-1 text-2xs text-ink-3 tabular-nums">
          Limit {amount(limits[0]!.limits[resource].current)}
          <ArrowRight className="size-2.5 shrink-0" aria-label="to" />
          <span className="font-medium text-ink-1">
            {amount(limits[0]!.limits[resource].recommended)}
          </span>
        </span>
      )}
      {limits.length > 1 && (
        <span className="mt-0.5 block text-2xs text-ink-3">{limits.length} limits raised</span>
      )}
    </>
  )
}

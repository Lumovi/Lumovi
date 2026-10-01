import { ChartArea, ChartLine } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import type { RangeResult } from '@shared/api'
import { parseQuantity } from '@shared/quantity'
import type { ResourceKind } from '@shared/resources'
import { Histogram, type Bin } from '@renderer/components/charts/Histogram'
import { formatValue, summarize } from '@renderer/components/charts/scale'
import { TimeChart } from '@renderer/components/charts/TimeChart'
import { EmptyState, ErrorState, Loading } from '@renderer/components/States'
import { SearchInput } from '@renderer/components/SearchInput'
import {
  OTHER,
  SeriesColorScope,
  timesOf,
  useSeriesColors,
  useUsageInstant,
  useUsageRange,
} from '@renderer/hooks/history'
import { useList } from '@renderer/hooks/queries'
import { useUpdateParams } from '@renderer/hooks/update-params'
import type { KubeApiError } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import {
  byNodeQuery,
  escapeRegex,
  isRangeId,
  overRange,
  rateWindow,
  usageQuery,
  USAGE_METRICS,
  workloadOf,
  zoomInto,
  type Matcher,
  type TimeSelection,
  type TimeWindow,
  type Unit,
  type UsageMetric,
} from '@renderer/lib/promql'
import { useCluster } from '@renderer/state/cluster'
import { usePrefs } from '@renderer/state/prefs'
import { RangePicker } from './ChartCard'
import { RankedTable, type Row } from './RankedTable'
import { HistoryGate, SourceChip } from './source'
import { sumValues } from './UsageChart'

export type Group = 'namespace' | 'workload' | 'pod' | 'node'

const GROUPS: { id: Group; label: string; plural: string }[] = [
  { id: 'namespace', label: 'Namespace', plural: 'namespaces' },
  { id: 'workload', label: 'Workload', plural: 'workloads' },
  { id: 'pod', label: 'Pod', plural: 'pods' },
  { id: 'node', label: 'Node', plural: 'nodes' },
]
const METRICS = Object.keys(USAGE_METRICS) as UsageMetric[]
const TOPS = [3, 5, 7]
const count = new Intl.NumberFormat()

/** The label a group is named by in cAdvisor's series. */
const LABEL: Record<Group, string> = {
  namespace: 'namespace',
  workload: 'pod',
  pod: 'pod',
  node: 'node',
}

interface Explore {
  metric: UsageMetric
  group: Group
  /** Name filter: comma-separated words, any of which may match. */
  q: string
  top: number
  view: 'stacked' | 'lines'
  selection: TimeSelection
}

function readParams(params: URLSearchParams, preset: TimeSelection): Explore {
  const metric = params.get('metric') as UsageMetric
  const group = params.get('by') as Group
  const from = Number(params.get('from'))
  const to = Number(params.get('to'))
  const back = params.get('back')
  const range = params.get('range')
  return {
    metric: METRICS.includes(metric) ? metric : 'cpu',
    // Restarts aren't labeled with nodes.
    group:
      GROUPS.some((g) => g.id === group) && !(metric === 'restarts' && group === 'node')
        ? group
        : 'namespace',
    q: params.get('q') ?? '',
    top: TOPS.includes(Number(params.get('top'))) ? Number(params.get('top')) : 7,
    view: params.get('view') === 'lines' ? 'lines' : 'stacked',
    selection:
      from > 0 && to > from && isRangeId(back)
        ? { from, to, back }
        : isRangeId(range)
          ? { range }
          : preset,
  }
}

/** Waits until typing pauses, so each keystroke doesn't ask Prometheus again. */
function useSettled<T>(value: T, delay = 350): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return settled
}

/** The workload each live pod belongs to, by its owner; gone pods are named by pattern. */
function useOwners(): (namespace: string, pod: string) => { name: string; kind?: ResourceKind } {
  const pods = useList('Pod').data
  const owners = new Map<string, { name: string; kind?: ResourceKind }>()
  for (const pod of pods ?? []) {
    const owner = pod.metadata.ownerReferences?.find((o) => o.controller)
    if (!owner) continue
    owners.set(
      `${pod.metadata.namespace}/${pod.metadata.name}`,
      owner.kind === 'ReplicaSet'
        ? { name: owner.name.replace(/-[a-z0-9]{6,10}$/, ''), kind: 'Deployment' }
        : { name: owner.name, kind: owner.kind as ResourceKind },
    )
  }
  return (namespace, pod) => owners.get(`${namespace}/${pod}`) ?? { name: workloadOf(pod) }
}

export function MetricsPage() {
  const preset = usePrefs((prefs) => prefs.metricsRange)
  const setPreset = usePrefs((prefs) => prefs.setMetricsRange)
  const [params] = useSearchParams()
  const update = useUpdateParams()
  const state = readParams(params, { range: preset })
  const set = (patch: Record<string, string | undefined>) =>
    update((p) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) p.delete(key)
        else p.set(key, value)
      }
    })
  const select = (selection: TimeSelection) => {
    if ('range' in selection) {
      setPreset(selection.range)
      set({ range: selection.range, from: undefined, to: undefined, back: undefined })
    } else {
      set({
        from: String(selection.from),
        to: String(selection.to),
        back: selection.back,
        range: undefined,
      })
    }
  }

  return (
    <div className="@container h-full overflow-y-auto">
      <div className="space-y-4 px-6 py-5">
        {/* Without a source, the filters would have nothing to filter. */}
        <HistoryGate>
          <div className="flex flex-wrap items-center gap-2">
            <RangePicker selection={state.selection} onChange={select} />
            <Segmented
              label="Metric"
              value={state.metric}
              options={METRICS.map((m) => ({ id: m, label: USAGE_METRICS[m].label }))}
              onChange={(metric) =>
                set({
                  metric,
                  by: metric === 'restarts' && state.group === 'node' ? 'namespace' : state.group,
                })
              }
            />
            <label className="flex h-8 items-center gap-2 rounded-lg border border-line bg-surface-2 pr-1 pl-2.5 text-xs text-ink-3">
              By
              <select
                aria-label="Group by"
                value={state.group}
                onChange={(event) => set({ by: event.target.value })}
                className="h-6 rounded-md bg-transparent pr-1 text-xs font-medium text-ink-1 outline-none"
              >
                {GROUPS.filter((g) => g.id !== 'node' || state.metric !== 'restarts').map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
            <SearchInput
              value={state.q}
              onChange={(q) => set({ q: q || undefined })}
              onArrowDown={() => undefined}
              placeholder={`Filter ${GROUPS.find((g) => g.id === state.group)!.plural}… (a, b)`}
              className="w-64"
            />
            <div className="flex-1" />
            <label className="flex h-8 items-center gap-2 rounded-lg border border-line bg-surface-2 pr-1 pl-2.5 text-xs text-ink-3">
              Top
              <select
                aria-label="Series shown"
                value={state.top}
                onChange={(event) => set({ top: event.target.value })}
                className="h-6 rounded-md bg-transparent pr-1 text-xs font-medium text-ink-1 outline-none"
              >
                {TOPS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            {state.metric !== 'restarts' && (
              <Segmented
                label="Chart"
                value={state.view}
                options={[
                  { id: 'stacked', label: <ChartArea className="size-3.5" aria-label="Stacked" /> },
                  { id: 'lines', label: <ChartLine className="size-3.5" aria-label="Lines" /> },
                ]}
                onChange={(view) => set({ view })}
              />
            )}
          </div>

          {/* Each grouping colors its series afresh, by rank; switching metrics keeps them. */}
          <SeriesColorScope key={state.group}>
            <Explorer
              state={state}
              onZoom={(from, to) => select(zoomInto(state.selection, from, to))}
            />
          </SeriesColorScope>
        </HistoryGate>
      </div>
    </div>
  )
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { id: T; label: ReactNode }[]
  onChange: (value: T) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex h-8 items-center rounded-lg border border-line bg-surface-2 p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className="flex h-6 items-center rounded-md px-2 text-xs font-medium text-ink-2 transition-colors hover:text-ink-1 aria-pressed:bg-surface aria-pressed:text-ink-1 aria-pressed:shadow-[0_0_0_1px_var(--line-strong)]"
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** Everything below the filters, which all of it follows. */
function Explorer({
  state,
  onZoom,
}: {
  state: Explore
  onZoom: (from: number, to: number) => void
}) {
  const { namespace } = useCluster()
  const { metric, group, top, selection } = state
  const q = useSettled(state.q.trim())
  const owners = useOwners()
  const nodes = useList('Node', { namespace: null }).data
  const [bin, setBin] = useState<Bin>()
  const unit = USAGE_METRICS[metric].unit
  const terms = q
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean)
  const filters: Matcher[] = [
    ...(namespace ? [['namespace', '=', namespace] as const] : []),
    ...(terms.length > 0
      ? [[LABEL[group], '=~', `(?i).*(${terms.map(escapeRegex).join('|')}).*`] as const]
      : []),
  ]
  const by =
    group === 'namespace' ? ['namespace'] : group === 'node' ? ['node'] : ['namespace', 'pod']
  const expr = (window: TimeWindow, extra: Matcher[] = []) =>
    group === 'node'
      ? byNodeQuery(metric, [...filters, ...extra], rateWindow(window.step))
      : usageQuery(
          metric,
          [...filters, ...extra],
          by,
          metric === 'restarts' ? window.step / 1000 : rateWindow(window.step),
        )
  const key = [metric, group, namespace, q]

  // Every group, ranked over the whole window: averages (totals for restarts), peaks, latest.
  const ranking = useUsageInstant(
    key,
    (window) => {
      const range = (window.end - window.start) / 1000
      if (metric === 'restarts') {
        return [{ id: 'avg', expr: usageQuery('restarts', filters, by, range) }]
      }
      const step = window.step / 1000
      return [
        { id: 'avg', expr: overRange('avg', expr(window), range, step) },
        { id: 'max', expr: overRange('max', expr(window), range, step) },
        { id: 'now', expr: expr(window) },
      ]
    },
    selection,
  )

  // Only what actually restarted ranks among restarts.
  const rows = (ranking.data ? rowsOf(ranking.data.results, group, owners) : []).filter(
    (r) => metric !== 'restarts' || r.avg >= 0.5,
  )
  const charted = rows.slice(0, top)

  const chart = useUsageRange(
    [...key, 'chart'],
    (window) => [
      {
        id: 'total',
        expr: usageQuery(
          metric,
          filters,
          [],
          metric === 'restarts' ? window.step / 1000 : rateWindow(window.step),
        ),
      },
      { id: 'top', expr: expr(window, restrict(group, charted)) },
    ],
    selection,
    {
      buckets: metric === 'restarts',
      enabled: charted.length > 0,
      detail: charted.map((r) => r.key),
    },
  )
  const series = chart.data
    ? chartSeries(chart.data, group, charted, rows.length > top, owners)
    : []
  const color = useSeriesColors(series.map((s) => s.key))

  if (ranking.isPending) return <Loading label="Ranking…" />
  if (!ranking.data) {
    return (
      <ErrorState error={ranking.error as KubeApiError} onRetry={() => void ranking.refetch()} />
    )
  }
  const plural = GROUPS.find((g) => g.id === group)!.plural
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ChartLine}
        title={
          q ? 'Nothing matches' : metric === 'restarts' ? 'No restarts' : 'No data for this time'
        }
      >
        {q
          ? `No ${plural} named like “${q}” have ${USAGE_METRICS[metric].noun} in this time.`
          : metric === 'restarts'
            ? `Nothing restarted ${namespace ? `in ${namespace} ` : ''}in this time.`
            : `Prometheus has no ${USAGE_METRICS[metric].noun} samples ${namespace ? `in ${namespace} ` : ''}for this time.`}
      </EmptyState>
    )
  }

  const total = chart.data
    ? summarize(chart.data.results.find((r) => r.id === 'total')!.series[0]!.values)
    : undefined
  const allocatable =
    metric === 'cpu' || metric === 'memory'
      ? (nodes ?? []).reduce(
          (sum, node) => sum + parseQuantity(node.status.allocatable?.[metric]),
          0,
        )
      : 0
  // Allocatable capacity only compares with everything stacked up, cluster-wide.
  const wholeCluster = !namespace && terms.length === 0 && allocatable > 0
  const kind = metric === 'restarts' ? 'bars' : state.view
  const shown = bin ? rows.filter((r) => r.avg >= bin.from && r.avg <= bin.to) : rows
  const title = `${USAGE_METRICS[metric].label} by ${group}`

  return (
    <div className="space-y-4">
      <div role="group" aria-label="Summary" className="grid grid-cols-2 gap-4 @3xl:grid-cols-4">
        {metric === 'restarts' ? (
          <>
            <Tile
              label="Restarts"
              value={formatValue(
                rows.reduce((sum, r) => sum + r.avg, 0),
                unit,
              )}
            />
            <Tile
              label={`${plural[0]!.toUpperCase()}${plural.slice(1)} restarting`}
              value={String(rows.length)}
            />
            <Tile label="Most" value={rows[0]!.name} small />
            <Tile label="Their restarts" value={formatValue(rows[0]!.avg, unit)} />
          </>
        ) : (
          <>
            <Tile label="Now" value={total && amount(total.last, unit)} />
            <Tile label="Average" value={total && amount(total.avg, unit)} />
            <Tile label="Peak" value={total && amount(total.max, unit)} />
            <Tile
              label={wholeCluster ? 'Of allocatable, on average' : `Busiest ${group}`}
              value={
                wholeCluster
                  ? total && `${Math.round((total.avg / allocatable) * 100)}%`
                  : rows[0]!.name
              }
              small={!wholeCluster}
            />
          </>
        )}
      </div>

      <section
        aria-label={title}
        className="rounded-xl border border-line bg-surface-2 p-4 shadow-panel"
      >
        <header className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold text-ink-1">{title}</h2>
            <p className="mt-0.5 text-xs text-ink-3">
              {rows.length > top
                ? `The top ${top} of ${count.format(rows.length)} ${plural}, the rest as Other`
                : `All ${rows.length} ${plural}`}{' '}
              · drag across the chart to zoom in
            </p>
          </div>
          <SourceChip />
        </header>
        {chart.data ? (
          <TimeChart
            label={title}
            times={timesOf(chart.data)}
            series={series.map((s) => ({ ...s, color: color(s.key) }))}
            unit={unit}
            kind={kind}
            references={
              wholeCluster && kind === 'stacked'
                ? [{ label: 'Allocatable', value: allocatable }]
                : []
            }
            height={280}
            onZoom={onZoom}
            stale={chart.isPlaceholderData}
          />
        ) : chart.isError ? (
          <ErrorState
            error={chart.error as KubeApiError}
            onRetry={() => void chart.refetch()}
            className="py-10"
          />
        ) : (
          <Loading label="Loading…" className="h-[280px] py-0" />
        )}
      </section>

      <div className="grid gap-4 @4xl:grid-cols-12">
        <section
          aria-label="Distribution"
          className="rounded-xl border border-line bg-surface-2 p-4 shadow-panel @4xl:col-span-5"
        >
          <header className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-[13px] font-semibold text-ink-1">
              {metric === 'restarts' ? 'Restarts' : `Average ${USAGE_METRICS[metric].noun}`} across{' '}
              {plural}
            </h2>
            <p className="text-xs text-ink-3">
              {bin ? 'Showing one band below' : 'Click a band to filter'}
            </p>
          </header>
          <Histogram
            label={`How ${plural} spread by ${USAGE_METRICS[metric].noun}`}
            values={rows.map((r) => r.avg)}
            unit={unit}
            noun={plural}
            selected={bin}
            onSelect={setBin}
          />
        </section>
        <section
          aria-label={`Ranked ${plural}`}
          className="min-w-0 rounded-xl border border-line bg-surface-2 p-4 shadow-panel @4xl:col-span-7"
        >
          <RankedTable
            rows={shown}
            total={rows.reduce((sum, r) => sum + r.avg, 0)}
            unit={unit}
            group={group}
            restarts={metric === 'restarts'}
            color={(row) => (charted.includes(row) ? color(row.key) : undefined)}
            filtered={bin !== undefined}
            onClearFilter={() => setBin(undefined)}
          />
        </section>
      </div>
    </div>
  )
}

/** A headline amount, CPU in words: "3.1 cores", "812 millicores". */
function amount(value: number, unit: Unit): string {
  if (unit !== 'cores') return formatValue(value, unit)
  return value < 1 ? `${Math.round(value * 1000)} millicores` : `${formatValue(value, unit)} cores`
}

function Tile({ label, value, small = false }: { label: string; value?: string; small?: boolean }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface-2 px-4 py-3 shadow-panel">
      <p className="text-xs text-ink-3">{label}</p>
      <p
        className={cn(
          'mt-1 truncate font-semibold tracking-[-0.02em] text-ink-1',
          small ? 'text-[15px] leading-7' : 'text-[24px] leading-7',
        )}
      >
        {value ?? '—'}
      </p>
    </div>
  )
}

/** The rows of the ranking: one per group, workloads added up from their pods. */
function rowsOf(
  results: { id: string; series: { labels: Record<string, string>; value: number | null }[] }[],
  group: Group,
  owners: ReturnType<typeof useOwners>,
): Row[] {
  const rows = new Map<string, Row>()
  for (const { id, series } of results) {
    for (const { labels, value } of series) {
      const { key, name, namespace, kind } = identify(labels, group, owners)
      const row = rows.get(key) ?? { key, name, namespace, kind, avg: 0 }
      // Prometheus can answer NaN (say, 0/0); that counts as nothing.
      const amount = value ?? 0
      if (id === 'avg') row.avg += amount
      // A workload's peak isn't the sum of its pods' peaks, so only single series have one.
      if (id === 'max' && group !== 'workload') row.max = amount
      if (id === 'now') row.now = (row.now ?? 0) + amount
      rows.set(key, row)
    }
  }
  return [...rows.values()].sort((a, b) => b.avg - a.avg)
}

function identify(
  labels: Record<string, string>,
  group: Group,
  owners: ReturnType<typeof useOwners>,
) {
  const namespace = labels.namespace
  switch (group) {
    case 'namespace':
      return { key: namespace!, name: namespace!, kind: 'Namespace' as ResourceKind }
    case 'node':
      return { key: labels.node!, name: labels.node!, kind: 'Node' as ResourceKind }
    case 'pod':
      return {
        key: `${namespace}/${labels.pod}`,
        name: labels.pod!,
        namespace,
        kind: 'Pod' as ResourceKind,
      }
    case 'workload': {
      const owner = owners(namespace!, labels.pod!)
      return { key: `${namespace}/${owner.name}`, name: owner.name, namespace, kind: owner.kind }
    }
  }
}

/** Narrows a query to the charted groups. */
function restrict(group: Group, rows: Row[]): Matcher[] {
  const any = (values: string[]) => [...new Set(values)].map(escapeRegex).join('|')
  switch (group) {
    case 'namespace':
      return [['namespace', '=~', any(rows.map((r) => r.name))]]
    case 'node':
      return [['node', '=~', any(rows.map((r) => r.name))]]
    case 'pod':
      return [
        ['namespace', '=~', any(rows.map((r) => r.namespace!))],
        ['pod', '=~', any(rows.map((r) => r.name))],
      ]
    case 'workload':
      // The workloads' pods by name (or the pod itself, for pods without one).
      return [
        ['namespace', '=~', any(rows.map((r) => r.namespace!))],
        ['pod', '=~', `(${any(rows.map((r) => r.name))})(-.+)?`],
      ]
  }
}

/** The charted groups' series, in ranking order, and Other: the total less what they add up to. */
function chartSeries(
  result: RangeResult,
  group: Group,
  charted: Row[],
  more: boolean,
  owners: ReturnType<typeof useOwners>,
) {
  const series = new Map(
    charted.map((r) => [r.key, { key: r.key, label: r.name, parts: [] as (number | null)[][] }]),
  )
  for (const s of result.results.find((r) => r.id === 'top')!.series) {
    series.get(identify(s.labels, group, owners).key)?.parts.push(s.values)
  }
  const shown = [...series.values()]
    .filter((s) => s.parts.length > 0)
    .map(({ key, label, parts }) => ({
      key,
      label,
      values: sumValues(
        parts.map((values) => ({ key, label, values })),
        result.points,
      ),
    }))
  if (!more) return shown
  const total = result.results.find((r) => r.id === 'total')!.series[0]!
  // What the charted series add up to, counting their gaps as nothing.
  const counted = (i: number) => shown.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)
  return [
    ...shown,
    {
      key: OTHER,
      label: 'Other',
      values: total.values.map((v, i) => (v === null ? null : Math.max(0, v - counted(i)))),
    },
  ]
}

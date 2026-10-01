import type { UseQueryResult } from '@tanstack/react-query'
import { ChartSpline, RotateCw, Table2, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { RangeResult } from '@shared/api'
import { IconButton } from '@renderer/components/Button'
import { formatMoment, formatValue, summarize } from '@renderer/components/charts/scale'
import {
  TimeChart,
  type ChartKind,
  type ChartReference,
  type ChartSeries,
} from '@renderer/components/charts/TimeChart'
import { Loading } from '@renderer/components/States'
import { timesOf } from '@renderer/hooks/history'
import { cn } from '@renderer/lib/cn'
import { RANGES, type TimeSelection, type Unit } from '@renderer/lib/promql'

/** Presets that follow the clock, and the window zoomed into, if any. */
export function RangePicker({
  selection,
  onChange,
}: {
  selection: TimeSelection
  onChange: (selection: TimeSelection) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <div
        role="group"
        aria-label="Time range"
        className="flex rounded-lg border border-line bg-surface-2 p-0.5"
      >
        {RANGES.map((range) => (
          <button
            key={range.id}
            type="button"
            title={range.label}
            aria-pressed={'range' in selection && selection.range === range.id}
            onClick={() => onChange({ range: range.id })}
            className="h-6 rounded-md px-2 text-xs font-medium text-ink-2 tabular-nums transition-colors hover:text-ink-1 aria-pressed:bg-surface aria-pressed:text-ink-1 aria-pressed:shadow-[0_0_0_1px_var(--line-strong)]"
          >
            {range.id}
          </button>
        ))}
      </div>
      {'from' in selection && (
        <span className="flex h-7 items-center gap-1 rounded-full bg-accent-soft pr-1 pl-2.5 text-xs font-medium text-accent-strong tabular-nums">
          {formatMoment(selection.from, selection.to - selection.from)} –{' '}
          {formatMoment(selection.to, selection.to - selection.from)}
          <button
            type="button"
            aria-label="Reset zoom"
            title="Reset zoom"
            onClick={() => onChange({ range: selection.back })}
            className="grid size-5 place-items-center rounded-full hover:bg-accent/15"
          >
            <X className="size-3.5" />
          </button>
        </span>
      )}
    </div>
  )
}

/** What a chart needs from a range result. */
export interface ChartData {
  series: ChartSeries[]
  references?: ChartReference[]
}

/**
 * A chart in a card: a title with the total's latest, average and peak
 * values, the chart (or its table), and its loading, empty and error states.
 * While new data loads, the previous frame stays, dimmed.
 */
export function ChartCard({
  title,
  query,
  data,
  unit,
  kind,
  onZoom,
  height = 180,
  empty,
  emptyTitle = 'No data for this time',
  summary = 'total',
  className,
}: {
  title: string
  query: UseQueryResult<RangeResult>
  data: (result: RangeResult) => ChartData
  unit: Unit
  kind: ChartKind
  onZoom: (from: number, to: number) => void
  height?: number
  /** Why there may be no data, for the empty state. */
  empty: ReactNode
  emptyTitle?: string
  /** Headline numbers: the sum of the series, or none (when they don't add up, like in/out). */
  summary?: 'total' | 'none'
  className?: string
}) {
  const [table, setTable] = useState(false)
  const result = query.data
  const chart = result && data(result)
  const filled = chart?.series.filter((s) => s.values.some((v) => v !== null)) ?? []
  const totals =
    result && summary === 'total' && filled.length > 0
      ? summarize(
          timesOf(result).map((_, i) =>
            filled.some((s) => s.values[i] !== null)
              ? filled.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)
              : null,
          ),
        )
      : undefined

  let body: ReactNode
  if (query.isPending) {
    body = <Loading label="Loading…" className="py-0" />
  } else if (!result) {
    body = (
      <div role="alert" className="flex flex-col items-center gap-2 text-center text-xs text-ink-2">
        <p className="max-w-sm break-words">{(query.error as Error).message}</p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="flex items-center gap-1 font-medium text-accent-strong hover:underline"
        >
          <RotateCw className="size-3.5" /> Try again
        </button>
      </div>
    )
  } else if (filled.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-1.5 text-center">
        <ChartSpline className="size-5 text-ink-3" />
        <p className="text-[13px] font-medium text-ink-1">{emptyTitle}</p>
        <p className="max-w-sm text-xs leading-relaxed text-ink-3">{empty}</p>
      </div>
    )
  } else if (table) {
    body = <SeriesTable series={filled} unit={unit} />
  } else {
    body = (
      <TimeChart
        label={title}
        times={timesOf(result)}
        series={filled}
        unit={unit}
        kind={kind}
        references={chart!.references}
        height={height}
        onZoom={onZoom}
        stale={query.isPlaceholderData}
      />
    )
  }
  const centered = !(result && filled.length > 0)

  return (
    <section
      aria-label={title}
      className={cn(
        'flex min-w-0 flex-col rounded-xl border border-line bg-surface-2 p-4 shadow-panel',
        className,
      )}
    >
      <header className="mb-3 flex min-h-7 items-center gap-3">
        <h3 className="text-[13px] font-semibold text-ink-1">{title}</h3>
        {totals && (
          <p className="flex min-w-0 flex-1 flex-wrap justify-end gap-x-3 text-xs text-ink-3">
            <span>
              Now{' '}
              <span className="font-semibold text-ink-1 tabular-nums">
                {formatValue(totals.last, unit)}
              </span>
            </span>
            <span>
              Avg{' '}
              <span className="font-medium text-ink-2 tabular-nums">
                {formatValue(totals.avg, unit)}
              </span>
            </span>
            <span>
              Peak{' '}
              <span className="font-medium text-ink-2 tabular-nums">
                {formatValue(totals.max, unit)}
              </span>
            </span>
          </p>
        )}
        {!totals && <span className="flex-1" />}
        {filled.length > 0 && (
          <IconButton
            label={table ? 'Show as chart' : 'Show as table'}
            onClick={() => setTable(!table)}
            className="size-7"
          >
            {table ? <ChartSpline /> : <Table2 />}
          </IconButton>
        )}
      </header>
      {query.isError && result && (
        <p className="mb-2 text-xs text-warn-text">Couldn’t refresh — showing the last data.</p>
      )}
      <div
        className={cn(centered && 'grid place-items-center')}
        style={centered ? { minHeight: height } : undefined}
      >
        {body}
      </div>
    </section>
  )
}

/** The chart as a table: each series' latest, average and peak. */
function SeriesTable({ series, unit }: { series: ChartSeries[]; unit: Unit }) {
  return (
    <table className="w-full text-left text-xs">
      <thead>
        <tr className="border-b border-line text-2xs tracking-wider text-ink-3 uppercase">
          <th className="py-1.5 font-medium">Series</th>
          <th className="py-1.5 text-right font-medium">Now</th>
          <th className="py-1.5 text-right font-medium">Average</th>
          <th className="py-1.5 text-right font-medium">Peak</th>
        </tr>
      </thead>
      <tbody>
        {series.map((s) => {
          const stats = summarize(s.values)!
          return (
            <tr key={s.key} className="border-b border-line last:border-0">
              <td className="max-w-0 py-1.5">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-[3px]"
                    style={{ background: s.color }}
                  />
                  <span className="truncate text-ink-1">{s.label}</span>
                </span>
              </td>
              <td className="py-1.5 text-right text-ink-1 tabular-nums">
                {formatValue(stats.last, unit)}
              </td>
              <td className="py-1.5 text-right text-ink-2 tabular-nums">
                {formatValue(stats.avg, unit)}
              </td>
              <td className="py-1.5 text-right text-ink-2 tabular-nums">
                {formatValue(stats.max, unit)}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

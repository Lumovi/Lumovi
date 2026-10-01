import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { RangeResult } from '@shared/api'
import { summarize } from '@renderer/components/charts/scale'
import type { ChartKind, ChartReference } from '@renderer/components/charts/TimeChart'
import { OTHER, useSeriesColors } from '@renderer/hooks/history'
import type { Unit } from '@renderer/lib/promql'
import { ChartCard } from './ChartCard'

export interface RawSeries {
  key: string
  label: string
  values: (number | null)[]
}

/** The series of one query in a result, named by a label (or fixed names). */
export function pick(
  result: RangeResult,
  id: string,
  name: (labels: Record<string, string>) => string,
): RawSeries[] {
  return result.results
    .find((r) => r.id === id)!
    .series.map((s) => ({ key: name(s.labels), label: name(s.labels), values: s.values }))
}

/** Adds series up, time by time; null where none of them has a sample. */
export function sumValues(series: RawSeries[], points: number): (number | null)[] {
  return Array.from({ length: points }, (_, i) =>
    series.some((s) => s.values[i] !== null)
      ? // Number(null) is 0: gaps count as nothing.
        series.reduce((sum, s) => sum + Number(s.values[i]), 0)
      : null,
  )
}

/**
 * The biggest series by average, then the rest added up as "Other" (when
 * `other`): at most eight on screen, so every one gets its own color.
 */
export function topSeries(series: RawSeries[], limit: number, other: boolean, points: number) {
  const ranked = series
    .map((s) => ({ s, avg: summarize(s.values)?.avg ?? -1 }))
    .sort((a, b) => b.avg - a.avg)
    .map(({ s }) => s)
  const rest = ranked.slice(limit)
  if (!other || rest.length === 0) return ranked.slice(0, limit)
  return [
    ...ranked.slice(0, limit),
    { key: OTHER, label: `Other (${rest.length})`, values: sumValues(rest, points) },
  ]
}

/** A usage chart over one query of a shared range result, ranked and colored per series. */
export function UsageChart({
  title,
  query,
  series,
  unit,
  kind,
  references,
  limit = 7,
  other = true,
  empty,
  onZoom,
  summary,
  height,
}: {
  title: string
  query: UseQueryResult<RangeResult>
  series: (result: RangeResult) => RawSeries[]
  unit: Unit
  kind: ChartKind
  references?: ChartReference[]
  limit?: number
  other?: boolean
  empty: ReactNode
  onZoom: (from: number, to: number) => void
  summary?: 'total' | 'none'
  height?: number
}) {
  const result = query.data
  // Counts that never went up (restarts) are nothing to chart.
  const shown = result
    ? topSeries(
        series(result).filter((s) => unit !== 'count' || s.values.some((v) => (v ?? 0) > 0.5)),
        limit,
        other,
        result.points,
      )
    : []
  const color = useSeriesColors(shown.map((s) => s.key))
  return (
    <ChartCard
      title={title}
      query={query}
      data={() => ({
        series: shown.map((s) => ({ ...s, color: color(s.key) })),
        references,
      })}
      unit={unit}
      kind={kind}
      onZoom={onZoom}
      empty={empty}
      emptyTitle={unit === 'count' ? 'None in this time' : undefined}
      summary={summary}
      height={height}
    />
  )
}

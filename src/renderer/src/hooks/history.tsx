import { useQuery, useQueryClient, type Query } from '@tanstack/react-query'
import { createContext, useContext, useState, type ReactNode } from 'react'
import type { MetricsSourceSetting } from '@shared/api'
import { api, unwrap } from '@renderer/lib/api'
import {
  bucketWindow,
  windowFor,
  type RangeId,
  type TimeSelection,
  type TimeWindow,
} from '@renderer/lib/promql'
import { useCluster } from '@renderer/state/cluster'

/** Where the current cluster's usage history comes from, detected once per session. */
export function useHistorySource() {
  const { context } = useCluster()
  return useQuery({
    queryKey: ['usage-source', context],
    queryFn: () => unwrap(api.usage.source(context)),
    staleTime: Infinity,
  })
}

/** Looks for the source again (or applies a new setting), then reloads every chart. */
export function useResetSource() {
  const { context } = useCluster()
  const queryClient = useQueryClient()
  return async (setting?: MetricsSourceSetting) => {
    if (setting)
      queryClient.setQueryData(['settings'], await api.app.setMetricsSource(context, setting))
    queryClient.setQueryData(
      ['usage-source', context],
      await unwrap(api.usage.source(context, true)),
    )
    await queryClient.invalidateQueries({ queryKey: ['usage', context] })
  }
}

/** How often charts that follow the clock refresh. */
const REFRESH: Record<RangeId, number> = {
  '15m': 30_000,
  '1h': 30_000,
  '6h': 60_000,
  '24h': 300_000,
  '7d': 600_000,
}

export interface UsageQuery {
  id: string
  expr: string
}

/**
 * Keeps showing the previous result while another time loads, but only for
 * the same question: data for another metric or grouping would be misread.
 */
function previousIf(prefix: unknown[]) {
  const same = JSON.stringify(prefix)
  return <T,>(
    previous: T | undefined,
    query: Query<T, Error, T, readonly unknown[]> | undefined,
  ) =>
    query && JSON.stringify(query.queryKey.slice(0, prefix.length)) === same ? previous : undefined
}

/**
 * History over the selected time: a preset follows the clock and refreshes,
 * a zoomed window stays put. Queries are built for the window they cover,
 * since rate windows depend on its step. `key` names what is asked; `detail`
 * narrows it (which series) without changing the question.
 */
export function useUsageRange(
  key: unknown[],
  build: (window: TimeWindow) => UsageQuery[],
  selection: TimeSelection,
  {
    buckets = false,
    enabled = true,
    detail,
  }: { buckets?: boolean; enabled?: boolean; detail?: unknown } = {},
) {
  const { context } = useCluster()
  const ready = useHistorySource().data?.state === 'ready'
  const prefix = ['usage', context, 'range', buckets, ...key]
  return useQuery({
    queryKey: [...prefix, detail, selection],
    queryFn: () => {
      const window = windowFor(selection, Date.now())
      const covered = buckets ? bucketWindow(window) : window
      return unwrap(api.usage.range({ context, queries: build(covered), ...covered }))
    },
    enabled: ready && enabled,
    placeholderData: previousIf(prefix),
    refetchInterval: 'range' in selection ? REFRESH[selection.range] : false,
  })
}

/** Values at the end of the selected time, e.g. averages and peaks over it. */
export function useUsageInstant(
  key: unknown[],
  build: (window: TimeWindow) => UsageQuery[],
  selection: TimeSelection,
) {
  const { context } = useCluster()
  const ready = useHistorySource().data?.state === 'ready'
  const prefix = ['usage', context, 'instant', ...key]
  return useQuery({
    queryKey: [...prefix, selection],
    queryFn: () => {
      const window = windowFor(selection, Date.now())
      return unwrap(api.usage.instant({ context, queries: build(window), time: window.end }))
    },
    enabled: ready,
    placeholderData: previousIf(prefix),
    refetchInterval: 'range' in selection ? REFRESH[selection.range] : false,
  })
}

/** The times of a range result's steps. */
export function timesOf({ start, step, points }: { start: number; step: number; points: number }) {
  return Array.from({ length: points }, (_, i) => start + i * step)
}

export const OTHER = 'Other'

/** The slot each series asked for first, shared by the charts of one view. */
const ColorScope = createContext<Map<string, number> | null>(null)

/** Gives the charts inside the same color for the same series (a namespace, a pod…). */
export function SeriesColorScope({ children }: { children: ReactNode }) {
  const [slots] = useState(() => new Map<string, number>())
  return <ColorScope value={slots}>{children}</ColorScope>
}

/**
 * Chart colors that follow each series rather than its rank: a series keeps
 * the slot it got first in its view (so a namespace looks the same in every
 * chart), unless another series in the same chart already has it; then it
 * takes the lowest free one. "Other" is always gray.
 */
export function useSeriesColors(keys: string[]): (key: string) => string {
  // Every chart sits inside a view's scope.
  const preferred = useContext(ColorScope)!
  const chart = new Map<string, number>()
  const taken = new Set<number>()
  for (const key of keys.filter((k) => k !== OTHER)) {
    if (!preferred.has(key)) preferred.set(key, preferred.size % 8)
    let slot = preferred.get(key)!
    while (taken.has(slot)) slot = (slot + 1) % 8
    chart.set(key, slot)
    taken.add(slot)
  }
  return (key) => (key === OTHER ? 'var(--series-other)' : `var(--series-${chart.get(key)! + 1})`)
}

import { create } from 'zustand'

export interface UsagePoint {
  at: number
  /** Fraction of allocatable capacity in use, 0–1. */
  cpu: number
  memory: number
}

const MAX_POINTS = 60

interface UsageHistory {
  byContext: Record<string, UsagePoint[]>
  record: (context: string, point: UsagePoint) => void
}

/** Cluster-wide usage sampled during this session, for sparklines. */
export const useUsageHistory = create<UsageHistory>()((set) => ({
  byContext: {},
  record: (context, point) =>
    set((state) => ({
      byContext: {
        ...state.byContext,
        [context]: [...(state.byContext[context] ?? []), point].slice(-MAX_POINTS),
      },
    })),
}))

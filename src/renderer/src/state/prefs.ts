import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { RangeId } from '@renderer/lib/promql'

const MAX_RECENT = 5

interface Prefs {
  /** The namespace picked per context; `null` is "All namespaces". */
  namespaces: Record<string, string | null>
  setNamespace: (context: string, namespace: string | null) => void
  /** Contexts opened most recently, newest first. */
  recent: string[]
  touchRecent: (context: string) => void
  /** Width of the detail panel in pixels, when the user has resized it. */
  panelWidth?: number
  setPanelWidth: (width: number) => void
  /** The time range metrics charts open with. */
  metricsRange: RangeId
  setMetricsRange: (range: RangeId) => void
}

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      namespaces: {},
      setNamespace: (context, namespace) =>
        set((prefs) => ({ namespaces: { ...prefs.namespaces, [context]: namespace } })),
      recent: [],
      touchRecent: (context) =>
        set((prefs) => ({
          recent: [context, ...prefs.recent.filter((c) => c !== context)].slice(0, MAX_RECENT),
        })),
      setPanelWidth: (panelWidth) => set({ panelWidth }),
      metricsRange: '1h',
      setMetricsRange: (metricsRange) => set({ metricsRange }),
    }),
    { name: 'kubestacks:prefs' },
  ),
)

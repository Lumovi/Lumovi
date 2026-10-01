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
  /** Kinds pinned to the sidebar, shown in every cluster that has them. */
  pinned: string[]
  setPinned: (kind: string, pinned: boolean) => void
  /** API groups unfolded in the sidebar's custom resources. */
  openGroups: string[]
  setGroupOpen: (group: string, open: boolean) => void
}

const toggled = (list: string[], item: string, on: boolean) =>
  on ? [...list.filter((i) => i !== item), item] : list.filter((i) => i !== item)

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
      pinned: [],
      setPinned: (kind, pinned) =>
        set((prefs) => ({ pinned: toggled(prefs.pinned, kind, pinned) })),
      openGroups: [],
      setGroupOpen: (group, open) =>
        set((prefs) => ({ openGroups: toggled(prefs.openGroups, group, open) })),
    }),
    { name: 'kubestacks:prefs' },
  ),
)

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { RangeId } from '@renderer/lib/promql'
import type { Marks } from '@shared/marks'
import type { ColumnChoices } from '@renderer/features/resources/column-choices'

const MAX_RECENT = 5
/** Custom kinds kept in the sidebar per cluster, most recently opened first. */
const MAX_RECENT_KINDS = 5

interface Prefs {
  /**
   * The namespaces picked per context; `null` is "All namespaces". (A name alone is how one was
   * kept before several could be picked.)
   */
  namespaces: Record<string, readonly string[] | string | null>
  setNamespaces: (context: string, namespaces: readonly string[] | null) => void
  /** The namespace a context was last left in, forgotten: it opens where it's set to. */
  forgetNamespace: (context: string) => void
  /** Contexts opened most recently, newest first. */
  recent: string[]
  touchRecent: (context: string) => void
  /** Width of the detail panel in pixels, when the user has resized it. */
  panelWidth?: number
  setPanelWidth: (width: number) => void
  /** Height of the terminal dock in pixels, when the user has resized it. */
  terminalHeight?: number
  setTerminalHeight: (height: number) => void
  /** The time range metrics charts open with. */
  metricsRange: RangeId
  setMetricsRange: (range: RangeId) => void
  /** Kinds pinned to the sidebar, shown in every cluster that has them. */
  pinned: string[]
  setPinned: (kind: string, pinned: boolean) => void
  /** Custom kinds opened most recently, per context, newest first. */
  recentKinds: Record<string, string[]>
  touchKind: (context: string, kind: string) => void
  /** The chart on this computer each Helm release was last deployed from, by `context/namespace/name`. */
  localCharts: Record<string, string>
  setLocalChart: (release: string, path: string) => void
  /** How the clusters page groups clusters: Lumovi's groups, a label's values (`label:key`), or not. */
  clusterGrouping: 'group' | 'none' | `label:${string}`
  setClusterGrouping: (grouping: Prefs['clusterGrouping']) => void
  /** Whether the clusters page shows the clusters hidden from it. */
  showHidden: boolean
  setShowHidden: (showHidden: boolean) => void
  /** Whether a comparison shows status and what the cluster set: as it was last left. */
  compareNoise: boolean
  setCompareNoise: (compareNoise: boolean) => void
  /**
   * The set of clusters last listed together, by context: the sidebar's Several clusters opens it
   * again. (One that signs in, remembered, is still read only once it's opened on the page.)
   */
  severalSet: string[]
  setSeveralSet: (contexts: string[]) => void
  /**
   * What was chosen for each list's columns, by `<context>/<list>` (a kind, or a page's own list:
   * "workloads", "helm", a plugin's).
   */
  columns: Record<string, ColumnChoices>
  /** Keeps what was chosen for a list's columns; nothing, to go back to Lumovi's. */
  setColumns: (list: string, choices: ColumnChoices | undefined) => void
  /**
   * On the desktop: what's pinned and saved in each cluster, by context. (A server keeps each
   * person's for them: see hooks/marks.ts.)
   */
  marks: Record<string, Marks>
  setMarks: (context: string, marks: Marks) => void
  /**
   * On a server: the clusters whose new warnings a person is told of in this browser, by
   * `<person>|<context>`, each with the namespaces it watches (all, where none are named).
   */
  warnings: Record<string, { watch?: string[] }>
  setWarnings: (key: string, watching: { watch?: string[] } | undefined) => void
  /** The side of Create used last, which opens first: its form, or its YAML. */
  createSide: 'form' | 'yaml'
  setCreateSide: (side: Prefs['createSide']) => void
  /** How an object's Events tab shows its events, as last chosen: a list, or a timeline. */
  eventsTabAs: 'list' | 'timeline'
  setEventsTabAs: (as: Prefs['eventsTabAs']) => void
}

const toggled = (list: string[], item: string, on: boolean) =>
  on ? [...list.filter((i) => i !== item), item] : list.filter((i) => i !== item)

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      namespaces: {},
      setNamespaces: (context, namespaces) =>
        set((prefs) => ({
          namespaces: { ...prefs.namespaces, [context]: namespaces?.length ? namespaces : null },
        })),
      forgetNamespace: (context) =>
        set((prefs) => {
          const { [context]: _forgotten, ...namespaces } = prefs.namespaces
          return { namespaces }
        }),
      columns: {},
      setColumns: (list, choices) =>
        set((prefs) => {
          const { [list]: _old, ...others } = prefs.columns
          return { columns: choices ? { ...others, [list]: choices } : others }
        }),
      recent: [],
      touchRecent: (context) =>
        set((prefs) => ({
          recent: [context, ...prefs.recent.filter((c) => c !== context)].slice(0, MAX_RECENT),
        })),
      setPanelWidth: (panelWidth) => set({ panelWidth }),
      setTerminalHeight: (terminalHeight) => set({ terminalHeight }),
      metricsRange: '1h',
      setMetricsRange: (metricsRange) => set({ metricsRange }),
      pinned: [],
      setPinned: (kind, pinned) =>
        set((prefs) => ({ pinned: toggled(prefs.pinned, kind, pinned) })),
      recentKinds: {},
      touchKind: (context, kind) =>
        set((prefs) => ({
          recentKinds: {
            ...prefs.recentKinds,
            [context]: [
              kind,
              ...(prefs.recentKinds[context] ?? []).filter((k) => k !== kind),
            ].slice(0, MAX_RECENT_KINDS),
          },
        })),
      localCharts: {},
      setLocalChart: (release, path) =>
        set((prefs) => ({ localCharts: { ...prefs.localCharts, [release]: path } })),
      clusterGrouping: 'group',
      setClusterGrouping: (clusterGrouping) => set({ clusterGrouping }),
      showHidden: false,
      setShowHidden: (showHidden) => set({ showHidden }),
      compareNoise: false,
      setCompareNoise: (compareNoise) => set({ compareNoise }),
      severalSet: [],
      setSeveralSet: (severalSet) => set({ severalSet }),
      createSide: 'form',
      setCreateSide: (createSide) => set({ createSide }),
      eventsTabAs: 'list',
      setEventsTabAs: (eventsTabAs) => set({ eventsTabAs }),
      warnings: {},
      setWarnings: (key, watching) =>
        set((prefs) => {
          const { [key]: _old, ...others } = prefs.warnings
          return { warnings: watching ? { ...others, [key]: watching } : others }
        }),
      marks: {},
      setMarks: (context, marks) =>
        set((prefs) => {
          const { [context]: _old, ...others } = prefs.marks
          // (Nothing pinned or saved is nothing kept.)
          const any = marks.pins.length > 0 || marks.views.length > 0
          return { marks: any ? { ...others, [context]: marks } : others }
        }),
    }),
    { name: 'lumovi:prefs' },
  ),
)

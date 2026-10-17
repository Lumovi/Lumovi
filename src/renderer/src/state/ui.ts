import { create } from 'zustand'

interface UiState {
  palette: boolean
  shortcuts: boolean
  /** The Create dialog. */
  create: boolean
  /** The current cluster's metrics source settings. */
  metricsSource: boolean
  /** The sidebar, where it's a drawer (a narrow page). */
  sidebar: boolean
  /**
   * A page of its own inside the page, on a phone (what a list's picked row opens): the top bar
   * has Back in the menu's place. That's all it's given: the bar's title stays the page's own,
   * which Lumovi wrote. A row's name is its plugin's text, and no plugin's text is drawn in
   * Lumovi's bar; it has no field to come by.
   */
  inside?: {
    back: () => void
    /** What Back is named, where not "Back to the list". */ label?: string
  }
  setPalette: (open: boolean) => void
  setShortcuts: (open: boolean) => void
  setCreate: (open: boolean) => void
  setMetricsSource: (open: boolean) => void
  setSidebar: (open: boolean) => void
  setInside: (inside: UiState['inside']) => void
}

/** Open/closed state of app-wide overlays, reachable from hotkeys and the native menu. */
export const useUi = create<UiState>()((set) => ({
  palette: false,
  shortcuts: false,
  create: false,
  metricsSource: false,
  sidebar: false,
  setPalette: (palette) => set({ palette }),
  setShortcuts: (shortcuts) => set({ shortcuts }),
  setCreate: (create) => set({ create }),
  setMetricsSource: (metricsSource) => set({ metricsSource }),
  setSidebar: (sidebar) => set({ sidebar }),
  setInside: (inside) => set({ inside }),
}))

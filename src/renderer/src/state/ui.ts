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
   * names it and has Back in the menu's place.
   */
  inside?: { title: string; back: () => void }
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

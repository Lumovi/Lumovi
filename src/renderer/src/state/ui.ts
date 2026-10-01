import { create } from 'zustand'

interface UiState {
  palette: boolean
  shortcuts: boolean
  /** The "Create from YAML" dialog. */
  create: boolean
  /** The current cluster's metrics source settings. */
  metricsSource: boolean
  setPalette: (open: boolean) => void
  setShortcuts: (open: boolean) => void
  setCreate: (open: boolean) => void
  setMetricsSource: (open: boolean) => void
}

/** Open/closed state of app-wide overlays, reachable from hotkeys and the native menu. */
export const useUi = create<UiState>()((set) => ({
  palette: false,
  shortcuts: false,
  create: false,
  metricsSource: false,
  setPalette: (palette) => set({ palette }),
  setShortcuts: (shortcuts) => set({ shortcuts }),
  setCreate: (create) => set({ create }),
  setMetricsSource: (metricsSource) => set({ metricsSource }),
}))

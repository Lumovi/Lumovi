import { create } from 'zustand'

interface UiState {
  palette: boolean
  shortcuts: boolean
  /** The "Create from YAML" dialog. */
  create: boolean
  setPalette: (open: boolean) => void
  setShortcuts: (open: boolean) => void
  setCreate: (open: boolean) => void
}

/** Open/closed state of app-wide overlays, reachable from hotkeys and the native menu. */
export const useUi = create<UiState>()((set) => ({
  palette: false,
  shortcuts: false,
  create: false,
  setPalette: (palette) => set({ palette }),
  setShortcuts: (shortcuts) => set({ shortcuts }),
  setCreate: (create) => set({ create }),
}))

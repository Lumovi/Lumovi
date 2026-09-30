import { create } from 'zustand'
import type { KubeObject } from '@shared/api'

interface ActionsState {
  /** The action whose dialog is open, and the object it acts on. */
  active: { id: string; object: KubeObject } | null
  /** Whether the detail panel's actions menu is open (the `.` shortcut opens it). */
  menu: boolean
  /** The object (by `Kind/namespace/name`) open in the YAML editor. */
  editing: string | null
  /** A tab the detail panel should switch to, e.g. after choosing "Shell". */
  tab: { ref: string; tab: string } | null
  /** The container to open a shell in first, like a debug container just added. */
  shell: string | null
  start(id: string, object: KubeObject): void
  close(): void
  setMenu(open: boolean): void
  edit(ref: string | null): void
  showTab(ref: string, tab: string, shell?: string): void
  tabShown(): void
}

export const useActionsUi = create<ActionsState>((set) => ({
  active: null,
  menu: false,
  editing: null,
  tab: null,
  shell: null,
  start: (id, object) => set({ active: { id, object }, menu: false }),
  close: () => set({ active: null }),
  setMenu: (menu) => set({ menu }),
  edit: (editing) => set({ editing }),
  showTab: (ref, tab, shell) => set({ tab: { ref, tab }, shell: shell ?? null }),
  tabShown: () => set({ tab: null }),
}))

/**
 * For menus and the palette: when closing them opened an action's dialog,
 * focus stays with the dialog instead of going back to what opened the menu.
 */
export function keepFocusInActionDialog(event: Event): void {
  if (useActionsUi.getState().active) event.preventDefault()
}

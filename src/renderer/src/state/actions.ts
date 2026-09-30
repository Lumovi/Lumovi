import { create } from 'zustand'
import type { KubeObject } from '@shared/api'

interface ActionsState {
  /** The action whose dialog is open, and the object it acts on. */
  active: { id: string; object: KubeObject } | null
  /** Whether the detail panel's actions menu is open (the `.` shortcut opens it). */
  menu: boolean
  /** The object (by `Kind/namespace/name`) open in the YAML editor. */
  editing: string | null
  start(id: string, object: KubeObject): void
  close(): void
  setMenu(open: boolean): void
  edit(ref: string | null): void
}

export const useActionsUi = create<ActionsState>((set) => ({
  active: null,
  menu: false,
  editing: null,
  start: (id, object) => set({ active: { id, object }, menu: false }),
  close: () => set({ active: null }),
  setMenu: (menu) => set({ menu }),
  edit: (editing) => set({ editing }),
}))

/**
 * For menus and the palette: when closing them opened an action's dialog,
 * focus stays with the dialog instead of going back to what opened the menu.
 */
export function keepFocusInActionDialog(event: Event): void {
  if (useActionsUi.getState().active) event.preventDefault()
}

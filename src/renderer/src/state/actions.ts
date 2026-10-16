import { create } from 'zustand'
import type { KubeObject, PluginVia } from '@shared/api'

interface ActionsState {
  /** The action whose dialog is open, and the object it acts on. */
  active: {
    id: string
    object: KubeObject
    /** What a plugin's link asked of its dialog: a forward's port; and which plugin's it was. */
    port?: number
    via?: PluginVia
  } | null
  /** Whether the detail panel's actions menu is open (the `.` shortcut opens it). */
  menu: boolean
  /** The object (by `Kind/namespace/name`) open in the YAML editor. */
  editing: string | null
  /** A tab the detail panel should switch to, e.g. after choosing "Shell". */
  tab: { ref: string; tab: string } | null
  /** When a tab was last asked for: a menu that closes just then leaves the focus to it. */
  tabAskedAt?: number
  /**
   * The container to open a pod's shell in, like a debug container just added. Asked by a
   * plugin's link (`via`), the tab waits for the person's Start, each time it's asked anew
   * (`n`), and a link never starts one. Attached to a container's process, rather (`how`).
   */
  shell: {
    ref: string
    container?: string
    via?: PluginVia
    how?: 'attach'
    n: number
  } | null
  /** The container to show a pod's logs from, as a plugin's link asked: each ask anew (`n`). */
  logs: { ref: string; container: string; n: number } | null
  /** An object a link opened on its Logs tab: they start without following, until asked to. */
  linkedLogs: string | null
  start(id: string, object: KubeObject, asked?: { port?: number; via?: PluginVia }): void
  close(): void
  setMenu(open: boolean): void
  edit(ref: string | null): void
  showTab(ref: string, tab: string, shell?: string, via?: PluginVia, how?: 'attach'): void
  tabShown(): void
  /** The person pressed Start on a shell a plugin's link asked for: the tab is theirs again. */
  shellStarted(ref: string): void
}

export const useActionsUi = create<ActionsState>((set) => ({
  active: null,
  menu: false,
  editing: null,
  tab: null,
  shell: null,
  logs: null,
  linkedLogs: null,
  start: (id, object, asked) => set({ active: { id, object, ...asked }, menu: false }),
  close: () => set({ active: null }),
  setMenu: (menu) => set({ menu }),
  edit: (editing) => set({ editing }),
  showTab: (ref, tab, shell, via, how) =>
    set((state) =>
      tab === 'logs'
        ? {
            tab: { ref, tab },
            tabAskedAt: Date.now(),
            logs: shell ? { ref, container: shell, n: (state.logs?.n ?? 0) + 1 } : null,
          }
        : {
            tab: { ref, tab },
            tabAskedAt: Date.now(),
            shell:
              shell || via || how
                ? {
                    ref,
                    ...(shell ? { container: shell } : {}),
                    ...(via ? { via } : {}),
                    ...(how ? { how } : {}),
                    n: (state.shell?.n ?? 0) + 1,
                  }
                : null,
          },
    ),
  tabShown: () => set({ tab: null }),
  shellStarted: (ref) =>
    set((state) =>
      state.shell?.ref === ref && state.shell.via
        ? {
            shell: {
              ref,
              ...(state.shell.container ? { container: state.shell.container } : {}),
              n: state.shell.n,
            },
          }
        : {},
    ),
}))

/**
 * For menus and the palette: when closing them opened an action's dialog,
 * focus stays with the dialog instead of going back to what opened the menu.
 */
export function keepFocusInActionDialog(event: Event): void {
  const { active, tabAskedAt } = useActionsUi.getState()
  // (Or with the tab it asked for, as it closes: a terminal there takes the keys.)
  if (active || (tabAskedAt !== undefined && Date.now() - tabAskedAt < 1_000)) {
    event.preventDefault()
  }
}

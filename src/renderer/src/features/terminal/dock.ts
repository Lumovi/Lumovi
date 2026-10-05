/**
 * The desktop app's terminals on this computer: a dock at the bottom of a
 * cluster's pages, with a tab for each. They keep running while the dock is
 * hidden, and while other pages (and clusters) are open; closing a tab ends
 * its shell.
 */
import { create } from 'zustand'
import { TerminalSession } from './session'

export interface TerminalTab {
  session: TerminalSession
  /** The cluster kubectl points at there, and its namespace (the context's own unless set). */
  context: string
  namespace?: string
  /** What it's called, once renamed. */
  title?: string
}

/** What a tab says: its own name, or its cluster (and namespace). */
export function tabName(tab: TerminalTab): string {
  return tab.title ?? `${tab.context}${tab.namespace ? `, namespace ${tab.namespace}` : ''}`
}

interface Dock {
  tabs: TerminalTab[]
  /** The tab shown, by its session's id. */
  active: string | null
  open: boolean
  maximized: boolean
  /** Asks the dock to focus the shown terminal (a counter: each ask is new). */
  focus: number
  /**
   * Where a new terminal points: the cluster whose pages are shown, and their
   * namespace (the one picked, else its context's). None on the start screen.
   */
  here?: { context: string; namespace?: string }
  /** A new terminal for `context`, shown at once. */
  add(context: string, namespace?: string): TerminalTab
  /** Ends a terminal; the dock hides once the last one is gone. */
  close(id: string): void
  /** Ends every terminal but this one. */
  closeOthers(id: string): void
  /** Names a terminal; an empty name goes back to its cluster's. */
  rename(id: string, title: string): void
  /** Shows the next terminal (or, -1, the one before), round. */
  step(by: 1 | -1): void
  /** Gives the shown terminal focus again (after its tab's name was edited, say). */
  refocus(): void
  /** Starts the shell again, in the same tab. */
  restart(id: string): void
  /** Shows a terminal (opening the dock, from its bar). */
  select(id: string): void
  /** Shows the dock (with a terminal for `context` if it has none), or hides it. */
  toggle(context: string, namespace?: string): void
  setMaximized(maximized: boolean): void
  /**
   * Types a command into the shown terminal (or a new one for `context`) for
   * the person to run: it isn't run until they press Enter.
   */
  paste(context: string, text: string): void
}

const tabFor = (context: string, namespace?: string): TerminalTab => ({
  session: new TerminalSession({ target: 'local', context, namespace }),
  context,
  namespace,
})

export const useDock = create<Dock>()((set, get) => ({
  tabs: [],
  active: null,
  open: false,
  maximized: false,
  focus: 0,
  add(context, namespace) {
    const tab = tabFor(context, namespace)
    tab.session.start()
    set((dock) => ({
      tabs: [...dock.tabs, tab],
      active: tab.session.id,
      open: true,
      focus: dock.focus + 1,
    }))
    return tab
  },
  close(id) {
    const { tabs, active } = get()
    const index = tabs.findIndex((tab) => tab.session.id === id)
    tabs[index]!.session.dispose()
    const rest = tabs.filter((tab) => tab.session.id !== id)
    // The neighbour takes its place: the one after it, or before it at the end.
    const next = rest[Math.min(index, rest.length - 1)]
    set((dock) => ({
      tabs: rest,
      active: active === id ? (next?.session.id ?? null) : active,
      open: dock.open && rest.length > 0,
      focus: dock.focus + 1,
    }))
  },
  closeOthers(id) {
    for (const tab of get().tabs) if (tab.session.id !== id) tab.session.dispose()
    set((dock) => ({
      tabs: dock.tabs.filter((tab) => tab.session.id === id),
      active: id,
      focus: dock.focus + 1,
    }))
  },
  rename(id, title) {
    const name = title.trim() || undefined
    set((dock) => ({
      tabs: dock.tabs.map((tab) => (tab.session.id === id ? { ...tab, title: name } : tab)),
      focus: dock.focus + 1,
    }))
  },
  refocus() {
    set((dock) => ({ focus: dock.focus + 1 }))
  },
  step(by) {
    const { tabs, active } = get()
    const index = tabs.findIndex((tab) => tab.session.id === active)
    get().select(tabs[(index + by + tabs.length) % tabs.length]!.session.id)
  },
  restart(id) {
    const tabs = get().tabs.map((tab) => {
      if (tab.session.id !== id) return tab
      tab.session.dispose()
      // A new shell, under the same name.
      const fresh = { ...tabFor(tab.context, tab.namespace), title: tab.title }
      fresh.session.start()
      return fresh
    })
    const index = get().tabs.findIndex((tab) => tab.session.id === id)
    set((dock) => ({ tabs, active: tabs[index]!.session.id, focus: dock.focus + 1 }))
  },
  select(id) {
    set((dock) => ({ active: id, open: true, focus: dock.focus + 1 }))
  },
  toggle(context, namespace) {
    const { open, tabs } = get()
    if (open) set({ open: false })
    else if (tabs.length === 0) get().add(context, namespace)
    else set((dock) => ({ open: true, focus: dock.focus + 1 }))
  },
  setMaximized(maximized) {
    set({ maximized })
  },
  paste(context, text) {
    const { tabs, active } = get()
    const shown = tabs.find((tab) => tab.session.id === active)
    const ready = shown && ['connecting', 'open'].includes(shown.session.phase.state)
    const tab = ready ? shown : get().add(context)
    tab.session.paste(text)
    set((dock) => ({ open: true, active: tab.session.id, focus: dock.focus + 1 }))
  },
}))

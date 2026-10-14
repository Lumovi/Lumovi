/**
 * The desktop app's tabs below a cluster's pages, each window's own: terminals on this computer,
 * and objects kept open there from the detail panel (a pod's logs, a Deployment's metrics…). They
 * stay while the tabs below are hidden and while other pages (and clusters) are open; closing a
 * terminal's tab ends its shell.
 */
import { create } from 'zustand'
import type { ObjectRef } from '@renderer/lib/routes'
import { TerminalSession } from './session'

export interface TerminalTab {
  session: TerminalSession
  /** The cluster kubectl points at there, and its namespace (the context's own unless set). */
  context: string
  namespace?: string
  /** What it's called, once renamed. */
  title?: string
}

/** An object kept open below: in its cluster, on one of its tabs, which it keeps as it's shown. */
export interface KeptTab {
  id: string
  context: string
  object: ObjectRef
  /** The detail's tab it's on ("overview", "logs"…). */
  tab: string
  /** When it was found deleted: its last view stays until the tab's closed. */
  deletedAt?: number
  /** Since when its cluster hasn't answered (Lumovi tries again on its own). */
  unreachableSince?: number
}

/** What a tab says: its own name, or its cluster (and namespace). */
export function tabName(tab: TerminalTab): string {
  return tab.title ?? `${tab.context}${tab.namespace ? `, namespace ${tab.namespace}` : ''}`
}

interface Dock {
  tabs: TerminalTab[]
  /** The objects kept open below. */
  kept: KeptTab[]
  /** Every tab below, terminals' and kept objects' alike, by id, in the bar's order. */
  order: string[]
  /** The detail panel's object and the tab it shows: what the palette keeps open below. */
  panelTab?: { ref: string; tab: string }
  /** The tab shown, by its id (a terminal's is its session's). */
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
  /** Keeps an object open below, on `tab`, and shows it: once a window, so again shows it. */
  keep(context: string, object: ObjectRef, tab: string): KeptTab
  /** The kept object, where it is. */
  keptOf(context: string, object: ObjectRef): KeptTab | undefined
  /** A kept object's tab, as it's shown. */
  setKeptTab(id: string, tab: string): void
  /** What became of a kept object: deleted, its cluster out of reach, or neither again. */
  setKeptState(id: string, state: Pick<KeptTab, 'deletedAt' | 'unreachableSince'>): void
  /** Ends a terminal, or lets a kept object go; hidden once the last one is gone. */
  close(id: string): void
  /** Closes every tab but this one. */
  closeOthers(id: string): void
  /** Names a terminal; an empty name goes back to its cluster's. */
  rename(id: string, title: string): void
  /** Shows the next tab (or, -1, the one before), round. */
  step(by: 1 | -1): void
  /** Gives the shown terminal focus again (after its tab's name was edited, say). */
  refocus(): void
  /** Starts the shell again, in the same tab. */
  restart(id: string): void
  /** Shows a tab (opening the tabs below, from its bar). */
  select(id: string): void
  /**
   * A terminal: the last one shown is shown (opening the tabs below), or one is opened for
   * `context` if there's none; shown already, the tabs below are hidden.
   */
  toggle(context: string, namespace?: string): void
  /** Shows the tabs below, on the tab last shown, or hides them. */
  toggleOpen(): void
  setMaximized(maximized: boolean): void
  setPanelTab(panelTab: { ref: string; tab: string } | undefined): void
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

const same = (a: ObjectRef, b: ObjectRef) =>
  a.kind === b.kind && a.name === b.name && (a.namespace ?? '') === (b.namespace ?? '')

export const useDock = create<Dock>()((set, get) => {
  /** The terminal shown, or last shown: what ⌃` and the bar's left button show. */
  let lastTerminal: string | null = null
  const isTerminal = (id: string | null) => get().tabs.some((tab) => tab.session.id === id)
  const show = (id: string) => {
    if (isTerminal(id)) lastTerminal = id
  }
  return {
    tabs: [],
    kept: [],
    order: [],
    active: null,
    open: false,
    maximized: false,
    focus: 0,
    add(context, namespace) {
      const tab = tabFor(context, namespace)
      tab.session.start()
      lastTerminal = tab.session.id
      set((dock) => ({
        tabs: [...dock.tabs, tab],
        order: [...dock.order, tab.session.id],
        active: tab.session.id,
        open: true,
        focus: dock.focus + 1,
      }))
      return tab
    },
    keep(context, object, tab) {
      const there = get().keptOf(context, object)
      if (there) {
        get().select(there.id)
        return there
      }
      const kept: KeptTab = { id: crypto.randomUUID(), context, object, tab }
      set((dock) => ({
        kept: [...dock.kept, kept],
        order: [...dock.order, kept.id],
        active: kept.id,
        open: true,
      }))
      return kept
    },
    keptOf(context, object) {
      return get().kept.find((each) => each.context === context && same(each.object, object))
    },
    setKeptTab(id, tab) {
      set((dock) => ({
        kept: dock.kept.map((each) => (each.id === id ? { ...each, tab } : each)),
      }))
    },
    setKeptState(id, { deletedAt, unreachableSince }) {
      set((dock) => ({
        kept: dock.kept.map((each) =>
          each.id === id ? { ...each, deletedAt, unreachableSince } : each,
        ),
      }))
    },
    close(id) {
      const { order, active } = get()
      get()
        .tabs.find((tab) => tab.session.id === id)
        ?.session.dispose()
      if (lastTerminal === id) lastTerminal = null
      const index = order.indexOf(id)
      const rest = order.filter((each) => each !== id)
      // The neighbour takes its place: the one after it, or before it at the end.
      const next = rest[Math.min(index, rest.length - 1)] ?? null
      if (active === id && next) show(next)
      set((dock) => ({
        tabs: dock.tabs.filter((tab) => tab.session.id !== id),
        kept: dock.kept.filter((each) => each.id !== id),
        order: rest,
        active: active === id ? next : active,
        open: dock.open && rest.length > 0,
        focus: dock.focus + 1,
      }))
    },
    closeOthers(id) {
      for (const tab of get().tabs) if (tab.session.id !== id) tab.session.dispose()
      lastTerminal = isTerminal(id) ? id : null
      set((dock) => ({
        tabs: dock.tabs.filter((tab) => tab.session.id === id),
        kept: dock.kept.filter((each) => each.id === id),
        order: [id],
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
      const { order, active } = get()
      const index = order.indexOf(active!)
      get().select(order[(index + by + order.length) % order.length]!)
    },
    restart(id) {
      const index = get().tabs.findIndex((tab) => tab.session.id === id)
      const old = get().tabs[index]!
      old.session.dispose()
      // A new shell, under the same name, in the same place.
      const fresh = { ...tabFor(old.context, old.namespace), title: old.title }
      fresh.session.start()
      lastTerminal = fresh.session.id
      set((dock) => ({
        tabs: dock.tabs.map((tab) => (tab.session.id === id ? fresh : tab)),
        order: dock.order.map((each) => (each === id ? fresh.session.id : each)),
        active: fresh.session.id,
        focus: dock.focus + 1,
      }))
    },
    select(id) {
      show(id)
      set((dock) => ({ active: id, open: true, focus: dock.focus + 1 }))
    },
    toggle(context, namespace) {
      const { open, active, tabs } = get()
      if (open && isTerminal(active)) return set({ open: false })
      const terminal = tabs.find((tab) => tab.session.id === lastTerminal) ?? tabs.at(-1)
      if (terminal) get().select(terminal.session.id)
      else get().add(context, namespace)
    },
    toggleOpen() {
      const { open, order, active } = get()
      if (open) return set({ open: false })
      if (order.length === 0) return
      set((dock) => ({
        open: true,
        active: active ?? order.at(-1)!,
        focus: dock.focus + 1,
      }))
    },
    setMaximized(maximized) {
      set({ maximized })
    },
    setPanelTab(panelTab) {
      set({ panelTab })
    },
    paste(context, text) {
      const { tabs, active } = get()
      const shown = tabs.find((tab) => tab.session.id === active)
      const ready = shown && ['connecting', 'open'].includes(shown.session.phase.state)
      const tab = ready ? shown : get().add(context)
      tab.session.paste(text)
      show(tab.session.id)
      set((dock) => ({ open: true, active: tab.session.id, focus: dock.focus + 1 }))
    },
  }
})

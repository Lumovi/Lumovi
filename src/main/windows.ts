/**
 * Lumovi's windows, and which of them each stream is for. A shell, a log, a copy or a forward
 * belongs to the window whose page started it: only that page hears of it, and it ends when that
 * page reloads or its window closes, whatever the other windows do. What's the app's own (a
 * plugin read again, an update, an assistant's ask) every window hears.
 */
import type { BrowserWindow, WebContents } from 'electron'
import type { MovedTab } from '@shared/api'

/** The most a page keeps of what it has below, in characters of JSON. */
const BELOW_MOST = 64_000
/**
 * The most of a handed stream's messages held for its new page, before it listens: past it, the
 * oldest go, so what it said last (its end, a shell's exit) is always there.
 */
const HELD_MOST = 5_000

/**
 * What a window's page is given once, as it starts: see `restore`. Opened from a link's card
 * (`asked`), the link's view and its object's tab.
 */
export interface Restored {
  page?: string
  below?: unknown
  asked?: true
  tab?: string
}

export class Windows {
  /** `end`: streams to end, held for a window that closed before its page took them. */
  constructor(private readonly end: (ids: string[]) => void = () => {}) {}

  #windows: BrowserWindow[] = []
  /** The page each stream belongs to, by the stream's id. */
  #owners = new Map<string, WebContents>()
  /** The window last in front: what the menu and the system's dialogs are for. */
  #front: BrowserWindow | undefined
  /** The windows by when they were last in front, the latest first. */
  #recent: BrowserWindow[] = []
  /** What each page says it has below, by its window. */
  #below = new Map<number, unknown>()
  /** The windows of one tab: their tab, and the window it came from (to put it back). */
  #tabs = new Map<number, { tab: MovedTab; from?: number; restored?: true }>()
  /** Where each window was, and what it had below, when Lumovi last closed: asked for once. */
  #restored = new Map<number, Restored>()
  /** What handed streams said before their new page listened, by the stream's id. */
  #held = new Map<string, unknown[][]>()
  /** The page a window's coming shell is handed from, as that window's page asks for it. */
  #coming = new Map<number, WebContents>()

  /** Lumovi's windows, the first opened first. */
  all(): BrowserWindow[] {
    return this.#windows.filter((win) => !win.isDestroyed())
  }

  add(win: BrowserWindow): void {
    this.#windows.push(win)
    this.#front = win
    win.on('focus', () => {
      this.#front = win
      this.#recent = [win, ...this.#recent.filter((each) => each !== win)]
    })
    const id = win.id
    win.on('closed', () => {
      // (A shell coming to it that never arrived: it ends with the window, as it would have there.)
      const coming = this.#coming.get(id)
      const tab = this.#tabs.get(id)?.tab
      if (coming && tab?.kind === 'terminal' && tab.shell) {
        const shell = tab.shell.id
        if (this.#owners.get(shell) === coming) {
          this.#owners.delete(shell)
          this.#held.delete(shell)
          this.end([shell])
        }
      }
      this.#below.delete(id)
      this.#restored.delete(id)
      this.#tabs.delete(id)
      this.#coming.delete(id)
      this.#windows = this.#windows.filter((each) => each !== win)
      this.#recent = this.#recent.filter((each) => each !== win)
      if (this.#front === win) this.#front = this.#windows.at(-1)
    })
  }

  /** Where a window was and what it had below as Lumovi last closed, for its page to ask for. */
  restore(win: BrowserWindow, restored: Restored): void {
    if (restored.page !== undefined || restored.below !== undefined) {
      this.#restored.set(win.id, restored)
    }
  }

  /** Where a page's window was and what it had below as Lumovi last closed: once. */
  takeRestored(page: WebContents): Restored | undefined {
    const id = this.#windowOf(page)?.id
    if (id === undefined) return undefined
    const restored = this.#restored.get(id)
    this.#restored.delete(id)
    return restored
  }

  /** What a page says it has below now. (Too much to be what it keeps, it's not kept.) */
  keepBelow(page: WebContents, below: unknown): void {
    const win = this.#windowOf(page)
    if (!win) return
    if (JSON.stringify(below ?? null).length > BELOW_MOST) this.#below.delete(win.id)
    else this.#below.set(win.id, below)
  }

  /** What a window's page last said it had below. */
  belowOf(win: BrowserWindow): unknown {
    return this.#below.get(win.id)
  }

  #windowOf(page: WebContents): BrowserWindow | undefined {
    return this.all().find((win) => win.webContents === page)
  }

  /**
   * The window that shows `context`'s cluster now, if one does: the one in front first. Never a
   * window of one tab, which shows no cluster's page.
   */
  showing(context: string): BrowserWindow | undefined {
    const shows = (win: BrowserWindow) => {
      if (this.tabOf(win)) return false
      let hash: string
      try {
        hash = new URL(win.webContents.getURL()).hash
      } catch {
        return false
      }
      const at = /^#\/cluster\/([^/?]+)/.exec(hash)?.[1]
      try {
        return at !== undefined && decodeURIComponent(at) === context
      } catch {
        return false
      }
    }
    const front = this.front()
    return front && shows(front) ? front : this.all().find(shows)
  }

  /** The window of Lumovi's own last in front: never a window of one tab. */
  ownFront(): BrowserWindow | undefined {
    return this.byRecency().find((win) => !this.tabOf(win))
  }

  /** The window in front, or the one last there. */
  front(): BrowserWindow | undefined {
    const front = this.#front
    return front && !front.isDestroyed() ? front : this.all().at(-1)
  }

  /** Tells every window's page. */
  toAll(channel: string, ...args: unknown[]): void {
    for (const win of this.all()) win.webContents.send(channel, ...args)
  }

  /** Tells the page a stream belongs to, and no other: `id` first, as the stream's own say. */
  toOwner(channel: string, id: string, ...args: unknown[]): void {
    const held = this.#held.get(id)
    if (held) {
      // (Handed to a page that isn't listening yet: kept for it, the oldest dropped past the most.)
      held.push([channel, ...args])
      if (held.length > HELD_MOST) held.shift()
      return
    }
    const owner = this.#owners.get(id)
    if (owner && !owner.isDestroyed()) owner.send(channel, id, ...args)
  }

  /**
   * A window of one tab: that tab, and the window it came from; or one opened again as Lumovi
   * did (`restored`). A terminal's running shell is held for the window's page from the one it
   * came from, until that page asks for its tab (`takeTab`).
   */
  holdTab(win: BrowserWindow, tab: MovedTab, from?: BrowserWindow | 'restored'): void {
    const source = from === 'restored' ? undefined : from
    this.#tabs.set(win.id, {
      tab: this.#bring(win, tab, source?.webContents),
      ...(from === 'restored' ? { restored: true } : source ? { from: source.id } : {}),
    })
  }

  /** A window of one tab becomes Lumovi's own, its tab below (it was the last of them). */
  untab(win: BrowserWindow): void {
    this.#tabs.delete(win.id)
    this.#coming.delete(win.id)
  }

  /** A window's one tab, where it's a window of one tab. */
  tabOf(win: BrowserWindow): { tab: MovedTab; from?: BrowserWindow; restored?: true } | undefined {
    const held = this.#tabs.get(win.id)
    if (!held) return undefined
    const from = this.all().find((each) => each.id === held.from)
    return {
      tab: held.tab,
      ...(from ? { from } : {}),
      ...(held.restored ? { restored: true } : {}),
    }
  }

  /** What a page's window of one tab holds, as its page asks: its running shell handed to it. */
  takeTab(page: WebContents): { tab?: MovedTab; restored?: true } {
    const win = this.#windowOf(page)
    const held = win && this.#tabs.get(win.id)
    if (!held) return {}
    const tab = this.#arrive(win.id, held.tab, page)
    // (Asked again, as the page reloads, its shell's gone: that ended with the page before.)
    this.#tabs.set(win.id, { ...held, tab: withoutShell(tab) })
    return { tab, ...(held.restored ? { restored: true } : {}) }
  }

  /** A tab's running shell, held for `win`'s page from the page that has it; else none. */
  #bring(win: BrowserWindow, tab: MovedTab, from: WebContents | undefined): MovedTab {
    if (tab.kind !== 'terminal' || !tab.shell) return tab
    if (!from || !this.hold(tab.shell.id, from)) return withoutShell(tab)
    this.#coming.set(win.id, from)
    return tab
  }

  /** The shell coming to a window, handed to its page now; else the tab without it. */
  #arrive(win: number, tab: MovedTab, page: WebContents): MovedTab {
    const from = this.#coming.get(win)
    this.#coming.delete(win)
    if (tab.kind !== 'terminal' || !tab.shell) return tab
    return from && this.hand(tab.shell.id, from, page) ? tab : withoutShell(tab)
  }

  /** Lumovi's windows, the one last in front first (one never in front last). */
  byRecency(): BrowserWindow[] {
    const open = this.all()
    return [
      ...this.#recent.filter((win) => open.includes(win)),
      ...open.filter((win) => !this.#recent.includes(win)),
    ]
  }

  /** The window a page is in. */
  windowOf(page: WebContents): BrowserWindow | undefined {
    return this.#windowOf(page)
  }

  /**
   * A stream goes to another page, still running (a terminal moved to a window of its own, or
   * put back): only from the page that has it.
   */
  hand(id: string, from: WebContents, to: WebContents): boolean {
    if (!this.hold(id, from)) return false
    this.#owners.set(id, to)
    return true
  }

  /**
   * What a stream says is kept, not told, until a page listens to it (see `adopt`): it's going
   * to another page. Only the page that has it holds it.
   */
  hold(id: string, page: WebContents): boolean {
    if (this.#owners.get(id) !== page) return false
    if (!this.#held.has(id)) this.#held.set(id, [])
    return true
  }

  /** A page listens to a stream handed to it: what it said meanwhile, now, then as it goes. */
  adopt(id: string, page: WebContents): void {
    const held = this.#held.get(id)
    if (!held || this.#owners.get(id) !== page) return
    this.#held.delete(id)
    for (const [channel, ...args] of held) page.send(channel as string, id, ...args)
  }

  /**
   * The stream `id` is the page's that started it: false, and nothing changed, where it's still
   * another page's (a stream never moves to another window by its id alone).
   */
  own(id: string, page: WebContents): boolean {
    const owner = this.#owners.get(id)
    if (owner && owner !== page && !owner.isDestroyed()) return false
    this.#owners.set(id, page)
    return true
  }

  /** A stream that didn't start: its page owns nothing by it. */
  disown(id: string, page: WebContents): void {
    if (this.#owners.get(id) === page) this.#owners.delete(id)
  }

  /** The streams a page started, forgotten: they're to be ended. */
  release(page: WebContents): string[] {
    const ids = [...this.#owners].filter(([, owner]) => owner === page).map(([id]) => id)
    for (const id of ids) {
      this.#owners.delete(id)
      this.#held.delete(id)
    }
    return ids
  }

  /** The streams of every page, forgotten (as the app quits). */
  releaseAll(): string[] {
    const ids = [...this.#owners.keys()]
    this.#owners.clear()
    this.#held.clear()
    return ids
  }
}

/** A terminal's tab without its running shell: one to start again, or a kept object's as it is. */
export function withoutShell(tab: MovedTab): MovedTab {
  if (tab.kind !== 'terminal' || !tab.shell) return tab
  const { shell: _shell, ...rest } = tab
  return rest
}

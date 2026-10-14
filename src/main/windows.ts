/**
 * Lumovi's windows, and which of them each stream is for. A shell, a log, a copy or a forward
 * belongs to the window whose page started it: only that page hears of it, and it ends when that
 * page reloads or its window closes, whatever the other windows do. What's the app's own (a
 * plugin read again, an update, an assistant's ask) every window hears.
 */
import type { BrowserWindow, WebContents } from 'electron'

/** The most a page keeps of what it has below, in characters of JSON. */
const BELOW_MOST = 64_000

export class Windows {
  #windows: BrowserWindow[] = []
  /** The page each stream belongs to, by the stream's id. */
  #owners = new Map<string, WebContents>()
  /** The window last in front: what the menu and the system's dialogs are for. */
  #front: BrowserWindow | undefined
  /** What each page says it has below, by its window. */
  #below = new Map<number, unknown>()
  /** Where each window was, and what it had below, when Lumovi last closed: asked for once. */
  #restored = new Map<number, { page?: string; below?: unknown }>()

  /** Lumovi's windows, the first opened first. */
  all(): BrowserWindow[] {
    return this.#windows.filter((win) => !win.isDestroyed())
  }

  add(win: BrowserWindow): void {
    this.#windows.push(win)
    this.#front = win
    win.on('focus', () => (this.#front = win))
    const id = win.id
    win.on('closed', () => {
      this.#below.delete(id)
      this.#restored.delete(id)
      this.#windows = this.#windows.filter((each) => each !== win)
      if (this.#front === win) this.#front = this.#windows.at(-1)
    })
  }

  /** Where a window was and what it had below as Lumovi last closed, for its page to ask for. */
  restore(win: BrowserWindow, restored: { page?: string; below?: unknown }): void {
    if (restored.page !== undefined || restored.below !== undefined) {
      this.#restored.set(win.id, restored)
    }
  }

  /** Where a page's window was and what it had below as Lumovi last closed: once. */
  takeRestored(page: WebContents): { page?: string; below?: unknown } | undefined {
    const id = this.#windowOf(page)?.id
    if (id === undefined) return undefined
    const below = this.#restored.get(id)
    this.#restored.delete(id)
    return below
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
    const owner = this.#owners.get(id)
    if (owner && !owner.isDestroyed()) owner.send(channel, id, ...args)
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
    for (const id of ids) this.#owners.delete(id)
    return ids
  }

  /** The streams of every page, forgotten (as the app quits). */
  releaseAll(): string[] {
    const ids = [...this.#owners.keys()]
    this.#owners.clear()
    return ids
  }
}

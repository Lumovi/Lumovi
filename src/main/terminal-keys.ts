/**
 * A terminal's ⌘ keys on macOS, as Terminal and iTerm have them: while one of
 * the desktop app's terminals has focus, ⌘T and ⌘N open another, ⌘W closes it
 * and ⌘K clears it, instead of the menu's Create…, Close (the window) and
 * Command Palette. Each window's page says when a terminal of its has focus. (Elsewhere the menu
 * keeps them; Windows and Linux have Ctrl+Shift+T and Ctrl+Shift+W, since a
 * shell has Ctrl+W for itself.)
 */
import type { Input } from 'electron'
import type { AppCommand } from '@shared/navigation'

const KEYS: Record<string, AppCommand> = {
  t: 'new-terminal',
  n: 'new-terminal',
  w: 'close-terminal',
  k: 'clear-terminal',
}

export class TerminalKeys {
  /** The pages (by their id) where a terminal has focus. */
  #focused = new Set<number>()

  /** What a page says: whether a terminal of its has focus now. */
  focus(page: number, focused: unknown): void {
    if (focused === true) this.#focused.add(page)
    else this.#focused.delete(page)
  }

  /**
   * The command a key typed in a page is while a terminal of its has focus (and so not the
   * menu's), if it's one.
   */
  command(page: number, input: Input): AppCommand | undefined {
    if (
      !this.#focused.has(page) ||
      process.platform !== 'darwin' ||
      input.type !== 'keyDown' ||
      !input.meta ||
      input.control ||
      input.alt ||
      input.shift
    ) {
      return undefined
    }
    return KEYS[input.key.toLowerCase()]
  }
}

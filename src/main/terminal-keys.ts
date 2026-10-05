/**
 * A terminal's ⌘ keys on macOS, as Terminal and iTerm have them: while one of
 * the desktop app's terminals has focus, ⌘T and ⌘N open another, ⌘W closes it
 * and ⌘K clears it, instead of the menu's New from YAML, Close (the window) and
 * Command Palette. The page says when a terminal has focus. (Elsewhere the menu
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
  #focused = false

  /** What the page says: whether a terminal has focus now. */
  focus(focused: unknown): void {
    this.#focused = focused === true
  }

  /** The command a key is while a terminal has focus (and so not the menu's), if it's one. */
  command(input: Input): AppCommand | undefined {
    if (
      !this.#focused ||
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

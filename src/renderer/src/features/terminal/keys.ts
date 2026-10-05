/**
 * The dock's shortcuts, as this platform has them: ⌃` everywhere, as editors
 * have it; on macOS, its terminals' ⌘ keys, as Terminal and iTerm have them;
 * elsewhere Ctrl+Shift, as Windows Terminal has them (a shell keeps Ctrl+W).
 */
import { CTRL_KEY, MOD_KEY } from '@renderer/components/Kbd'
import { api } from '@renderer/lib/api'

const MAC = api.platform === 'darwin'

export const TERMINAL_KEYS = {
  /** Anywhere in a cluster's pages. */
  toggle: [CTRL_KEY, '`'],
  add: [CTRL_KEY, '⇧', '`'],
  /** In a terminal. */
  addHere: MAC ? [MOD_KEY, 'T'] : [CTRL_KEY, '⇧', 'T'],
  addHereToo: MAC ? [MOD_KEY, 'N'] : undefined,
  close: MAC ? [MOD_KEY, 'W'] : [CTRL_KEY, '⇧', 'W'],
  /** In a terminal, on macOS. */
  clear: MAC ? [MOD_KEY, 'K'] : undefined,
  next: MAC ? [MOD_KEY, '⇧', ']'] : [CTRL_KEY, 'PgDn'],
  previous: MAC ? [MOD_KEY, '⇧', '['] : [CTRL_KEY, 'PgUp'],
}

/** Keys as a tooltip says them: "⌘T", "Ctrl⇧T". */
export const keysText = (keys: string[]) => keys.join('')

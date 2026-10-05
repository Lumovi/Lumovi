/**
 * The dock's shortcuts, as this platform has them: ⌃` everywhere, as editors
 * have it; on macOS, its terminals' ⌘ keys, as Terminal and iTerm have them;
 * elsewhere Ctrl+Shift, as Windows Terminal has them (a shell keeps Ctrl+W).
 */
import { CTRL_KEY, MOD_KEY } from '@renderer/components/Kbd'
import { api } from '@renderer/lib/api'

const MAC = api.platform === 'darwin'

export const TERMINAL_KEYS = {
  toggle: [CTRL_KEY, '`'],
  add: MAC ? [MOD_KEY, 'T'] : [CTRL_KEY, '⇧', 'T'],
  close: MAC ? [MOD_KEY, 'W'] : [CTRL_KEY, '⇧', 'W'],
  next: MAC ? [MOD_KEY, '⇧', ']'] : [CTRL_KEY, 'PgDn'],
  previous: MAC ? [MOD_KEY, '⇧', '['] : [CTRL_KEY, 'PgUp'],
}

/** Keys as a tooltip says them: "⌘T", "Ctrl⇧T". */
export const keysText = (keys: string[]) => keys.join('')

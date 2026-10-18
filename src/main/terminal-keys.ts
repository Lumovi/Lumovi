/**
 * A terminal's ⌘ keys on macOS, as Terminal and iTerm have them: while one of
 * the desktop app's terminals has focus, ⌘T and ⌘N open another, ⌘W closes it
 * and ⌘K clears it, instead of the menu's Create…, Close (the window) and
 * Command Palette, or the keys Settings gives them (LMV-358). Each window's page says when a
 * terminal of its has focus. (Elsewhere the menu keeps them; Windows and Linux have
 * Ctrl+Shift+T and Ctrl+Shift+W, which the page hears, since a shell has Ctrl+W for itself.)
 */
import type { Input } from 'electron'
import type { AppCommand } from '@shared/navigation'
import { chordOf, normalChord } from '@shared/shortcuts'

const COMMANDS: [string, AppCommand][] = [
  ['terminal.new', 'new-terminal'],
  ['terminal.close', 'close-terminal'],
  ['terminal.clear', 'clear-terminal'],
]

export class TerminalKeys {
  constructor(
    /** Each command's keys, as Settings has them now. */
    private readonly keys: () => Record<string, string[]>,
  ) {}

  /**
   * The pages (by their id) where a terminal has focus, or something else in the tabs below
   * (whose ⌘W alone is theirs: it closes the tab shown).
   */
  #focused = new Map<number, 'terminal' | 'below'>()

  /** The pages (by their id) whose Settings records a command's new keys. */
  #recording = new Set<number>()

  /** What a page says: whether its Settings records keys now. */
  record(page: number, on: boolean): void {
    if (on) this.#recording.add(page)
    else this.#recording.delete(page)
  }

  /** Whether a page's keys go to its Settings, recording them (not the menu's, nor a terminal's). */
  recording(page: number): boolean {
    return this.#recording.has(page)
  }

  /** What a page says: whether a terminal of its has focus now, or something else below. */
  focus(page: number, focused: unknown): void {
    if (focused === true) this.#focused.set(page, 'terminal')
    else if (focused === 'below') this.#focused.set(page, 'below')
    else this.#focused.delete(page)
  }

  /**
   * The command a key typed in a page is while a terminal of its has focus (and so not the
   * menu's), if it's one.
   */
  command(page: number, input: Input): AppCommand | undefined {
    const focused = this.#focused.get(page)
    if (!focused || process.platform !== 'darwin' || input.type !== 'keyDown') return undefined
    const chord = chordOf(
      {
        key: input.key,
        code: input.code,
        ctrlKey: input.control,
        altKey: input.alt,
        shiftKey: input.shift,
        metaKey: input.meta,
      },
      true,
    )
    const keys = this.keys()
    const command = COMMANDS.find(([id]) =>
      keys[id]!.some((key) => normalChord(key, true) === chord),
    )?.[1]
    return focused === 'terminal' || command === 'close-terminal' ? command : undefined
  }
}

/**
 * In Developer mode, the person's plugins folder, watched (the desktop app's): a change in it (a
 * build writing a plugin's code, an edit to its file) is told to the page once things have been
 * quiet a moment, so a build that writes many files is one change; and the page reads its plugins
 * again. Its code waits for the person again where it changed. Off, nothing is watched.
 */
import { watch, type FSWatcher } from 'node:fs'

/** How long things are quiet before a change is told: a build's files, written one after another. */
const QUIET_MS = 300

export class PluginsWatch {
  readonly #path: string
  readonly #changed: () => void
  #watcher: FSWatcher | undefined
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(path: string, changed: () => void) {
    this.#path = path
    this.#changed = changed
  }

  /** Watches while `on`; stops, and tells nothing more, once it's not. */
  set(on: boolean): void {
    if (on && !this.#watcher) {
      try {
        this.#watcher = watch(this.#path, { recursive: true }, () => this.#soon())
        // (A folder that goes, or can't be watched: nothing more is told, as if it were off.)
        this.#watcher.on('error', () => this.set(false))
      } catch {
        // (No folder yet: nothing to watch. A page read again finds it once it's there.)
      }
    } else if (!on && this.#watcher) {
      this.#watcher.close()
      this.#watcher = undefined
      clearTimeout(this.#timer)
    }
  }

  #soon(): void {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => this.#changed(), QUIET_MS)
  }
}

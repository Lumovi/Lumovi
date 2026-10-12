/**
 * Watches the kubeconfig files read, and the folders of them, for a change made elsewhere: a
 * cloud CLI adding a context, an editor saving. The folder each is in is watched, not the file,
 * so one replaced by a rename (as editors and CLIs write) is still seen, on macOS, Windows and
 * Linux. A change is acted on once it looks the same twice, a quiet time apart, so a file being
 * written is read whole; and a look every few seconds sees what the system's watch can't (a
 * network drive, Linux's limit on watches, a folder that wasn't there yet).
 */
import { readdirSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'

/** How long a change has to look the same before it's acted on. */
export const QUIET_MS = 300
/** How often what's watched is looked at anyway. */
export const CHECK_MS = 5000

/** What's read, as it is now: asked again each time it's looked at. */
export interface Watched {
  /** Files read: each looked at where it is, there or not. */
  files: readonly string[]
  /** Folders read: what's in each. */
  folders: readonly string[]
}

export class KubeconfigWatcher {
  readonly #watchers = new Map<string, FSWatcher>()
  /** How it all looked when last acted on, and at the last look while it's changing. */
  #seen: string
  #looked: string | undefined
  #quiet: ReturnType<typeof setTimeout> | undefined
  readonly #check: ReturnType<typeof setInterval>

  constructor(
    private readonly watched: () => Watched,
    private readonly changed: () => void,
    private readonly timing = { quietMs: QUIET_MS, checkMs: CHECK_MS },
  ) {
    this.#seen = this.#look()
    this.#arm()
    this.#check = setInterval(() => {
      this.#arm()
      this.#poke()
    }, timing.checkMs)
    this.#check.unref()
  }

  /** What's read may be other files now (one chosen, a folder added): watched where they are. */
  refresh(): void {
    this.#arm()
    this.#poke()
  }

  close(): void {
    clearInterval(this.#check)
    clearTimeout(this.#quiet)
    for (const watcher of this.#watchers.values()) watcher.close()
    this.#watchers.clear()
  }

  /**
   * Something may have changed: looked at after the quiet time. Not put off by more of the same,
   * so a busy folder (other files changing all the time) doesn't keep a change from being seen.
   */
  #poke = (): void => {
    this.#quiet ??= setTimeout(() => {
      this.#quiet = undefined
      this.#settle()
    }, this.timing.quietMs)
  }

  /** Acted on when it isn't as it was, and looks the same as at the last look. */
  #settle(): void {
    this.#arm()
    const now = this.#look()
    if (now === this.#seen) {
      this.#looked = undefined
      return
    }
    if (now !== this.#looked) {
      this.#looked = now
      this.#poke()
      return
    }
    this.#seen = now
    this.#looked = undefined
    this.changed()
  }

  /** How it all looks: each file's size, times and identity, and what's in each folder. */
  #look(): string {
    const { files, folders } = this.watched()
    return JSON.stringify([
      files.map((file) => [file, mark(file)]),
      folders.map((folder) => [folder, contents(folder)]),
    ])
  }

  /**
   * Watches the folder each file is in (and the one it leads to, for a link) and each folder
   * read; one that isn't there yet, from the nearest that is, until it is. Those no longer
   * needed are let go. One that can't be watched is left to the look every few seconds.
   */
  #arm(): void {
    const { files, folders } = this.watched()
    const wanted = new Set<string>()
    for (const file of files) {
      wanted.add(nearest(dirname(resolve(file))))
      const real = realOf(file)
      if (real) wanted.add(dirname(real))
    }
    for (const folder of folders) wanted.add(nearest(resolve(folder)))
    for (const [folder, watcher] of this.#watchers) {
      if (wanted.has(folder)) continue
      watcher.close()
      this.#watchers.delete(folder)
    }
    for (const folder of wanted) {
      if (this.#watchers.has(folder)) continue
      try {
        const watcher = watch(folder, { persistent: false }, this.#poke)
        // Gone, or no longer watchable: watched again at the next look, if it can be.
        watcher.on('error', () => {
          watcher.close()
          this.#watchers.delete(folder)
          this.#poke()
        })
        this.#watchers.set(folder, watcher)
      } catch {
        // Not watchable here: the look every few seconds sees it instead.
      }
    }
  }
}

/** A file's size, times and identity, or null where there's none. */
function mark(path: string): string | null {
  try {
    const { size, mtimeMs, ctimeMs, ino } = statSync(path)
    return `${size}:${mtimeMs}:${ctimeMs}:${ino}`
  } catch {
    return null
  }
}

/** What's in a folder, each with its mark; null where it isn't one. */
function contents(folder: string): [string, string | null][] | null {
  try {
    return readdirSync(folder)
      .sort()
      .map((name) => [name, mark(join(folder, name))])
  } catch {
    return null
  }
}

/** Where a file really is, if that's somewhere else (it's a link, or in a linked folder). */
function realOf(file: string): string | undefined {
  try {
    const real = realpathSync(file)
    return real === resolve(file) ? undefined : real
  } catch {
    return undefined
  }
}

/** The folder itself, or the nearest one above it that's there. */
function nearest(folder: string): string {
  let at = folder
  while (!isFolder(at)) {
    const up = dirname(at)
    if (up === at || at === parse(at).root) return at
    at = up
  }
  return at
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

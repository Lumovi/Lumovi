/**
 * Files saved where the person said (`app.saveFile`: a list as CSV, a pod's logs, the audit
 * log), and showing one in the file manager. The page never learns where a file went: a save
 * gives it the file's name, and a token of its own that stands for the path, made here. A file
 * is shown by its token only, and only while it's still a file there (not a link put in its
 * place since); anything else the page names is refused, so it can't have the file manager open
 * wherever it likes.
 */
import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'

export class SavedFiles {
  readonly #saved = new Map<string, string>()

  constructor(private readonly reveal: (path: string) => void) {}

  /** A file a save just wrote: the token the page shows it by. */
  record(path: string): string {
    const token = randomUUID()
    this.#saved.set(token, path)
    return token
  }

  /** Shows a saved file where it is, by its token; false, showing nothing, for anything else. */
  async show(token: unknown): Promise<boolean> {
    const path = typeof token === 'string' ? this.#saved.get(token) : undefined
    if (path === undefined) return false
    const there = await lstat(path).catch(() => undefined)
    if (!there?.isFile()) return false
    this.reveal(path)
    return true
  }
}

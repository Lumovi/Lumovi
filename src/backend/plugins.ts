/**
 * The user's own plugins: YAML files in ~/.lumovi/plugins (or the folder in
 * LUMOVI_PLUGINS_DIR). They are read whenever the page asks, so changes show
 * up on the next refresh; the page checks and applies them.
 */
import { createHash } from 'node:crypto'
import { constants, type Dirent } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { LocalPlugins } from '@shared/api'

/** Set by the build: true only in the build the tests run. */
declare const LUMOVI_TEST_BUILD: boolean

const MAX_FILES = 200
const MAX_BYTES = 256 * 1024
/** How long one file's reading may take: a folder's file is small and near. */
const READ_MS = 5_000

/** Where the user's plugins are, and how to show that folder: inside the home folder as ~/… */
export function pluginsDirectory(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; shown: string } {
  const path = env.LUMOVI_PLUGINS_DIR || join(home, '.lumovi', 'plugins')
  return { path, shown: path.startsWith(home + sep) ? join('~', relative(home, path)) : path }
}

/** A file as it was read: its text for the checker, and the digest of the very bytes read. */
export type ReadFile = LocalPlugins['files'][number] & {
  /** `sha256:` and the hex, of the file's bytes: what `shasum -a 256` gives for it. */
  digest?: string
}

/** `sha256:` and the hex of some bytes. */
export const digestOf = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`

/** The folder's files, and in the tests' build its stand-ins for Lumovi's own, as they were read. */
export async function readFiles(
  { path }: { path: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ files: ReadFile[]; included?: ReadFile[] }> {
  const own = { files: await filesIn(path) }
  // (A release build ends here: what follows, and the variable it reads, are left out of it.)
  if (!LUMOVI_TEST_BUILD) return own
  // The tests' stand-in for plugins that came inside the build: Lumovi's own are only ever the
  // ones built in, so a bad one can't be shown to the app any other way.
  const included = env.LUMOVI_TEST_INCLUDED_PLUGINS_DIR
  return included ? { ...own, included: await filesIn(included) } : own
}

export async function readPlugins(
  directory: { path: string; shown: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalPlugins> {
  // (The page gets what it always has: names, texts, and why one couldn't be read.)
  const page = (files: ReadFile[]) =>
    files.map(({ name, text, error }) => ({ name, text, ...(error ? { error } : {}) }))
  const read = await readFiles(directory, env)
  return {
    directory: directory.shown,
    files: page(read.files),
    ...(read.included ? { included: page(read.included) } : {}),
  }
}

/** Reads text strictly: bytes that aren't UTF-8 are refused, never read with marks in their place. */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

async function filesIn(path: string): Promise<ReadFile[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    // No folder: no plugins of one's own.
    return []
  }
  const names = entries
    // Links too: a ConfigMap mounted as a volume (as the Helm chart's plugins are) is links into
    // a folder of its own.
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && /\.ya?ml$/i.test(entry.name))
    .map((entry) => ({ name: entry.name, link: entry.isSymbolicLink() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, MAX_FILES)
  return Promise.all(
    names.map(({ name, link }) => within(READ_MS, name, fileRead(join(path, name), name, link))),
  )
}

/** `reading`, or after `ms` that it took too long: no file holds the others up. */
function within(ms: number, name: string, reading: Promise<ReadFile>): Promise<ReadFile> {
  let timer: ReturnType<typeof setTimeout>
  const late = new Promise<ReadFile>((done) => {
    timer = setTimeout(() => done({ name, text: '', error: 'It took too long to read.' }), ms)
  })
  return Promise.race([reading, late]).finally(() => clearTimeout(timer))
}

/**
 * One file, read: a plain file, of the limit's size at most whatever it says of itself. A name
 * in a plugins folder can be a link to anything (a pipe, a device that never ends): what isn't
 * a plain file is refused before a byte is read, the open never waits for a pipe's other end,
 * and no more than the limit and one byte is ever read.
 */
async function fileRead(path: string, name: string, link: boolean): Promise<ReadFile> {
  try {
    // Checked and read through one open file, so it can't be swapped in between. (Opened
    // without waiting: a pipe nobody writes to would otherwise hold the open for ever.)
    const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
    try {
      const stat = await file.stat()
      if (!stat.isFile()) return { name, text: '', error: 'It isn’t a file.' }
      const tooLarge = { name, text: '', error: `It’s larger than ${MAX_BYTES / 1024} KB.` }
      if (stat.size > MAX_BYTES) return tooLarge
      // One read: the text that's checked and the digest are of the same bytes.
      const room = Buffer.alloc(MAX_BYTES + 1)
      let read = 0
      while (read < room.length) {
        const { bytesRead } = await file.read(room, read, room.length - read, read)
        if (bytesRead === 0) break
        read += bytesRead
      }
      if (read > MAX_BYTES) return tooLarge
      const bytes = room.subarray(0, read)
      let text: string
      try {
        text = utf8.decode(bytes)
      } catch {
        return { name, text: '', error: 'It isn’t UTF-8 text.' }
      }
      return { name, text, digest: digestOf(bytes) }
    } finally {
      await file.close()
    }
  } catch (error) {
    // The others still load. What the page is told is by the file's name alone, in Lumovi's
    // words; the system's own, which carry the folder's whole path, go to the log.
    // (Both quoted: a name with a line break in it, which the system's words repeat, stays one
    // line of the log.)
    console.warn(
      `Lumovi couldn’t read the plugin file ${JSON.stringify(name)}: ${JSON.stringify((error as Error).message)}`,
    )
    const code = (error as NodeJS.ErrnoException).code
    return {
      name,
      text: '',
      error:
        code === 'ENOENT'
          ? link
            ? 'It isn’t there: a link to a file that’s gone.'
            : 'It isn’t there.'
          : code === 'EACCES' || code === 'EPERM'
            ? 'Lumovi isn’t allowed to read it.'
            : 'It couldn’t be read.',
    }
  }
}

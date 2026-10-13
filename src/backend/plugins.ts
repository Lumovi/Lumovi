/**
 * The user's own plugins: YAML files in ~/.lumovi/plugins (or the folder in
 * LUMOVI_PLUGINS_DIR). They are read whenever the page asks, so changes show
 * up on the next refresh; the page checks and applies them.
 */
import { createHash } from 'node:crypto'
import { constants, type Dirent } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
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
): Promise<{ files: ReadFile[]; included?: ReadFile[]; includedCode?: ReadFile[] }> {
  const own = { files: await filesIn(path) }
  const included = includedFolder(env)
  // (The stand-ins' code, beside their files: `toys.js` beside `toys.yaml`. A folder's own files
  // carry no code, so nothing of the kind is read from it.)
  return included
    ? { ...own, included: await filesIn(included), includedCode: await filesIn(included, CODE) }
    : own
}

/** A plugin's file, and the code that comes beside one of Lumovi's own. */
const YAML = /\.ya?ml$/i
const CODE = /\.js$/i

/** The tests' stand-in for plugins that came inside the build, in the tests' build alone. */
function includedFolder(env: NodeJS.ProcessEnv): string | undefined {
  // (A release build has none: the variable isn't read in it. Lumovi's own are only ever the
  // ones built in, so a bad one can't be shown to the app any other way.)
  return LUMOVI_TEST_BUILD ? env.LUMOVI_TEST_INCLUDED_PLUGINS_DIR : undefined
}

/**
 * What the folders' files are now, without reading them: each one's name, and of what it is
 * (through a link, of what that leads to) its device, its number there, its size and the times
 * it was written and changed, to the nanosecond. Nothing changes a file without changing its
 * change time, so files with the same mark were read the same, and what was read of them
 * stands. One that can't be looked at is marked by why.
 */
export async function filesMark(
  { path }: { path: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const included = includedFolder(env)
  const folders = [
    { folder: path, names: YAML },
    ...(included === undefined ? [] : [{ folder: included, names: /\.(?:ya?ml|js)$/i }]),
  ]
  const marks = await Promise.all(
    folders.map(async ({ folder, names }) =>
      Promise.all(
        ((await listed(folder, names)) ?? []).map(async ({ name }) => {
          try {
            const s = await stat(join(folder, name), { bigint: true })
            return [name, s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')
          } catch (error) {
            return `${name}:${(error as NodeJS.ErrnoException).code ?? 'unreadable'}`
          }
        }),
      ),
    ),
  )
  return JSON.stringify(marks)
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
    // (Which of them have code beside them: never the code itself, which is handed over.)
    ...(read.includedCode
      ? {
          includedCoded: read.includedCode
            .filter((file) => !file.error)
            .map((file) => file.name.replace(CODE, '')),
        }
      : {}),
  }
}

/** Reads text strictly: bytes that aren't UTF-8 are refused, never read with marks in their place. */
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** A folder's plugin files, by name, in order; nothing if there's no folder. */
async function listed(
  path: string,
  names: RegExp = YAML,
): Promise<{ name: string; link: boolean }[] | undefined> {
  let entries: Dirent[]
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return undefined
  }
  return (
    entries
      // Links too: a ConfigMap mounted as a volume (as the Helm chart's plugins are) is links
      // into a folder of its own.
      .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && names.test(entry.name))
      .map((entry) => ({ name: entry.name, link: entry.isSymbolicLink() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, MAX_FILES)
  )
}

async function filesIn(path: string, which: RegExp = YAML): Promise<ReadFile[]> {
  // (No folder: no plugins of one's own.)
  const names = (await listed(path, which)) ?? []
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

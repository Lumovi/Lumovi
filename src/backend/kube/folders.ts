/**
 * A folder of kubeconfigs, the person's own choice: the files directly in it that are
 * kubeconfigs, in name order, and those skipped, with why. A link is followed only to a file
 * inside the folder, and nothing is waited on that isn't a file (a FIFO, a device). Nothing in it
 * is written.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { parse } from 'yaml'

/** The most a kubeconfig is read of: far more than any has. */
export const MAX_KUBECONFIG = 1024 * 1024

/** Why a file in a folder isn't read. */
export type Skipped =
  | 'folder'
  | 'link-out'
  | 'hidden'
  | 'large'
  | 'not-kubeconfig'
  /** The system doesn't let Lumovi read it. */
  | 'not-allowed'

export interface FolderRead {
  /** Its kubeconfigs, in name order: each by its name there, and where it's read from (a link's, the file it leads to). */
  files: { name: string; path: string }[]
  skipped: { name: string; why: Skipped }[]
  /** Why it can't be read at all: it isn't there, isn't a folder, or isn't Lumovi's to read. */
  problem?: 'gone' | 'not-a-folder' | 'not-allowed'
}

/**
 * What's in `folder`. One read as a kubeconfig before (`known`, where it's read from) that no
 * longer looks like one is still read, so a file caught half-written keeps what it last said.
 */
export function readFolder(folder: string, known: ReadonlySet<string> = new Set()): FolderRead {
  let real: string
  let names: string[]
  try {
    real = realpathSync(folder)
    if (!statSync(real).isDirectory()) return { files: [], skipped: [], problem: 'not-a-folder' }
    names = readdirSync(real).sort()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      files: [],
      skipped: [],
      problem: code === 'EACCES' || code === 'EPERM' ? 'not-allowed' : 'gone',
    }
  }
  const files: FolderRead['files'] = []
  const skipped: FolderRead['skipped'] = []
  for (const name of names) {
    const why = skipOf(name, join(folder, name), real, known)
    if (typeof why === 'string') skipped.push({ name, why })
    else files.push({ name, path: why.path })
  }
  return { files, skipped }
}

/** Why one isn't read, or where it's read from. */
function skipOf(
  name: string,
  path: string,
  folder: string,
  known: ReadonlySet<string>,
): Skipped | { path: string } {
  if (hidden(name)) return 'hidden'
  let target = path
  try {
    if (lstatSync(path).isSymbolicLink()) {
      target = realpathSync(path)
      const way = relative(folder, target)
      if (!way || way.split(sep)[0] === '..' || isAbsolute(way)) return 'link-out'
    }
    if (statSync(target).isDirectory()) return 'folder'
  } catch (error) {
    // A link to nothing leads nowhere in the folder either.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'link-out' : 'not-allowed'
  }
  const read = kubeconfigText(target)
  if ('skipped' in read) return read.skipped
  return isKubeconfig(read.text) || known.has(target) ? { path: target } : 'not-kubeconfig'
}

/** Hidden, or an editor's temporary file. */
function hidden(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    name.startsWith('.') || name.endsWith('~') || lower.endsWith('.swp') || lower.endsWith('.tmp')
  )
}

/**
 * A file's text, from the file opened once and checked as it is (not as it was a moment before):
 * if it's a file, and no larger than any kubeconfig.
 */
export function kubeconfigText(path: string): { text: string } | { skipped: Skipped } {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { skipped: code === 'EISDIR' ? 'folder' : 'not-allowed' }
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { skipped: 'not-kubeconfig' }
    if (stat.size > MAX_KUBECONFIG) return { skipped: 'large' }
    // No more than the most a kubeconfig is, and one byte: one that grew since is too large.
    const buffer = Buffer.alloc(MAX_KUBECONFIG + 1)
    let read = 0
    for (let got = -1; got !== 0 && read < buffer.length; read += got) {
      got = readSync(fd, buffer, read, buffer.length - read, null)
    }
    if (read > MAX_KUBECONFIG) return { skipped: 'large' }
    return { text: buffer.subarray(0, read).toString('utf8') }
  } catch {
    return { skipped: 'not-allowed' }
  } finally {
    closeSync(fd)
  }
}

/** Whether it's a kubeconfig: YAML or JSON with `kind: Config`, or clusters, contexts or users. */
function isKubeconfig(text: string): boolean {
  try {
    const document = parse(text) as unknown
    if (typeof document !== 'object' || document === null || Array.isArray(document)) return false
    const config = document as Record<string, unknown>
    return (
      config.kind === 'Config' ||
      ['clusters', 'contexts', 'users'].some((key) => Array.isArray(config[key]))
    )
  } catch {
    return false
  }
}

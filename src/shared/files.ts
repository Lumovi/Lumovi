import type { KubeError } from './api'
import { kubectl } from './kubectl'

/**
 * Files copied out of and into a container, as `kubectl cp` does it: `tar` run in the
 * container, its archive read (or written) here. What a container sends is never trusted: see
 * `entryPath`.
 */

/** The most one copy carries unless it's set otherwise: 2 GiB. */
export const FILE_COPY_MAX_BYTES = 2 * 1024 ** 3
/** How many files and folders one copy carries at most. */
export const FILE_COPY_MAX_ENTRIES = 100_000
/** How long a path in a container can be (Linux's PATH_MAX). */
const MAX_PATH = 4096

/** One of a pod's containers. */
export interface ContainerRef {
  context: string
  namespace: string
  pod: string
  container: string
}

/** A file or a folder of a container, to this computer. */
export interface FileDownloadRequest extends ContainerRef {
  path: string
}

/** A file or a folder of this computer, into a folder of a container. */
export interface FileUploadRequest extends ContainerRef {
  /** The folder it's put in, which is there already. */
  path: string
  /** What was picked to send: `PickedFiles.handle`. */
  source: string
}

/** What someone picked on their computer to upload: the page never has its path. */
export interface PickedFiles {
  handle: string
  /** Its own name: the file's, or the folder's. */
  name: string
  folder: boolean
  files: number
  bytes: number
  /** What it holds that isn't sent: links, and what's neither a file nor a folder. */
  leftOut: number
}

export interface FileCopyProgress {
  /** Of the files' contents. */
  bytes: number
  files: number
  /** How much there is in all, when that's known: an upload's, or one downloaded file's. */
  total?: number
}

/** What an archive held that isn't kept. */
export interface LeftOut {
  /** Symbolic and hard links: none is ever written, so none can lead out of the folder. */
  links: number
  /** Devices, pipes and whatever else is neither a file nor a folder. */
  special: number
  /** Names this computer can't give a file (Windows'). */
  unnamed: number
}

/** Why a copy didn't happen, where the page says more than the message. */
export type FileCopyReason =
  /** The container has no tar. */
  | 'no-tar'
  /** More than a copy may carry. */
  | 'too-large'
  /** The archive named something outside what was asked for. */
  | 'unsafe'

export interface FileCopyError extends KubeError {
  reason?: FileCopyReason
}

export type FileCopyResult<T> = { ok: true; data: T } | { ok: false; error: FileCopyError }

/** A copy that's under way: a server's says where its page fetches it from, or sends it to. */
export interface FileCopyBegun {
  url?: string
  /** How much there is in all, when that's known from the start: one downloaded file's. */
  total?: number
}

export interface FileCopyEnd extends FileCopyProgress {
  outcome: 'done' | 'failed' | 'cancelled'
  error?: FileCopyError
  leftOut?: LeftOut
  /** Where it was saved on this computer (the desktop app's). */
  saved?: string
  /** What to know of what was copied, though it's whole (a file that grew meanwhile). */
  note?: string
}

export const NOTHING_LEFT_OUT: LeftOut = { links: 0, special: 0, unnamed: 0 }

/** A path's parts, `.` and empty ones dropped, `..` followed; undefined when it leads above its start. */
function parts(path: string): { absolute: boolean; names: string[] } | undefined {
  const absolute = path.startsWith('/')
  const names: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..') names.push(part)
    // Above the root is the root, as the container's own shell has it.
    else if (names.length > 0) names.pop()
    else if (!absolute) return undefined
  }
  return { absolute, names }
}

/**
 * A container's path as tar is given it: the folder it's in, and its name there. Neither can be
 * read as an option, whatever the path: the folder is `-C`'s value and starts with `/` or `./`,
 * and the name starts with `./`.
 */
export interface ContainerPath {
  folder: string
  /** `.` for the folder itself (the root, or the working directory). */
  name: string
  /** The whole path, tidied. */
  path: string
}

export function containerPath(path: string): ContainerPath | undefined {
  if (path === '' || path.length > MAX_PATH || path.includes('\0')) return undefined
  const split = parts(path)
  if (!split) return undefined
  const { absolute, names } = split
  const start = absolute ? '/' : './'
  const name = names.at(-1) ?? '.'
  return {
    folder: `${start}${names.slice(0, -1).join('/')}`,
    name,
    path: `${start}${names.join('/')}`,
  }
}

/** `tar cf - -C <folder> -- ./<name>`: the archive of one file or folder, to stdout. */
export function downloadCommand(at: ContainerPath): string[] {
  return ['tar', 'cf', '-', '-C', at.folder, '--', `./${at.name}`]
}

/**
 * `tar xmf - -C <folder>`: an archive from stdin, unpacked in a folder (`m`: with the time it's
 * unpacked, as `kubectl cp` does, whatever this computer's clock says).
 */
export function uploadCommand(at: ContainerPath): string[] {
  return ['tar', 'xmf', '-', '-C', at.path]
}

/**
 * Where an archive's entry goes, under what was asked for: its names from there, none for the
 * thing itself. Undefined for one that isn't under it: an absolute path, one with `..`, or one
 * of something else. A container can send any archive it likes, so that ends the copy.
 */
export function entryPath(entry: string, root: string): string[] | undefined {
  if (entry.includes('\0') || entry.startsWith('/')) return undefined
  const names = entry.split('/').filter((part) => part !== '' && part !== '.')
  if (names.includes('..')) return undefined
  if (root === '.') return names
  return names[0] === root ? names.slice(1) : undefined
}

/** A name Windows can't give a file, or gives a meaning of its own (a device, a stream). */
const WINDOWS_UNNAMEABLE = /[<>:"|?*\\]|[. ]$|^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i
const controls = (name: string) => [...name].some((character) => character < ' ')

/** Whether this computer can name a file so. */
export function nameable(name: string, platform: string): boolean {
  return platform !== 'win32' || !(WINDOWS_UNNAMEABLE.test(name) || controls(name))
}

/** What a download is saved as, from its path: its name, or the container's for its root. */
export function downloadName(at: ContainerPath, r: ContainerRef): string {
  return at.name === '.' ? r.container : at.name
}

/** `kubectl cp shop/web-1:/var/log/app.log app.log -c app`. */
export function downloadKubectl(r: FileDownloadRequest): string {
  const at = containerPath(r.path)
  return kubectl(
    r.context,
    undefined,
    'cp',
    `${r.namespace}/${r.pod}:${at?.path ?? r.path}`,
    at ? downloadName(at, r) : '.',
    '-c',
    r.container,
  )
}

/** `kubectl cp report.csv shop/web-1:/tmp/report.csv -c app`. */
export function uploadKubectl(r: ContainerRef & { path: string }, name: string): string {
  const at = containerPath(r.path)
  const folder = at?.path ?? r.path
  return kubectl(
    r.context,
    undefined,
    'cp',
    name,
    `${r.namespace}/${r.pod}:${folder.endsWith('/') ? folder : `${folder}/`}${name}`,
    '-c',
    r.container,
  )
}

/** `kubectl debug` for a container without tar: one with tools beside it, seeing its files. */
export function debugKubectl(r: ContainerRef): string {
  return kubectl(
    r.context,
    r.namespace,
    'debug',
    '-it',
    r.pod,
    '--image=busybox',
    `--target=${r.container}`,
  )
}

const UNITS = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB']

/** 1.5 GiB, 340 KiB, 12 bytes. */
export function sized(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const shown = unit === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  return `${shown} ${unit === 0 && shown === 1 ? 'byte' : UNITS[unit]}`
}

/** "2 links and 1 device or pipe", for what was left out; empty when nothing was. */
export function leftOutText(left: LeftOut | undefined): string {
  if (!left) return ''
  const said = [
    left.links ? `${left.links} ${left.links === 1 ? 'link' : 'links'}` : '',
    left.special
      ? `${left.special} ${left.special === 1 ? 'device or pipe' : 'devices or pipes'}`
      : '',
    left.unnamed
      ? `${left.unnamed} with ${left.unnamed === 1 ? 'a name' : 'names'} this computer can’t use`
      : '',
  ].filter(Boolean)
  return said.length > 1 ? `${said.slice(0, -1).join(', ')} and ${said.at(-1)}` : (said[0] ?? '')
}

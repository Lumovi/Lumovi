/**
 * Files copied out of and into containers, on this computer: where a download is saved is
 * asked of its person, in a dialog of the system's, and so is what's uploaded. The page gives
 * no path and gets none to read: what it has of a pick is a handle.
 *
 * A download is written beside where it'll be, under a name of its own, and takes its place
 * only once it's whole; stopped early, it's removed. A folder is a new one: it's never
 * unpacked over one that's there, so nothing there is replaced, and nothing in it is a link an
 * archive could write through.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Writable } from 'node:stream'
import type { Arriving, FilesHost, Saving, Sending, Sent } from '@backend/kube/files'
import { KubeRequestError, toKubeError } from '@backend/kube/errors'
import { invalid } from '@backend/kube/validate'
import {
  FILE_COPY_MAX_ENTRIES,
  type FileCopyResult,
  type FileDownloadRequest,
  type PickedFiles,
} from '@shared/files'

/** The system's dialogs, as this needs them: each resolves to a path, or nothing if cancelled. */
export interface FileDialogs {
  save(options: { title: string; defaultPath: string }): Promise<string | undefined>
  open(options: { title: string; folder: boolean }): Promise<string | undefined>
  /** Where downloads go unless their person says otherwise. */
  downloads(): string
  /** Shows a file where it is, in the system's file manager. */
  show(path: string): void
}

/** How many picks are held at once: the oldest are let go. */
const PICKS_KEPT = 8

interface Picked {
  path: string
  files: number
  bytes: number
}

/** `path` under `root`, by its names: it throws rather than name anything outside it. */
function under(root: string, names: string[]): string {
  const target = resolve(root, ...names)
  const from = relative(root, target)
  if (from.startsWith('..') || isAbsolute(from)) {
    throw new KubeRequestError('invalid', `${names.join('/')} would be outside ${root}`)
  }
  return target
}

/** A name of its own beside where a download will be, until it's whole. */
const partial = (path: string) =>
  join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.part`)

/**
 * A new file to write to, with its permission bits (and its owner's to read and write it):
 * never one that's there, nor through a link.
 */
async function created(path: string, mode: number, names: string[]): Promise<Writable> {
  const file = await open(path, 'wx', (mode & 0o777) | 0o600).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    // Two names that differ only in their letters' case, where this computer tells none apart.
    throw new KubeRequestError(
      'conflict',
      `${names.join('/')} is in it twice, as this computer reads names. Nothing of it was kept.`,
    )
  })
  return file.createWriteStream()
}

/** One file, written under a name of its own and renamed into place once it's all there. */
function fileSaving(path: string): Saving {
  const part = partial(path)
  return {
    folder: () => Promise.resolve(),
    file: (names, file) => created(part, file.mode, names),
    done: async () => {
      await rename(part, path)
      return path
    },
    discard: () => rm(part, { force: true }),
  }
}

/** A folder, unpacked into a new one of its own and renamed into place once it's all there. */
async function folderSaving(path: string): Promise<Saving> {
  if (await lstat(path).catch(() => undefined)) {
    throw new KubeRequestError(
      'conflict',
      `${path} is there already, and a folder isn’t copied over one. Save it under a new name.`,
    )
  }
  const part = partial(path)
  await mkdir(part, { mode: 0o700 })
  return {
    folder: async (names) => {
      await mkdir(under(part, names), { recursive: true })
    },
    file: async (names, file) => {
      const target = under(part, names)
      await mkdir(dirname(target), { recursive: true })
      return created(target, file.mode, names)
    },
    done: async () => {
      await rename(part, path)
      return path
    },
    discard: () => rm(part, { recursive: true, force: true }),
  }
}

/** What a folder holds, in an order that's the same each time: folders before what's in them. */
async function* walk(
  path: string,
  names: string[],
  windows: boolean,
): AsyncGenerator<Sent & { leftOut?: true }> {
  const stats = await lstat(path)
  // Links aren't followed, here either: what's sent is what's in the folder.
  if (!stats.isFile() && !stats.isDirectory()) {
    yield { names, folder: false, size: 0, mode: 0, leftOut: true, open: () => never() }
    return
  }
  // Windows has no permission bits to send: a file's are the usual ones.
  const mode = windows ? (stats.isDirectory() ? 0o755 : 0o644) : stats.mode & 0o777
  if (stats.isFile()) {
    yield {
      names,
      folder: false,
      size: stats.size,
      mode,
      mtime: stats.mtime,
      open: () => Promise.resolve(createReadStream(path)),
    }
    return
  }
  yield { names, folder: true, size: 0, mode, open: () => never() }
  for (const name of (await readdir(path)).sort()) {
    yield* walk(join(path, name), [...names, name], windows)
  }
}

const never = () => Promise.reject(new Error('Only a file is read'))

export class DesktopFiles implements FilesHost {
  readonly platform = process.platform
  readonly #picked = new Map<string, Picked>()
  /** What this saved, which is all it shows in the file manager. */
  readonly #saved = new Set<string>()

  constructor(private readonly dialogs: FileDialogs) {}

  /** Asks for a file or a folder to upload, and measures it. */
  async pick(what: unknown): Promise<FileCopyResult<PickedFiles | null>> {
    try {
      if (what !== 'file' && what !== 'folder') throw invalid('A file, or a folder')
      const folder = what === 'folder'
      const path = await this.dialogs.open({
        title: folder ? 'Upload a folder' : 'Upload a file',
        folder,
      })
      if (!path) return { ok: true, data: null }
      let files = 0
      let bytes = 0
      let leftOut = 0
      let entries = 0
      for await (const entry of walk(path, [basename(path)], this.platform === 'win32')) {
        if (entries === 0 && entry.leftOut) throw invalid('What’s uploaded is a file, or a folder')
        entries += 1
        if (entries > FILE_COPY_MAX_ENTRIES) {
          throw invalid(
            `${basename(path)} holds more than the ${FILE_COPY_MAX_ENTRIES} files and folders one copy carries`,
          )
        }
        if (entry.leftOut) leftOut += 1
        else if (!entry.folder) {
          files += 1
          bytes += entry.size
        }
      }
      const handle = randomUUID()
      this.#picked.set(handle, { path, files, bytes })
      while (this.#picked.size > PICKS_KEPT) this.#picked.delete(this.#picked.keys().next().value!)
      return { ok: true, data: { handle, name: basename(path), folder, files, bytes, leftOut } }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  save(
    _id: string,
    request: FileDownloadRequest,
    arriving: Arriving,
  ): { saving: Promise<Saving | null> } {
    const saving = (async () => {
      // Only a name is offered: where it goes is its person's to say, never the container's.
      const path = await this.dialogs.save({
        title: `Save ${arriving.folder ? 'the folder' : 'the file'} from ${request.pod}`,
        defaultPath: join(this.dialogs.downloads(), basename(arriving.name)),
      })
      if (!path) return null
      const kept = arriving.folder ? await folderSaving(path) : fileSaving(path)
      return {
        ...kept,
        done: async () => {
          const saved = await kept.done()
          this.#saved.add(saved!)
          return saved
        },
      }
    })()
    return { saving }
  }

  sending(_id: string, source: string): Sending | undefined {
    const picked = this.#picked.get(source)
    if (!picked) return undefined
    const windows = this.platform === 'win32'
    return {
      name: basename(picked.path),
      // As it was when it was picked: it's read again as it's sent, and that's what counts.
      files: picked.files,
      bytes: picked.bytes,
      async *entries(): AsyncGenerator<Sent> {
        for await (const entry of walk(picked.path, [basename(picked.path)], windows)) {
          if (!entry.leftOut) yield entry
        }
      },
      close: () => undefined,
    }
  }

  /** Shows a download in the file manager: only one this saved. */
  show(saved: unknown): void {
    if (typeof saved === 'string' && this.#saved.has(saved)) this.dialogs.show(saved)
  }
}

import { once } from 'node:events'
import { PassThrough, Writable, type Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { Exec, type KubeConfig } from '@kubernetes/client-node'
import { extract as untar, pack as tar, type Extract, type Header, type Pack } from 'tar-stream'
import type { AccessGuard } from '@shared/access'
import {
  containerPath,
  debugKubectl,
  downloadCommand,
  downloadKubectl,
  downloadName,
  entryPath,
  FILE_COPY_MAX_BYTES,
  FILE_COPY_MAX_ENTRIES,
  leftOutText,
  nameable,
  sized,
  uploadCommand,
  uploadKubectl,
  type ContainerPath,
  type ContainerRef,
  type FileCopyBegun,
  type FileCopyEnd,
  type FileCopyError,
  type FileCopyProgress,
  type FileCopyReason,
  type FileCopyResult,
  type FileDownloadRequest,
  type FileUploadRequest,
  type LeftOut,
} from '@shared/files'
import { isRefusal } from '../audit/describe'
import type { Recorder } from '../audit/recorder'
import { KubeRequestError, readOnlyRefusal, toKubeError, type ReadOnlyCheck } from './errors'
import type { ClusterConfigs } from './kubeconfig'
import { exitOf, prepare, took } from './streams'
import { assertQuery, assertString, invalid } from './validate'

/**
 * Files copied out of a container and into one, as `kubectl cp` does it: `tar` runs in the
 * container, and its archive is read here, or written here for it.
 *
 * What a container sends is whatever it likes, so nothing of an archive is trusted:
 * - only files and folders are kept. Links (symbolic or hard) are never written, so none can
 *   lead out of the folder; devices and pipes aren't either. What's left out is counted, and said;
 * - an entry that isn't under what was asked for (an absolute path, one with `..`, another
 *   name) ends the copy, as does more than a copy may carry, in bytes or in entries;
 * - where it's kept is the host's: a place its person chose, never one the archive names.
 *
 * And what's run there is fixed: `tar cf` or `tar xmf`, with the one path as an argument no tar
 * reads as an option (see `containerPath`). So a download changes nothing in its container.
 */

/** How much a copy carries, and how long it waits for more. */
export interface FileCopyLimits {
  /** In bytes, of the files' contents; 0 turns copying off. */
  maxBytes: number
  /** How long nothing may arrive (or leave) before a copy is stopped. */
  idleMs: number
  /** Who set it and how it's changed, said to whoever meets it. */
  raise: string
}

const whole = (text: string | undefined) => (text && /^\d+$/.test(text) ? Number(text) : undefined)

/**
 * How much a copy carries here: what the organization's policy says (the desktop app's), or
 * LUMOVI_FILE_COPY_MAX_BYTES, or 2 GiB; and how long it waits (LUMOVI_FILE_COPY_IDLE_MS, or a
 * minute).
 */
export function fileCopyLimits(
  env: NodeJS.ProcessEnv,
  policy?: { off?: boolean; maxBytes?: number },
): FileCopyLimits {
  const idleMs = whole(env.LUMOVI_FILE_COPY_IDLE_MS) || IDLE_MS
  if (policy?.off) {
    return { maxBytes: 0, idleMs, raise: 'Your organization’s policy turns it off (fileCopy).' }
  }
  if (policy?.maxBytes !== undefined) {
    return {
      maxBytes: policy.maxBytes,
      idleMs,
      raise: 'Your organization’s policy sets that (fileCopy).',
    }
  }
  return {
    maxBytes: whole(env.LUMOVI_FILE_COPY_MAX_BYTES) ?? FILE_COPY_MAX_BYTES,
    idleMs,
    raise:
      'LUMOVI_FILE_COPY_MAX_BYTES sets that where Lumovi runs, in bytes (0 turns copying off).',
  }
}

/** A file of a download, as it's kept: only what's safe to give one. */
export interface SavedFile {
  size: number
  /** Its permission bits only: nothing that'd make it run as someone else. */
  mode: number
  mtime: Date
}

/** Where a download goes, as its entries arrive: under one place, by their names from it. */
export interface Saving {
  folder(names: string[]): Promise<void>
  file(names: string[], file: SavedFile): Promise<Writable>
  /** It all arrived: where it is now, if that's somewhere to say. */
  done(): Promise<string | undefined>
  /** It stopped early: nothing of it is left. */
  discard(): Promise<void>
}

/** What a download turned out to be, once its archive says. */
export interface Arriving {
  folder: boolean
  name: string
  /** A file's size. */
  size?: number
}

/** One thing of an upload: a folder, or a file and how to read it. */
export interface Sent {
  names: string[]
  folder: boolean
  size: number
  mode: number
  mtime?: Date
  open(): Promise<Readable>
}

/** What's uploaded, in the order it goes: a folder before what's in it. */
export interface Sending {
  name: string
  files: number
  bytes: number
  /** Where the page sends the files' contents (a server's). */
  url?: string
  entries(): AsyncIterable<Sent>
  /** It ended, however it did. */
  close(): void
}

/** What only the host can do: ask its person where to save, and read what they picked. */
export interface FilesHost {
  platform: string
  /**
   * Where a download is kept: nowhere (null) if its person chose not to. A server's is fetched
   * by the page from `url`.
   */
  save(
    id: string,
    request: FileDownloadRequest,
    arriving: Arriving,
  ): { url?: string; saving: Promise<Saving | null> }
  /** What was picked to upload, by its handle; undefined for one that isn't this page's. */
  sending(id: string, source: string): Sending | undefined
}

interface Dependencies {
  store: ClusterConfigs
  envReady: Promise<void>
  isReadOnly: ReadOnlyCheck
  audit: Recorder
  guard?: AccessGuard
}

/** Stopped by its person. */
class Cancelled extends Error {}

/** Turned down by Lumovi for what it asks, before anything is asked of the cluster. */
class TurnedDown extends KubeRequestError {
  constructor(message: string) {
    super('invalid', message)
  }
}

/** A path as it's recorded, whatever was given as one: no longer than 300, and nothing unprintable. */
const printable = (path: string) => JSON.stringify(path.slice(0, 300)).slice(1, -1)

const failed = (reason: FileCopyReason, code: FileCopyError['code'], message: string) =>
  Object.assign(new KubeRequestError(code, message), { reason })

function copyError(error: unknown): FileCopyError {
  const reason = (error as { reason?: FileCopyReason }).reason
  // A file of this computer's that couldn't be written, or read: it's said as that.
  if (!(error instanceof KubeRequestError) && (error as NodeJS.ErrnoException).path) {
    return { code: 'invalid', message: `This computer said: ${(error as Error).message}` }
  }
  return { ...toKubeError(error), ...(reason ? { reason } : {}) }
}

/** How a copy came out, as the page is told and as it's recorded. */
function ending(error: unknown): Ending {
  if (error === undefined) return { outcome: 'done' }
  if (error instanceof Cancelled) return { outcome: 'cancelled' }
  return {
    outcome: 'failed',
    error: copyError(error),
    ...(error instanceof TurnedDown ? { turnedDown: true } : {}),
  }
}

type Ending = Pick<FileCopyEnd, 'outcome' | 'error'> & { turnedDown?: boolean }

/** What tar wrote to stderr, to say if it fails: its start, which is where it says why. */
class Said extends Writable {
  text = ''

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    if (this.text.length < 2000) this.text = (this.text + chunk.toString('utf8')).slice(0, 2000)
    done()
  }
}

/**
 * An archive as it arrives, handed to its reader no faster than it's read: the exec client
 * writes whatever comes, so what waits here says when to stop reading the connection.
 */
class Inflow extends Writable {
  constructor(
    private readonly into: Extract,
    private readonly arrived: (bytes: number) => void,
  ) {
    super({ highWaterMark: 1024 * 1024 })
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    this.arrived(chunk.length)
    if (this.into.write(chunk)) done()
    else this.into.once('drain', done)
  }

  override _final(done: () => void) {
    this.into.end(undefined)
    done()
  }
}

interface Exit {
  code?: number
  message?: string
  /** The connection closed with no word of how tar ended. */
  closed?: true
}

interface Running {
  socket: Awaited<ReturnType<Exec['exec']>>
  exit: Promise<Exit>
  said(): string
}

interface Copy {
  id: string
  direction: 'download' | 'upload'
  request: ContainerRef & { path: string }
  /** What's sent, by name (an upload's). */
  name?: string
  since: number
  bytes: number
  files: number
  total?: number
  leftOut: LeftOut
  /** Lets go of what was picked to send, once (an upload's). */
  release?: () => void
  /** Why it's being stopped: by its person, or for waiting too long. */
  halted?: Error
  /** Stops it. */
  halt(why: Error): void
  /** Settles when it's stopped. */
  halting: Promise<void>
}

/** tar's own words for a file that grew while it was read: what was there when it began is whole. */
const GREW = /^(tar: )?.*file changed as we read it\s*$/
const NO_TAR = /executable file not found|exec: "tar"|no such file or directory/i
/** How much unsent data may wait on a connection before more is read for it. */
const WAITING_MAX = 1024 * 1024
/** tar reads in records of this many bytes, and waits for a whole one. */
const RECORD = 10 * 1024
const PROGRESS_MS = 200
const IDLE_MS = 60_000
/** How long tar gets to say how it ended once everything was sent. */
const CLOSED = 'The connection to the container closed before the copy was finished.'

export class FileCopies {
  readonly #copies = new Map<string, Copy>()
  /** Copies under way, each until it has ended and been told of. */
  readonly #ending = new Set<Promise<void>>()

  constructor(
    private readonly deps: Dependencies,
    private readonly limits: FileCopyLimits,
    private readonly host: FilesHost,
    private readonly emit: {
      progress: (id: string, progress: FileCopyProgress) => void
      end: (id: string, end: FileCopyEnd) => void
    },
  ) {}

  /**
   * Starts copying a file or a folder out of a container. Resolves once tar sent the first of
   * it (so a path that isn't there, or no tar, is said at once); the rest is told as it goes.
   */
  async download(id: unknown, request: unknown): Promise<FileCopyResult<FileCopyBegun>> {
    return this.#begin(id, request, 'download', async (copy, at) => {
      const r = copy.request
      await this.deps.guard?.require(
        r.context,
        'shells',
        'on',
        r.namespace,
        'copy files out of containers',
      )
      return (kc) => this.#download(copy, kc, at)
    })
  }

  /** Starts copying what was picked into a folder of a container. */
  async upload(id: unknown, request: unknown): Promise<FileCopyResult<FileCopyBegun>> {
    return this.#begin(id, request, 'upload', async (copy, at) => {
      const r = copy.request
      const { guard } = this.deps
      await guard?.require(r.context, 'shells', 'on', r.namespace, 'copy files into containers')
      await guard?.require(r.context, 'changes', 'write', r.namespace, 'copy files into containers')
      const readOnly = this.deps.isReadOnly(r.context)
      if (readOnly) throw readOnlyRefusal(r.context, readOnly)
      const { source } = r as FileUploadRequest
      assertString(source, 'source')
      const sending = this.host.sending(copy.id, source)
      if (!sending) {
        throw new TurnedDown('Pick what to upload again: what was picked is no longer held')
      }
      copy.name = sending.name
      copy.total = sending.bytes
      copy.release = () => sending.close()
      // Turned off, that's what's said, below: not that it's too much.
      if (this.limits.maxBytes > 0 && sending.bytes > this.limits.maxBytes) throw this.#tooLarge()
      return (kc) => this.#upload(copy, kc, at, sending)
    })
  }

  cancel(id: unknown): void {
    this.#copies.get(String(id))?.halt(new Cancelled())
  }

  /** Stops every copy; resolves once what was half-saved is removed. */
  async cancelAll(): Promise<void> {
    for (const copy of this.#copies.values()) copy.halt(new Cancelled())
    await Promise.all(this.#ending)
  }

  /** Whether any copy is under way (quitting waits for what's half-saved to be removed). */
  get active(): boolean {
    return this.#ending.size > 0
  }

  #until(ended: Promise<void>) {
    this.#ending.add(ended)
    void ended.then(() => this.#ending.delete(ended))
  }

  /** What both directions check first, and how either's failure to begin is answered and recorded. */
  async #begin(
    id: unknown,
    request: unknown,
    direction: Copy['direction'],
    allowed: (
      copy: Copy,
      at: ContainerPath,
    ) => Promise<(kc: KubeConfig) => Promise<FileCopyResult<FileCopyBegun>>>,
  ): Promise<FileCopyResult<FileCopyBegun>> {
    let copy: Copy | undefined
    try {
      if (typeof id !== 'string' || !/^[\w-]{8,64}$/.test(id) || this.#copies.has(id)) {
        throw invalid('A new copy needs a new id')
      }
      const r = assertQuery<ContainerRef & { path: string }>(request)
      assertString(r.context, 'context')
      assertString(r.namespace, 'namespace')
      assertString(r.pod, 'pod')
      assertString(r.container, 'container')
      assertString(r.path, 'path')
      let halted!: () => void
      const halting = new Promise<void>((resolve) => (halted = resolve))
      const made: Copy = {
        id,
        direction,
        request: r,
        since: Date.now(),
        bytes: 0,
        files: 0,
        leftOut: { links: 0, special: 0, unnamed: 0 },
        halt: (why) => {
          made.halted ??= why
          halted()
        },
        halting,
      }
      copy = made
      this.#copies.set(id, copy)
      // From here it's a copy someone asked for, of something, somewhere: recorded however it
      // ends, and one turned down for what it asks (a path that leads elsewhere) as refused.
      const at = containerPath(r.path)
      if (!at) {
        throw new TurnedDown(
          'A path in the container is one that doesn’t lead above where it starts, and has no NUL in it.',
        )
      }
      const run = await allowed(copy, at)
      if (this.limits.maxBytes <= 0) {
        throw new KubeRequestError(
          'forbidden',
          `Copying files is turned off here. ${this.limits.raise}`,
        )
      }
      await this.deps.envReady
      const kc = this.deps.store.forContext(r.context)
      await prepare(kc)
      return await run(kc)
    } catch (error) {
      const failure = { ok: false as const, error: copyError(copy?.halted ?? error) }
      if (copy) {
        copy.release?.()
        this.#copies.delete(copy.id)
        this.#record(copy, ending(copy.halted ?? error))
      }
      return failure
    }
  }

  #tooLarge(): Error {
    return failed(
      'too-large',
      'invalid',
      `That’s more than one copy carries here, which is ${sized(this.limits.maxBytes)}. ${this.limits.raise}`,
    )
  }

  /** tar, run in the container, with what it reads and writes. */
  async #exec(
    kc: KubeConfig,
    r: ContainerRef,
    command: string[],
    stdin: Readable | null,
    stdout: Writable | null,
  ): Promise<Running> {
    const said = new Said()
    let settle!: (exit: Exit) => void
    const exit = new Promise<Exit>((resolve) => (settle = resolve))
    const socket = await new Exec(kc).exec(
      r.namespace,
      r.pod,
      r.container,
      command,
      stdout,
      said,
      stdin,
      false,
      (status) => settle(exitOf(status)),
    )
    socket.on('close', () => settle({ closed: true }))
    return { socket, exit, said: () => said.text.trim() }
  }

  /** Stops a copy that waits too long for more: `touch` each time something moves. */
  #idle(copy: Copy) {
    let timer: NodeJS.Timeout | undefined
    let held = false
    const { idleMs } = this.limits
    const touch = () => {
      clearTimeout(timer)
      if (held) return
      timer = setTimeout(
        () =>
          copy.halt(
            new KubeRequestError(
              'timeout',
              `Nothing moved for ${took(idleMs)}, so the copy was stopped.`,
            ),
          ),
        idleMs,
      )
    }
    return {
      touch,
      /** While its person decides something, however long they take. */
      hold: (waiting: boolean) => {
        held = waiting
        touch()
      },
      stop: () => {
        held = true
        clearTimeout(timer)
      },
    }
  }

  /** Tells the page how far a copy is, a few times a second at most. */
  #progress(copy: Copy) {
    let last = 0
    return () => {
      const now = Date.now()
      if (now - last < PROGRESS_MS) return
      last = now
      this.emit.progress(copy.id, this.#so(copy))
    }
  }

  #so(copy: Copy): FileCopyProgress {
    return {
      bytes: copy.bytes,
      files: copy.files,
      ...(copy.total === undefined ? {} : { total: copy.total }),
    }
  }

  /** Why tar ended as it did, when that wasn't well: no tar there, or what it said. */
  #tarFailure(copy: Copy, exit: Exit, said: string): Error | undefined {
    if (exit.code === 0) return undefined
    const r = copy.request
    // tar's own complaints start with its name: then it's there.
    const missing = NO_TAR.test(`${exit.message ?? ''} ${said}`) || exit.code === 127
    if (missing && !/^tar: /m.test(said)) {
      return failed(
        'no-tar',
        'invalid',
        `${r.container} has no tar, which copying files needs, as kubectl cp does. A debug container with tools, started beside it, sees its files under /proc/1/root: ${debugKubectl(r)}`,
      )
    }
    if (exit.closed) return new KubeRequestError('unreachable', CLOSED)
    const what = said || exit.message || `tar ended with ${exit.code}`
    return new KubeRequestError(
      /no such file or directory|not found in archive|can't (open|stat)/i.test(said) &&
        copy.direction === 'download'
        ? 'not-found'
        : 'invalid',
      copy.direction === 'download'
        ? `tar in ${r.container} couldn’t read ${r.path}: ${what}`
        : `tar in ${r.container} couldn’t write to ${r.path}: ${what} Some of it may be there already.`,
    )
  }

  async #download(
    copy: Copy,
    kc: KubeConfig,
    at: ContainerPath,
  ): Promise<FileCopyResult<FileCopyBegun>> {
    const r = copy.request
    const { maxBytes } = this.limits
    const idle = this.#idle(copy)
    const progress = this.#progress(copy)
    const parse = untar()
    let arrived = 0
    const inflow = new Inflow(parse, (bytes) => {
      idle.touch()
      arrived += bytes
      // Headers and padding aren't counted as the files' own, but they're bounded too.
      if (arrived > maxBytes + FILE_COPY_MAX_ENTRIES * 2048) copy.halt(this.#tooLarge())
    })
    let begun!: (begun: FileCopyBegun) => void
    const beginning = new Promise<FileCopyBegun>((resolve) => (begun = resolve))
    let kind: 'file' | 'folder' | undefined
    let saving: Saving | null | undefined
    let entries = 0
    let note: string | undefined

    const entry = async (header: Header, contents: AsyncIterable<Buffer>) => {
      const skip = async () => {
        for await (const chunk of contents) void chunk
      }
      const names = entryPath(header.name, at.name)
      if (!names) {
        throw failed(
          'unsafe',
          'invalid',
          `The archive from ${r.container} names “${header.name.slice(0, 200)}”, which isn’t under ${at.path}. Nothing of it was kept.`,
        )
      }
      if (header.type !== 'file' && header.type !== 'directory') {
        if (header.type === 'link' || header.type === 'symlink') copy.leftOut.links += 1
        else copy.leftOut.special += 1
        return skip()
      }
      entries += 1
      if (entries > FILE_COPY_MAX_ENTRIES) {
        throw failed(
          'too-large',
          'invalid',
          `That’s more than the ${FILE_COPY_MAX_ENTRIES} files and folders one copy carries.`,
        )
      }
      const folder = header.type === 'directory'
      if (!folder && copy.bytes + header.size > maxBytes) throw this.#tooLarge()
      if (kind === undefined) {
        kind = names.length === 0 && !folder ? 'file' : 'folder'
        if (kind === 'file') copy.total = header.size
        const { url, saving: chosen } = this.host.save(copy.id, r, {
          folder: kind === 'folder',
          name: downloadName(at, r),
          ...(kind === 'file' ? { size: header.size } : {}),
        })
        begun({ ...(url ? { url } : {}), ...(kind === 'file' ? { total: header.size } : {}) })
        // Its person takes as long as they like to say where.
        idle.hold(true)
        saving = await Promise.race([chosen, copy.halting.then(() => null)])
        if (copy.halted) {
          void chosen.then(
            (kept) => kept?.discard(),
            () => undefined,
          )
          throw copy.halted
        }
        if (!saving) throw new Cancelled()
        idle.hold(false)
      }
      // One file is one file; a folder has one top, and it's a folder.
      const more = kind === 'file' ? names.length > 0 || folder || copy.files > 0 : false
      if (more || (kind === 'folder' && names.length === 0 && !folder)) {
        throw failed(
          'unsafe',
          'invalid',
          `The archive from ${r.container} holds more than ${at.path}. Nothing of it was kept.`,
        )
      }
      if (!names.every((name) => nameable(name, this.host.platform))) {
        copy.leftOut.unnamed += 1
        return skip()
      }
      if (folder) return names.length > 0 ? saving!.folder(names) : undefined
      const out = await saving!.file(names, {
        size: header.size,
        mode: header.mode & 0o777,
        mtime: header.mtime,
      })
      try {
        for await (const chunk of contents) {
          copy.bytes += chunk.length
          progress()
          if (!out.write(chunk)) await once(out, 'drain')
        }
        out.end()
        await finished(out)
      } catch (error) {
        out.destroy()
        throw error
      }
      copy.files += 1
    }

    let run: Running | undefined
    const whole = (async (): Promise<string | undefined> => {
      try {
        const parsed = new Promise<void>((resolve, reject) => {
          parse.on('finish', resolve)
          parse.on('error', reject)
        })
        parse.on('entry', (header, contents, next) => {
          // Ended early, what's being read of it ends with the same error: it's said once, below.
          contents.on('error', () => undefined)
          entry(header, contents as AsyncIterable<Buffer>).then(
            () => next(),
            (error: unknown) => parse.destroy(error as Error),
          )
        })
        run = await this.#exec(kc, r, downloadCommand(at), null, inflow)
        const { socket } = run
        let exit: Exit | undefined
        void run.exit.then((ended) => {
          exit = ended
          // Without tar's word, what arrived may not be all of it.
          if (ended.closed) parse.destroy(new KubeRequestError('unreachable', CLOSED))
        })
        void copy.halting.then(() => parse.destroy(copy.halted))
        // No more is read from the connection than the archive's reader has taken.
        socket.on('message', () => {
          if (inflow.writableNeedDrain) socket.pause()
        })
        inflow.on('drain', () => socket.resume())
        idle.touch()
        const problem = await parsed.then(
          () => undefined,
          (error: unknown) => error,
        )
        if (copy.halted) throw copy.halted
        const failure = exit && this.#tarFailure(copy, exit, run.said())
        if (failure) {
          // A file that grew while tar read it (a log): what was there when it began is whole.
          const lines = run.said().split('\n')
          if (exit?.code !== 1 || problem || !kind || !lines.every((line) => GREW.test(line))) {
            throw failure
          }
          note = 'It changed while it was read: what was there when the copy began is whole.'
        }
        // What reads the archive says only that it couldn't: said as what it means.
        // (Not what this computer said of a file, which has a code and is said as that.)
        if (problem instanceof Error && problem.constructor === Error && !('code' in problem)) {
          throw new KubeRequestError(
            'invalid',
            `What ${r.container} sent isn’t an archive as tar writes one (${problem.message}). Nothing of it was kept.`,
          )
        }
        if (problem) throw problem
        if (!kind) {
          throw new KubeRequestError(
            'invalid',
            copy.leftOut.links
              ? `${at.path} is a link, and links aren’t followed: give the path it leads to.`
              : `${at.path} is neither a file nor a folder, so there’s nothing to copy.`,
          )
        }
        return await saving!.done()
      } catch (error) {
        run?.socket.close()
        parse.destroy()
        await saving?.discard()
        throw error
      } finally {
        idle.stop()
      }
    })()
    const failing = whole.then(
      () => undefined,
      (error: unknown) => ({ error }),
    )
    const first = await Promise.race([beginning, failing])
    // It ended before anything of it arrived: that's its answer.
    if (first && 'error' in first) throw first.error
    this.#until(
      whole.then(
        (saved) => this.#end(copy, undefined, { saved, note }),
        (error: unknown) => this.#end(copy, error, {}),
      ),
    )
    return { ok: true, data: first as FileCopyBegun }
  }

  async #upload(
    copy: Copy,
    kc: KubeConfig,
    at: ContainerPath,
    sending: Sending,
  ): Promise<FileCopyResult<FileCopyBegun>> {
    const r = copy.request
    const idle = this.#idle(copy)
    const progress = this.#progress(copy)
    const input = new PassThrough()
    const run = await this.#exec(kc, r, uploadCommand(at), input, null)
    const { socket } = run
    const pack = tar()
    let exit: Exit | undefined
    void run.exit.then((ended) => {
      exit = ended
      pack.destroy()
    })
    void copy.halting.then(() => pack.destroy())
    idle.touch()

    /** The archive, sent no faster than the connection takes it. */
    const send = async (chunk: Buffer) => {
      input.write(chunk)
      idle.touch()
      while (socket.bufferedAmount > WAITING_MAX && !exit && !copy.halted) await delay(5)
    }
    let complete = false
    const feed = async () => {
      let sent = 0
      for await (const chunk of pack as AsyncIterable<Buffer>) {
        sent += chunk.length
        await send(chunk)
      }
      // tar waits for a whole record before it reads the archive's end in it.
      if (sent % RECORD) await send(Buffer.alloc(RECORD - (sent % RECORD)))
      // Where the connection can say so, tar is told there's no more; elsewhere the end is enough.
      if (socket.protocol === 'v5.channel.k8s.io') input.end()
      complete = true
    }
    const fill = async () => {
      let entries = 0
      for await (const sent of sending.entries()) {
        entries += 1
        if (
          entries > FILE_COPY_MAX_ENTRIES ||
          sent.names.length === 0 ||
          !sent.names.every(named)
        ) {
          throw invalid('What was picked can’t be sent: a name in it isn’t a file’s or a folder’s')
        }
        const name = sent.names.join('/')
        if (sent.folder) {
          await put(pack, { name: `${name}/`, type: 'directory', mode: sent.mode & 0o777 })
          continue
        }
        if (copy.bytes + sent.size > this.limits.maxBytes) throw this.#tooLarge()
        const from = await sent.open()
        try {
          await put(
            pack,
            {
              name,
              type: 'file',
              size: sent.size,
              mode: sent.mode & 0o777,
              ...(sent.mtime ? { mtime: sent.mtime } : {}),
            },
            async (sink) => {
              let left = sent.size
              for await (const chunk of from as AsyncIterable<Buffer>) {
                // No more than it was said to hold, if it grew since.
                const part = chunk.length > left ? chunk.subarray(0, left) : chunk
                left -= part.length
                copy.bytes += part.length
                progress()
                if (part.length > 0 && !sink.write(part)) await once(sink, 'drain')
                if (left === 0) break
              }
              if (left > 0) {
                throw new KubeRequestError(
                  'invalid',
                  `${name} changed while it was read, so the copy was stopped. Some of it may be there already.`,
                )
              }
            },
          )
        } finally {
          from.destroy()
        }
        copy.files += 1
      }
      pack.finalize()
    }

    const whole = (async () => {
      try {
        await Promise.all([feed(), fill()]).catch((error: unknown) => {
          // tar ending early (nowhere to write) is what stopped it: that's what's said.
          if (!exit || copy.halted) throw error
        })
        if (copy.halted) throw copy.halted
        const ended = await Promise.race([run.exit, copy.halting.then(() => undefined)])
        if (!ended) throw copy.halted!
        const failure = this.#tarFailure(copy, ended, run.said())
        if (failure) throw failure
        if (!complete) {
          throw new KubeRequestError(
            'invalid',
            `tar in ${r.container} ended before everything was sent. Some of it may be there already.`,
          )
        }
        return undefined
      } catch (error) {
        socket.close()
        pack.destroy()
        throw error
      } finally {
        idle.stop()
        sending.close()
      }
    })()
    this.#until(
      whole.then(
        () => this.#end(copy, undefined, {}),
        (error: unknown) => this.#end(copy, error, {}),
      ),
    )
    return { ok: true, data: sending.url ? { url: sending.url } : {} }
  }

  #end(copy: Copy, error: unknown, { saved, note }: { saved?: string; note?: string }) {
    this.#copies.delete(copy.id)
    const { turnedDown, ...how } = ending(error)
    this.#record(copy, { ...how, turnedDown }, note)
    const left = copy.leftOut
    this.emit.end(copy.id, {
      ...this.#so(copy),
      ...how,
      ...(left.links || left.special || left.unnamed ? { leftOut: left } : {}),
      ...(saved ? { saved } : {}),
      ...(note ? { note } : {}),
    })
  }

  /** One entry in the audit log for a copy, however it ended: never what was in it. */
  #record(copy: Copy, { outcome, error, turnedDown }: Ending, note?: string) {
    // The path is whatever was given as one: recorded so that it can't pass for anything else.
    const r = { ...copy.request, path: printable(copy.request.path) }
    const down = copy.direction === 'download'
    const done = outcome === 'done'
    const where = `Pod ${r.pod} (${r.container})`
    const what = down
      ? `${done ? 'Downloaded' : 'Download'} ${r.path} from ${where}`
      : `${done ? 'Uploaded' : 'Upload'} ${copy.name ?? 'files'} to ${r.path} in ${where}`
    const left = leftOutText(copy.leftOut)
    this.deps.audit.record({
      action: down ? 'files.download' : 'files.upload',
      outcome:
        outcome === 'done'
          ? 'success'
          : outcome === 'cancelled'
            ? 'cancelled'
            : turnedDown || isRefusal(error!.code)
              ? 'refused'
              : 'failure',
      ...(error ? { error: error.message } : {}),
      cluster: r.context,
      target: { kind: 'Pod', name: r.pod, namespace: r.namespace },
      summary: done
        ? `${what}: ${copy.files} ${copy.files === 1 ? 'file' : 'files'}, ${sized(copy.bytes)}`
        : what,
      command: down ? downloadKubectl(r) : uploadKubectl(r, copy.name ?? '<what was picked>'),
      details: {
        container: r.container,
        path: r.path,
        direction: copy.direction,
        bytes: copy.bytes,
        files: copy.files,
        seconds: Math.round((Date.now() - copy.since) / 1000),
        ...(left ? { leftOut: left } : {}),
        ...(note ? { note } : {}),
      },
    })
  }
}

/** A name a file or a folder can have in an archive: one name, and not one that leads elsewhere. */
const named = (name: string) =>
  name !== '' && name !== '.' && name !== '..' && name.length <= 255 && !/[/\0]/.test(name)

/** One entry put in an archive: resolves once it's in, contents and all. */
async function put(
  pack: Pack,
  header: Parameters<Pack['entry']>[0],
  write?: (sink: ReturnType<Pack['entry']>) => Promise<void>,
): Promise<void> {
  let sink!: ReturnType<Pack['entry']>
  const packed = new Promise<void>((resolve, reject) => {
    sink = pack.entry(header, (error) => (error ? reject(error) : resolve()))
  })
  sink.on('error', () => undefined)
  // Its own failure is what's thrown; the entry's, that it never finished, isn't a second one.
  packed.catch(() => undefined)
  if (write) await write(sink)
  sink.end(undefined)
  await packed
}

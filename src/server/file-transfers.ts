/**
 * Files copied out of and into containers, on a server: a download is the browser's own,
 * streamed as it's read from the container, and an upload is one request's body, streamed into
 * it. Nothing of either is kept on the server's disk.
 *
 * A page asks for a copy over its connection, where who it is and what they may do are already
 * known; what it gets back is an address that works once, soon, and only for the same person.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable, Writable } from 'node:stream'
import { pack as tar, type Pack } from 'tar-stream'
import type { Arriving, FilesHost, SavedFile, Saving, Sending, Sent } from '@backend/kube/files'
import { KubeRequestError } from '@backend/kube/errors'
import { invalid } from '@backend/kube/validate'
import { FILE_COPY_MAX_ENTRIES, type FileDownloadRequest } from '@shared/files'
import { PATHS } from '@shared/server'
import { SECURITY_HEADERS, sendJson } from './http'

/** How long a page has to fetch what it asked for, or to start sending it. */
const CLAIM_MS = 30_000
/** How many picks a page's connection holds at once. */
const PICKS_KEPT = 8
/** How deep a folder that's uploaded goes. */
const MAX_DEPTH = 64

interface Offer {
  user: string
  method: 'GET' | 'POST'
  claim(req: IncomingMessage, res: ServerResponse): void
  timer: NodeJS.Timeout
}

/** The server's copies waiting for their page's request: each address works once, for its person. */
export class Transfers {
  readonly #offers = new Map<string, Offer>()

  constructor(private readonly claimMs = CLAIM_MS) {}

  /** An address for one request of `user`'s; `expired` if it never comes. */
  offer(
    user: string,
    method: Offer['method'],
    claim: Offer['claim'],
    expired: () => void,
  ): { url: string; withdraw(): void } {
    const token = randomBytes(32).toString('base64url')
    const timer = setTimeout(() => {
      this.#offers.delete(token)
      expired()
    }, this.claimMs)
    this.#offers.set(token, { user, method, claim, timer })
    return {
      url: `${PATHS.files}/${token}`,
      withdraw: () => {
        clearTimeout(timer)
        this.#offers.delete(token)
      },
    }
  }

  /**
   * Answers a request for a copy; false if the path isn't one's. Whatever is wrong with it (no
   * such copy, fetched already, someone else's, another site's page asking), it's told the same.
   */
  answer(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    caller: () => string | undefined,
    ownPage: () => boolean,
  ): boolean {
    if (!path.startsWith(`${PATHS.files}/`)) return false
    const token = path.slice(PATHS.files.length + 1)
    const offer = this.#offers.get(token)
    if (
      !offer ||
      offer.method !== req.method ||
      caller() !== offer.user ||
      (offer.method === 'POST' && !ownPage())
    ) {
      sendJson(res, 404, {
        error: 'There’s no such copy here: it was fetched already, or took too long. Try again.',
      })
      return true
    }
    clearTimeout(offer.timer)
    this.#offers.delete(token)
    offer.claim(req, res)
    return true
  }
}

/** A file name as a download's header gives it: plainly, and in full for browsers that read that. */
function disposition(name: string): string {
  const plain = name.replace(/[^\w.-]/g, '_')
  // RFC 5987's attr-char leaves out four that encodeURIComponent lets through.
  const full = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="${plain}"; filename*=UTF-8''${full}`
}

const downloadHeaders = (name: string, type: string) => ({
  ...SECURITY_HEADERS,
  'Content-Type': type,
  'Content-Disposition': disposition(name),
  'Cache-Control': 'no-store',
})

/** One file of an archive that's being written, as something to write its contents to. */
class Packed extends Writable {
  readonly #sink: ReturnType<Pack['entry']>
  readonly #done: Promise<void>

  constructor(pack: Pack, header: Parameters<Pack['entry']>[0]) {
    super()
    let sink!: ReturnType<Pack['entry']>
    this.#done = new Promise<void>((resolve, reject) => {
      sink = pack.entry(header, (error) => (error ? reject(error) : resolve()))
    })
    sink.on('error', () => undefined)
    // Said to whoever ends it, below.
    this.#done.catch(() => undefined)
    this.#sink = sink
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    if (this.#sink.write(chunk)) done()
    else this.#sink.once('drain', done)
  }

  override _final(done: (error?: Error) => void) {
    this.#sink.end(undefined)
    this.#done.then(() => done(), done)
  }
}

/**
 * A file's contents on their way to the browser, but for the last byte: a browser that has
 * every byte it was told of has the file, whatever comes after. So the last is kept back until
 * the copy is known to be whole.
 */
class Held extends Writable {
  #last: Buffer = Buffer.alloc(0)

  constructor(private readonly res: ServerResponse) {
    super()
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    const all = Buffer.concat([this.#last, chunk])
    this.#last = all.subarray(all.length - 1)
    if (all.length === 1 || this.res.write(all.subarray(0, all.length - 1))) done()
    else this.res.once('drain', done)
  }

  /** The last byte, and the end. */
  async release(): Promise<void> {
    this.res.end(this.#last)
    await once(this.res, 'finish')
  }
}

/** One file, as the browser's download of it. */
function fileSaving(res: ServerResponse, arriving: Arriving): Saving {
  res.writeHead(200, {
    ...downloadHeaders(arriving.name, 'application/octet-stream'),
    'Content-Length': String(arriving.size),
  })
  const held = new Held(res)
  return {
    folder: () => Promise.resolve(),
    file: () => Promise.resolve(held),
    done: async () => {
      await held.release()
      return undefined
    },
    // Cut off short of the length it was told: the browser says it failed, and keeps nothing.
    discard: () => {
      res.destroy()
      return Promise.resolve()
    },
  }
}

/**
 * A folder, as the browser's download of an archive of it: made here, of what was kept (files
 * and folders, with their permission bits and nobody's ownership), not the container's own.
 */
function folderSaving(res: ServerResponse, arriving: Arriving): Saving {
  res.writeHead(200, downloadHeaders(`${arriving.name}.tar`, 'application/x-tar'))
  const pack = tar()
  const sent = (async () => {
    for await (const chunk of pack as AsyncIterable<Buffer>) {
      if (!res.write(chunk)) await once(res, 'drain')
    }
    res.end()
    await once(res, 'finish')
  })()
  // Said by whatever stops it, which discards it.
  sent.catch(() => undefined)
  const under = (names: string[]) => [arriving.name, ...names].join('/')
  pack.entry({ name: `${arriving.name}/`, type: 'directory', mode: 0o755 })
  return {
    folder: (names) => {
      pack.entry({ name: `${under(names)}/`, type: 'directory', mode: 0o755 })
      return Promise.resolve()
    },
    file: (names, file: SavedFile) =>
      Promise.resolve(
        new Packed(pack, {
          name: under(names),
          type: 'file',
          size: file.size,
          mode: file.mode,
          mtime: file.mtime,
        }),
      ),
    done: async () => {
      pack.finalize()
      await sent
      return undefined
    },
    // An archive without its end: the browser says it failed, and what unpacks it would too.
    discard: () => {
      pack.destroy()
      res.destroy()
      return Promise.resolve()
    },
  }
}

interface Manifest {
  name: string
  files: number
  bytes: number
  entries: { names: string[]; folder: boolean; size: number }[]
}

/** A name a file or a folder can have: one name, and not one that leads elsewhere. */
const named = (name: unknown): name is string =>
  typeof name === 'string' &&
  name !== '' &&
  name !== '.' &&
  name !== '..' &&
  name.length <= 255 &&
  !/[/\0]/.test(name)

/** What a page says it will send, checked: it's the page's word, so none of it is taken as given. */
function manifest(input: unknown): Manifest {
  const { name, entries } = Object(input) as { name?: unknown; entries?: unknown }
  if (!named(name) || !Array.isArray(entries) || entries.length === 0) {
    throw invalid('What’s uploaded has a name, and at least one file or folder')
  }
  if (entries.length > FILE_COPY_MAX_ENTRIES) {
    throw invalid(
      `That’s more than the ${FILE_COPY_MAX_ENTRIES} files and folders one copy carries`,
    )
  }
  let files = 0
  let bytes = 0
  const checked = entries.map((entry: unknown) => {
    const { names, folder, size } = Object(entry) as Record<string, unknown>
    if (
      !Array.isArray(names) ||
      names.length === 0 ||
      names.length > MAX_DEPTH ||
      !names.every(named) ||
      names[0] !== name ||
      typeof folder !== 'boolean' ||
      !Number.isSafeInteger(size) ||
      (size as number) < 0 ||
      (folder && size !== 0)
    ) {
      throw invalid('Each file or folder uploaded has its names from the top, and its size')
    }
    if (!folder) files += 1
    bytes += size as number
    return { names: names as string[], folder, size: size as number }
  })
  return { name, files, bytes, entries: checked }
}

/** What one page's person copies: saved by their browser, sent from it. */
export class PageFiles implements FilesHost {
  /**
   * Nothing is written here; but a folder's archive is unpacked wherever its person likes, so
   * a name is left out that could lead elsewhere there (`shared/files`'s `nameable`).
   */
  readonly platform = 'browser'
  /** What pages said they'd send, as they said it: checked when a copy takes it. */
  readonly #picked = new Map<string, unknown>()
  /** Stops a copy whose browser went away; set once there's something that copies. */
  cancel: (id: string) => void = () => undefined

  constructor(
    private readonly transfers: Transfers,
    private readonly user: string,
  ) {}

  /**
   * Keeps what a page says it will upload, for the copy that follows: its handle. Whether
   * its person may upload at all is asked first, so it's checked only once a copy takes it.
   */
  picked(input: unknown): string {
    const handle = randomUUID()
    this.#picked.set(handle, input)
    while (this.#picked.size > PICKS_KEPT) this.#picked.delete(this.#picked.keys().next().value!)
    return handle
  }

  /** Lets go of what was picked, if no copy took it. */
  forget(handle: string): void {
    this.#picked.delete(handle)
  }

  save(
    id: string,
    _request: FileDownloadRequest,
    arriving: Arriving,
  ): { url: string; saving: Promise<Saving | null>; withdraw(): void } {
    let chosen!: (saving: Saving | null) => void
    let never!: (error: Error) => void
    const saving = new Promise<Saving | null>((resolve, reject) => {
      chosen = resolve
      never = reject
    })
    const { url, withdraw } = this.transfers.offer(
      this.user,
      'GET',
      (_req, res) => {
        // The browser stopped it, or went away: so does the copy.
        res.on('close', () => {
          if (!res.writableFinished) this.cancel(id)
        })
        chosen(arriving.folder ? folderSaving(res, arriving) : fileSaving(res, arriving))
      },
      () =>
        never(
          new KubeRequestError(
            'timeout',
            'The browser didn’t fetch it in time, so the copy was stopped. Try again. (Where Lumovi runs as several replicas, a browser’s requests must stay with one.)',
          ),
        ),
    )
    return {
      url,
      saving,
      // Not fetched yet, and never to be: the address is no copy's from here on.
      withdraw: () => {
        withdraw()
        chosen(null)
      },
    }
  }

  sending(_id: string, source: string): Sending | undefined {
    if (!this.#picked.has(source)) return undefined
    const said = this.#picked.get(source)
    this.#picked.delete(source)
    const picked = manifest(said)
    let arrived!: (req: IncomingMessage) => void
    let never!: (error: Error) => void
    const body = new Promise<IncomingMessage>((resolve, reject) => {
      arrived = resolve
      never = reject
    })
    // Said to whoever waits for it, if anyone does.
    body.catch(() => undefined)
    let claimed: { req: IncomingMessage; res: ServerResponse } | undefined
    let read = 0
    const { url, withdraw } = this.transfers.offer(
      this.user,
      'POST',
      (req, res) => {
        if (Number(req.headers['content-length']) !== picked.bytes) {
          sendJson(res, 400, { error: 'That isn’t the size of what was picked.' })
          never(new KubeRequestError('invalid', 'What the page sent isn’t what it said it would.'))
          return
        }
        claimed = { req, res }
        arrived(req)
      },
      () =>
        never(
          new KubeRequestError(
            'timeout',
            'The page didn’t send what it picked in time, so the copy was stopped. Try again. (Where Lumovi runs as several replicas, a browser’s requests must stay with one.)',
          ),
        ),
    )
    let reader: AsyncIterator<Buffer> | undefined
    let rest: Buffer = Buffer.alloc(0)
    /** The next `size` bytes of the request's body: one file's. */
    async function* contents(size: number): AsyncGenerator<Buffer> {
      let left = size
      while (left > 0) {
        if (rest.length === 0) {
          reader ??= (await body)[Symbol.asyncIterator]() as AsyncIterator<Buffer>
          const next = await reader.next()
          if (next.done) return
          rest = next.value
        }
        const part = rest.subarray(0, left)
        rest = rest.subarray(part.length)
        left -= part.length
        read += part.length
        yield part
      }
    }
    return {
      name: picked.name,
      files: picked.files,
      bytes: picked.bytes,
      // Nothing to send where there's nothing in the files: the page doesn't either.
      ...(picked.bytes > 0 ? { url } : {}),
      async *entries(): AsyncGenerator<Sent> {
        for (const entry of picked.entries) {
          yield {
            ...entry,
            mode: entry.folder ? 0o755 : 0o644,
            open: () => Promise.resolve(Readable.from(contents(entry.size))),
          }
        }
      },
      close: () => {
        withdraw()
        if (!claimed || claimed.res.headersSent) return
        const { req, res } = claimed
        if (read === picked.bytes) {
          res.writeHead(204, SECURITY_HEADERS).end()
        } else {
          // What's left of it isn't wanted: the page hears how the copy ended on its connection.
          res.on('finish', () => req.destroy())
          sendJson(
            res,
            409,
            { error: 'The copy stopped before all of it was sent.' },
            { Connection: 'close' },
          )
        }
      },
    }
  }
}

/**
 * The sponsor card's content, from Lumovi/main-sponsor on GitHub: its sponsor.json and the
 * pictures it names, read now and then, checked (rules.ts), and handed to the page as data: URLs
 * of Lumovi's own copy, so the page fetches nothing. The desktop app's main process reads it, and
 * the server for its pages. Nothing is sent but the requests, and nothing is counted.
 *
 * Whatever can't be read, or doesn't pass, gives Lumovi's own card: never an error, an empty or
 * broken card, or a wait. A read that fails on the way (no network, GitHub busy) keeps what was
 * read last; one that gets an answer (nothing there, or something wrong) is the answer.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LUMOVI_CARD, type SponsorCard, type SponsorPicture } from '@shared/sponsor'
import { checkFile, checkPicture, endOf, LIMITS, type Picture, type SponsorFile } from './rules'

/** Lumovi/main-sponsor's main branch, as GitHub serves its files. */
export const SPONSOR_REPO = 'https://raw.githubusercontent.com/Lumovi/main-sponsor/main/'

/** How often it's read again, while Lumovi runs: a change shows within this. */
export const SPONSOR_EVERY_MS = 60 * 60_000

/** How long a read may take: past that, it's tried again. */
const TIMEOUT_MS = 20_000

/** How soon a read that got no answer (offline, say) is tried again. */
const RETRY_MS = 5 * 60_000

/** The longest a timer waits in one go (Node's limit, about 24 days). */
const LONGEST_WAIT_MS = 2 ** 31 - 1

/**
 * Whether this is a test build (`npm run build:coverage`, which nothing ships): a release build
 * is built with it false, which leaves the stand-ins below out of it.
 */
declare const LUMOVI_TEST_BUILD: boolean

/** The quickest a test build reads it again, however often it's asked to. */
const QUICKEST_MS = 1_000

/**
 * Where the card is read from, and how often: Lumovi/main-sponsor, every hour. Or, in a test build
 * only, a stand-in on this computer that LUMOVI_SPONSOR_URL gives, as often as
 * LUMOVI_SPONSOR_REFRESH_MS says. Never anywhere else, and never an off switch.
 */
export function sponsorSource(env: NodeJS.ProcessEnv): { base: string; everyMs: number } {
  const given = LUMOVI_TEST_BUILD ? URL.parse(env.LUMOVI_SPONSOR_URL ?? '') : null
  const local =
    given !== null &&
    (given.protocol === 'http:' || given.protocol === 'https:') &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(given.hostname)
  return local
    ? {
        base: new URL('./', given).href,
        everyMs: Math.max(QUICKEST_MS, Number(env.LUMOVI_SPONSOR_REFRESH_MS) || SPONSOR_EVERY_MS),
      }
    : { base: SPONSOR_REPO, everyMs: SPONSOR_EVERY_MS }
}

export interface SponsorOptions {
  /** Where sponsor.json and its pictures are. */
  base: string
  /** Where what was read last is kept for the next start (the desktop app's); otherwise memory. */
  dir?: string
  /** Waited for before the first read (the desktop app's proxy and certificate authorities). */
  ready?: Promise<unknown>
  /** When it's first read, and how often after. */
  firstMs: number
  everyMs: number
}

/** A picture as read, with the ETag to ask GitHub whether it changed. */
interface Read {
  bytes: Uint8Array
  picture: Picture
  etag?: string
}

/** What a read got: the file, the same as before (304), a wrong answer, or no answer. */
type Got = { bytes: Uint8Array; etag?: string } | 'same' | 'wrong' | 'unreachable'

export class SponsorSource {
  /** sponsor.json as read last, and what it says; neither when it's missing or wrong. */
  #text?: string
  #file?: SponsorFile
  /** Its pictures, by name: only those that passed. */
  readonly #pictures = new Map<string, Read>()
  #card: SponsorCard = { mode: 'lumovi', link: LUMOVI_CARD.link }
  readonly #listeners = new Set<(card: SponsorCard) => void>()
  readonly #loaded: Promise<void>
  #reading?: Promise<boolean>
  #timer?: NodeJS.Timeout
  /** When a sponsor's `until` ends. */
  #expiry?: NodeJS.Timeout
  #stopped = false
  /** What was kept last, so the same isn't written again. */
  #kept?: string

  constructor(private readonly options: SponsorOptions) {
    this.#loaded = this.#load()
  }

  /** The card the page shows now (once what was kept from last time is read). */
  async card(): Promise<SponsorCard> {
    await this.#loaded
    return this.#card
  }

  /** Called when the card changes; returns a function that stops it. */
  onChange(listener: (card: SponsorCard) => void): () => void {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  /** Reads it soon, then every so often (sooner after a read that got no answer). */
  start(): void {
    const { ready, firstMs, everyMs } = this.options
    const next = (ms: number) => {
      if (this.#stopped) return
      this.#timer = setTimeout(
        () =>
          void this.refresh()
            // (Whatever goes wrong, it's read again: a read that threw got no answer.)
            .catch(() => false)
            .then((answered) => next(answered ? everyMs : Math.min(everyMs, RETRY_MS))),
        ms,
      )
      // It never keeps Lumovi running.
      this.#timer.unref()
    }
    void Promise.all([ready, this.#loaded]).then(() => next(firstMs))
  }

  stop(): void {
    this.#stopped = true
    clearTimeout(this.#timer)
    clearTimeout(this.#expiry)
  }

  /**
   * Reads sponsor.json and its pictures again (once at a time); whether everything answered.
   */
  refresh(): Promise<boolean> {
    this.#reading ??= this.#read().finally(() => (this.#reading = undefined))
    return this.#reading
  }

  async #read(): Promise<boolean> {
    // (Not asked whether it changed: its pictures are, each time.)
    const got = await this.#get('sponsor.json', LIMITS.fileBytes)
    if (got === 'unreachable' || got === 'same') return false
    const text = got === 'wrong' ? undefined : new TextDecoder().decode(got.bytes)
    const checked = text === undefined ? undefined : checkFile(text)
    const file = checked?.ok ? checked.value : undefined
    const names =
      file?.mode === 'sponsor' ? new Set(Object.values(file.sponsor!.image)) : new Set<string>()
    const answered = await Promise.all([...names].map((name) => this.#readPicture(name)))
    for (const name of this.#pictures.keys()) if (!names.has(name)) this.#pictures.delete(name)
    this.#text = file && text
    this.#file = file
    this.#update()
    await this.#keep()
    return answered.every(Boolean)
  }

  /** Reads a picture again; whether it answered. */
  async #readPicture(name: string): Promise<boolean> {
    const known = this.#pictures.get(name)
    const got = await this.#get(name, LIMITS.animatedBytes, known?.etag)
    // Unchanged, or not read this time: what was read last stays.
    if (got === 'same') return true
    if (got === 'unreachable') return false
    const checked = got === 'wrong' ? undefined : checkPicture(got.bytes)
    if (got !== 'wrong' && checked?.ok) {
      this.#pictures.set(name, { bytes: got.bytes, picture: checked.value, etag: got.etag })
    } else {
      this.#pictures.delete(name)
    }
    return true
  }

  /**
   * A file next to sponsor.json, as GitHub has it: up to `max` bytes, without following a
   * redirect, and with nothing in the request but its address (and the ETag Lumovi has).
   */
  async #get(name: string, max: number, etag?: string): Promise<Got> {
    try {
      const response = await fetch(new URL(name, this.options.base), {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
        ...(etag ? { headers: { 'if-none-match': etag } } : {}),
      })
      if (response.status === 304) return 'same'
      if (response.status === 404 || response.status === 410) return 'wrong'
      if (!response.ok) {
        await response.body?.cancel()
        return 'unreachable'
      }
      const bytes = await upTo(response, max)
      if (!bytes) return 'wrong'
      const given = response.headers.get('etag')
      return { bytes, ...(isEtag(given) ? { etag: given } : {}) }
    } catch {
      return 'unreachable'
    }
  }

  /** Works the card out from what was read, and tells listeners if it changed. */
  #update(): void {
    clearTimeout(this.#expiry)
    const card = this.#compute()
    if (JSON.stringify(card) !== JSON.stringify(this.#card)) {
      this.#card = card
      for (const listener of this.#listeners) listener(card)
    }
    // A sponsor's card ends with its last day: looked at again then.
    const until = this.#file?.mode === 'sponsor' ? this.#file.sponsor!.until : undefined
    const left = until === undefined ? 0 : endOf(until) - Date.now()
    if (left > 0) {
      this.#expiry = setTimeout(() => this.#update(), Math.min(left, LONGEST_WAIT_MS))
      this.#expiry.unref()
    }
  }

  #compute(): SponsorCard {
    const file = this.#file
    const link = file?.lumovi?.link ?? LUMOVI_CARD.link
    const lumovi: SponsorCard = { mode: 'lumovi', link }
    if (!file || file.mode === 'lumovi') return lumovi
    if (file.mode === 'none') return { mode: 'none' }
    const sponsor = file.sponsor!
    if (sponsor.until !== undefined && Date.now() >= endOf(sponsor.until)) return lumovi
    const light = this.#pictures.get(sponsor.image.light)
    const dark = this.#pictures.get(sponsor.image.dark)
    if (!light || !dark) return lumovi
    return {
      mode: 'sponsor',
      name: sponsor.name,
      line: sponsor.description,
      alt: sponsor.alt,
      link: sponsor.link,
      picture: { light: shown(light), dark: shown(dark) },
      lumovi: link,
    }
  }

  /** What was read last, for the next start: in one file, replaced whole. */
  async #keep(): Promise<void> {
    const { dir } = this.options
    if (!dir) return
    const kept: Kept = {
      text: this.#text ?? null,
      pictures: Object.fromEntries(
        [...this.#pictures].map(([name, read]) => [
          name,
          { data: Buffer.from(read.bytes).toString('base64'), etag: read.etag ?? null },
        ]),
      ),
    }
    const json = JSON.stringify(kept)
    if (json === this.#kept) return
    try {
      await mkdir(dir, { recursive: true })
      const file = join(dir, KEPT)
      await writeFile(`${file}.new`, json)
      await rename(`${file}.new`, file)
      this.#kept = json
    } catch {
      // Read again next time.
    }
  }

  /** What was kept last time, checked again as if just read: anything wrong in it is dropped. */
  async #load(): Promise<void> {
    const { dir } = this.options
    if (!dir) return
    try {
      const raw = await readFile(join(dir, KEPT), 'utf8')
      const kept = JSON.parse(raw) as Kept
      const checked = typeof kept.text === 'string' ? checkFile(kept.text) : undefined
      if (!checked?.ok) return
      for (const [name, { data, etag }] of Object.entries(kept.pictures)) {
        const bytes = new Uint8Array(Buffer.from(data, 'base64'))
        const picture = checkPicture(bytes)
        if (picture.ok) {
          this.#pictures.set(name, {
            bytes,
            picture: picture.value,
            ...(isEtag(etag) ? { etag } : {}),
          })
        }
      }
      this.#text = kept.text!
      this.#file = checked.value
      this.#kept = raw
      this.#update()
    } catch {
      // Nothing kept yet, or nothing usable: Lumovi's own card until the first read.
    }
  }
}

/** An ETag as HTTP has it (`"…"`, or weak, `W/"…"`), and not long: anything else isn't sent back. */
const isEtag = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 200 && /^(W\/)?"[\x21\x23-\x7e]*"$/.test(value)

/** The file it's kept in, in the desktop app's folder. */
const KEPT = 'kept.json'

interface Kept {
  text: string | null
  pictures: Record<string, { data: string; etag: string | null }>
}

/** A picture as the page shows it: Lumovi's copy, as data: URLs. */
function shown({ bytes, picture }: Read): SponsorPicture {
  const url = (data: Uint8Array) =>
    `data:${picture.type};base64,${Buffer.from(data).toString('base64')}`
  return { src: url(bytes), ...(picture.still ? { still: url(picture.still) } : {}) }
}

/** A response's body, unless it's longer than `max` bytes (then it's not read on). */
async function upTo(response: Response, max: number): Promise<Uint8Array | undefined> {
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel()
    return undefined
  }
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const chunk of response.body ?? []) {
    length += chunk.length
    if (length > max) return undefined
    chunks.push(chunk)
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.length
  }
  return body
}

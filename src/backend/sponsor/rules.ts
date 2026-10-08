/**
 * What Lumovi/main-sponsor's sponsor.json may say, and the pictures it may show: the rules the
 * app checks what it reads against, and the repository checks every change against.
 *
 * It stands alone (no imports, and only TypeScript that Node strips), so the same file runs in
 * both: the original is Lumovi/Lumovi's src/backend/sponsor/rules.ts, and Lumovi/main-sponsor
 * has a copy that its check (`node check.ts`) runs on every change. Change the original, then
 * copy it over.
 */

/** The limits, as the repository's README gives them to sponsors. */
export const LIMITS = {
  /** sponsor.json itself, in bytes. */
  fileBytes: 16 * 1024,
  /** Each picture: twice the card's 204 × 68, exactly. */
  width: 408,
  height: 136,
  stillBytes: 150 * 1024,
  animatedBytes: 500 * 1024,
  /** An animated picture's frames, all together. */
  animatedMs: 5_000,
  /** The words, in characters. */
  text: { name: 40, description: 32, alt: 100, link: 200 },
} as const

export type SponsorMode = 'none' | 'lumovi' | 'sponsor'

export interface SponsorFile {
  version: 1
  /** Nothing, Lumovi's own card, or the sponsor's. */
  mode: SponsorMode
  /** Where Lumovi's own card leads, when not to the app's built-in link. */
  lumovi?: { link: string }
  sponsor?: SponsorEntry
}

export interface SponsorEntry {
  name: string
  /** The line under the picture. */
  description: string
  link: string
  /** What the picture says, for screen readers. */
  alt: string
  /** The pictures' file names, next to sponsor.json: one for each mode. */
  image: { light: string; dark: string }
  /** The last day the card shows (UTC), as YYYY-MM-DD. */
  until?: string
}

export type Checked<T> = { ok: true; value: T } | { ok: false; why: string }

const fail = (why: string): { ok: false; why: string } => ({ ok: false, why })

/** Only these keys, each where it belongs: a misspelt one isn't quietly ignored. */
function onlyKeys(value: object, where: string, keys: string[]): string | undefined {
  const extra = Object.keys(value).find((key) => !keys.includes(key))
  return extra === undefined
    ? undefined
    : `${where} has “${extra}”, which isn’t one of ${keys.join(', ')}`
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Plain text: one line, no emoji, links, control or invisible characters (which could reorder
 * or hide what's shown), and no spaces around it.
 */
function checkText(value: unknown, field: string, max: number): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return `${field} must be some text`
  if (value !== value.trim()) return `${field} has spaces around it`
  if ([...value].length > max) return `${field} is longer than ${max} characters`
  // Control and format characters (bidi marks, zero-width ones), line and paragraph separators,
  // private use and lone surrogates; and what shows as nothing (variation selectors, the combining
  // grapheme joiner, Hangul fillers, the blank Braille pattern).
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Default_Ignorable_Code_Point}\u2800]/u.test(value)) {
    return `${field} has a line break, or a control or invisible character`
  }
  // A letter takes a mark or two (é, ệ); a pile of them spills over the lines around it.
  if (/\p{M}{3}/u.test(value)) return `${field} has more than two marks on a letter`
  if (/\p{Emoji_Presentation}/u.test(value)) return `${field} has an emoji`
  if (/[a-z][a-z0-9+.-]*:\/\/|\bwww\./i.test(value)) return `${field} has a link`
  return undefined
}

/**
 * An https link to a named host, without a user or password in it (which could make it look like
 * somewhere else), as the URL standard writes it.
 */
export function checkLink(value: unknown, field: string): Checked<string> {
  if (typeof value !== 'string') return fail(`${field} must be a link`)
  if ([...value].length > LIMITS.text.link) {
    return fail(`${field} is longer than ${LIMITS.text.link} characters`)
  }
  // The URL parser drops tabs and line breaks, so a link with them isn't what it seems.
  if (/[\s\p{Cc}\p{Cf}]/u.test(value)) return fail(`${field} has spaces or invisible characters`)
  const url = URL.parse(value)
  if (!url) return fail(`${field} isn’t a link`)
  if (url.protocol !== 'https:') return fail(`${field} must start with https://`)
  if (url.username || url.password) return fail(`${field} has a user or password in it`)
  const host = url.hostname
  if (host.startsWith('[') || /^[\d.]+$/.test(host) || !host.includes('.') || host.endsWith('.')) {
    return fail(`${field} must lead to a domain, not an address`)
  }
  return { ok: true, value: url.href }
}

/** A day, YYYY-MM-DD, that's on the calendar. */
function checkDay(value: unknown, field: string): string | undefined {
  const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null
  if (!match) return `${field} must be a day, as YYYY-MM-DD`
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return `${field} isn’t a day on the calendar`
  }
  return undefined
}

/** When the card stops showing: the end of its `until` day, UTC. */
export function endOf(until: string): number {
  const [year, month, day] = until.split('-').map(Number) as [number, number, number]
  return Date.UTC(year, month - 1, day + 1)
}

/** A file next to sponsor.json: a plain name, with nothing that could lead anywhere else. */
function checkName(value: unknown, field: string): string | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) {
    return `${field} must be a file next to sponsor.json: letters, digits, “.”, “_” and “-”`
  }
  if (value.includes('..')) return `${field} has “..” in it`
  return undefined
}

/** What sponsor.json says, if it's all as the README describes. */
export function checkFile(text: string): Checked<SponsorFile> {
  if (new TextEncoder().encode(text).length > LIMITS.fileBytes) {
    return fail(`sponsor.json is larger than ${LIMITS.fileBytes / 1024} KB`)
  }
  let file: unknown
  try {
    file = JSON.parse(text)
  } catch {
    return fail('sponsor.json isn’t JSON')
  }
  if (!isObject(file)) return fail('sponsor.json must be an object')
  const extra = onlyKeys(file, 'sponsor.json', ['version', 'mode', 'lumovi', 'sponsor'])
  if (extra) return fail(extra)
  if (file.version !== 1) return fail('version must be 1')
  const { mode } = file
  if (mode !== 'none' && mode !== 'lumovi' && mode !== 'sponsor') {
    return fail('mode must be "none", "lumovi" or "sponsor"')
  }
  const checked: SponsorFile = { version: 1, mode }
  if (file.lumovi !== undefined) {
    if (!isObject(file.lumovi)) return fail('lumovi must be an object')
    const extra = onlyKeys(file.lumovi, 'lumovi', ['link'])
    if (extra) return fail(extra)
    const link = checkLink(file.lumovi.link, 'lumovi.link')
    if (!link.ok) return link
    checked.lumovi = { link: link.value }
  }
  if (file.sponsor !== undefined) {
    const sponsor = checkSponsor(file.sponsor)
    if (!sponsor.ok) return sponsor
    checked.sponsor = sponsor.value
  } else if (mode === 'sponsor') {
    return fail('mode is "sponsor", but there’s no sponsor')
  }
  return { ok: true, value: checked }
}

function checkSponsor(sponsor: unknown): Checked<SponsorEntry> {
  if (!isObject(sponsor)) return fail('sponsor must be an object')
  const keys = ['name', 'description', 'link', 'alt', 'image', 'until']
  const why =
    onlyKeys(sponsor, 'sponsor', keys) ??
    checkText(sponsor.name, 'sponsor.name', LIMITS.text.name) ??
    checkText(sponsor.description, 'sponsor.description', LIMITS.text.description) ??
    checkText(sponsor.alt, 'sponsor.alt', LIMITS.text.alt) ??
    (sponsor.until === undefined ? undefined : checkDay(sponsor.until, 'sponsor.until'))
  if (why) return fail(why)
  const link = checkLink(sponsor.link, 'sponsor.link')
  if (!link.ok) return link
  const { image } = sponsor
  if (!isObject(image)) return fail('sponsor.image must say a picture for light and for dark')
  const imageWhy =
    onlyKeys(image, 'sponsor.image', ['light', 'dark']) ??
    checkName(image.light, 'sponsor.image.light') ??
    checkName(image.dark, 'sponsor.image.dark')
  if (imageWhy) return fail(imageWhy)
  return {
    ok: true,
    value: {
      name: sponsor.name as string,
      description: sponsor.description as string,
      link: link.value,
      alt: sponsor.alt as string,
      image: { light: image.light as string, dark: image.dark as string },
      ...(sponsor.until === undefined ? {} : { until: sponsor.until as string }),
    },
  }
}

export type PictureType = 'image/png' | 'image/gif' | 'image/webp'

export interface Picture {
  /** What it is, from its contents (not its name). */
  type: PictureType
  animated: boolean
  /**
   * An animated one's first frame, alone, for people who ask for less motion: the same file
   * with the rest of its frames left out.
   */
  still?: Uint8Array
}

/** Thrown, and caught by checkPicture, when a picture isn't what it should be. */
class Bad extends Error {}

/** Reading a file's bytes, in its byte order, never past its end. */
class Bytes {
  readonly data: Uint8Array
  constructor(data: Uint8Array) {
    this.data = data
  }
  get length(): number {
    return this.data.length
  }
  #at(offset: number, size: number): number {
    if (offset < 0 || offset + size > this.data.length) throw new Bad('it ends too soon')
    return offset
  }
  u8(offset: number): number {
    return this.data[this.#at(offset, 1)]!
  }
  u16le(offset: number): number {
    return this.u8(offset) | (this.u8(offset + 1) << 8)
  }
  u24le(offset: number): number {
    return this.u16le(offset) | (this.u8(offset + 2) << 16)
  }
  u32le(offset: number): number {
    return (this.u24le(offset) | (this.u8(offset + 3) << 24)) >>> 0
  }
  u32be(offset: number): number {
    const high = (this.u8(offset) << 8) | this.u8(offset + 1)
    return ((high << 16) | (this.u8(offset + 2) << 8) | this.u8(offset + 3)) >>> 0
  }
  text(offset: number, size: number): string {
    this.#at(offset, size)
    return String.fromCharCode(...this.data.subarray(offset, offset + size))
  }
  slice(start: number, end: number): Uint8Array {
    this.#at(start, end - start)
    return this.data.subarray(start, end)
  }
}

/** How long a frame shows, as browsers show it: a very short delay is taken as 100 ms. */
const shown = (ms: number) => (ms <= 10 ? 100 : ms)

interface Parsed {
  type: PictureType
  width: number
  height: number
  frames: number
  /** All its frames' durations, in ms. */
  ms: number
  /** Whether it's set to play more than once. */
  loops: boolean
  still?: Uint8Array
}

/**
 * Whether a picture is one the card may show, checked by what it is: a PNG, GIF or WebP
 * (animated or not), 408 × 136, small enough, and an animation that plays once, for 5 s at most.
 */
export function checkPicture(data: Uint8Array): Checked<Picture> {
  if (data.length > LIMITS.animatedBytes) {
    return fail(`it’s larger than ${LIMITS.animatedBytes / 1024} KB`)
  }
  let parsed: Parsed
  try {
    const bytes = new Bytes(data)
    const signature = bytes.length >= 12 ? bytes.text(0, 12) : ''
    if (signature.startsWith('\x89PNG\r\n\x1a\n')) parsed = png(bytes)
    else if (signature.startsWith('GIF87a') || signature.startsWith('GIF89a')) parsed = gif(bytes)
    else if (signature.startsWith('RIFF') && signature.endsWith('WEBP')) parsed = webp(bytes)
    else return fail('it isn’t a PNG, GIF or WebP')
  } catch (error) {
    if (error instanceof Bad) return fail(`it isn’t a whole picture: ${error.message}`)
    throw error
  }
  const { type, width, height, frames, ms, loops, still } = parsed
  if (width !== LIMITS.width || height !== LIMITS.height) {
    return fail(`it’s ${width} × ${height}, not ${LIMITS.width} × ${LIMITS.height}`)
  }
  const animated = frames > 1
  if (!animated && data.length > LIMITS.stillBytes) {
    return fail(`it’s larger than ${LIMITS.stillBytes / 1024} KB, for a still picture`)
  }
  if (animated && loops) return fail('it’s set to play more than once')
  if (animated && ms > LIMITS.animatedMs) {
    return fail(`it plays for ${ms / 1000} s, more than ${LIMITS.animatedMs / 1000}`)
  }
  return { ok: true, value: { type, animated, ...(animated ? { still } : {}) } }
}

/** A PNG: its size, from its header; an animated one (APNG) isn't one of the formats. */
function png(bytes: Bytes): Parsed {
  let offset = 8
  let width = 0
  let height = 0
  for (let first = true; ; first = false) {
    const size = bytes.u32be(offset)
    const type = bytes.text(offset + 4, 4)
    const data = offset + 8
    bytes.slice(data, data + size + 4)
    if (first) {
      if (type !== 'IHDR' || size !== 13) throw new Bad('it has no header')
      width = bytes.u32be(data)
      height = bytes.u32be(data + 4)
    }
    if (type === 'acTL') throw new Bad('an animated PNG isn’t accepted: send a GIF or a WebP')
    offset = data + size + 4
    if (type === 'IEND') break
  }
  return { type: 'image/png', width, height, frames: 1, ms: 0, loops: false }
}

type Quad = [number, number, number, number]

/** A GIF: its size, its frames and how long they show, and whether it says to loop. */
function gif(bytes: Bytes): Parsed {
  const width = bytes.u16le(6)
  const height = bytes.u16le(8)
  const packed = bytes.u8(10)
  let offset = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0)
  let frames = 0
  let ms = 0
  let loops = false
  let delay = 0
  let firstEnd = 0
  /** Past a run of sub-blocks, each a length and that many bytes, ending with a zero. */
  const skipBlocks = (from: number) => {
    let at = from
    for (let size = bytes.u8(at); size !== 0; size = bytes.u8(at)) at += size + 1
    return at + 1
  }
  for (;;) {
    const block = bytes.u8(offset)
    if (block === 0x3b) break
    if (block === 0x21) {
      const label = bytes.u8(offset + 1)
      // NETSCAPE2.0 (or ANIMEXTS1.0): play it again, however many times it says.
      if (label === 0xff && bytes.u8(offset + 2) === 11) {
        const application = bytes.text(offset + 3, 11)
        if (application === 'NETSCAPE2.0' || application === 'ANIMEXTS1.0') loops = true
      }
      // How long the next frame shows, in hundredths of a second.
      if (label === 0xf9) delay = bytes.u16le(offset + 4) * 10
      offset = skipBlocks(offset + 2)
    } else if (block === 0x2c) {
      // Where the frame is, and its size: something, and inside the picture.
      const [x, y, w, h] = [1, 3, 5, 7].map((at) => bytes.u16le(offset + at)) as Quad
      if (w === 0 || h === 0) throw new Bad('it has an empty frame')
      if (x + w > width || y + h > height) throw new Bad('a frame goes past its edges')
      const local = bytes.u8(offset + 9)
      offset += 10 + (local & 0x80 ? 3 * 2 ** ((local & 7) + 1) : 0)
      offset = skipBlocks(offset + 1)
      frames++
      ms += shown(delay)
      delay = 0
      if (frames === 1) firstEnd = offset
    } else {
      throw new Bad('it has a block GIF doesn’t have')
    }
  }
  if (frames === 0) throw new Bad('it has no frames')
  // The first frame alone: everything up to its end, and the trailer.
  const still = frames > 1 ? concat([bytes.slice(0, firstEnd), Uint8Array.of(0x3b)]) : undefined
  return { type: 'image/gif', width, height, frames, ms, loops, still }
}

/** A WebP: its size, and an animated one's frames, how long they show, and its loop count. */
function webp(bytes: Bytes): Parsed {
  if (bytes.u32le(4) + 8 !== bytes.length) throw new Bad('its size isn’t its length')
  const chunks: { type: string; start: number; end: number; data: number; size: number }[] = []
  for (let offset = 12; offset < bytes.length;) {
    const type = bytes.text(offset, 4)
    const size = bytes.u32le(offset + 4)
    const end = offset + 8 + size + (size % 2)
    bytes.slice(offset, end)
    chunks.push({ type, start: offset, end, data: offset + 8, size })
    offset = end
  }
  const first = chunks[0]
  if (!first) throw new Bad('it has nothing in it')
  /** A chunk at least this long, so what's read of it is its own. */
  const atLeast = (chunk: (typeof chunks)[number], size: number) => {
    if (chunk.size < size) throw new Bad(`its ${chunk.type.trim()} is too short`)
  }
  const still = (width: number, height: number): Parsed => ({
    type: 'image/webp',
    width,
    height,
    frames: 1,
    ms: 0,
    loops: false,
  })
  if (first.type === 'VP8 ') {
    atLeast(first, 10)
    if (bytes.text(first.data + 3, 3) !== '\x9d\x01\x2a') throw new Bad('its frame is broken')
    return still(bytes.u16le(first.data + 6) & 0x3fff, bytes.u16le(first.data + 8) & 0x3fff)
  }
  if (first.type === 'VP8L') {
    atLeast(first, 5)
    if (bytes.u8(first.data) !== 0x2f) throw new Bad('its frame is broken')
    const bits = bytes.u32le(first.data + 1)
    return still((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  if (first.type !== 'VP8X') throw new Bad('it doesn’t start as WebP does')
  atLeast(first, 10)
  const flags = bytes.u8(first.data)
  const width = bytes.u24le(first.data + 4) + 1
  const height = bytes.u24le(first.data + 7) + 1
  if (!(flags & 0x02)) {
    if (!chunks.some((c) => c.type === 'VP8 ' || c.type === 'VP8L')) {
      throw new Bad('it has no picture in it')
    }
    return still(width, height)
  }
  const anim = chunks.find((c) => c.type === 'ANIM')
  const frames = chunks.filter((c) => c.type === 'ANMF')
  if (!anim || frames.length === 0) throw new Bad('it says it’s animated, but has no frames')
  atLeast(anim, 6)
  for (const frame of frames) {
    // ANMF: x and y (halved), width and height (less one), 3 bytes each; then the frame itself.
    atLeast(frame, 24)
    const x = bytes.u24le(frame.data) * 2
    const y = bytes.u24le(frame.data + 3) * 2
    const w = bytes.u24le(frame.data + 6) + 1
    const h = bytes.u24le(frame.data + 9) + 1
    if (x + w > width || y + h > height) throw new Bad('a frame goes past its edges')
  }
  // ANMF: x, y, width and height (3 bytes each), then the duration (3 bytes, ms).
  const ms = frames.reduce((sum, frame) => sum + shown(bytes.u24le(frame.data + 12)), 0)
  // 0 is forever; 1 plays once.
  const loops = bytes.u16le(anim.data + 4) !== 1
  let firstFrame: Uint8Array | undefined
  if (frames.length > 1) {
    // The first frame alone: the header, the color profile if there is one, the animation's
    // settings and that frame (EXIF and XMP left out, and the header says so).
    const kept = chunks
      .filter((c) => c === first || c.type === 'ICCP' || c === anim || c === frames[0])
      .map((c) => bytes.slice(c.start, c.end))
    const header = Uint8Array.from(kept[0]!)
    header[8] = flags & ~0x0c
    kept[0] = header
    const body = concat(kept)
    const riff = new Uint8Array(12)
    riff.set(bytes.slice(0, 12))
    new DataView(riff.buffer).setUint32(4, body.length + 4, true)
    firstFrame = concat([riff, body])
  }
  return {
    type: 'image/webp',
    width,
    height,
    frames: frames.length,
    ms,
    loops,
    ...(firstFrame ? { still: firstFrame } : {}),
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}

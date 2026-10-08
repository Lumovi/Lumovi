/**
 * What a server keeps so that restarting it signs nobody out: who's signed in, the AI
 * assistants they allowed (and their tokens), and what each person made read-only for their
 * assistants. In a Secret of the namespace Lumovi runs in (the chart makes it, and lets Lumovi
 * read and write it, and nothing else), in a file under LUMOVI_DATA_DIR, or only in memory.
 *
 * Each entry is sealed (AES-256-GCM) with the state's key, and filed under an HMAC of what it
 * is, which the seal is bound to. The key isn't kept with the state: it's LUMOVI_STATE_KEY,
 * which the chart keeps in a Secret of its own (Lumovi doesn't read it, Kubernetes gives it),
 * or, without Kubernetes, a file beside state.json. So whoever can read the state learns
 * nothing from it (not even who's signed in), and whoever can write it can't make an entry that
 * opens (a session as someone, say), change one, nor move one to another's place: what doesn't
 * open is let go.
 *
 * No credential is in an entry, either: cookies and tokens are kept by their hash, and the token
 * a session passes on (its person's own) is sealed again with a key its cookie alone gives (see
 * sessions.ts), so not even the state's key acts as anyone.
 *
 * It's changed a key at a time, and written a little after: each write is what was read with
 * the changes since, so another replica's (or a restart's) are never written over. What mustn't
 * be lost (a sign-out, an assistant let go) is written before it's answered (flush, strictly).
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { KubeRequestError } from '@backend/kube/errors'
import { ConfigError } from './config'
import { keeper, MAX_KEPT_BYTES, type Keeper, type Keeping, type Kept } from './kept'
import { log } from './log'

/** What's kept, each a map of its own. */
export const SECTIONS = [
  'sessions',
  'grants',
  'access',
  'refresh',
  'spent',
  'clusters',
  'agents',
] as const
export type Section = (typeof SECTIONS)[number]

/** As it's kept: each entry by its name (an HMAC), sealed. */
interface Document {
  entries: Record<string, string>
}

const KEPT: Kept<Document> = {
  what: 'who’s signed in and the AI assistants they allowed',
  key: 'state.json',
  empty: { entries: {} },
  write: (document) => JSON.stringify(document),
  // What can't be read is what was lost: people sign in again, rather than the server stop.
  read: (text, where) => {
    let problem = 'it isn’t what Lumovi keeps'
    try {
      const { entries } = JSON.parse(text) as Partial<Document>
      if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
        return {
          entries: Object.fromEntries(
            Object.entries(entries).filter(([, sealed]) => typeof sealed === 'string'),
          ) as Record<string, string>,
        }
      }
    } catch (error) {
      problem = (error as Error).message.split('\n')[0]!
    }
    log(`What ${where} kept can’t be read (${problem}): everyone signs in again.`)
    return { entries: {} }
  },
}

/** A change waiting to be written: the latest for each entry (by its name). */
interface Change {
  section: Section
  key: string
  value?: unknown
  /**
   * What it is over the entry as another wrote it meanwhile (a write that met theirs reads it
   * again): its value made again from theirs, not from what this server had read.
   */
  rebase?: (current: unknown) => unknown
}

/** How long after a change it's written: changes made together are written together. */
const WRITE_AFTER_MS = 50
/** How often a write over someone else's is tried again, with what they wrote. */
const ATTEMPTS = 5
/** After a write that failed, how long until it's tried again. */
const RETRY_MS = 5_000
/** The most it may be (LUMOVI_STATE_MAX_BYTES, for tests): a Secret holds a megabyte. */
const MAX_BYTES = Number(process.env.LUMOVI_STATE_MAX_BYTES) || MAX_KEPT_BYTES

/** The state's key, from LUMOVI_STATE_KEY; without Kubernetes, kept beside state.json. */
export function stateKey(keeping: Keeping, given: string | undefined): Buffer {
  if (given) return Buffer.from(given)
  if (keeping.kind === 'memory') return randomBytes(32)
  if (keeping.kind === 'file') {
    const file = join(dirname(keeping.path), 'state.key')
    try {
      writeFileSync(file, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new ConfigError(
          `Lumovi can’t keep the state’s key in ${file}: ${(error as Error).message}`,
        )
      }
    }
    return Buffer.from(readFileSync(file, 'utf8').trim())
  }
  throw new ConfigError(
    'LUMOVI_STATE_SECRET needs LUMOVI_STATE_KEY: the key what’s kept is sealed with, from a Secret of its own (the chart makes one).',
  )
}

export class ServerState {
  /** What's kept, opened: this server's own view of it. */
  readonly #open = new Map<Section, Map<string, unknown>>(SECTIONS.map((s) => [s, new Map()]))
  /** As it was last read or written. */
  #document: Document
  readonly #changes = new Map<string, Change>()
  #writing: Promise<void> = Promise.resolve()
  #timer?: NodeJS.Timeout
  /** What went wrong writing, said once until it's put right. */
  #failing?: string
  /** How many of what's kept don't open with this server's key, as last said. */
  #unopened = 0
  readonly #seal: Buffer
  readonly #name: Buffer

  private constructor(
    private readonly keeper: Keeper<Document>,
    document: Document,
    key: Buffer,
  ) {
    this.#seal = Buffer.from(hkdfSync('sha256', key, 'lumovi', 'state seal', 32))
    this.#name = Buffer.from(hkdfSync('sha256', key, 'lumovi', 'state names', 32))
    this.#document = document
    for (const [name, sealed] of Object.entries(document.entries)) {
      const entry = this.#opened(name, sealed)
      if (entry) this.#open.get(entry.section)!.set(entry.key, entry.value)
    }
    this.#sayUnopened(document)
  }

  /**
   * Entries that don't open with this server's key: its key changed, or they were, or another
   * replica seals with another key (while keys are rotated). Left as they are, unused, and said
   * once (until how many changes): never taken for entries deleted, nor let go while another may
   * be using them, but to make room.
   */
  #sayUnopened(document: Document): void {
    const unopened = Object.entries(document.entries).filter(
      ([name, sealed]) => !this.#opened(name, sealed),
    ).length
    if (unopened > 0 && unopened !== this.#unopened) {
      log(
        `${unopened} of what Lumovi kept doesn’t open with its key (it changed, they were, or another replica uses another): they’re left as they are, unused.`,
      )
    }
    this.#unopened = unopened
  }

  static async open(keeping: Keeping, env: NodeJS.ProcessEnv, key: Buffer): Promise<ServerState> {
    // In a cluster, the chart's: auth.keepSessions keeps them.
    const howToKeep = env.KUBERNETES_SERVICE_HOST
      ? 'The Helm chart’s auth.keepSessions keeps them (LUMOVI_STATE_SECRET).'
      : 'Set LUMOVI_DATA_DIR to keep them.'
    const kept = keeper(keeping, { ...KEPT, howToKeep }, env)
    if (kept.kept === 'memory') {
      log(
        'Run a single replica so: each would keep its own, and what’s set for everyone (the clusters made read-only, say) would differ between them.',
      )
    }
    return new ServerState(kept, await kept.read(), key)
  }

  /** Where it's kept. */
  get kept(): Keeping['kind'] {
    return this.keeper.kept
  }

  /** A section as it was when the server started (and as it's changed here since). */
  entries<T>(section: Section): [string, T][] {
    return [...this.#open.get(section)!] as [string, T][]
  }

  /** An entry of a section, as it is here. */
  get<T>(section: Section, key: string): T | undefined {
    return this.#open.get(section)!.get(key) as T | undefined
  }

  /**
   * A section as it's kept now, read again (another replica may have changed it), with what's
   * changed here and not yet written over it. Whether it changed.
   */
  refresh(section: Section): Promise<boolean> {
    const reading = this.#writing.then(async () => {
      const document = await this.keeper.read()
      // What's written next is over what's there now.
      this.#document = document
      this.#sayUnopened(document)
      const fresh = new Map<string, unknown>()
      for (const [name, sealed] of Object.entries(document.entries)) {
        const entry = this.#opened(name, sealed)
        if (entry?.section === section) fresh.set(entry.key, entry.value)
      }
      for (const change of this.#changes.values()) {
        if (change.section !== section) continue
        if (change.value === undefined) fresh.delete(change.key)
        else fresh.set(change.key, change.value)
      }
      const before = this.#open.get(section)!
      this.#open.set(section, fresh)
      return !isDeepStrictEqual(before, fresh)
    })
    this.#writing = reading.then(
      () => undefined,
      () => undefined,
    )
    return reading
  }

  /** `rebase` makes it again over another's write, if one met it (see Change). */
  set(section: Section, key: string, value: unknown, rebase?: (current: unknown) => unknown): void {
    this.#open.get(section)!.set(key, value)
    this.#change({ section, key, value, ...(rebase ? { rebase } : {}) })
  }

  delete(section: Section, key: string): void {
    this.#open.get(section)!.delete(key)
    this.#change({ section, key })
  }

  /**
   * Once what's changed so far is written. `strict`: throws if it couldn't be (it's tried
   * again later all the same), for what mustn't be said done until it's kept.
   */
  flush({ strict = false } = {}): Promise<void> {
    clearTimeout(this.#timer)
    const writing = this.#writing.then(() => this.#write())
    this.#writing = writing.then(
      () => undefined,
      () => undefined,
    )
    return strict ? writing : this.#writing
  }

  /** An entry's name: an HMAC of what it is. */
  #nameOf(section: Section, key: string): string {
    return createHmac('sha256', this.#name).update(`${section}\0${key}`).digest('base64url')
  }

  #change(change: Change): void {
    if (this.keeper.kept === 'memory') return
    this.#changes.set(this.#nameOf(change.section, change.key), change)
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => void this.flush(), WRITE_AFTER_MS)
    this.#timer.unref()
  }

  #sealed(
    name: string,
    { section, key, value }: Pick<Change, 'section' | 'key' | 'value'>,
  ): string {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#seal, nonce)
    cipher.setAAD(Buffer.from(name))
    const sealed = Buffer.concat([
      cipher.update(JSON.stringify({ section, key, value }), 'utf8'),
      cipher.final(),
    ])
    return Buffer.concat([nonce, cipher.getAuthTag(), sealed]).toString('base64url')
  }

  /** An entry, if it opens, under its own name. */
  #opened(name: string, sealed: string): Required<Change> | undefined {
    try {
      const bytes = Buffer.from(sealed, 'base64url')
      const decipher = createDecipheriv('aes-256-gcm', this.#seal, bytes.subarray(0, 12))
      decipher.setAAD(Buffer.from(name))
      decipher.setAuthTag(bytes.subarray(12, 28))
      const text = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])
      const entry = JSON.parse(text.toString('utf8')) as Required<Change>
      if (!SECTIONS.includes(entry.section) || typeof entry.key !== 'string') return undefined
      return this.#nameOf(entry.section, entry.key) === name ? entry : undefined
    } catch {
      return undefined
    }
  }

  async #write(): Promise<void> {
    if (this.#changes.size === 0) return
    const changes = new Map(this.#changes)
    this.#changes.clear()
    let base = this.#document
    for (let attempt = 1; ; attempt++) {
      // Made again over the entry as it's there now, where a change says how: another replica
      // may have written it since this one read it (a write that met theirs reads it again).
      for (const [name, change] of changes) {
        if (!change.rebase) continue
        const sealed = base.entries[name]
        change.value = change.rebase(sealed ? this.#opened(name, sealed)?.value : undefined)
        if (!this.#changes.has(name)) this.#open.get(change.section)!.set(change.key, change.value)
      }
      // What's there, with these changes: never another's written over.
      const next: Document = { entries: { ...base.entries } }
      for (const [name, change] of changes) {
        if (change.value === undefined) delete next.entries[name]
        else next.entries[name] = this.#sealed(name, change)
      }
      this.#prune(next)
      try {
        await this.keeper.write(next)
        this.#document = next
        if (this.#failing) log('Lumovi keeps who’s signed in again.')
        this.#failing = undefined
        return
      } catch (error) {
        if (error instanceof KubeRequestError && error.code === 'conflict' && attempt < ATTEMPTS) {
          base = await this.keeper.read().catch(() => base)
          continue
        }
        const message = (error as Error).message
        if (this.#failing !== message) {
          log(
            `Lumovi can’t keep who’s signed in (${message}): if it restarts now, what changed since is lost.`,
          )
        }
        this.#failing = message
        // Tried again later, but for what's changed again since.
        for (const [name, change] of changes) {
          if (!this.#changes.has(name)) this.#changes.set(name, change)
        }
        this.#timer = setTimeout(() => void this.flush(), RETRY_MS)
        this.#timer.unref()
        throw error
      }
    }
  }

  /**
   * What nothing will look up again goes as it's written: what's run out, and what doesn't open.
   * Past what it may hold, the sessions that end soonest make way (they're signed out when
   * the server next restarts), never what's being let go.
   */
  #prune(document: Document): void {
    const now = Date.now()
    const sessions: { name: string; expires: number }[] = []
    // What doesn't open: let go first, but only to make room (another replica may use it).
    const unopened: { name: string; expires: number }[] = []
    for (const [name, sealed] of Object.entries(document.entries)) {
      const entry = this.#opened(name, sealed)
      const expires = (entry?.value as { expires?: number } | undefined)?.expires
      if (!entry) unopened.push({ name, expires: -Infinity })
      else if ((expires ?? Infinity) < now) delete document.entries[name]
      else if (entry.section === 'sessions') sessions.push({ name, expires: expires ?? Infinity })
    }
    let size = Buffer.byteLength(KEPT.write(document))
    if (size <= MAX_BYTES) return
    sessions.sort((a, b) => a.expires - b.expires)
    let dropped = 0
    let unopenedDropped = 0
    for (const { name, expires } of [...unopened, ...sessions]) {
      if (size <= MAX_BYTES) break
      size -= Buffer.byteLength(document.entries[name]!) + name.length + 6
      delete document.entries[name]
      if (expires === -Infinity) unopenedDropped++
      else dropped++
    }
    log(
      `What Lumovi keeps would be more than the ${Math.round(MAX_BYTES / 1000)} kB it may hold: ${unopenedDropped ? `${unopenedDropped} that don’t open with its key, and ` : ''}the ${dropped} sessions that end soonest aren’t kept (they sign in again after a restart).`,
    )
  }
}

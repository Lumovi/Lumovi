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
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto'
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
  'joins',
  'added',
  // Since when each entry that doesn't open with the key has been there (see #track).
  'unopened',
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
  /** How many times its rebase threw, and it was held back. */
  held?: number
}

/** How long after a change it's written: changes made together are written together. */
const WRITE_AFTER_MS = 50
/** How often a write over someone else's is tried again, with what they wrote. */
const ATTEMPTS = 5
/** How many times a change whose rebase throws is held back, before it's written as it was made. */
const HELD = 3
/** After a write that failed, how long until it's tried again. */
const RETRY_MS = 5_000
/** The most it may be (LUMOVI_STATE_MAX_BYTES, for tests): a Secret holds a megabyte. */
const MAX_BYTES = Number(process.env.LUMOVI_STATE_MAX_BYTES) || MAX_KEPT_BYTES
/**
 * How long entries that don't open with this server's key are left as they are: a rollout's
 * length, while another replica may still seal with another key (LUMOVI_STATE_UNOPENED_GRACE_MS,
 * for tests). Then they're let go: what an old key (a leaked one, say) opens doesn't outlive it.
 */
const UNOPENED_GRACE_MS = Number(process.env.LUMOVI_STATE_UNOPENED_GRACE_MS) || 15 * 60_000
/** How many entries are opened before the event loop is let go a moment, as they're read. */
const OPENED_AT_ONCE = 200
/** An entry's name (an HMAC, in base64url), and a sealed entry: what could be one, at least. */
const NAME = /^[A-Za-z0-9_-]{43}$/
const SEALED = /^[A-Za-z0-9_-]{40,}$/

/**
 * For tests: the time it is, how long what doesn't open is left as it is, and how long after a
 * change, or a write that failed, it's written (a test that writes when it says gives long ones).
 */
export interface StateOptions {
  now?: () => number
  unopenedGraceMs?: number
  writeAfterMs?: number
  retryMs?: number
}

/** A length of time, in minutes. */
const minutes = (ms: number): string => {
  const n = Math.round(ms / 60_000)
  return `${n} minute${n === 1 ? '' : 's'}`
}

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
  /** Since when entries that don't open with this server's key have been there (see #track). */
  #unopenedSince?: number
  /** What they were then (a digest of them all): another such time, if they change. */
  #unopenedAs?: string
  /** How many there were, as they were last read. */
  #unopened = 0
  /** Each entry as it opened (or didn't), by its name and what's sealed: opened once. */
  #opening = new Map<string, Required<Change> | null>()
  /** How many writes met another's (for tests). */
  #conflicts = 0
  readonly #seal: Buffer
  readonly #name: Buffer
  readonly #now: () => number
  readonly #grace: number
  readonly #writeAfter: number
  readonly #retry: number

  private constructor(
    private readonly keeper: Keeper<Document>,
    document: Document,
    key: Buffer,
    options: StateOptions,
  ) {
    this.#seal = Buffer.from(hkdfSync('sha256', key, 'lumovi', 'state seal', 32))
    this.#name = Buffer.from(hkdfSync('sha256', key, 'lumovi', 'state names', 32))
    this.#now = options.now ?? Date.now
    this.#grace = options.unopenedGraceMs ?? UNOPENED_GRACE_MS
    this.#writeAfter = options.writeAfterMs ?? WRITE_AFTER_MS
    this.#retry = options.retryMs ?? RETRY_MS
    this.#document = document
    // As the server starts: nothing else waits on it yet.
    for (const [name, sealed] of Object.entries(document.entries)) {
      this.#opening.set(`${name}\0${sealed}`, this.#open1(name, sealed))
    }
    this.#track(document)
    for (const [name, sealed] of Object.entries(document.entries)) {
      const entry = this.#opened(name, sealed)
      if (entry) this.#open.get(entry.section)!.set(entry.key, entry.value)
    }
  }

  /**
   * What's kept, as it's read (or written): each entry opened (only those it has now are
   * remembered, and each once), a few hundred at a time with the event loop let go between, so
   * that a store full of junk shaped like entries never holds a server up for long.
   */
  async #seen(document: Document): Promise<void> {
    const opening = new Map<string, Required<Change> | null>()
    let opened = 0
    for (const [name, sealed] of Object.entries(document.entries)) {
      const id = `${name}\0${sealed}`
      if (this.#opening.has(id)) {
        opening.set(id, this.#opening.get(id)!)
        continue
      }
      opening.set(id, this.#open1(name, sealed))
      if (++opened % OPENED_AT_ONCE === 0) await new Promise((done) => setImmediate(done))
    }
    this.#opening = opening
    this.#track(document)
  }

  /**
   * Since when the entries that don't open with this server's key have been the same ones: its
   * key changed, or they were, or another replica seals with another key (while keys are
   * rotated). They're left as they are (never taken for entries deleted) until they've been the
   * same for the grace period, then let go together: what an old key (a leaked one) opens doesn't
   * outlive a rotation, while a key still in use, whose replicas add entries, keeps its own. By
   * their names (what's in them changes as they're written again: two keys' replicas would put
   * each other's off for ever). Kept as one time and a digest of the names, however many there
   * are (sealed with this key, so that a restart doesn't put it off; deleted, it counts from this
   * server's own sighting). When it runs out, it's written at once, which lets them go; so is
   * anything not even shaped like an entry, which no key made.
   */
  #track(document: Document): void {
    const now = this.#now()
    const keptName = this.#nameOf('unopened', 'since')
    const sealedKept = document.entries[keptName]
    const value = sealedKept ? this.#opened(keptName, sealedKept)?.value : undefined
    const kept = (value as { since?: unknown; as?: unknown } | undefined) ?? {}
    const unopened: string[] = []
    let junk = 0
    for (const [name, sealed] of Object.entries(document.entries)) {
      if (!NAME.test(name) || !SEALED.test(sealed)) junk++
      else if (!this.#opened(name, sealed)) unopened.push(name)
    }
    const as =
      unopened.length > 0
        ? createHash('sha256').update(unopened.sort().join('\n')).digest('base64url')
        : undefined
    const keptSince = kept.as === as && typeof kept.since === 'number' ? kept.since : undefined
    const ownSince = this.#unopenedAs === as ? this.#unopenedSince : undefined
    const since = as ? Math.min(keptSince ?? now, ownSince ?? now) : undefined
    if (unopened.length > 0 && unopened.length !== this.#unopened) {
      log(
        `${unopened.length} of what Lumovi kept doesn’t open with its key (it changed, they were, or another replica uses another): left as they are, unused, until they’ve been so for ${minutes(this.#grace)}, then let go.`,
      )
    }
    this.#unopened = unopened.length
    this.#unopenedSince = since
    this.#unopenedAs = as
    if (this.keeper.kept === 'memory') return
    const runOut = since !== undefined && now - since >= this.#grace
    if (since === keptSince && kept.as === as && !runOut && junk === 0) return
    if (!as) this.delete('unopened', 'since')
    // Kept as the earliest, over another replica's (with the same key) meanwhile, if it saw them
    // as they are.
    else {
      this.set('unopened', 'since', { since, as }, (current) => {
        const theirs = (current ?? {}) as { since?: unknown; as?: unknown }
        return theirs.as === as && typeof theirs.since === 'number'
          ? { since: Math.min(theirs.since, since!), as }
          : { since, as }
      })
    }
  }

  /** How many writes met another replica's, and were tried again (for tests). */
  get conflicts(): number {
    return this.#conflicts
  }

  /** For tests: how many of a section's changes aren't written yet. */
  unwritten(section: Section): number {
    return [...this.#changes.values()].filter((change) => change.section === section).length
  }

  /** For tests: once what's being written now is (without writing what isn't yet). */
  get writing(): Promise<void> {
    return this.#writing
  }

  static async open(
    keeping: Keeping,
    env: NodeJS.ProcessEnv,
    key: Buffer,
    options: StateOptions = {},
  ): Promise<ServerState> {
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
    return new ServerState(kept, await kept.read(), key, options)
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
   * changed here and not yet written over it. Whether it changed. `settle` sees it, and what it
   * was here, before anything else does, and may change it (what's changed so isn't written).
   */
  refresh(
    section: Section,
    settle?: (fresh: Map<string, unknown>, before: Map<string, unknown>) => void,
  ): Promise<boolean> {
    const reading = this.#writing.then(async () => {
      const document = await this.keeper.read()
      // What's written next is over what's there now.
      this.#document = document
      await this.#seen(document)
      const fresh = new Map<string, unknown>()
      for (const [name, sealed] of Object.entries(document.entries)) {
        const entry = this.#opened(name, sealed)
        if (entry?.section === section) fresh.set(entry.key, entry.value)
      }
      // What's changed here and not yet written: made again over what's there now, where it says
      // how, as it will be when it's written.
      for (const change of this.#changes.values()) {
        if (change.section !== section) continue
        const value = change.rebase ? change.rebase(fresh.get(change.key)) : change.value
        if (value === undefined) fresh.delete(change.key)
        else fresh.set(change.key, value)
      }
      const before = this.#open.get(section)!
      settle?.(fresh, before)
      this.#open.set(section, fresh)
      return !isDeepStrictEqual(before, fresh)
    })
    this.#writing = reading.then(
      () => undefined,
      () => undefined,
    )
    return reading
  }

  /** No more writes later (a server that stops, once it's flushed): what isn't written isn't. */
  close(): void {
    clearTimeout(this.#timer)
  }

  /** `rebase` makes it again over another's write, if one met it (see Change). */
  set(section: Section, key: string, value: unknown, rebase?: (current: unknown) => unknown): void {
    this.#open.get(section)!.set(key, value)
    this.#change({ section, key, value, ...(rebase ? { rebase } : {}) })
  }

  /** `rebase` says what it is over another's write, if one met it: none, it's deleted. */
  delete(section: Section, key: string, rebase?: (current: unknown) => unknown): void {
    this.#open.get(section)!.delete(key)
    this.#change({ section, key, ...(rebase ? { rebase } : {}) })
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
    const name = this.#nameOf(change.section, change.key)
    // Over one not yet written: made again as that one, then as this one, which was made from
    // it (from what was read, this one alone would take that one's for another's).
    const pending = this.#changes.get(name)
    if (pending?.rebase && change.rebase) {
      const first = pending.rebase
      const then = change.rebase
      change.rebase = (current) => then(first(current))
    }
    this.#changes.set(name, change)
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => void this.flush(), this.#writeAfter)
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

  /** An entry, if it opens, under its own name: opened once (what's kept is read often). */
  #opened(name: string, sealed: string): Required<Change> | undefined {
    const id = `${name}\0${sealed}`
    if (!this.#opening.has(id)) this.#opening.set(id, this.#open1(name, sealed))
    return this.#opening.get(id) ?? undefined
  }

  /** An entry, opened: never tried where it isn't shaped like one (junk can be much). */
  #open1(name: string, sealed: string): Required<Change> | null {
    if (!NAME.test(name) || !SEALED.test(sealed)) return null
    try {
      const bytes = Buffer.from(sealed, 'base64url')
      const decipher = createDecipheriv('aes-256-gcm', this.#seal, bytes.subarray(0, 12))
      decipher.setAAD(Buffer.from(name))
      decipher.setAuthTag(bytes.subarray(12, 28))
      const text = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])
      const entry = JSON.parse(text.toString('utf8')) as Required<Change>
      if (!SECTIONS.includes(entry.section) || typeof entry.key !== 'string') return null
      return this.#nameOf(entry.section, entry.key) === name ? entry : null
    } catch {
      return null
    }
  }

  async #write(): Promise<void> {
    if (this.#changes.size === 0) return
    const changes = new Map(this.#changes)
    this.#changes.clear()
    let base = this.#document
    const held = new Map<string, Change>()
    let heldBack = false
    for (let attempt = 1; ; attempt++) {
      // Made again over the entry as it's there now, where a change says how: another replica
      // may have written it since this one read it (a write that met theirs reads it again).
      for (const [name, change] of changes) {
        if (!change.rebase) continue
        const sealed = base.entries[name]
        try {
          change.value = change.rebase(sealed ? this.#opened(name, sealed)?.value : undefined)
        } catch (error) {
          // Not made again: held back to be tried again (later and later), not the rest with it
          // (sign-outs, say); after a few tries, written as it was made.
          change.held = (change.held ?? 0) + 1
          const why = (error as Error).message
          if (change.held >= HELD) {
            log(
              `Lumovi couldn’t make a change again over what’s kept, ${HELD} times (${why}): it’s written as it was made.`,
            )
            delete change.rebase
          } else {
            if (change.held === 1) {
              log(
                `Lumovi couldn’t make a change again over what’s kept (${why}): it’s tried again.`,
              )
            }
            held.set(name, change)
            continue
          }
        }
        if (!this.#changes.has(name)) {
          const open = this.#open.get(change.section)!
          if (change.value === undefined) open.delete(change.key)
          else open.set(change.key, change.value)
        }
      }
      if (held.size > 0) {
        for (const name of held.keys()) changes.delete(name)
        this.#again(held, Math.max(...[...held.values()].map((change) => change.held!)))
        held.clear()
        heldBack = true
        if (changes.size === 0) break
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
        await this.#seen(next)
        if (this.#failing) log('Lumovi keeps who’s signed in again.')
        this.#failing = undefined
        break
      } catch (error) {
        if (error instanceof KubeRequestError && error.code === 'conflict' && attempt < ATTEMPTS) {
          this.#conflicts++
          base = await this.keeper.read().catch(() => base)
          // What's written next is over what was just read, whatever comes of this write: the
          // keeper checks against it now (a write that then failed, made over what this server
          // had read before, would put back what others removed, and lose what they wrote).
          this.#document = base
          await this.#seen(base)
          continue
        }
        const message = (error as Error).message
        if (this.#failing !== message) {
          log(
            `Lumovi can’t keep who’s signed in (${message}): if it restarts now, what changed since is lost.`,
          )
        }
        this.#failing = message
        this.#again(changes)
        throw error
      }
    }
    // Said to whoever waits for it to be written (a strict flush): it isn't, all of it.
    if (heldBack)
      throw new Error('A change couldn’t be made again over what’s kept: it’s held back.')
  }

  /**
   * Changes not written, tried again later (the more often held back, the later): before what's
   * changed since, made from them.
   */
  #again(changes: Map<string, Change>, held = 1): void {
    for (const [name, change] of changes) {
      const since = this.#changes.get(name)
      if (!since) this.#changes.set(name, change)
      else if (since.rebase && change.rebase) {
        const first = change.rebase
        const then = since.rebase
        since.rebase = (current) => then(first(current))
        since.held = Math.max(since.held ?? 0, change.held ?? 0)
      }
    }
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => void this.flush(), this.#retry * 2 ** (held - 1))
    this.#timer.unref()
  }

  /**
   * What nothing will look up again goes as it's written: what's run out, and what hasn't opened
   * with this server's key for the grace period. Past what it may hold, what doesn't open makes
   * way first, then the sessions that end soonest (they're signed out when the server next
   * restarts), never what's being let go.
   */
  #prune(document: Document): void {
    const now = this.#now()
    const sessions: { name: string; expires: number }[] = []
    const unopened: { name: string; expires: number }[] = []
    const graceOver = this.#unopenedSince !== undefined && now - this.#unopenedSince >= this.#grace
    let junk = 0
    for (const [name, sealed] of Object.entries(document.entries)) {
      // Not even shaped like an entry: no key made it.
      if (!NAME.test(name) || !SEALED.test(sealed)) {
        delete document.entries[name]
        junk++
        continue
      }
      const entry = this.#opened(name, sealed)
      const expires = (entry?.value as { expires?: number } | undefined)?.expires
      if (!entry) {
        if (graceOver) delete document.entries[name]
        else unopened.push({ name, expires: -Infinity })
      } else if ((expires ?? Infinity) < Date.now()) delete document.entries[name]
      else if (entry.section === 'sessions') sessions.push({ name, expires: expires ?? Infinity })
    }
    if (junk > 0) log(`${junk} of what’s where Lumovi keeps its state isn’t Lumovi’s: let go.`)
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
    const what = [
      ...(unopenedDropped ? [`${unopenedDropped} that don’t open with its key`] : []),
      ...(dropped ? [`the ${dropped} sessions that end soonest`] : []),
    ]
    log(
      `What Lumovi keeps would be more than the ${Math.round(MAX_BYTES / 1000)} kB it may hold: ${what.join(', and ')} aren’t kept${dropped ? ' (they sign in again after a restart)' : ''}.`,
    )
  }
}

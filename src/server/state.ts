/**
 * What a server keeps so that restarting it signs nobody out: who's signed in, the AI
 * assistants they allowed (and their tokens), and what each person made read-only for their
 * assistants. In a Secret of the namespace Lumovi runs in (the chart makes it, and lets Lumovi
 * read and write it, and nothing else), in a file under LUMOVI_DATA_DIR, or only in memory.
 *
 * No credential is kept as it is: session cookies and assistants' tokens by their hash only,
 * and the token a session passes on (its person's own) sealed with a key its cookie alone
 * gives (see sessions.ts). Whoever can read the Secret can't act as anyone with what's in it.
 *
 * It's changed a key at a time, and written a little after: each write is what was read with
 * the changes since, so another replica's (or a restart's) are never written over.
 */
import { KubeRequestError } from '@backend/kube/errors'
import { keeper, MAX_KEPT_BYTES, type Keeper, type Keeping, type Kept } from './kept'
import { log } from './log'

/** What's kept, each a map of its own. */
export const SECTIONS = ['sessions', 'grants', 'access', 'refresh', 'spent', 'readOnly'] as const
export type Section = (typeof SECTIONS)[number]
export type State = Record<Section, Record<string, unknown>>

const empty = (): State => Object.fromEntries(SECTIONS.map((section) => [section, {}])) as State

const KEPT: Kept<State> = {
  what: 'who’s signed in and the AI assistants they allowed',
  key: 'state.json',
  empty: empty(),
  write: (state) => JSON.stringify(state),
  // What can't be read is what was lost: people sign in again, rather than the server stop.
  read: (text, where) => {
    const state = empty()
    try {
      const given = JSON.parse(text) as Partial<Record<Section, unknown>>
      for (const section of SECTIONS) {
        const entries = given[section]
        if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
          state[section] = entries as Record<string, unknown>
        }
      }
    } catch (error) {
      log(
        `What ${where} kept can’t be read (${(error as Error).message}): everyone signs in again.`,
      )
    }
    return state
  },
}

/** A change waiting to be written. */
type Change = { section: Section; key: string; value?: unknown }

/** How long after a change it's written: changes made together are written together. */
const WRITE_AFTER_MS = 50
/** How often a write over someone else's is tried again, with what they wrote. */
const ATTEMPTS = 5
/** After a write that failed, how long until it's tried again. */
const RETRY_MS = 5_000

export class ServerState {
  #state: State
  #changes: Change[] = []
  #writing: Promise<void> = Promise.resolve()
  #timer?: NodeJS.Timeout
  /** What went wrong writing, said once until it's put right. */
  #failing?: string

  private constructor(
    private readonly keeper: Keeper<State>,
    state: State,
  ) {
    this.#state = state
  }

  static async open(keeping: Keeping, env: NodeJS.ProcessEnv): Promise<ServerState> {
    const kept = keeper(keeping, KEPT, env)
    return new ServerState(kept, await kept.read())
  }

  /** Where it's kept. */
  get kept(): Keeping['kind'] {
    return this.keeper.kept
  }

  /** A section as it was when the server started (and as it's changed here since). */
  entries<T>(section: Section): [string, T][] {
    return Object.entries(this.#state[section]) as [string, T][]
  }

  set(section: Section, key: string, value: unknown): void {
    this.#change({ section, key, value })
  }

  delete(section: Section, key: string): void {
    this.#change({ section, key })
  }

  /** Once what's changed so far is written (or couldn't be). */
  flush(): Promise<void> {
    clearTimeout(this.#timer)
    this.#writing = this.#writing.then(() => this.#write())
    return this.#writing
  }

  #change(change: Change): void {
    this.#changes.push(change)
    apply(this.#state, [change])
    if (this.keeper.kept === 'memory') {
      this.#changes = []
      return
    }
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => void this.flush(), WRITE_AFTER_MS)
    this.#timer.unref()
  }

  async #write(): Promise<void> {
    const changes = this.#changes
    if (changes.length === 0) return
    this.#changes = []
    let base = this.#state
    for (let attempt = 1; ; attempt++) {
      // What's there, with these changes: never another's written over.
      const next = structuredClone(base)
      apply(next, changes)
      prune(next)
      try {
        const size = Buffer.byteLength(KEPT.write(next))
        if (size > MAX_KEPT_BYTES) {
          throw new Error(
            `it would be ${Math.round(size / 1000)} kB, more than the ${MAX_KEPT_BYTES / 1000} kB it may be`,
          )
        }
        await this.keeper.write(next)
        // Theirs, and these, and whatever changed meanwhile.
        this.#state = next
        apply(this.#state, this.#changes)
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
            `Lumovi can’t keep who’s signed in (${message}): if it restarts now, they sign in again.`,
          )
        }
        this.#failing = message
        // Tried again later, with what's changed by then.
        this.#changes = [...changes, ...this.#changes]
        this.#timer = setTimeout(() => void this.flush(), RETRY_MS)
        this.#timer.unref()
        return
      }
    }
  }
}

function apply(state: State, changes: Change[]): void {
  for (const { section, key, value } of changes) {
    if (value === undefined) delete state[section][key]
    else state[section][key] = value
  }
}

/** What's run out goes as it's written: what nothing will look up again. */
function prune(state: State): void {
  const now = Date.now()
  for (const section of ['sessions', 'access'] as const) {
    for (const [key, entry] of Object.entries(state[section])) {
      if (((entry as { expires?: number }).expires ?? Infinity) < now) delete state[section][key]
    }
  }
}

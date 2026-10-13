/**
 * Each signed-in person's pins and saved views, per cluster: kept by the server in its state
 * (state.ts), sealed with who's signed in, never in the browser. Filed under the person's user
 * name and the cluster's, so nobody reads another's, and a shared browser keeps nothing of anyone.
 *
 * The state is one Secret (or file) of a megabyte, with who's signed in, so these have a budget:
 * one person's in one cluster at most MOST_EACH, one person's in all at most MOST_PERSON, and
 * everyone's together at most MOST_ALL. Past any, a pin or a save is refused, in Lumovi's words;
 * and these are never what the state lets go of to make room (it lets go of sessions, which sign
 * in again). What goes unused for KEPT_UNUSED_MS is let go: each entry expires, and every page
 * that reads it puts that off again (the state drops what's expired as it writes).
 *
 * A cluster the server doesn't show now (a fleet's removed, or not back yet after a restart)
 * keeps its entries, but they count toward no one's own budget; only toward everyone's, where,
 * when a save would pass it, they're let go first, the longest unread first. Nothing is let go
 * on a guess: a cluster that comes back has its pins.
 */
import type { SessionUser } from '@shared/server'
import { NO_MARKS, type Marks } from '@shared/marks'
import type { MarksAccess } from '@backend/handlers'
import { log } from './log'
import type { ServerState } from './state'

/** At most, sealed: one person's in one cluster, one person's in all, and everyone's together. */
export const MOST_EACH = 32_000
export const MOST_PERSON = 96_000
export const MOST_ALL = 400_000

/** How long a person's pins and views are kept without being used; renewed once a day at most. */
export const KEPT_UNUSED_MS = 180 * 24 * 60 * 60 * 1000
const RENEWED_AFTER_MS = 24 * 60 * 60 * 1000

export const OVER_OWN =
  'This server keeps no more of your pins and views in this cluster. Unpin or delete some to save this.'
export const OVER_YOURS =
  'This server keeps no more of your pins and views. Unpin or delete some, in this cluster or another, to save this.'
export const OVER_ALL =
  'This server keeps no more pins and views, anyone’s. Unpin or delete some of yours, or ask whoever runs Lumovi.'

/** One person's in one cluster, as it's kept: with when it's let go if nothing reads it. */
interface Entry {
  marks: Marks
  expires: number
}

/**
 * How much an entry takes where it's kept: its JSON sealed (a 12-byte nonce and a 16-byte tag
 * beside it), in base64, filed under its HMAC's name. (Measured, never sealed twice to find out.)
 */
export const sealedSize = (entry: Entry) =>
  Math.ceil((Buffer.byteLength(JSON.stringify(entry)) + 28) / 3) * 4 + 50

/**
 * An entry's key: whose, and which cluster's, as a pair written out (a user name can hold any
 * character, a NUL too, where it's an OIDC claim: no separator would do).
 */
const keyOf = (user: SessionUser, context: string) => JSON.stringify([user.name, context])
const pairOf = (key: string) => JSON.parse(key) as [string, string]
const ownerOf = (key: string) => pairOf(key)[0]
const contextOf = (key: string) => pairOf(key)[1]

/** The pins and views of every person, kept in the server's state. */
export class PeopleMarks {
  constructor(
    private readonly state: ServerState,
    /** Whether the server shows a cluster now. */
    private readonly shows: (context: string) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** One person's, as the backend is given them; `known` refuses a cluster they can't see. */
  of(user: SessionUser, known: (context: string) => void): MarksAccess {
    return {
      get: (context) => {
        known(context)
        const key = keyOf(user, context)
        const entry = this.state.get<Entry>('marks', key)
        // (Run out, it's as good as gone: the state lets it go as it next writes, as sessions do.)
        if (!entry || entry.expires <= this.now()) return NO_MARKS
        // Read, it's in use: kept another while (written at most once a day for it).
        const expires = this.now() + KEPT_UNUSED_MS
        if (expires - entry.expires >= RENEWED_AFTER_MS) {
          this.state.set('marks', key, { ...entry, expires })
        }
        return entry.marks
      },
      set: (context, marks) => {
        known(context)
        const key = keyOf(user, context)
        // Nothing pinned or saved is nothing kept.
        if (marks.pins.length === 0 && marks.views.length === 0) {
          this.state.delete('marks', key)
          return undefined
        }
        const entry: Entry = { marks, expires: this.now() + KEPT_UNUSED_MS }
        const size = sealedSize(entry)
        if (size > MOST_EACH) return OVER_OWN
        let theirs = size
        let all = size
        const unshown: { key: string; expires: number; taken: number }[] = []
        for (const [each, kept] of this.state.entries<Entry>('marks')) {
          if (each === key || kept.expires <= this.now()) continue
          const taken = sealedSize(kept)
          all += taken
          if (!this.shows(contextOf(each)))
            unshown.push({ key: each, expires: kept.expires, taken })
          else if (ownerOf(each) === user.name) theirs += taken
        }
        if (theirs > MOST_PERSON) return OVER_YOURS
        // Past everyone's: what's of clusters not shown makes room, the longest unread first, and
        // only where that's room enough.
        const freed: string[] = []
        for (const { key: each, taken } of unshown.sort((a, b) => a.expires - b.expires)) {
          if (all <= MOST_ALL) break
          all -= taken
          freed.push(each)
        }
        if (all > MOST_ALL) return OVER_ALL
        for (const each of freed) this.state.delete('marks', each)
        if (freed.length > 0) {
          const clusters = new Set(freed.map(contextOf)).size
          log(
            `Pins and saved views kept for ${clusters === 1 ? 'a cluster' : `${clusters} clusters`} this server doesn’t show now were let go, longest unread first, to keep everyone’s within 400 kB.`,
          )
        }
        this.state.set('marks', key, entry)
        return undefined
      },
    }
  }
}

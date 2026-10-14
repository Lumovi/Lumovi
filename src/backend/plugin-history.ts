/**
 * What a plugin's pages read, held to what the audit history lists. Everything a plugin's code
 * reads as the person is in the history, or it isn't made: the cluster's objects, a pod's logs,
 * an ask of its tool's server. A history lists only so much, and a plugin's code chooses what
 * its page reads and how often: left to itself it could fill a history that keeps only so much
 * and push what a person did out of it, or bury one read among thousands.
 *
 * So a plugin's pages make at most so many different reads in a while, in one cluster
 * (`READ_LIMITS.differentAWhile`). Each ask takes its place before anything is made of it; the
 * same ask again in the while has its place already, as a page keeps what it shows up to date
 * by reading it again. Past them a new ask is refused, before its file, the cluster or anything
 * else is asked, until the while ends; and Lumovi says so in two entries of its own, one at the
 * first refusal and one at the while's end with how many there were.
 *
 * An ask makes one entry, whatever comes of it; a second only when a read that first wasn't made
 * (refused, or failed) is made after all, so that a read that was made is never in the history
 * as one that wasn't. And asks that come to the same thing (the same read, the same refusal)
 * are one entry a while, as they were.
 *
 * Counted where it's made: the desktop app has one count, and on a server each page's
 * connection has its own, so two tabs are two counts and a page loaded again starts anew. A
 * plugin's code can open neither a tab nor a connection.
 */
import { READ_LIMITS } from '@shared/plugin-reads'
import { whose } from '@shared/plugins'
import type { KnownPlugin } from '@shared/plugins-known'
import type { Recorded, Recorder } from './audit/recorder'

/** An ask's place among a while's different reads: where what came of it is written. */
export interface Place {
  /**
   * What came of the ask, with what makes it the same entry as another's: written once for the
   * ask (and once more if it's then made), and once a while for the key.
   */
  record(key: string, input: Recorded): void
}

/** No place left: how long until the while ends, in minutes. */
export interface NoPlace {
  refused: 'too-many-reads'
  minutes: number
}

export interface PluginHistory {
  /**
   * A place for an ask of a plugin's page, before anything is made of it. `ask` is what makes
   * it the same ask as another: the page's own words, kept here for the while and written
   * nowhere. `plugin` is the plugin as the backend knows it.
   */
  take(plugin: Readonly<KnownPlugin>, cluster: string, ask: string): Place | NoPlace
  /**
   * An entry for a name Lumovi hasn't in use: nothing is ever made for one, and it's one entry
   * a while by the recorder's own count (no text of a page's is in such a key).
   */
  unknown(key: string, input: Recorded): void
  /** As Lumovi stops, or a page's connection ends: what was refused is said now. */
  stop(): void
}

/** The time, and a wait: a test's own, where it counts ten minutes in a moment. */
export interface HistoryClock {
  now(): number
  /** Runs `run` after `ms`. What it gives back calls the wait off. */
  after(ms: number, run: () => void): () => void
}

const CLOCK: HistoryClock = {
  now: () => Date.now(),
  after: (ms, run) => {
    const timer = setTimeout(run, ms)
    // (Nothing waits for it: Lumovi stopping says what's left, in `stop`.)
    timer.unref()
    return () => clearTimeout(timer)
  },
}

/** A plugin's while in one cluster. */
interface While {
  since: number
  /** The asks that have a place, each with what's written of it so far. */
  asks: Map<string, { written?: 'not made' | 'made' }>
  /** The entries written, by what makes each the same. */
  listed: Set<string>
  /** Asks refused for want of a place. */
  refused: number
  /** The plugin, as the entries of Lumovi's own name it. */
  who: Record<string, string>
  label: string
  cluster: string
  off(): void
}

export function pluginHistory(audit: Recorder, clock: HistoryClock = CLOCK): PluginHistory {
  const whiles = new Map<string, While>()
  const { differentAWhile, whileMs } = READ_LIMITS
  /** A while's end: how many asks were refused, if any were. */
  const end = (id: string) => {
    const ended = whiles.get(id)
    if (!ended) return
    whiles.delete(id)
    ended.off()
    if (ended.refused === 0) return
    audit.record({
      action: 'plugin.read',
      outcome: 'refused',
      cluster: ended.cluster,
      summary: `Refused for the plugin ${whose(ended.label)} page, past what Lumovi lists: ${ended.refused.toLocaleString('en-US')} ${ended.refused === 1 ? 'read' : 'reads'}`,
      details: { ...ended.who, refused: 'too-many-reads', reads: ended.refused },
    })
  }
  return {
    take(plugin, cluster, ask) {
      const id = JSON.stringify([cluster, plugin.name])
      // (A wait that's late ends its while here.)
      const before = whiles.get(id)
      if (before && clock.now() - before.since >= whileMs) end(id)
      let now = whiles.get(id)
      if (!now) {
        now = {
          since: clock.now(),
          asks: new Map(),
          listed: new Set(),
          refused: 0,
          who: {
            plugin: plugin.name,
            pluginVersion: plugin.version,
            pluginDigest: plugin.digest,
            ...(plugin.codeDigest === undefined ? {} : { codeDigest: plugin.codeDigest }),
          },
          label: plugin.label ?? plugin.name,
          cluster,
          off: clock.after(whileMs, () => end(id)),
        }
        whiles.set(id, now)
      }
      const during = now
      let place = during.asks.get(ask)
      if (!place) {
        if (during.asks.size >= differentAWhile) {
          // No place: refused, counted, and said once, in Lumovi's words alone. (Nothing of the
          // ask is kept, not even to tell it from the next: each is one more.)
          const minutes = Math.max(1, Math.ceil((during.since + whileMs - clock.now()) / 60_000))
          if (during.refused++ === 0) {
            audit.record({
              action: 'plugin.read',
              outcome: 'refused',
              cluster,
              summary: `The plugin ${whose(during.label)} page asked to read more than Lumovi lists in ten minutes: its new reads are refused for the next ${minutes === 1 ? 'minute' : `${minutes} minutes`}`,
              details: { ...during.who, refused: 'too-many-reads', listed: differentAWhile },
            })
          }
          return { refused: 'too-many-reads', minutes }
        }
        during.asks.set(ask, (place = {}))
      }
      const mine = place
      return {
        record(key, input) {
          const made = input.outcome === 'success'
          // One entry an ask; and where that one says it wasn't made, one more once it is.
          if (mine.written === 'made' || (mine.written === 'not made' && !made)) return
          mine.written = made ? 'made' : 'not made'
          // (The same thing as another ask came to: one entry a while.)
          if (during.listed.has(key)) return
          during.listed.add(key)
          audit.record(input)
        },
      }
    },
    unknown: (key, input) => audit.read(key, input),
    stop() {
      for (const id of [...whiles.keys()]) end(id)
    },
  }
}

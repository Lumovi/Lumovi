/**
 * What a server sets for each of its clusters, the same for everyone on it: which are read-only
 * (who made them so, and when), where their metrics come from, where their node shells run, and,
 * in a fleet, the name, labels and groups its Fleet page sets.
 * Kept with what a restart mustn't lose (state.ts), read again every few seconds (another replica
 * may change it), and changed by Lumovi's admins (or, where it has none, anyone). By its
 * context's name: a cluster renamed doesn't keep what was set for it.
 *
 * Whoever can write where it's kept can't make an entry (they're sealed), but can delete one, or
 * put back an older one. What holds all the same (tests/web/read-only-replicas.spec.ts checks it
 * after every step of seeded random runs), wherever state is kept but in memory:
 *
 * 1. Read-only doesn't go off but by someone who may turn it off: turned off outside Lumovi, it's
 *    on again at the next refresh of a replica that knew it on, as it was last turned on, which
 *    refuses changes to the cluster all along. (A replica that knew only an older on can follow
 *    a copy that turned it off before it was last turned on, until then.)
 * 2. Node shells and the metrics source likewise: as someone who may last set them, through
 *    Lumovi, on every replica that knew it, from its next refresh; never an older copy's.
 * 3. Lumovi's own changes, on any replica, in whatever order of reads, writes, conflicts and
 *    failed writes, are never recorded as made outside it.
 * 4. A copy put back (or a deletion) is recorded once by each replica that finds it behind what
 *    it knew (the first to, and one that knew more than that one's fix holds), never more often
 *    than such things were done since it started, naming the copy where entries tell it apart
 *    (`found`: its count; none for a deletion).
 * 5. What a key no longer in use opens doesn't outlive its last change (the rotation, or the end
 *    of a rollout) by more than the grace period, and while it lasts, it's left as it is: never
 *    taken for entries deleted (state.ts).
 * 6. A store full of junk shaped like entries never holds a replica up for long (state.ts).
 *
 * How: each setting in an entry carries the count of the write that last set it (unset too), and
 * each write counts above the entry it's written over, and above everything in it, and no less
 * than the time (so that one made again, after one was deleted while no replica ran, counts above
 * any older copy). Lumovi never sets a setting below what it was: one counting lower than a
 * replica knew was put back outside Lumovi (or deleted). Whoever finds that keeps each setting as
 * whichever of the two set it last; read-only, if either has it (a copy that has it, over a newer
 * one without, made it so outside Lumovi, to be confirmed); marks it until someone who may sets
 * read-only again; and records it. Lumovi's changes are made over the entry as it's kept when
 * they're written, and over the fix of what was lost, where something was. As settings are each
 * as last set, it doesn't matter which replica fixes what, from how old a view, nor in what order.
 *
 * A setting the entry a replica knows never had is unset as of that entry, where what's found is
 * no newer: an older copy's (from before the entry was made again, after a deletion) is put back
 * as unset, and recorded; its read-only, kept, as made outside Lumovi.
 *
 * Limits:
 * - A replica that starts knows nothing older, and takes what's kept as it finds it.
 * - Two writes of the same setting, by replicas that didn't see each other's (one written over a
 *   copy put back), come out by their clocks: a replica whose clock is behind loses to older
 *   copies from correct clocks, as does one writing in the same millisecond.
 * - An entry made again after a deletion, then an older copy put back and written over by a
 *   replica that never read the new entry, keeps that copy's settings (unrecorded).
 * - A copy that was itself written over a deletion is named, put back, as a deletion.
 * - Replicas on two keys for longer than the grace period let each other's entries go (LMV-94).
 * - A state key is one install's.
 */
import { isDeepStrictEqual } from 'node:util'
import type { AuditLog } from '@backend/audit/log'
import { KubeRequestError } from '@backend/kube/errors'
import type { ChangedOutside, MetricsSourceSetting, NodeShellSetting } from '@shared/api'
import type { FleetSetting } from '@shared/fleet'
import type { SessionUser } from '@shared/server'
import type { ServerAccess } from './access'
import { SERVER_ACTOR } from './audit'
import { log } from './log'
import type { ServerState } from './state'

/** How often what's kept is read again. */
const REFRESH_MS = 10_000

/** A cluster's, as kept (by its context's name). */
export interface ClusterEntry {
  /** Who made it read-only, and when; `outside` where an older copy, put back, made it so. */
  readOnly?: { by: string; at: string; outside?: true }
  metricsSource?: MetricsSourceSetting
  nodeShell?: NodeShellSetting
  /** A fleet's: what its page sets (each field its source leaves unset). */
  fleet?: FleetSetting
  /** A change made outside Lumovi, found and dealt with: shown until read-only is set again. */
  outside?: ChangedOutside
  /** The count of the write that last set each of those (unset too). */
  counts?: Partial<Record<Field, number>>
  /** This one's count: above the entry it was written over and all in it, no less than the time. */
  version?: number
  /** The counts of the entries it was written over, latest first (a few). */
  trail?: number[]
}

/** What an entry sets, each counted by the write that last set it. */
const FIELDS = ['readOnly', 'metricsSource', 'nodeShell', 'fleet', 'outside'] as const
type Field = (typeof FIELDS)[number]
/** How many entries back an entry says it was written over (enough to name a copy). */
const TRAIL = 4

/** The settings besides read-only, which have nothing stricter: as Lumovi last set them. */
const OTHERS = ['metricsSource', 'nodeShell', 'fleet'] as const
const AUDITED = {
  metricsSource: 'metrics-source.changed',
  nodeShell: 'node-shell.changed',
  fleet: 'cluster-settings.changed',
} as const
const SAID = {
  metricsSource: 'metrics source was',
  nodeShell: 'node shells were',
  fleet: 'name, labels and groups on the Fleet page were',
} as const
const KEPT_AS = {
  metricsSource: 'its metrics source as it set it',
  nodeShell: 'its node shells as it set them',
  fleet: 'its name, labels and groups as it set them',
} as const

/** What's kept of an entry: nothing that's unset. */
const kept = (entry: ClusterEntry): ClusterEntry =>
  Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined))

const countOf = (entry: ClusterEntry | undefined, field: Field): number =>
  entry?.counts?.[field] ?? 0

/** The highest count in an entry. */
const top = (entry: ClusterEntry | undefined): number =>
  Math.max(entry?.version ?? 0, ...FIELDS.map((field) => countOf(entry, field)))

/** Whether `now` lost something `was` had: a setting put back as it was before, or deleted. */
const behind = (was: ClusterEntry, now: ClusterEntry | undefined): boolean =>
  FIELDS.some((field) => countOf(now, field) < countOf(was, field))

/**
 * The copy `now` is, or was written over, that a replica knowing `was` found, by its count: the
 * latest in its trail that `was` doesn't count above (fresher ones are writes, by replicas that
 * didn't know better, over it). None, where it was deleted, or written over a deletion.
 */
function foundIn(was: ClusterEntry, now: ClusterEntry | undefined): number | null {
  if (!now) return null
  const trail = [now.version ?? 0, ...(now.trail ?? [])]
  const found = trail.find((version) => version <= (was.version ?? 0))
  if (found !== undefined) return found
  return trail.length > TRAIL ? trail.at(-1)! : null
}

/** A change made outside Lumovi, as it's dealt with: the stricter, and what that took. */
interface Fix {
  how: ChangedOutside['how']
  readOnly: ChangedOutside['readOnly']
  restored: ChangedOutside['restored']
  found: number | null
  fixed: ClusterEntry
}

/**
 * `now` found where Lumovi's `was` was, behind it (gone, or an older copy): each setting from
 * whichever set it last; read-only where either has it (a copy's, over a newer one without, as made
 * so outside Lumovi); and what changed, marked. Counted by `version`, the write it's made in.
 */
function fixOf(was: ClusterEntry, now: ClusterEntry | undefined, at: string, version: number): Fix {
  const how = now ? 'replaced' : 'deleted'
  // A setting `was` never had is unset as of `was`, where `now` is no newer: one set in an older
  // copy is from before `was` was made again (after a deletion), not a change made knowing it.
  const older = !now || !((now.version ?? 0) > (was.version ?? 0))
  const before = (field: Field) => older && countOf(was, field) === 0
  const from = (field: Field) =>
    countOf(now, field) > countOf(was, field) && !before(field) ? now! : was
  const counts: Partial<Record<Field, number>> = Object.fromEntries(
    FIELDS.map((field) => [field, countOf(from(field), field)]).filter(([, count]) => count),
  )
  let readOnly = from('readOnly').readOnly
  let what: Fix['readOnly'] = 'kept'
  if (from('readOnly') === was && was.readOnly && !now?.readOnly) what = 'restored'
  else if (!readOnly && now?.readOnly) {
    readOnly = { ...now.readOnly, outside: true }
    counts.readOnly = version
    what = 'made'
  }
  const restored = OTHERS.filter(
    (key) => from(key) === was && !isDeepStrictEqual(was[key], now?.[key]),
  )
  const changed = what !== 'kept' || restored.length > 0
  if (changed) counts.outside = version
  return {
    how,
    readOnly: what,
    restored,
    found: foundIn(was, now),
    fixed: kept({
      readOnly,
      metricsSource: from('metricsSource').metricsSource,
      nodeShell: from('nodeShell').nodeShell,
      fleet: from('fleet').fleet,
      outside: changed ? { at, how, readOnly: what, restored } : from('outside').outside,
      counts,
    }),
  }
}

/** For tests: the time it is. */
export interface ClusterSettingsOptions {
  now?: () => number
}

export class ClusterSettings {
  readonly #listeners = new Set<() => void>()
  readonly #refresher?: NodeJS.Timeout
  readonly #now: () => number

  constructor(
    private readonly state: ServerState,
    private readonly access: ServerAccess,
    private readonly audit: AuditLog,
    options: ClusterSettingsOptions = {},
  ) {
    this.#now = options.now ?? Date.now
    if (state.kept !== 'memory') {
      this.#refresher = setInterval(() => void this.refresh(), REFRESH_MS)
      this.#refresher.unref()
    }
  }

  get #entries(): [string, ClusterEntry][] {
    return this.state.entries<ClusterEntry>('clusters')
  }

  isReadOnly(context: string): boolean {
    return this.state.get<ClusterEntry>('clusters', context)?.readOnly !== undefined
  }

  /** Who made `context` read-only, and when, if it is. */
  readOnly(context: string): ClusterEntry['readOnly'] {
    return this.state.get<ClusterEntry>('clusters', context)?.readOnly
  }

  /** Who made each read-only, and when; or that an older copy, put back, made it so. */
  readOnlyBy(): Record<string, NonNullable<ClusterEntry['readOnly']>> {
    return Object.fromEntries(
      this.#entries.flatMap(([context, { readOnly }]) => (readOnly ? [[context, readOnly]] : [])),
    )
  }

  /** The clusters whose settings were changed outside Lumovi, as each was dealt with. */
  changedOutside(): Record<string, ChangedOutside> {
    return Object.fromEntries(
      this.#entries.flatMap(([context, entry]) =>
        entry.outside ? [[context, entry.outside]] : [],
      ),
    )
  }

  metricsSources(): Record<string, MetricsSourceSetting> {
    return Object.fromEntries(
      this.#entries.flatMap(([context, entry]) =>
        entry.metricsSource ? [[context, entry.metricsSource]] : [],
      ),
    )
  }

  nodeShells(): Record<string, NodeShellSetting> {
    return Object.fromEntries(
      this.#entries.flatMap(([context, entry]) =>
        entry.nodeShell ? [[context, entry.nodeShell]] : [],
      ),
    )
  }

  /** A fleet's: what its page sets for each cluster. */
  fleetSettings(): Record<string, FleetSetting> {
    return Object.fromEntries(
      this.#entries.flatMap(([context, entry]) => (entry.fleet ? [[context, entry.fleet]] : [])),
    )
  }

  /**
   * A fleet's: what its page sets for `context`, which its admins alone change (none, where it
   * has none: who sees a cluster is theirs to say).
   */
  setFleet(context: string, setting: FleetSetting, user: SessionUser): void {
    if (!this.access.administered || !this.access.isAdmin(user)) {
      throw new KubeRequestError(
        'not-allowed',
        'Only Lumovi’s admins change a cluster’s settings on the Fleet page.',
        403,
      )
    }
    const fleet = Object.keys(setting).length ? setting : undefined
    this.#change(context, user, ['fleet'], (entry) => ({ ...entry, fleet }))
  }

  /** A fleet's: what its page set for `context`, let go by Lumovi (it was another cluster's). */
  dropFleet(context: string): void {
    this.#change(context, undefined, ['fleet'], (entry) => ({ ...entry, fleet: undefined }))
  }

  /** Why `user` may not change them, or nothing when they may. */
  whyNot(user: SessionUser): string | undefined {
    return this.access.administered && !this.access.isAdmin(user)
      ? 'Only Lumovi’s admins change what’s set for everyone on this server.'
      : undefined
  }

  /** Read-only, as someone who may sets it: which settles a change made outside Lumovi. */
  setReadOnly(context: string, readOnly: boolean, user: SessionUser): void {
    this.#change(context, user, ['readOnly', 'outside'], (entry) => ({
      ...entry,
      readOnly: readOnly
        ? // Kept as it was, but where it's to be confirmed: then it's theirs, who confirm it.
          entry.readOnly && !entry.outside && !entry.readOnly.outside
          ? entry.readOnly
          : { by: user.name, at: new Date(this.#now()).toISOString() }
        : undefined,
      outside: undefined,
    }))
  }

  setMetricsSource(context: string, setting: MetricsSourceSetting, user: SessionUser): void {
    this.#change(context, user, ['metricsSource'], (entry) => ({
      ...entry,
      metricsSource: setting,
    }))
  }

  /** Where `context`'s node shells run; null goes back to the server's default. */
  setNodeShell(context: string, setting: NodeShellSetting | null, user: SessionUser): void {
    this.#change(context, user, ['nodeShell'], (entry) => ({
      ...entry,
      nodeShell: setting ?? undefined,
    }))
  }

  /** Tells `listener` whenever they change (here, or as another replica kept them). */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  close(): void {
    clearInterval(this.#refresher)
  }

  /**
   * What's kept, read again (every few seconds; at once, for tests): another replica's changes
   * taken, and what was changed outside Lumovi fixed before anything sees it.
   */
  async refresh(): Promise<void> {
    const fixes: [string, ClusterEntry, (current: unknown) => unknown][] = []
    const read = this.state.refresh('clusters', (fresh, before) => {
      for (const [context, was] of before as Map<string, ClusterEntry>) {
        const now = fresh.get(context) as ClusterEntry | undefined
        if (!behind(was, now)) continue
        const settle = this.#settler(context, was)
        const fixed = settle(now)!
        fresh.set(context, fixed)
        // Written over what's kept then: over a newer change of Lumovi's, that change (unless
        // it's behind too, a replica's that didn't know better: then that, fixed).
        fixes.push([context, fixed, (current) => settle(current as ClusterEntry | undefined)])
      }
    })
    if (!(await read.catch(() => false))) return
    for (const [context, fixed, rebase] of fixes) {
      this.state.set('clusters', context, fixed, rebase)
    }
    if (fixes.length) void this.state.flush()
    this.#tell()
  }

  /**
   * What a replica that knew `was` makes of each entry it finds: as it is, where it isn't behind
   * it; else fixed, counted as written over it, and recorded, once for each copy found.
   */
  #settler(
    context: string,
    was: ClusterEntry,
  ): (now: ClusterEntry | undefined) => ClusterEntry | undefined {
    const fixes = new Map<string, ClusterEntry>()
    const recorded = new Set<number | null>()
    return (now) => {
      if (!behind(was, now)) return now
      const id = JSON.stringify(now ?? null)
      if (!fixes.has(id)) {
        const version = this.#next(now, was)
        const fix = fixOf(was, now, new Date(this.#now()).toISOString(), version)
        if (!recorded.has(fix.found)) this.#record(context, fix)
        recorded.add(fix.found)
        fixes.set(id, this.#stamped(fix.fixed, now, version))
      }
      return fixes.get(id)
    }
  }

  /**
   * A change, by someone who may, of `fields`: counted by its write, above the entry it's written
   * over (as it's kept then: over the fix of what was lost, where something was) and all in it.
   */
  #change(
    context: string,
    /** Who changes it; none, Lumovi itself. */
    user: SessionUser | undefined,
    fields: readonly Field[],
    change: (entry: ClusterEntry) => ClusterEntry,
  ): void {
    const why = user && this.whyNot(user)
    if (why) throw new KubeRequestError('not-allowed', why, 403)
    const based = this.state.get<ClusterEntry>('clusters', context)
    const settle = based ? this.#settler(context, based) : (now: ClusterEntry | undefined) => now
    const made = (over: ClusterEntry | undefined) => {
      const entry = settle(over) ?? {}
      const version = this.#next(over, entry)
      const counts = { ...entry.counts }
      for (const field of fields) counts[field] = version
      return this.#stamped({ ...change(entry), counts }, over, version)
    }
    this.state.set('clusters', context, made(based), (current) =>
      made(current as ClusterEntry | undefined),
    )
    void this.state.flush()
    this.#tell()
  }

  /** A write's count: above what it's written over and everything in what it writes, and no less than now. */
  #next(over: ClusterEntry | undefined, entry: ClusterEntry | undefined): number {
    return Math.max(this.#now(), top(over) + 1, top(entry) + 1)
  }

  /** `entry`, as written over `over` with `version`. */
  #stamped(entry: ClusterEntry, over: ClusterEntry | undefined, version: number): ClusterEntry {
    const { version: _version, trail: _trail, ...rest } = entry
    return kept({
      ...rest,
      version,
      trail: over ? [over.version ?? 0, ...(over.trail ?? [])].slice(0, TRAIL) : [],
    })
  }

  /** A change made outside Lumovi, as it's fixed: recorded in the audit log, and said. */
  #record(context: string, fix: Fix): void {
    const done =
      fix.how === 'deleted'
        ? 'its setting was deleted where Lumovi keeps it'
        : 'an older copy of its setting was put back where Lumovi keeps it'
    const record = (action: Parameters<AuditLog['record']>[0]['action'], summary: string) =>
      this.audit.record({
        action,
        outcome: 'success',
        actor: SERVER_ACTOR,
        cluster: context,
        summary: `Changed outside Lumovi: ${summary}`,
        details: {
          outside: true,
          how: fix.how,
          // The copy found, by its count (none, where it was deleted).
          found: fix.found,
          readOnly: fix.fixed.readOnly !== undefined,
        },
      })
    if (fix.readOnly === 'restored') {
      record(
        'read-only.changed',
        `${context}’s read-only was turned off, as ${done}, and Lumovi made it read-only again`,
      )
    } else if (fix.readOnly === 'made') {
      record('read-only.changed', `${context} was made read-only for everyone, as ${done}`)
    }
    for (const key of fix.restored) {
      record(
        AUDITED[key],
        `${context}’s ${SAID[key]} changed, as ${done}, and Lumovi put back what it last set`,
      )
    }
    const kept = [
      ...(fix.readOnly === 'restored' ? ['read-only again'] : []),
      ...(fix.readOnly === 'made' ? ['read-only'] : []),
      ...fix.restored.map((key) => KEPT_AS[key]),
    ]
    log(
      kept.length
        ? `What’s set for ${context} was changed outside Lumovi: ${done}. Lumovi kept the stricter (${kept.join(', ')}), and it’s recorded in the audit log.`
        : `What’s set for ${context} was changed outside Lumovi (${done}), but nothing it sets.`,
    )
  }

  #tell(): void {
    for (const listener of this.#listeners) listener()
  }
}

/**
 * What's said where `context` is read-only for everyone on the server: who made it so, or that
 * it was made so outside Lumovi (nothing where it isn't). Not when: the server doesn't know the
 * reader's time zone, and the page says when in theirs.
 */
export function readOnlyWhy(
  readOnly: ClusterEntry['readOnly'],
  context: string,
): string | undefined {
  if (!readOnly) return undefined
  return readOnly.outside
    ? `${context} is read-only for everyone on this server: it was made so outside Lumovi.`
    : `${context} is read-only for everyone on this server: ${readOnly.by} made it so.`
}

/**
 * What a server sets for each of its clusters, the same for everyone on it: which are read-only
 * (who made them so, and when), where their metrics come from, and where their node shells run.
 *
 * Kept with what a restart mustn't lose (state.ts), and read again every few seconds, as another
 * replica may change it. Lumovi's admins change it, or, where it has none, anyone. By its
 * context's name: a cluster renamed doesn't keep what was set for it.
 *
 * Whoever can write where it's kept can't make an entry (they're sealed), but could delete one,
 * or put back an older one: read-only off, unseen. So each entry carries a count that only grows
 * (from the time it's changed, so that an entry made again, after one was deleted while no
 * replica ran, counts above any older copy), and stays when nothing else is set. An entry gone,
 * or not counting above what a running replica knew, was changed outside Lumovi. It's recorded
 * in the audit log, and kept as the stricter of the two, failing closed: read-only if either was,
 * and the rest as Lumovi last set it, never an older copy's. Marked in the entry, it's shown to
 * those who may set read-only, on every replica, until one of them does. (Changed while no
 * replica runs, a replica that starts takes it as it finds it: it knows nothing older.)
 *
 * A fix counts just above what it's made from, so that a replica knowing something newer (an
 * admin's change another replica hadn't read yet) takes it for what it is, and fixes it from its
 * own, newer view. Lumovi's own changes, and fixes, are made again over the entry as it's kept
 * when they're written: over another replica's newer change, theirs stands; over a copy put
 * back, it's fixed first.
 */
import { isDeepStrictEqual } from 'node:util'
import type { AuditLog } from '@backend/audit/log'
import { KubeRequestError } from '@backend/kube/errors'
import type { ChangedOutside, MetricsSourceSetting, NodeShellSetting } from '@shared/api'
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
  /** Only ever more: above what it was, and, for Lumovi's own changes, no less than their time. */
  version?: number
  /** A change made outside Lumovi, found and dealt with: shown until read-only is set again. */
  outside?: ChangedOutside
}

/** The settings besides read-only, which have nothing stricter: as Lumovi last set them. */
const OTHERS = ['metricsSource', 'nodeShell'] as const
const AUDITED = {
  metricsSource: 'metrics-source.changed',
  nodeShell: 'node-shell.changed',
} as const
const SAID = { metricsSource: 'metrics source was', nodeShell: 'node shells were' } as const
const KEPT_AS = {
  metricsSource: 'its metrics source as it set it',
  nodeShell: 'its node shells as it set them',
} as const

/** What's kept of an entry: nothing that's unset. */
const kept = (entry: ClusterEntry): ClusterEntry =>
  Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined))

/** A change made outside Lumovi, as it's dealt with: the stricter, and what that took. */
interface Fix {
  how: ChangedOutside['how']
  readOnly: ChangedOutside['readOnly']
  restored: ChangedOutside['restored']
  fixed: ClusterEntry
}

/**
 * `now` found where Lumovi's `was` was (gone, or an older copy): the stricter of the two, counting
 * just above both. Read-only where either is (as it was where it was: who made it so is known),
 * else as the copy has it, made so outside Lumovi; the rest as `was`.
 */
function fixOf(was: ClusterEntry, now: ClusterEntry | undefined, at: string): Fix {
  const how = now ? 'replaced' : 'deleted'
  const readOnly =
    was.readOnly ?? (now?.readOnly ? { ...now.readOnly, outside: true as const } : undefined)
  const what: Fix['readOnly'] =
    was.readOnly && !now?.readOnly ? 'restored' : !was.readOnly && now?.readOnly ? 'made' : 'kept'
  const restored = OTHERS.filter((key) => !isDeepStrictEqual(was[key], now?.[key]))
  const changed = what !== 'kept' || restored.length > 0
  return {
    how,
    readOnly: what,
    restored,
    fixed: kept({
      readOnly,
      metricsSource: was.metricsSource,
      nodeShell: was.nodeShell,
      outside: changed ? { at, how, readOnly: what, restored } : was.outside,
      version: Math.max(was.version ?? 0, now?.version ?? 0) + 1,
    }),
  }
}

export class ClusterSettings {
  readonly #listeners = new Set<() => void>()
  readonly #refresher?: NodeJS.Timeout

  constructor(
    private readonly state: ServerState,
    private readonly access: ServerAccess,
    private readonly audit: AuditLog,
  ) {
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

  /** Who made each read-only, and when. */
  readOnlyBy(): Record<string, { by: string; at: string }> {
    return Object.fromEntries(
      this.#entries.flatMap(([context, { readOnly }]) =>
        readOnly ? [[context, { by: readOnly.by, at: readOnly.at }]] : [],
      ),
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

  /** Why `user` may not change them, or nothing when they may. */
  whyNot(user: SessionUser): string | undefined {
    return this.access.administered && !this.access.isAdmin(user)
      ? 'Only Lumovi’s admins change what’s set for everyone on this server.'
      : undefined
  }

  /** Read-only, as someone who may sets it: which settles a change made outside Lumovi. */
  setReadOnly(context: string, readOnly: boolean, user: SessionUser): void {
    this.#change(context, user, (entry) => ({
      ...entry,
      readOnly: readOnly
        ? // Kept as it was, but where it's to be confirmed: then it's theirs, who confirm it.
          entry.readOnly && !entry.outside && !entry.readOnly.outside
          ? entry.readOnly
          : { by: user.name, at: new Date().toISOString() }
        : undefined,
      outside: undefined,
    }))
  }

  setMetricsSource(context: string, setting: MetricsSourceSetting, user: SessionUser): void {
    this.#change(context, user, (entry) => ({ ...entry, metricsSource: setting }))
  }

  /** Where `context`'s node shells run; null goes back to the server's default. */
  setNodeShell(context: string, setting: NodeShellSetting | null, user: SessionUser): void {
    this.#change(context, user, (entry) => ({ ...entry, nodeShell: setting ?? undefined }))
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
   * taken, and what was changed outside Lumovi dealt with.
   */
  async refresh(): Promise<void> {
    const before = new Map(this.#entries)
    if (!(await this.state.refresh('clusters').catch(() => false))) return
    for (const [context, was] of before) {
      const now = this.state.get<ClusterEntry>('clusters', context)
      if (this.#ownOrSame(was, now)) continue
      this.#keepFixed(context, was, this.#fix(context, was, now))
    }
    this.#tell()
  }

  /** Whether `now` is Lumovi's own (counting above `was`), or as `was` is. */
  #ownOrSame(was: ClusterEntry, now: ClusterEntry | undefined): boolean {
    if (!was.version) return true
    return now !== undefined && ((now.version ?? 0) > was.version || isDeepStrictEqual(now, was))
  }

  /**
   * A change, by someone who may: counting above the entry it's made from, and no less than now.
   * Written over the entry as it's kept then: over another replica's newer change, made again
   * from theirs; over a copy put back, made over its fix (recorded once).
   */
  #change(context: string, user: SessionUser, change: (entry: ClusterEntry) => ClusterEntry): void {
    const why = this.whyNot(user)
    if (why) throw new KubeRequestError('not-allowed', why, 403)
    const based = this.state.get<ClusterEntry>('clusters', context)
    const made = (entry: ClusterEntry) =>
      kept({ ...change(entry), version: Math.max(Date.now(), (entry.version ?? 0) + 1) })
    const fixes = new Map<string, Fix>()
    this.state.set('clusters', context, made(based ?? {}), (current) => {
      const now = current as ClusterEntry | undefined
      if (!based || this.#ownOrSame(based, now)) return made(now ?? {})
      // Found as it's written: fixed (and recorded) once, however often it's tried.
      const key = JSON.stringify(now ?? null)
      if (!fixes.has(key)) fixes.set(key, this.#fix(context, based, now))
      return made(fixes.get(key)!.fixed)
    })
    void this.state.flush()
    this.#tell()
  }

  /** A fix, kept: over a newer change by Lumovi meanwhile, that change stands. */
  #keepFixed(context: string, was: ClusterEntry, { fixed }: Fix): void {
    this.state.set('clusters', context, fixed, (current) => {
      const now = current as ClusterEntry | undefined
      return now && (now.version ?? 0) > (was.version ?? 0) ? now : fixed
    })
    void this.state.flush()
  }

  /** `now` found where `was` was, outside Lumovi: its fix, recorded in the audit log. */
  #fix(context: string, was: ClusterEntry, now: ClusterEntry | undefined): Fix {
    const fix = fixOf(was, now, new Date().toISOString())
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
        details: { outside: true, how: fix.how, readOnly: fix.fixed.readOnly !== undefined },
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
    return fix
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

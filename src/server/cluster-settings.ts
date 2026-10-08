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
 * (from the time it's written, so that an entry made again, after one was deleted while no
 * replica ran, counts above any older copy), and stays when nothing else is set. An entry gone,
 * or not counting above what a running replica knew, was changed outside Lumovi. It's recorded
 * in the audit log, and kept as the stricter of the two, failing closed: read-only if either was,
 * and the rest as Lumovi last set it, never an older copy's. Marked in the entry, it's shown to
 * those who may set it, on every replica, until one of them does. (Changed while no replica runs,
 * a replica that starts takes it as it finds it: it knows nothing older.)
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
  /** Only ever more: from the time Lumovi wrote it, and above what it was. */
  version?: number
  /** A change made outside Lumovi, found and dealt with: shown until Lumovi's next change. */
  outside?: ChangedOutside
}

/** The settings besides read-only, which have nothing stricter: as Lumovi last set them. */
const OTHERS = ['metricsSource', 'nodeShell'] as const
const AUDITED = {
  metricsSource: 'metrics-source.changed',
  nodeShell: 'node-shell.changed',
} as const
const NAMED = { metricsSource: 'metrics source', nodeShell: 'node shells' } as const

/** A count above each of `counts`, and no less than now. */
const above = (...counts: (number | undefined)[]) =>
  Math.max(Date.now(), ...counts.map((count) => (count ?? 0) + 1))

/** What's kept of an entry: nothing that's unset. */
const kept = (entry: ClusterEntry): ClusterEntry =>
  Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined))

export class ClusterSettings {
  readonly #listeners = new Set<() => void>()
  readonly #refresher?: NodeJS.Timeout

  constructor(
    private readonly state: ServerState,
    private readonly access: ServerAccess,
    private readonly audit: AuditLog,
  ) {
    if (state.kept !== 'memory') {
      this.#refresher = setInterval(() => void this.#refresh(), REFRESH_MS)
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

  setReadOnly(context: string, readOnly: boolean, user: SessionUser): void {
    this.#change(context, user, (entry) => ({
      ...entry,
      readOnly: readOnly
        ? // Kept as it was, but where it's to be confirmed: then it's theirs, who confirm it.
          entry.readOnly && !entry.outside && !entry.readOnly.outside
          ? entry.readOnly
          : { by: user.name, at: new Date().toISOString() }
        : undefined,
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
   * A change, by someone who may: over the entry as it's kept (as another replica wrote it, if one
   * did meanwhile), counting above it. It settles a change made outside Lumovi, if one's shown.
   */
  #change(context: string, user: SessionUser, change: (entry: ClusterEntry) => ClusterEntry): void {
    const why = this.whyNot(user)
    if (why) throw new KubeRequestError('not-allowed', why, 403)
    const next = (current: unknown) => {
      const entry = (current ?? {}) as ClusterEntry
      return kept({ ...change(entry), outside: undefined, version: above(entry.version) })
    }
    this.state.set('clusters', context, next(this.state.get('clusters', context)), next)
    void this.state.flush()
    this.#tell()
  }

  async #refresh(): Promise<void> {
    const before = new Map(this.#entries)
    if (!(await this.state.refresh('clusters').catch(() => false))) return
    for (const [context, was] of before) {
      if (!was.version) continue
      const now = this.state.get<ClusterEntry>('clusters', context)
      // As Lumovi changed it, on this replica or another, counting above it; or as it was.
      if (now && (now.version ?? 0) > was.version) continue
      if (now && isDeepStrictEqual(now, was)) continue
      this.#changedOutside(context, was, now)
    }
    this.#tell()
  }

  /**
   * An entry deleted, or an older copy of it put back, where it's kept: recorded, and kept as the
   * stricter of what was and what's there (read-only if either is; the rest as Lumovi last set
   * it), marked, and counting above both, so that other replicas take it as Lumovi's own.
   */
  #changedOutside(context: string, was: ClusterEntry, now: ClusterEntry | undefined): void {
    const how = now ? 'replaced' : 'deleted'
    const done =
      how === 'deleted'
        ? 'its setting was deleted where Lumovi keeps it'
        : 'an older copy of its setting was put back where Lumovi keeps it'
    const at = new Date().toISOString()
    // Read-only where either is: as it was where it was (who made it so is known), else as the
    // copy has it, made so outside Lumovi.
    const readOnly =
      was.readOnly ?? (now?.readOnly ? { ...now.readOnly, outside: true as const } : undefined)
    const what: ChangedOutside['readOnly'] =
      was.readOnly && !now?.readOnly ? 'restored' : !was.readOnly && now?.readOnly ? 'made' : 'kept'
    const restored = OTHERS.filter((key) => !isDeepStrictEqual(was[key], now?.[key]))
    const record = (action: Parameters<AuditLog['record']>[0]['action'], summary: string) =>
      this.audit.record({
        action,
        outcome: 'success',
        actor: SERVER_ACTOR,
        cluster: context,
        summary: `Changed outside Lumovi: ${summary}`,
        details: { outside: true, how, readOnly: readOnly !== undefined },
      })
    if (what === 'restored') {
      record(
        'read-only.changed',
        `${context}’s read-only was turned off, as ${done}, and Lumovi made it read-only again`,
      )
    } else if (what === 'made') {
      record('read-only.changed', `${context} was made read-only for everyone, as ${done}`)
    }
    for (const key of restored) {
      record(
        AUDITED[key],
        `${context}’s ${NAMED[key]} were changed, as ${done}, and Lumovi put back what it last set`,
      )
    }
    const changed = what !== 'kept' || restored.length > 0
    log(
      changed
        ? `What’s set for ${context} was changed outside Lumovi: ${done}. Lumovi kept the stricter (${[
            ...(what === 'restored' ? ['read-only again'] : what === 'made' ? ['read-only'] : []),
            ...restored.map((key) => `its ${NAMED[key]} as it set them`),
          ].join(', ')}), and it’s recorded in the audit log.`
        : `What’s set for ${context} was changed outside Lumovi (${done}), but nothing it sets.`,
    )
    const fixed: ClusterEntry = kept({
      readOnly,
      metricsSource: was.metricsSource,
      nodeShell: was.nodeShell,
      outside: changed ? { at, how, readOnly: what, restored: [...restored] } : was.outside,
      version: above(was.version, now?.version),
    })
    // Over another replica's write meanwhile: counting above it too.
    this.state.set('clusters', context, fixed, (current) => ({
      ...fixed,
      version: above(fixed.version, (current as ClusterEntry | undefined)?.version),
    }))
    void this.state.flush()
  }

  #tell(): void {
    for (const listener of this.#listeners) listener()
  }
}

/**
 * What's said where `context` is read-only for everyone on the server: who made it so (nothing
 * where it isn't). Not when: the server doesn't know the reader's time zone, and the page says
 * when in theirs.
 */
export function readOnlyWhy(
  readOnly: ClusterEntry['readOnly'],
  context: string,
): string | undefined {
  if (!readOnly) return undefined
  return `${context} is read-only for everyone on this server: ${readOnly.by} made it so.`
}

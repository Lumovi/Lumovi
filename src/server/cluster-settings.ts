/**
 * What a server sets for each of its clusters, the same for everyone on it: which are read-only
 * (who made them so, and when), where their metrics come from, and where their node shells run.
 *
 * Kept with what a restart mustn't lose (state.ts), and read again every few seconds, as another
 * replica may change it. Lumovi's admins change it, or, where it has none, anyone. By its
 * context's name: a cluster renamed doesn't keep what was set for it.
 *
 * Whoever can write where it's kept can't make an entry (they're sealed), but could delete one,
 * or put back an older one: read-only off, unseen. So each entry counts how many times Lumovi
 * changed it, only ever more, and stays when nothing else is set. An entry gone, or counting less
 * than a replica knew, was changed outside Lumovi: where that turned read-only on or off, it's
 * recorded in the audit log, and shown to those who may set it, until one does. (Changed while no
 * replica runs, or before one ever read it, it can't be told from Lumovi's own.)
 */
import type { AuditLog } from '@backend/audit/log'
import { KubeRequestError } from '@backend/kube/errors'
import type { MetricsSourceSetting, NodeShellSetting, ReadOnlyChangedOutside } from '@shared/api'
import type { SessionUser } from '@shared/server'
import type { ServerAccess } from './access'
import { SERVER_ACTOR } from './audit'
import { log } from './log'
import type { ServerState } from './state'

/** How often what's kept is read again. */
const REFRESH_MS = 10_000

/** A cluster's, as kept (by its context's name). */
export interface ClusterEntry {
  readOnly?: { by: string; at: string }
  metricsSource?: MetricsSourceSetting
  nodeShell?: NodeShellSetting
  /** How many times Lumovi changed it, only ever more. */
  version?: number
}

export class ClusterSettings {
  readonly #listeners = new Set<() => void>()
  readonly #refresher?: NodeJS.Timeout
  /** Clusters whose read-only was changed outside Lumovi, until someone who may sets it again. */
  readonly #outside = new Map<string, ReadOnlyChangedOutside>()

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
      this.#entries.flatMap(([context, entry]) =>
        entry.readOnly ? [[context, entry.readOnly]] : [],
      ),
    )
  }

  /** Clusters whose read-only was changed outside Lumovi, since the server started. */
  readOnlyChangedOutside(): Record<string, ReadOnlyChangedOutside> {
    return Object.fromEntries(this.#outside)
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
        ? (entry.readOnly ?? { by: user.name, at: new Date().toISOString() })
        : undefined,
    }))
    // Set by someone who may, as they chose it: a change made outside Lumovi is settled.
    this.#outside.delete(context)
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

  #change(context: string, user: SessionUser, change: (entry: ClusterEntry) => ClusterEntry): void {
    const why = this.whyNot(user)
    if (why) throw new KubeRequestError('not-allowed', why, 403)
    const entry = this.state.get<ClusterEntry>('clusters', context) ?? {}
    this.#keep(context, { ...change(entry), version: (entry.version ?? 0) + 1 })
    this.#tell()
  }

  /** An entry, as it's kept: never deleted (its count stays, so that its going says so too). */
  #keep(context: string, entry: ClusterEntry): void {
    const kept = Object.fromEntries(
      Object.entries(entry).filter(([, value]) => value !== undefined),
    )
    this.state.set('clusters', context, kept)
    void this.state.flush()
  }

  async #refresh(): Promise<void> {
    const before = new Map(this.#entries)
    if (!(await this.state.refresh('clusters').catch(() => false))) return
    for (const [context, was] of before) {
      if (!was.version) continue
      const now = this.state.get<ClusterEntry>('clusters', context)
      // As Lumovi changed it, on this replica or another: its count went on.
      if (now && (now.version ?? 0) >= was.version) continue
      this.#changedOutside(context, was, now)
    }
    this.#tell()
  }

  /**
   * An entry deleted, or put back as it once was, where it's kept: recorded where read-only went
   * on or off, then kept as it is now, counting on from what was known, so that it's recorded
   * once, by whichever replica found it first.
   */
  #changedOutside(context: string, was: ClusterEntry, now: ClusterEntry | undefined): void {
    const how = now ? 'replaced' : 'deleted'
    const done =
      how === 'deleted'
        ? 'its setting was deleted where Lumovi keeps it'
        : 'an older copy of its setting was put back where Lumovi keeps it'
    const readOnly = now?.readOnly !== undefined
    if (readOnly !== (was.readOnly !== undefined)) {
      this.audit.record({
        action: 'read-only.changed',
        outcome: 'success',
        actor: SERVER_ACTOR,
        cluster: context,
        summary: `Changed outside Lumovi: ${context} is ${readOnly ? 'read-only' : 'no longer read-only'} for everyone on this server, as ${done}`,
        details: {
          outside: true,
          how,
          readOnly,
          ...(was.readOnly ? { was: `read-only, by ${was.readOnly.by}, ${was.readOnly.at}` } : {}),
        },
      })
      this.#outside.set(context, { at: new Date().toISOString(), how, readOnly })
      log(
        `${context}’s read-only was turned ${readOnly ? 'on' : 'off'} outside Lumovi: ${done}. It’s recorded in the audit log.`,
      )
    } else {
      log(`What’s set for ${context} was changed outside Lumovi (${done}), but not its read-only.`)
    }
    this.#keep(context, { ...now, version: was.version! + 1 })
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

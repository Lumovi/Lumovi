/**
 * What a server sets for each of its clusters, the same for everyone on it: which are read-only
 * (who made them so, and when), where their metrics come from, and where their node shells run.
 *
 * Kept with what a restart mustn't lose (state.ts), and read again every few seconds, as another
 * replica may change it. Lumovi's admins change it, or, where it has none, anyone.
 */
import { KubeRequestError } from '@backend/kube/errors'
import type { MetricsSourceSetting, NodeShellSetting } from '@shared/api'
import type { SessionUser } from '@shared/server'
import type { ServerAccess } from './access'
import type { ServerState } from './state'

/** How often what's kept is read again. */
const REFRESH_MS = 10_000

/** A cluster's, as kept (by its context's name). */
export interface ClusterEntry {
  readOnly?: { by: string; at: string }
  metricsSource?: MetricsSourceSetting
  nodeShell?: NodeShellSetting
}

export class ClusterSettings {
  readonly #listeners = new Set<() => void>()
  readonly #refresher?: NodeJS.Timeout

  constructor(
    private readonly state: ServerState,
    private readonly access: ServerAccess,
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
    const next = change(this.state.get<ClusterEntry>('clusters', context) ?? {})
    const kept = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined))
    if (Object.keys(kept).length) this.state.set('clusters', context, kept)
    else this.state.delete('clusters', context)
    void this.state.flush()
    this.#tell()
  }

  async #refresh(): Promise<void> {
    if (await this.state.refresh('clusters').catch(() => false)) this.#tell()
  }

  #tell(): void {
    for (const listener of this.#listeners) listener()
  }
}

/**
 * What's said where `context` is read-only for everyone on the server: who made it so, and when
 * (nothing where it isn't).
 */
export function readOnlyWhy(
  readOnly: ClusterEntry['readOnly'],
  context: string,
): string | undefined {
  if (!readOnly) return undefined
  const day = new Date(readOnly.at).toISOString().slice(0, 10)
  return `${context} is read-only for everyone on this server: ${readOnly.by} made it so on ${day}.`
}

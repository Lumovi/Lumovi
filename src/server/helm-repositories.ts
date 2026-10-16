/**
 * A server's chart repositories (LMV-354): the same for everyone who uses it, kept in its state
 * (state.ts), each entry sealed with the state's key, a sign-in's password or token with it. That
 * is never sent anywhere but where the sign-in goes: not to the page, not to Helm, not to the
 * audit log (which says it was set, replaced or removed). Only Lumovi's admins add, change and
 * remove them; everyone reads the list.
 */
import {
  RepositoryReads,
  type KeptRepository,
  type RepositoryKeeper,
} from '@backend/helm/repositories'
import type { ServerState } from './state'

/** As it's kept: the repository, and its sign-in's secret. */
type Entry = KeptRepository & { secret?: string }

export class ServerRepositories implements RepositoryKeeper {
  readonly kept = 'server' as const
  /** What's read of them: the same for everyone, so read once for all. */
  readonly reads = new RepositoryReads()

  constructor(private readonly state: ServerState) {}

  noSignIns(): string | undefined {
    return undefined
  }

  /** As they're kept now (another replica may have changed them). */
  async list(): Promise<KeptRepository[]> {
    // (Kept only in memory, there's no other replica: what's here is all there is.)
    if (this.state.kept !== 'memory') await this.state.refresh('repositories')
    return this.state
      .entries<Entry>('repositories')
      .map(([, { secret: _secret, ...repository }]) => repository)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async put(repository: KeptRepository, secret: string | null | undefined): Promise<void> {
    const kept = (current: unknown): Entry => {
      const before = (current as Entry | undefined)?.secret
      const sealed =
        repository.username === undefined || secret === null ? undefined : (secret ?? before)
      return { ...repository, ...(sealed ? { secret: sealed } : {}) }
    }
    this.state.set(
      'repositories',
      repository.id,
      kept(this.state.get('repositories', repository.id)),
      kept,
    )
    // Said done only once it's kept.
    await this.state.flush({ strict: true })
  }

  async remove(id: string): Promise<void> {
    this.state.delete('repositories', id)
    await this.state.flush({ strict: true })
  }

  async secret(id: string): Promise<string | undefined> {
    return this.state.get<Entry>('repositories', id)?.secret
  }
}

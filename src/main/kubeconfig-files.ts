/**
 * The kubeconfig files the desktop app reads: those chosen in Lumovi (kept in its settings), or
 * else KUBECONFIG's, or ~/.kube/config. Merged as kubectl merges them (the first file to name a
 * cluster, user or context wins), and read where they are: Lumovi never writes them. An
 * organization's policy can keep it to the default (`kubeconfigFiles: "locked"`).
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { KubeconfigFiles as Files, ManagedSettings, Result } from '@shared/api'
import type { KubeConfigStore } from '@backend/kube/kubeconfig'
import { KubeRequestError, toKubeError } from '@backend/kube/errors'
import type { SettingsStore } from './settings'

/** Why the files can't be chosen in Lumovi, by the organization's policy, if they can't. */
export function lockedBy(managed: ManagedSettings | undefined): string | undefined {
  if (!managed?.kubeconfigFilesLocked) return undefined
  return managed.problem
    ? `Your organization’s policy can’t be used (${managed.source}), so Lumovi reads only KUBECONFIG’s kubeconfig, or ~/.kube/config, until it’s put right.`
    : `Your organization’s policy (${managed.source}) keeps Lumovi to KUBECONFIG’s kubeconfig, or ~/.kube/config.`
}

export class KubeconfigFiles {
  constructor(
    private readonly deps: {
      settings: SettingsStore
      store: KubeConfigStore
      managed: ManagedSettings | undefined
      /** Asks for files (the system's file picker); null if the person cancels. */
      pick: () => Promise<string[] | null>
      /** Shows a file in Finder or Explorer. */
      reveal: (path: string) => void
    },
  ) {}

  list(): Files {
    const { paths, from } = this.deps.store.paths()
    const locked = lockedBy(this.deps.managed)
    return {
      files: paths.map((path) => ({ path, exists: existsSync(path) })),
      from,
      ...(locked ? { locked } : {}),
    }
  }

  /** In place of those read (`replace`), or after them (`add`). */
  async choose(how: 'replace' | 'add'): Promise<Result<Files | null>> {
    try {
      this.#mayChange()
      const picked = await this.deps.pick()
      if (!picked?.length) return { ok: true, data: null }
      const before = how === 'add' ? this.#read() : []
      return { ok: true, data: this.#keep([...before, ...picked]) }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /** No longer read: the file itself is left as it is. The last gone, the default again. */
  remove(path: string): Result<Files> {
    try {
      this.#mayChange()
      return { ok: true, data: this.#keep(this.#read().filter((file) => file !== path)) }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /** Back to KUBECONFIG's, or ~/.kube/config. */
  useDefault(): Result<Files> {
    try {
      this.#mayChange()
      return { ok: true, data: this.#keep([]) }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /** Only one of those read: not any path the page names. */
  show(path: string): void {
    if (this.#read().includes(path)) this.deps.reveal(path)
  }

  #mayChange(): void {
    const locked = lockedBy(this.deps.managed)
    if (locked) throw new KubeRequestError('not-allowed', locked, 403)
  }

  /** Those read now, each where it is (a relative one in KUBECONFIG, from where Lumovi started). */
  #read(): string[] {
    return this.deps.store.paths().paths.map((path) => resolve(path))
  }

  /** Kept (each once, in order), and read again. */
  #keep(files: string[]): Files {
    this.deps.settings.update({ kubeconfigFiles: [...new Set(files.map((file) => resolve(file)))] })
    this.deps.store.load()
    return this.list()
  }
}

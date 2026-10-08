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

  /** Each where it is (what show and remove take), and which Lumovi was given. */
  list(): Files {
    const { base, added, from } = this.deps.store.paths()
    const locked = lockedBy(this.deps.managed)
    const file = (path: string, more: { added?: true; removable?: true }) => ({
      path: resolve(path),
      exists: existsSync(path),
      ...more,
    })
    return {
      files: [
        ...base.map((path) => file(path, from === 'chosen' ? { removable: true } : {})),
        ...added.map((path) => file(path, { added: true, removable: true })),
      ],
      from,
      ...(locked ? { locked } : {}),
    }
  }

  /**
   * In place of those read (`replace`: added ones too), or after them (`add`: those before still
   * come from KUBECONFIG, if that's where they come from).
   */
  async choose(how: 'replace' | 'add'): Promise<Result<Files | null>> {
    try {
      this.#mayChange()
      const picked = await this.deps.pick()
      if (!picked?.length) return { ok: true, data: null }
      const { chosen, added } = this.deps.settings.kubeconfigFiles()
      return {
        ok: true,
        data:
          how === 'replace' ? this.#keep(picked, []) : this.#keep(chosen, [...added, ...picked]),
      }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /**
   * One Lumovi was given, no longer read; the file itself is left as it is. The last chosen
   * gone, KUBECONFIG's are read again. KUBECONFIG's own (or the default) aren't Lumovi's to drop.
   */
  remove(path: string): Result<Files> {
    try {
      this.#mayChange()
      const { chosen, added } = this.deps.settings.kubeconfigFiles()
      if (added.includes(path)) return { ok: true, data: this.#keep(chosen, without(added, path)) }
      if (chosen.includes(path)) return { ok: true, data: this.#keep(without(chosen, path), added) }
      throw new KubeRequestError(
        'invalid',
        this.deps.store.paths().from === 'env'
          ? `${path} is in KUBECONFIG, which Lumovi reads as it’s set: change KUBECONFIG, or choose a kubeconfig in its place.`
          : `${path} is read where no other kubeconfig is chosen: choose one in its place.`,
      )
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /** Back to KUBECONFIG's, or ~/.kube/config, and nothing added. */
  useDefault(): Result<Files> {
    try {
      this.#mayChange()
      return { ok: true, data: this.#keep([], []) }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /** Only one of those read: not any path the page names. */
  show(path: string): void {
    if (this.list().files.some((file) => file.path === path)) this.deps.reveal(path)
  }

  #mayChange(): void {
    const locked = lockedBy(this.deps.managed)
    if (locked) throw new KubeRequestError('not-allowed', locked, 403)
  }

  /** Kept (each where it is, once, in order), and read again. */
  #keep(chosen: string[], added: string[]): Files {
    const kubeconfigFiles = [...new Set(chosen.map((file) => resolve(file)))]
    const kubeconfigAdded = [...new Set(added.map((file) => resolve(file)))].filter(
      (file) => !kubeconfigFiles.includes(file),
    )
    this.deps.settings.update({ kubeconfigFiles, kubeconfigAdded })
    this.deps.store.load()
    return this.list()
  }
}

/** A list, without `path`. */
const without = (files: string[], path: string) => files.filter((file) => file !== path)

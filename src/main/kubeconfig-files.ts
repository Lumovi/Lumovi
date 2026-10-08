/**
 * The kubeconfig files the desktop app reads: those chosen in Lumovi (kept in its settings), or
 * else KUBECONFIG's, or ~/.kube/config. Merged as kubectl merges them (the first file to name a
 * cluster, user or context wins), and read where they are: Lumovi never writes them. An
 * organization's policy can keep it to the default (`kubeconfigFiles: "locked"`).
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
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
      /** Where Lumovi keeps the clusters added in it. */
      ownFolder: string
    },
  ) {}

  /** Each where it is (what show and remove take), and which Lumovi was given, or keeps. */
  list(): Files {
    const { base, added, own, from } = this.deps.store.paths()
    const locked = lockedBy(this.deps.managed)
    const results = this.deps.store.results()
    const file = (
      path: string,
      origin: Files['files'][number]['origin'],
      more: { added?: true; removable?: true; own?: true },
    ) => {
      const result = results.get(path)
      return {
        path: resolve(path),
        exists: existsSync(path),
        origin,
        ...more,
        ...(result && 'problem' in result ? { problem: result.problem } : {}),
        ...(result && 'contexts' in result ? { contexts: result.contexts.length } : {}),
      }
    }
    return {
      files: [
        ...base.map((path) => file(path, from, from === 'chosen' ? { removable: true } : {})),
        ...added.map((path) => file(path, 'added', { added: true, removable: true })),
        ...own.map((path) => ({ ...file(path, 'own', { own: true }), addedAt: addedAt(path) })),
      ],
      from,
      ...(locked ? { locked } : {}),
      home: homedir(),
      ownFolder: this.deps.ownFolder,
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
      const { own, from } = this.deps.store.paths()
      if (own.includes(path)) {
        throw new KubeRequestError(
          'invalid',
          `${path} is a cluster added in Lumovi: remove it there.`,
        )
      }
      throw new KubeRequestError(
        'invalid',
        from === 'env'
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

  /** One Lumovi was given that's gone, chosen again where it is now, in its place. */
  async chooseAgain(path: string): Promise<Result<Files | null>> {
    try {
      this.#mayChange()
      const { chosen, added } = this.deps.settings.kubeconfigFiles()
      if (!chosen.includes(path) && !added.includes(path)) {
        throw new KubeRequestError('invalid', `${path} isn’t one Lumovi was given.`)
      }
      const [picked] = (await this.deps.pick()) ?? []
      if (!picked) return { ok: true, data: null }
      const instead = (files: string[]) => files.map((file) => (file === path ? picked : file))
      return { ok: true, data: this.#keep(instead(chosen), instead(added)) }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /** Only one of those read, or Lumovi's own folder: not any path the page names. */
  show(path: string): void {
    if (path === this.deps.ownFolder || this.list().files.some((file) => file.path === path)) {
      this.deps.reveal(path)
    }
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

/** When one of Lumovi's own was made (or last written, where a disk doesn't keep that). */
function addedAt(path: string): string | undefined {
  try {
    const { birthtimeMs, mtimeMs } = statSync(path)
    return new Date(birthtimeMs || mtimeMs).toISOString()
  } catch {
    return undefined
  }
}

/** A list, without `path`. */
const without = (files: string[], path: string) => files.filter((file) => file !== path)

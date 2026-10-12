/**
 * The kubeconfig files the desktop app reads: those chosen in Lumovi (kept in its settings), or
 * else KUBECONFIG's, or ~/.kube/config; those added after them; and the kubeconfigs in the
 * folders added. Merged as kubectl merges them (the first file to name a cluster, user or
 * context wins), and read where they are: Lumovi never writes them. An organization's policy can
 * keep it to the default (`kubeconfigFiles: "locked"`).
 *
 * What a folder's kubeconfig has its credentials do on this computer is asked first, as for a
 * cluster added in Lumovi (folder-consents.ts).
 */
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { relative, resolve, isAbsolute } from 'node:path'
import type {
  KubeconfigFiles as Files,
  ManagedSettings,
  PastedKubeconfig,
  Result,
} from '@shared/api'
import type { FileResults, KubeConfigStore } from '@backend/kube/kubeconfig'
import { KubeRequestError, toKubeError } from '@backend/kube/errors'
import { agreedTo } from './consent'
import { asksOf, consentsOf, rawOf } from './folder-consents'
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
      /** Asks for a folder (the system's folder picker); null if the person cancels. */
      pickFolder: () => Promise<string | null>
      /** Shows a file in Finder or Explorer. */
      reveal: (path: string) => void
      /** Where Lumovi keeps the clusters added in it. */
      ownFolder: string
    },
  ) {}

  /** Each where it is (what show and remove take), and which Lumovi was given, or keeps. */
  list(): Files {
    const { base, added, folders, own, from } = this.deps.store.paths()
    const locked = lockedBy(this.deps.managed)
    const results = this.deps.store.results()
    const file = (
      path: string,
      origin: Files['files'][number]['origin'],
      more: { added?: true; removable?: true; own?: true },
    ) => ({
      path: resolve(path),
      exists: existsSync(path),
      origin,
      ...more,
      ...asRead(results, path),
      ...this.#refused(results, path),
    })
    return {
      files: [
        ...base.map((path) => file(path, from, from === 'chosen' ? { removable: true } : {})),
        ...added.map((path) => file(path, 'added', { added: true, removable: true })),
        ...own.map((path) => ({ ...file(path, 'own', { own: true }), addedAt: addedAt(path) })),
      ],
      folders: folders.map(({ folder, read, files }) => ({
        path: resolve(folder),
        ...(read.problem ? { problem: read.problem } : {}),
        files: read.files
          .filter(({ path }) => files.includes(path))
          .map(({ name, path }) => {
            const asks = this.#asking(results, path)
            return {
              name,
              path: resolve(path),
              ...asRead(results, path),
              ...(asks ? { asks } : {}),
              ...this.#refused(results, path),
            }
          }),
        skipped: read.skipped,
      })),
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
      const { chosen, added, folders } = this.deps.settings.kubeconfigFiles()
      return {
        ok: true,
        data:
          how === 'replace'
            ? this.#keep(picked, [], folders)
            : this.#keep(chosen, [...added, ...picked], folders),
      }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /** A folder whose kubeconfigs are read, after those read already. */
  async addFolder(): Promise<Result<Files | null>> {
    try {
      this.#mayChange()
      const picked = await this.deps.pickFolder()
      if (!picked) return { ok: true, data: null }
      const { chosen, added, folders } = this.deps.settings.kubeconfigFiles()
      return { ok: true, data: this.#keep(chosen, added, [...folders, picked]) }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /**
   * One Lumovi was given (a file or a folder), no longer read; the file or folder itself is left
   * as it is. The last chosen gone, KUBECONFIG's are read again. KUBECONFIG's own (or the
   * default) aren't Lumovi's to drop.
   */
  remove(path: string): Result<Files> {
    try {
      this.#mayChange()
      const { chosen, added, folders } = this.deps.settings.kubeconfigFiles()
      if (added.includes(path)) {
        return { ok: true, data: this.#keep(chosen, without(added, path), folders) }
      }
      if (chosen.includes(path)) {
        return { ok: true, data: this.#keep(without(chosen, path), added, folders) }
      }
      if (folders.includes(path)) {
        return { ok: true, data: this.#keep(chosen, added, without(folders, path)) }
      }
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

  /** Back to KUBECONFIG's, or ~/.kube/config, and nothing added (no folder either). */
  useDefault(): Result<Files> {
    try {
      this.#mayChange()
      return { ok: true, data: this.#keep([], [], []) }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /** One Lumovi was given that's gone, chosen again where it is now, in its place. */
  async chooseAgain(path: string): Promise<Result<Files | null>> {
    try {
      this.#mayChange()
      const { chosen, added, folders } = this.deps.settings.kubeconfigFiles()
      if (!chosen.includes(path) && !added.includes(path)) {
        throw new KubeRequestError('invalid', `${path} isn’t one Lumovi was given.`)
      }
      const [picked] = (await this.deps.pick()) ?? []
      if (!picked) return { ok: true, data: null }
      const instead = (files: string[]) => files.map((file) => (file === path ? picked : file))
      return { ok: true, data: this.#keep(instead(chosen), instead(added), folders) }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /**
   * What a folder's context has its credentials do that isn't agreed to yet, exactly as it would
   * do it: to be allowed, or not.
   */
  asks(context: string): Result<PastedKubeconfig> {
    try {
      const { parts, agreed } = this.#folderContext(context)
      const asks = asksOf(rawOf(parts))
      const open = <T extends { consent: string }>(list: T[]) =>
        list.filter(({ consent }) => !agreedTo(agreed, consent))
      return {
        ok: true,
        data: {
          ...asks,
          commands: open(asks.commands),
          tokenFiles: open(asks.tokenFiles),
          unverified: open(asks.unverified),
        },
      }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /**
   * What the person allowed of a folder's context, kept: only what it does now (as `asks` gave
   * it), so nothing else can be agreed to through it.
   */
  agree(context: string, consents: string[]): Result<Files> {
    try {
      const { parts } = this.#folderContext(context)
      const now = consentsOf(asksOf(rawOf(parts)))
      const given = consents.filter((consent) => agreedTo(now, consent))
      if (given.length === 0) {
        throw new KubeRequestError('invalid', `What was allowed isn’t what “${context}” does now.`)
      }
      this.deps.settings.agreeTo(parts.context.file, given)
      this.deps.store.load()
      return { ok: true, data: this.list() }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /** Only one of those read, a folder read, or Lumovi's own folder: not any path the page names. */
  show(path: string): void {
    const files = this.list()
    if (
      path === this.deps.ownFolder ||
      files.files.some((file) => file.path === path) ||
      files.folders.some(
        (folder) => folder.path === path || folder.files.some((file) => file.path === path),
      )
    ) {
      this.deps.reveal(path)
    }
  }

  #mayChange(): void {
    const locked = lockedBy(this.deps.managed)
    if (locked) throw new KubeRequestError('not-allowed', locked, 403)
  }

  /** A context any part of which is a folder's, as read, and what's agreed to for it. */
  #folderContext(context: string) {
    this.#mayChange()
    const parts = this.deps.store.parts(context)
    if (!parts || !this.deps.store.fromFolder(context)) {
      throw new KubeRequestError('invalid', `“${context}” isn’t a context of a folder’s.`)
    }
    // One that takes parts across a folder's kubeconfig isn't offered: it's refused.
    const unwhole = this.deps.store.unwhole(context)
    if (unwhole) throw new KubeRequestError('invalid', unwhole)
    return { parts, agreed: this.deps.settings.kubeconfigConsents(parts.context.file) }
  }

  /** Why its contexts that take parts across a folder's kubeconfig aren't used, if any don't. */
  #refused(results: FileResults, path: string): { refused?: string[] } {
    const result = results.get(path)
    if (!result || !('contexts' in result)) return {}
    const refused = result.contexts
      .filter((name) => this.deps.store.parts(name)?.context.file === path)
      .flatMap((name) => this.deps.store.unwhole(name) ?? [])
    return refused.length > 0 ? { refused } : {}
  }

  /** How many of a folder's kubeconfig's contexts ask before they're used. */
  #asking(results: FileResults, path: string): number {
    const result = results.get(path)
    if (!result || !('contexts' in result)) return 0
    return result.contexts.filter((name) => this.deps.store.refusal(name)).length
  }

  /** Kept (each where it is, once, in order), and read again. */
  #keep(chosen: string[], added: string[], folders: string[]): Files {
    const kubeconfigFiles = [...new Set(chosen.map((file) => resolve(file)))]
    const kubeconfigAdded = [...new Set(added.map((file) => resolve(file)))].filter(
      (file) => !kubeconfigFiles.includes(file),
    )
    const kubeconfigFolders = [...new Set(folders.map((folder) => resolve(folder)))]
    this.deps.settings.update({ kubeconfigFiles, kubeconfigAdded, kubeconfigFolders })
    // What was agreed to for a folder's files, forgotten with the folder.
    this.deps.settings.forgetConsents((file) =>
      kubeconfigFolders.some((folder) => inside(folder, file)),
    )
    this.deps.store.load()
    return this.list()
  }
}

/** A file as last read: how many contexts it has, or why it couldn't be read, or both (kept). */
function asRead(results: FileResults, path: string) {
  const result = results.get(path)
  if (!result) return {}
  return {
    ...('problem' in result ? { problem: result.problem } : {}),
    ...('contexts' in result ? { contexts: result.contexts.length } : {}),
    ...('keptFrom' in result
      ? {
          keptFrom: new Date(result.keptFrom).toISOString(),
          failedAt: new Date(result.failedAt).toISOString(),
        }
      : {}),
  }
}

/** Whether a file is somewhere in a folder (a link's file, where it leads in it). */
function inside(folder: string, file: string): boolean {
  const way = relative(folder, file)
  return !!way && !way.startsWith('..') && !isAbsolute(way)
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

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { KubeConfig } from '@kubernetes/client-node'
import type { ContextsResult } from '@shared/api'
import { plain } from '@shared/plugins'
import { withProxy } from '../network'
import { KubeRequestError } from './errors'
import { kubeconfigText, readFolder, type FolderRead } from './folders'

/** Resolves kubeconfig locations the same way kubectl does. */
export function kubeconfigPaths(env: NodeJS.ProcessEnv): string[] {
  const fromEnv = (env.KUBECONFIG ?? '').split(delimiter).filter(Boolean)
  return fromEnv.length > 0 ? fromEnv : [join(homedir(), '.kube', 'config')]
}

/**
 * What each file read came to: the contexts it names, or why it couldn't be read; or both, where
 * it couldn't be read now and what it said when it last could is kept (`keptFrom`: when it was
 * written so; `failedAt`: when it first couldn't be read since).
 */
export type FileResults = Map<
  string,
  | { contexts: string[] }
  | { problem: string }
  | { contexts: string[]; problem: string; keptFrom: number; failedAt: number }
>

/** A file's last good read: its text, as read, and when it was written so. */
export interface GoodRead {
  kc: KubeConfig
  text: string
  writtenAt: number
  /** When it first couldn't be read since. */
  failedAt?: number
}

/** The file each cluster, user and context is taken from: the first to name it. */
export interface Whence {
  clusters: Map<string, string>
  users: Map<string, string>
  contexts: Map<string, string>
}

const noWhence = (): Whence => ({ clusters: new Map(), users: new Map(), contexts: new Map() })

/**
 * Loads and merges kubeconfig files with kubectl semantics: missing files are
 * skipped, and the first file to define a name (or a current context) wins. A file that
 * can't be read fails the whole, as kubectl does, unless `results` is given: then it's
 * skipped, and why is noted there with what each other file came to; or, given its last good
 * read (`good`, kept up to date), that's taken in its place, said so. `whence` is told where
 * each name came from; `onlyFiles` are read only as files no larger than any kubeconfig.
 */
export function loadKubeConfig(
  paths: string[],
  env = process.env,
  options: {
    results?: FileResults
    good?: Map<string, GoodRead>
    whence?: Whence
    onlyFiles?: ReadonlySet<string>
  } = {},
): KubeConfig {
  const { results, good, whence, onlyFiles } = options
  const merged = { clusters: [], users: [], contexts: [], currentContext: '' } as {
    clusters: KubeConfig['clusters']
    users: KubeConfig['users']
    contexts: KubeConfig['contexts']
    currentContext: string
  }
  for (const file of paths.filter((path) => existsSync(path))) {
    let kc = new KubeConfig()
    try {
      // Read here too: one that can't be opened (not yours, a folder) is as one that can't be read.
      const text = onlyFiles?.has(file) ? fileText(file) : readFileSync(file, 'utf8')
      // kubectl treats an empty file as an empty config rather than an error.
      if (text.trim()) {
        kc.loadFromString(text)
        kc.makePathsAbsolute(dirname(file))
      }
      good?.set(file, { kc, text, writtenAt: writtenAt(file) })
      results?.set(file, { contexts: kc.contexts.map(({ name }) => name) })
    } catch (error) {
      // Only the reason and where: the parser quotes the lines around it, credentials and all.
      const reason = (error as Error).message.split('\n')[0]!
      if (!results) throw new Error(`Could not read ${file}: ${reason}`, { cause: error })
      const last = good?.get(file)
      if (!last || last.kc.contexts.length === 0) {
        results.set(file, { problem: reason })
        continue
      }
      // Caught half-written, say: what it said when it last could be read, until it can again.
      last.failedAt ??= Date.now()
      kc = last.kc
      results.set(file, {
        contexts: kc.contexts.map(({ name }) => name),
        problem: reason,
        keptFrom: last.writtenAt,
        failedAt: last.failedAt,
      })
    }
    addMissing(merged.clusters, kc.clusters, file, whence?.clusters)
    addMissing(merged.users, kc.users, file, whence?.users)
    addMissing(merged.contexts, kc.contexts, file, whence?.contexts)
    merged.currentContext ||= kc.currentContext
  }
  const kc = new KubeConfig()
  // Each cluster through the proxy the environment says, as kubectl would, unless its own does.
  kc.loadFromOptions({ ...merged, clusters: merged.clusters.map((c) => withProxy(c, env)) })
  return kc
}

function addMissing<T extends { name: string }>(
  target: T[],
  source: T[],
  file: string,
  from?: Map<string, string>,
): void {
  for (const entry of source) {
    if (target.some((existing) => existing.name === entry.name)) continue
    target.push(entry)
    from?.set(entry.name, file)
  }
}

/**
 * A name a kubeconfig gave, quoted, and set apart from the words around it, with what can't be
 * seen in it shown as its code point: a mark that turns text right to left (or one that would end
 * the isolate early) can't turn the sentence it's in.
 */
export const quoted = (name: string) => `“\u2068${plain(name)}\u2069”`

/** A file's text, if it's a file and no larger than any kubeconfig. */
function fileText(file: string): string {
  const read = kubeconfigText(file)
  if ('text' in read) return read.text
  // (As a folder's skipped files say it, so a file doesn't read otherwise for having been read.)
  if (read.skipped === 'large') throw new Error('it’s larger than 1 MB')
  if (read.skipped === 'not-allowed') throw new Error('Lumovi isn’t allowed to read it')
  throw new Error('it isn’t a file')
}

/** When a file was last written (now, where that can't be told). */
function writtenAt(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return Date.now()
  }
}

/**
 * The clusters Lumovi can show, and how to reach each: the user's
 * kubeconfig on the desktop, or the server's one cluster, on behalf of
 * whoever is signed in.
 */
export interface ClusterConfigs {
  /** The contexts there are (on the desktop, the kubeconfig is read again). */
  load(): ContextsResult
  /** A KubeConfig whose current context is `name`, with the credentials to use. */
  forContext(name: string): KubeConfig
  /**
   * Whether `name`'s lists may be watched, where that's not all of them: a fleet's cluster
   * reached through its agent isn't (what its tunnel carries has nothing to slow it).
   */
  watches?(name: string): boolean
}

/** Where a context, its cluster or its user is taken from: the file, and its text as read. */
export interface Source {
  name: string
  file: string
  text: string
}

/** The files Lumovi is given to read. */
export interface Given {
  chosen: string[]
  added: string[]
  own?: string[]
  /** Folders, each read for the kubeconfigs in it. */
  folders?: string[]
}

/**
 * Holds the merged kubeconfig and hands out per-context views of it: the files chosen in Lumovi
 * (on the desktop), or else KUBECONFIG's, or ~/.kube/config; then those added in Lumovi; then
 * Lumovi's own (clusters added in it, each a file of its own); then the kubeconfigs in the
 * folders added, folder by folder, so none of those stands in for an entry of the others. Read,
 * never written.
 *
 * A folder's kubeconfig is used whole: its contexts with its own clusters and users alone, and
 * none of those by a context anywhere else (a folder is the one place whose files aren't the
 * person's own choosing). Then its context is used only if `refuse` (given its parts, as read)
 * has nothing to say against it: what its credentials do there is agreed to.
 */
export class KubeConfigStore implements ClusterConfigs {
  #base = new KubeConfig()
  #perContext = new Map<string, KubeConfig>()
  #results: FileResults = new Map()
  /** Each file's last good read, while it's read. */
  readonly #good = new Map<string, GoodRead>()
  #whence = noWhence()
  #folders: { folder: string; read: FolderRead }[] = []
  /** What's said against each context, as last read. */
  readonly #refusals = new Map<string, string | undefined>()

  private readonly refuse?: (parts: {
    context: Source
    cluster?: Source
    user?: Source
  }) => string | undefined
  private readonly loaded?: () => void

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly given: () => Given = () => ({ chosen: [], added: [] }),
    options: {
      /** What's said against a folder's context, if anything. */
      refuse?: KubeConfigStore['refuse']
      /** Told each time it's read again (what's read may be other files now). */
      loaded?: () => void
    } = {},
  ) {
    this.refuse = options.refuse
    this.loaded = options.loaded
    this.load()
  }

  /**
   * The files read, in order: those before (`base`, from where `from` says), then those added,
   * then Lumovi's own, then the folders' kubeconfigs (each once).
   */
  paths(): {
    paths: string[]
    base: string[]
    added: string[]
    /** Each folder as last read, and those of its kubeconfigs read from it (not read before). */
    folders: { folder: string; read: FolderRead; files: string[] }[]
    own: string[]
    from: 'chosen' | 'env' | 'default'
  } {
    const { chosen, added, own = [] } = this.given()
    const from = chosen.length > 0 ? 'chosen' : this.env.KUBECONFIG ? 'env' : 'default'
    const base = chosen.length > 0 ? chosen : kubeconfigPaths(this.env)
    const seen = new Set(base.map((file) => resolve(file)))
    const after = (files: string[]) =>
      files.filter((file) => !seen.has(resolve(file)) && seen.add(resolve(file)))
    const addedAfter = after(added)
    const ownAfter = after(own)
    const folders = this.#folders.map(({ folder, read }) => ({
      folder,
      read,
      files: after(read.files.map(({ path }) => path)),
    }))
    return {
      paths: [...base, ...addedAfter, ...ownAfter, ...folders.flatMap(({ files }) => files)],
      base,
      added: addedAfter,
      folders,
      own: ownAfter,
      from,
    }
  }

  /** What each file read came to, as last read. */
  results(): FileResults {
    return this.#results
  }

  /**
   * The files read, as kubectl should read them too: without those that couldn't be (kubectl
   * would refuse them all for one), and without the folders' (kubectl would run what their
   * credentials run, agreed to or not).
   */
  readable(): string[] {
    const folders = this.#fromFolders()
    return this.paths().paths.filter((path) => {
      const result = this.#results.get(path)
      return !folders.has(path) && (!result || !('problem' in result))
    })
  }

  /** Whether a file is read as one of a folder's kubeconfigs. */
  inFolder(file: string): boolean {
    return this.#fromFolders().has(file)
  }

  /** Whether any part of a context (it, its cluster or its user) is taken from a folder. */
  fromFolder(name: string): boolean {
    return this.#parts(name).some((part) => part && this.#fromFolders().has(part.file))
  }

  /** A context, its cluster and its user, each from where it's taken, as read; if it's one. */
  parts(name: string): { context: Source; cluster?: Source; user?: Source } | undefined {
    const [context, cluster, user] = this.#parts(name)
    return context && { context, cluster, user }
  }

  /**
   * Re-reads the kubeconfig from disk. A file that can't be read is left out, and said so (or,
   * having been read before, what it said then is kept, said so); only when nothing else could
   * be read is that the error.
   */
  load(): ContextsResult {
    const { folders = [] } = this.given()
    // What each folder had, so one of its kubeconfigs caught half-written is still read.
    const had = new Map(this.#folders.map(({ folder, read }) => [folder, read]))
    this.#folders = folders.map((folder) => ({
      folder,
      read: readFolder(folder, new Set(had.get(folder)?.files.map(({ path }) => path))),
    }))
    const { paths } = this.paths()
    const source = paths.join(delimiter)
    this.#perContext.clear()
    this.#refusals.clear()
    for (const file of [...this.#good.keys()]) if (!paths.includes(file)) this.#good.delete(file)
    const results: FileResults = new Map()
    const whence = noWhence()
    try {
      this.#base = loadKubeConfig(paths, this.env, {
        results,
        good: this.#good,
        whence,
        onlyFiles: this.#fromFolders(),
      })
    } catch (error) {
      this.#base = new KubeConfig()
      this.#results = results
      this.#whence = noWhence()
      this.loaded?.()
      return { contexts: [], source, error: (error as Error).message }
    }
    this.#results = results
    this.#whence = whence
    this.loaded?.()
    const problems = [...results].flatMap(([path, result]) =>
      'problem' in result ? [{ path, message: result.problem }] : [],
    )
    const current = this.#base.getCurrentContext()
    if (problems.length > 0 && this.#base.getContexts().length === 0) {
      const [{ path, message }] = problems as [(typeof problems)[number]]
      return { contexts: [], source, problems, error: `Could not read ${path}: ${message}` }
    }
    return {
      source,
      ...(problems.length > 0 ? { problems } : {}),
      currentContext: current || undefined,
      contexts: this.#base.getContexts().map((context) => ({
        name: context.name,
        // The first file to name it, as kubectl takes it from.
        file: whence.contexts.get(context.name),
        cluster: context.cluster,
        user: context.user,
        namespace: context.namespace,
        server: this.#base.getCluster(context.cluster)?.server,
      })),
    }
  }

  /**
   * Why a context can't be used at all, if it takes parts across a folder's kubeconfig: a folder
   * file's context with a cluster or user from another file (another's, or one whose name was
   * taken before its own), or a context elsewhere with one from a folder file.
   */
  unwhole(name: string): string | undefined {
    const [context, cluster, user] = this.#parts(name)
    if (!context) return undefined
    const folders = this.#fromFolders()
    const borrowed = (
      [
        ['cluster', cluster],
        ['user', user],
      ] as const
    ).filter(([, part]) => part && part.file !== context.file)
    const kinds = (parts: typeof borrowed) => parts.map(([kind]) => kind)
    if (folders.has(context.file) && borrowed.length > 0) {
      // Its own file defines them too, under names another took first: it would get theirs.
      const own = this.#good.get(context.file)?.kc
      const taken = borrowed.filter(([kind, part]) =>
        (kind === 'cluster' ? own?.clusters : own?.users)?.some(({ name }) => name === part!.name),
      )
      if (taken.length === borrowed.length) {
        const what = taken
          .map(
            ([kind, part], index) => `${index === 0 ? '' : 'and '}a ${kind} ${quoted(part!.name)}`,
          )
          .join(' ')
        const have =
          taken.length > 1
            ? 'other kubeconfigs already have, so it would use those'
            : 'another kubeconfig already has, so it would use that one'
        return `${quoted(name)} names ${what} that ${have}. A kubeconfig in a folder can only use its own.`
      }
      const what = kinds(borrowed)
        .map((kind, index) => (index === 0 ? `a ${kind}` : `and a ${kind}`))
        .join(' ')
      return `${quoted(name)} uses ${what} from another kubeconfig. A kubeconfig in a folder can only use its own.`
    }
    const fromFolder = borrowed.filter(([, part]) => folders.has(part!.file))
    if (fromFolder.length > 0) {
      return `${quoted(name)} takes its ${kinds(fromFolder).join(' and its ')} from a kubeconfig in a folder, which only that file’s own contexts can use.`
    }
    return undefined
  }

  /**
   * What's said against using a context, as last read: what its credentials would do, from a
   * folder's kubeconfig, that isn't agreed to. Nothing for one that's no folder's, or that can't
   * be used at all (unwhole).
   */
  refusal(name: string): string | undefined {
    if (!this.refuse || !this.#base.getContextObject(name) || this.unwhole(name)) return undefined
    if (this.#refusals.has(name)) return this.#refusals.get(name)
    const parts = this.#parts(name)
    const [context, cluster, user] = parts
    const folders = this.#fromFolders()
    let said: string | undefined
    if (context && parts.some((part) => part && folders.has(part.file))) {
      try {
        said = this.refuse({ context, cluster, user })
      } catch (error) {
        // What can't be told can't be agreed to.
        said = (error as Error).message
      }
    }
    this.#refusals.set(name, said)
    return said
  }

  /**
   * Returns a KubeConfig pinned to `name`. Instances are cached so credential
   * plugins (exec auth) can reuse their token caches between requests.
   */
  forContext(name: string): KubeConfig {
    const cached = this.#perContext.get(name)
    if (cached) return cached
    const context = this.#base.getContextObject(name)
    if (!context) throw new KubeRequestError('invalid', `Unknown context "${name}"`)
    if (!this.#base.getCluster(context.cluster)) {
      throw new KubeRequestError(
        'invalid',
        `Context "${name}" points at cluster "${context.cluster}", which isn’t defined`,
      )
    }
    const unwhole = this.unwhole(name)
    if (unwhole) throw new KubeRequestError('invalid', unwhole)
    const refusal = this.refusal(name)
    if (refusal) throw new KubeRequestError('consent', refusal, 403)
    const kc = new KubeConfig()
    kc.loadFromOptions({
      clusters: this.#base.clusters,
      users: this.#base.users,
      contexts: this.#base.contexts,
      currentContext: name,
    })
    this.#perContext.set(name, kc)
    return kc
  }

  /** The kubeconfigs read from folders. */
  #fromFolders(): Set<string> {
    return new Set(this.paths().folders.flatMap(({ files }) => files))
  }

  /** A context, its cluster and its user: each where it's taken from, as read. */
  #parts(name: string): [Source | undefined, Source | undefined, Source | undefined] {
    const context = this.#base.getContextObject(name)
    const source = (kind: keyof Whence, entry: string | undefined): Source | undefined => {
      const file = entry === undefined ? undefined : this.#whence[kind].get(entry)
      return file === undefined || entry === undefined
        ? undefined
        : { name: entry, file, text: this.#good.get(file)?.text ?? '' }
    }
    return [
      source('contexts', context ? name : undefined),
      source('clusters', context?.cluster),
      source('users', context?.user || undefined),
    ]
  }
}

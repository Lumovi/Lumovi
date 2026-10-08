import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { KubeConfig } from '@kubernetes/client-node'
import type { ContextsResult } from '@shared/api'
import { withProxy } from '../network'
import { KubeRequestError } from './errors'

/** Resolves kubeconfig locations the same way kubectl does. */
export function kubeconfigPaths(env: NodeJS.ProcessEnv): string[] {
  const fromEnv = (env.KUBECONFIG ?? '').split(delimiter).filter(Boolean)
  return fromEnv.length > 0 ? fromEnv : [join(homedir(), '.kube', 'config')]
}

/** What each file read came to: the contexts it names, or why it couldn't be read. */
export type FileResults = Map<string, { contexts: string[] } | { problem: string }>

/**
 * Loads and merges kubeconfig files with kubectl semantics: missing files are
 * skipped, and the first file to define a name (or a current context) wins. A file that
 * can't be read fails the whole, as kubectl does, unless `results` is given: then it's
 * skipped, and why is noted there with what each other file came to.
 */
export function loadKubeConfig(
  paths: string[],
  env = process.env,
  results?: FileResults,
): KubeConfig {
  const merged = { clusters: [], users: [], contexts: [], currentContext: '' } as {
    clusters: KubeConfig['clusters']
    users: KubeConfig['users']
    contexts: KubeConfig['contexts']
    currentContext: string
  }
  for (const file of paths.filter((path) => existsSync(path))) {
    const kc = new KubeConfig()
    try {
      // Read here too: one that can't be opened (not yours, a folder) is as one that can't be read.
      const text = readFileSync(file, 'utf8')
      // kubectl treats an empty file as an empty config rather than an error.
      if (!text.trim()) {
        results?.set(file, { contexts: [] })
        continue
      }
      kc.loadFromString(text)
      kc.makePathsAbsolute(dirname(file))
    } catch (error) {
      // Only the reason and where: the parser quotes the lines around it, credentials and all.
      const reason = (error as Error).message.split('\n')[0]!
      if (!results) throw new Error(`Could not read ${file}: ${reason}`, { cause: error })
      results.set(file, { problem: reason })
      continue
    }
    results?.set(file, { contexts: kc.contexts.map(({ name }) => name) })
    addMissing(merged.clusters, kc.clusters)
    addMissing(merged.users, kc.users)
    addMissing(merged.contexts, kc.contexts)
    merged.currentContext ||= kc.currentContext
  }
  const kc = new KubeConfig()
  // Each cluster through the proxy the environment says, as kubectl would, unless its own does.
  kc.loadFromOptions({ ...merged, clusters: merged.clusters.map((c) => withProxy(c, env)) })
  return kc
}

function addMissing<T extends { name: string }>(target: T[], source: T[]): void {
  for (const entry of source) {
    if (!target.some((existing) => existing.name === entry.name)) target.push(entry)
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
}

/**
 * Holds the merged kubeconfig and hands out per-context views of it: the files chosen in Lumovi
 * (on the desktop), or else KUBECONFIG's, or ~/.kube/config; then those added in Lumovi; then
 * Lumovi's own (clusters added in it, each a file of its own). Read, never written.
 */
export class KubeConfigStore implements ClusterConfigs {
  #base = new KubeConfig()
  #perContext = new Map<string, KubeConfig>()
  #results: FileResults = new Map()

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly given: () => { chosen: string[]; added: string[]; own?: string[] } = () => ({
      chosen: [],
      added: [],
    }),
  ) {
    this.load()
  }

  /**
   * The files read, in order: those before (`base`, from where `from` says), then those added,
   * then Lumovi's own (each once).
   */
  paths(): {
    paths: string[]
    base: string[]
    added: string[]
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
    return {
      paths: [...base, ...addedAfter, ...ownAfter],
      base,
      added: addedAfter,
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
   * would refuse them all for one).
   */
  readable(): string[] {
    return this.paths().paths.filter((path) => {
      const result = this.#results.get(path)
      return !result || !('problem' in result)
    })
  }

  /**
   * Re-reads the kubeconfig from disk. A file that can't be read is left out, and said so;
   * only when nothing else could be read is that the error.
   */
  load(): ContextsResult {
    const { paths } = this.paths()
    const source = paths.join(delimiter)
    this.#perContext.clear()
    const results: FileResults = new Map()
    try {
      this.#base = loadKubeConfig(paths, this.env, results)
    } catch (error) {
      this.#base = new KubeConfig()
      this.#results = results
      return { contexts: [], source, error: (error as Error).message }
    }
    this.#results = results
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
        file: [...results].find(
          ([, result]) => 'contexts' in result && result.contexts.includes(context.name),
        )?.[0],
        cluster: context.cluster,
        user: context.user,
        namespace: context.namespace,
        server: this.#base.getCluster(context.cluster)?.server,
      })),
    }
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
}

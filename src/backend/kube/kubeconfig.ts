import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { KubeConfig } from '@kubernetes/client-node'
import type { ContextsResult } from '@shared/api'
import { KubeRequestError } from './errors'

/** Resolves kubeconfig locations the same way kubectl does. */
export function kubeconfigPaths(env: NodeJS.ProcessEnv): string[] {
  const fromEnv = (env.KUBECONFIG ?? '').split(delimiter).filter(Boolean)
  return fromEnv.length > 0 ? fromEnv : [join(homedir(), '.kube', 'config')]
}

/**
 * Loads and merges kubeconfig files with kubectl semantics: missing files are
 * skipped, and the first file to define a name (or a current context) wins.
 */
export function loadKubeConfig(paths: string[]): KubeConfig {
  const merged = { clusters: [], users: [], contexts: [], currentContext: '' } as {
    clusters: KubeConfig['clusters']
    users: KubeConfig['users']
    contexts: KubeConfig['contexts']
    currentContext: string
  }
  for (const file of paths.filter((path) => existsSync(path))) {
    const text = readFileSync(file, 'utf8')
    // kubectl treats an empty file as an empty config rather than an error.
    if (!text.trim()) continue
    const kc = new KubeConfig()
    try {
      kc.loadFromString(text)
      kc.makePathsAbsolute(dirname(file))
    } catch (error) {
      // Only the reason and where: the parser quotes the lines around it, credentials and all.
      const reason = (error as Error).message.split('\n')[0]
      throw new Error(`Could not read ${file}: ${reason}`, { cause: error })
    }
    addMissing(merged.clusters, kc.clusters)
    addMissing(merged.users, kc.users)
    addMissing(merged.contexts, kc.contexts)
    merged.currentContext ||= kc.currentContext
  }
  const kc = new KubeConfig()
  kc.loadFromOptions(merged)
  return kc
}

function addMissing<T extends { name: string }>(target: T[], source: T[]): void {
  for (const entry of source) {
    if (!target.some((existing) => existing.name === entry.name)) target.push(entry)
  }
}

/**
 * The clusters KubeStacks can show, and how to reach each: the user's
 * kubeconfig on the desktop, or the server's one cluster, on behalf of
 * whoever is signed in.
 */
export interface ClusterConfigs {
  /** The contexts there are (on the desktop, the kubeconfig is read again). */
  load(): ContextsResult
  /** A KubeConfig whose current context is `name`, with the credentials to use. */
  forContext(name: string): KubeConfig
}

/** Holds the merged kubeconfig and hands out per-context views of it. */
export class KubeConfigStore implements ClusterConfigs {
  #base = new KubeConfig()
  #perContext = new Map<string, KubeConfig>()

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    this.load()
  }

  /** Re-reads the kubeconfig from disk. */
  load(): ContextsResult {
    const paths = kubeconfigPaths(this.env)
    const source = paths.join(delimiter)
    this.#perContext.clear()
    try {
      this.#base = loadKubeConfig(paths)
    } catch (error) {
      this.#base = new KubeConfig()
      return { contexts: [], source, error: (error as Error).message }
    }
    const current = this.#base.getCurrentContext()
    return {
      source,
      currentContext: current || undefined,
      contexts: this.#base.getContexts().map((context) => ({
        name: context.name,
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

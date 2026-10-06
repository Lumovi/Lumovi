/**
 * What an assistant's rules need to know about where it acts: namespaces'
 * labels, and whether a change reads a Secret into a workload.
 */
import type { KubeObject } from '@shared/api'
import type { KubeService } from '../kube/service'

/** How long a cluster's namespaces' labels are kept before they're read again. */
const LABELS_MS = 15_000

/**
 * Namespaces' labels, as the assistant's person may read them: each cluster's
 * list, kept a little while, else the one namespace. Null when neither can be
 * read: rules that match labels then count where that's stricter.
 */
export class NamespaceLabels {
  readonly #lists = new Map<string, { at: number; labels: Promise<Map<string, Labels> | null> }>()

  constructor(private readonly kube: KubeService) {}

  async of(context: string, namespace: string): Promise<Labels | null> {
    const listed = (await this.#list(context))?.get(namespace)
    if (listed) return listed
    // Not in the list (made since, or the list can't be read): this one namespace.
    const one = await this.kube.get({ context, kind: 'Namespace', name: namespace })
    if (one.ok) return one.data.metadata.labels ?? {}
    // There's none: nothing is in it, whatever its rules.
    return one.error.code === 'not-found' ? {} : null
  }

  #list(context: string): Promise<Map<string, Labels> | null> {
    const kept = this.#lists.get(context)
    if (kept && Date.now() - kept.at < LABELS_MS) return kept.labels
    const labels = this.kube
      .list({ context, kind: 'Namespace' })
      .then((list) =>
        list.ok
          ? new Map(list.data.items.map((ns) => [ns.metadata.name, ns.metadata.labels ?? {}]))
          : null,
      )
    this.#lists.set(context, { at: Date.now(), labels })
    return labels
  }
}

type Labels = Record<string, string>

/**
 * Where an object names a Secret it reads: envFrom's, an env var's, a
 * volume's (projected too), a CSI driver's.
 */
const SECRET_REFERENCES = ['secretRef', 'secretKeyRef', 'secret', 'nodePublishSecretRef']

/** The Secrets an object reads into what it runs, each as it names it. */
function secretReads(object: KubeObject | null): Set<string> {
  const found = new Set<string>()
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (SECRET_REFERENCES.includes(key)) found.add(`${key}:${JSON.stringify(inner)}`)
        else walk(inner)
      }
    }
  }
  walk(object)
  return found
}

/**
 * Whether a change makes an object read a Secret it didn't (a workload's
 * logs could show it): not one that scales or restarts what reads one now.
 */
export function addsSecretReads(before: KubeObject | null, after: KubeObject | null): boolean {
  const had = secretReads(before)
  return [...secretReads(after)].some((read) => !had.has(read))
}

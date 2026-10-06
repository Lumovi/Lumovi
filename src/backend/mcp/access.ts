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

/** Where an object names a Secret it reads: envFrom's, an env var's, a volume's (projected too). */
const SECRET_REFERENCES = ['secretRef', 'secretKeyRef', 'secret']

/**
 * Whether an object reads a Secret into what it runs: an env var from one
 * (envFrom, secretKeyRef), or a volume of one (projected ones too). A
 * workload's logs could show it.
 */
export function readsSecrets(object: KubeObject | null): boolean {
  const walk = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(walk)
    if (value === null || typeof value !== 'object') return false
    return Object.entries(value).some(
      ([key, inner]) => SECRET_REFERENCES.includes(key) || walk(inner),
    )
  }
  return walk(object)
}

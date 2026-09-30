import type {
  ClusterVersion,
  ContextsResult,
  GetQuery,
  KubeList,
  KubeObject,
  ListQuery,
  LogsQuery,
  MetricsQuery,
  MetricsSnapshot,
  Result,
  UsageSample,
} from '@shared/api'
import { parseQuantity } from '@shared/quantity'
import { resourceByKind, resourcePath } from '@shared/resources'
import { kubeGet } from './client'
import { KubeRequestError, toKubeError } from './errors'
import type { KubeConfigStore } from './kubeconfig'
import {
  assertIntegerInRange,
  assertKind,
  assertQuery,
  assertString,
  optionalString,
} from './validate'

const DEFAULT_TIMEOUT_MS = 20_000
const METRICS_API = '/apis/metrics.k8s.io/v1beta1'

interface Usage {
  cpu: string
  memory: string
}

interface NodeMetric {
  metadata: { name: string }
  usage: Usage
}

interface PodMetric {
  metadata: { name: string; namespace: string }
  containers: { name: string; usage: Usage }[]
}

/**
 * Read-only access to the clusters in the user's kubeconfig. Every public
 * method resolves to a `Result` and never rejects.
 */
export class KubeService {
  readonly #timeoutMs: number

  constructor(
    private readonly store: KubeConfigStore,
    /** Resolves once the environment (login shell PATH) is ready for credential plugins. */
    private readonly envReady: Promise<void>,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.#timeoutMs = Number(env.KUBESTACKS_REQUEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
  }

  contexts(): ContextsResult {
    return this.store.load()
  }

  version(context: unknown): Promise<Result<ClusterVersion>> {
    return this.#run(async () => {
      const { gitVersion, platform } = await this.#getJson<ClusterVersion>(context, '/version')
      return { gitVersion, platform }
    })
  }

  list(query: unknown): Promise<Result<KubeList>> {
    return this.#run(async () => {
      const q = assertQuery<ListQuery>(query)
      assertKind(q.kind)
      optionalString(q.namespace, 'namespace')
      optionalString(q.labelSelector, 'labelSelector')
      optionalString(q.fieldSelector, 'fieldSelector')
      const resource = resourceByKind(q.kind)
      const params = new URLSearchParams()
      for (const key of ['labelSelector', 'fieldSelector'] as const) {
        if (q[key]) params.set(key, q[key])
      }
      const search = params.size > 0 ? `?${params}` : ''
      const list = await this.#getJson<{
        items: KubeObject[]
        metadata: { resourceVersion?: string }
      }>(q.context, resourcePath(resource, q.namespace) + search)
      const apiVersion = resource.group ? `${resource.group}/${resource.version}` : resource.version
      return {
        resourceVersion: list.metadata.resourceVersion,
        // List items omit apiVersion/kind; add them back so detail views and YAML are complete.
        items: list.items.map((item) => slim({ apiVersion, kind: resource.kind, ...item })),
      }
    })
  }

  get(query: unknown): Promise<Result<KubeObject>> {
    return this.#run(async () => {
      const q = assertQuery<GetQuery>(query)
      assertKind(q.kind)
      assertString(q.name, 'name')
      optionalString(q.namespace, 'namespace')
      const path = resourcePath(resourceByKind(q.kind), q.namespace, q.name)
      return slim(await this.#getJson<KubeObject>(q.context, path))
    })
  }

  metrics(query: unknown): Promise<Result<MetricsSnapshot>> {
    return this.#run(async () => {
      const q = assertQuery<MetricsQuery>(query)
      optionalString(q.namespace, 'namespace')
      try {
        if (q.target === 'nodes') {
          const list = await this.#getJson<{ items: NodeMetric[] }>(
            q.context,
            `${METRICS_API}/nodes`,
          )
          return { available: true, items: list.items.map(nodeUsage) }
        }
        if (q.target === 'pods') {
          const scope = q.namespace ? `/namespaces/${encodeURIComponent(q.namespace)}` : ''
          const list = await this.#getJson<{ items: PodMetric[] }>(
            q.context,
            `${METRICS_API}${scope}/pods`,
          )
          return { available: true, items: list.items.map(podUsage) }
        }
        throw new KubeRequestError('invalid', 'target must be "nodes" or "pods"')
      } catch (error) {
        // No metrics API registered (404) or metrics-server not running (503).
        if (error instanceof KubeRequestError && (error.status === 404 || error.status === 503)) {
          return { available: false, items: [] }
        }
        throw error
      }
    })
  }

  logs(query: unknown): Promise<Result<string>> {
    return this.#run(async () => {
      const q = assertQuery<LogsQuery>(query)
      assertString(q.namespace, 'namespace')
      assertString(q.pod, 'pod')
      assertString(q.container, 'container')
      assertIntegerInRange(q.tailLines, 'tailLines', 1, 10_000)
      const params = new URLSearchParams({
        container: q.container,
        tailLines: String(q.tailLines),
        timestamps: 'true',
        previous: String(q.previous === true),
      })
      const pod = `/api/v1/namespaces/${encodeURIComponent(q.namespace)}/pods/${encodeURIComponent(q.pod)}`
      return this.#get(q.context, `${pod}/log?${params}`)
    })
  }

  async #run<T>(task: () => Promise<T>): Promise<Result<T>> {
    try {
      return { ok: true, data: await task() }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  async #get(context: unknown, path: string): Promise<string> {
    assertString(context, 'context')
    const kc = this.store.forContext(context)
    await this.envReady
    return kubeGet(kc, path, { timeoutMs: this.#timeoutMs })
  }

  async #getJson<T>(context: unknown, path: string): Promise<T> {
    return JSON.parse(await this.#get(context, path)) as T
  }
}

/** Drops server-side bookkeeping that is large and never shown. */
function slim<T extends KubeObject>(object: T): T {
  delete object.metadata.managedFields
  return object
}

function nodeUsage(metric: NodeMetric): UsageSample {
  return {
    name: metric.metadata.name,
    cpu: parseQuantity(metric.usage.cpu),
    memory: parseQuantity(metric.usage.memory),
  }
}

function podUsage(metric: PodMetric): UsageSample {
  const containers = metric.containers.map((c) => ({
    name: c.name,
    cpu: parseQuantity(c.usage.cpu),
    memory: parseQuantity(c.usage.memory),
  }))
  return {
    name: metric.metadata.name,
    namespace: metric.metadata.namespace,
    cpu: containers.reduce((sum, c) => sum + c.cpu, 0),
    memory: containers.reduce((sum, c) => sum + c.memory, 0),
    containers,
  }
}

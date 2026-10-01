import type {
  AccessCheck,
  AccessVerb,
  Change,
  ChangeRequest,
  ClusterVersion,
  ContextsResult,
  FieldSchema,
  HistoryQuery,
  GetQuery,
  KubeList,
  KubeObject,
  ListQuery,
  LogsQuery,
  MetricsQuery,
  MetricsSnapshot,
  Result,
  Revision,
  RolloutKind,
  TableColumn,
  UsageSample,
} from '@shared/api'
import { parseQuantity } from '@shared/quantity'
import {
  builtinResource,
  resourceByKind,
  resourcePath,
  type ResourceDefinition,
  type ResourceKind,
} from '@shared/resources'
import { kubeRequest, type RequestOptions } from './client'
import { discover } from './discovery'
import { KubeRequestError, toKubeError } from './errors'
import type { KubeConfigStore } from './kubeconfig'
import { Limiter } from './limiter'
import { schemaOf, type DocumentCache } from './schemas'
import {
  assertIntegerInRange,
  assertKind,
  assertObject,
  assertOneOf,
  assertQuery,
  assertString,
  invalid,
  optionalString,
} from './validate'

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_LIST_ITEMS = 5_000
/** Lists are fetched in chunks of this size, like kubectl does. */
const LIST_CHUNK = 500
const METRICS_API = '/apis/metrics.k8s.io/v1beta1'
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration'
/**
 * Connection checks run for every context at once on the start screen; each can
 * start a credential plugin, so only a few run at a time.
 */
const CONCURRENT_CHECKS = 4
/** Discovery without aggregation asks each API group separately, a few at a time. */
const CONCURRENT_DISCOVERY = 8
/** A kind that isn't known looks again at most this often: it may have just been installed. */
const REDISCOVER_AFTER_MS = 5_000
/** Lists of kinds without built-in columns come as Tables, with the server's columns. */
const TABLE_ACCEPT = [
  'application/json;as=Table;v=v1;g=meta.k8s.io',
  'application/json;as=Table;v=v1beta1;g=meta.k8s.io',
  'application/json',
].join(',')
const ACCESS_REVIEWS = '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews'
const MAX_ACCESS_CHECKS = 50
const VERBS: readonly AccessVerb[] = ['get', 'list', 'create', 'update', 'patch', 'delete']
const PATCH_TYPES = {
  merge: 'application/merge-patch+json',
  strategic: 'application/strategic-merge-patch+json',
  json: 'application/json-patch+json',
}
const PROPAGATION = ['Background', 'Foreground', 'Orphan'] as const
const SUBRESOURCES = ['status', 'scale'] as const
const ROLLOUT_KINDS: readonly RolloutKind[] = ['Deployment', 'StatefulSet', 'DaemonSet']
const REVISION = 'deployment.kubernetes.io/revision'
const CHANGE_CAUSE = 'kubernetes.io/change-cause'
const TEMPLATE_HASH = 'pod-template-hash'

interface ListResponse {
  items: KubeObject[]
  metadata: { continue?: string; remainingItemCount?: number }
}

interface TableResponse {
  kind: 'Table'
  columnDefinitions: TableColumn[]
  rows: { cells: unknown[]; object: KubeObject }[]
  metadata: { continue?: string; remainingItemCount?: number }
}

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
 * Access to the clusters in the user's kubeconfig. Every public method
 * resolves to a `Result` and never rejects.
 */
export class KubeService {
  readonly #timeoutMs: number
  readonly #maxListItems: number
  readonly #checks = new Limiter(CONCURRENT_CHECKS)
  readonly #discoveries = new Limiter(CONCURRENT_DISCOVERY)
  /** Each context's kinds, as last discovered. */
  readonly #discovered = new Map<string, { at: number; resources: Promise<ResourceDefinition[]> }>()
  readonly #documents: DocumentCache = new Map()

  constructor(
    private readonly store: KubeConfigStore,
    /** Resolves once the environment (login shell PATH) is ready for credential plugins. */
    private readonly envReady: Promise<void>,
    /** Whether the user made a context read-only; changes to it are refused. */
    private readonly isReadOnly: (context: string) => boolean,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.#timeoutMs = Number(env.KUBESTACKS_REQUEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
    this.#maxListItems = Number(env.KUBESTACKS_MAX_LIST_ITEMS) || DEFAULT_MAX_LIST_ITEMS
  }

  contexts(): ContextsResult {
    return this.store.load()
  }

  version(context: unknown): Promise<Result<ClusterVersion>> {
    return this.#run(() =>
      this.#checks.run(async () => {
        const started = performance.now()
        const { gitVersion, platform } = await this.#getJson<ClusterVersion>(context, '/version')
        return { gitVersion, platform, latencyMs: Math.round(performance.now() - started) }
      }),
    )
  }

  /** Every kind the cluster serves that can be listed, looked up afresh. */
  resources(context: unknown): Promise<Result<ResourceDefinition[]>> {
    return this.#run(() => {
      assertString(context, 'context')
      return this.#discover(context, 0)
    })
  }

  /** The kinds `context` serves, discovered again if what's known is older than `maxAge` ms. */
  #discover(context: string, maxAge: number): Promise<ResourceDefinition[]> {
    const cached = this.#discovered.get(context)
    if (cached && Date.now() - cached.at < maxAge) return cached.resources
    const resources = discover(
      (path, accept) => this.#getJson(context, path, accept),
      (task) => this.#discoveries.run(task),
    )
    this.#discovered.set(context, { at: Date.now(), resources })
    // A failed discovery isn't kept, so the next call tries again.
    resources.catch(() => this.#discovered.delete(context))
    return resources
  }

  /** What `kind` is on `context`: built in, or found by discovery (again, if it's new). */
  async #resource(context: string, kind: ResourceKind): Promise<ResourceDefinition> {
    const builtin = builtinResource(kind)
    if (builtin) return builtin
    // A kind that isn't known may be new: look again, but not on every request.
    for (const maxAge of [Infinity, REDISCOVER_AFTER_MS]) {
      const found = (await this.#discover(context, maxAge)).find((r) => r.kind === kind)
      if (found) return found
    }
    throw new KubeRequestError('not-found', `${context} doesn’t serve ${kind} resources.`)
  }

  /** A kind's schema from the cluster's OpenAPI documents; null when it has none. */
  schema(context: unknown, kind: unknown): Promise<Result<FieldSchema | null>> {
    return this.#run(async () => {
      assertString(context, 'context')
      assertKind(kind)
      const resource = await this.#resource(context, kind)
      try {
        return await schemaOf(resource, (path) => this.#getJson(context, path), this.#documents)
      } catch (error) {
        // Clusters before Kubernetes 1.27 have no OpenAPI v3; fields just go unexplained.
        if (error instanceof KubeRequestError && error.status === 404) return null
        throw error
      }
    })
  }

  list(query: unknown): Promise<Result<KubeList>> {
    return this.#run(async () => {
      const q = assertQuery<ListQuery>(query)
      assertString(q.context, 'context')
      assertKind(q.kind)
      optionalString(q.namespace, 'namespace')
      optionalString(q.labelSelector, 'labelSelector')
      optionalString(q.fieldSelector, 'fieldSelector')
      const resource = await this.#resource(q.context, q.kind)
      // Kinds without columns of their own get the server's, like `kubectl get`.
      const table = !builtinResource(q.kind)
      const params = new URLSearchParams()
      for (const key of ['labelSelector', 'fieldSelector'] as const) {
        if (q[key]) params.set(key, q[key])
      }
      if (table) params.set('includeObject', 'Object')
      const list = await this.#listChunks(
        q.context,
        resourcePath(resource, q.namespace),
        params,
        table,
      )
      const apiVersion = resource.group ? `${resource.group}/${resource.version}` : resource.version
      return {
        ...list,
        // List items omit apiVersion/kind; add them back so detail views and YAML are complete.
        items: list.items.map((item) =>
          slimListItem({ apiVersion, kind: resource.apiKind, ...item }),
        ),
      }
    })
  }

  /**
   * Lists in chunks so a huge collection never arrives as one giant response,
   * and stops at the item cap to keep memory bounded.
   */
  async #listChunks(
    context: string,
    path: string,
    params: URLSearchParams,
    table = false,
    restarted = false,
  ): Promise<KubeList> {
    const items: KubeObject[] = []
    const cells: unknown[][] = []
    let columns: TableColumn[] | undefined
    let token: string | undefined
    let remaining: number
    do {
      const chunk = new URLSearchParams(params)
      chunk.set('limit', String(Math.min(LIST_CHUNK, this.#maxListItems - items.length)))
      if (token) chunk.set('continue', token)
      let list: ListResponse | TableResponse
      try {
        list = await this.#getJson<ListResponse | TableResponse>(
          context,
          `${path}?${chunk}`,
          table ? TABLE_ACCEPT : undefined,
        )
      } catch (error) {
        // The continue token expired (the collection changed a lot between chunks): start over once.
        if (!restarted && error instanceof KubeRequestError && error.status === 410) {
          return this.#listChunks(context, path, params, table, true)
        }
        throw error
      }
      if ('rows' in list) {
        columns ??= list.columnDefinitions
        for (const row of list.rows) {
          items.push(row.object)
          cells.push(row.cells)
        }
      } else {
        items.push(...list.items)
      }
      token = list.metadata.continue
      remaining = list.metadata.remainingItemCount ?? 0
    } while (token && items.length < this.#maxListItems)
    const truncated = Boolean(token)
    // The API only reports how many objects are left for unfiltered lists.
    const total = truncated && remaining === 0 ? undefined : items.length + remaining
    return { items, truncated, total, ...(columns ? { table: { columns, cells } } : {}) }
  }

  get(query: unknown): Promise<Result<KubeObject>> {
    return this.#run(async () => {
      const q = assertQuery<GetQuery>(query)
      assertString(q.context, 'context')
      assertKind(q.kind)
      assertString(q.name, 'name')
      optionalString(q.namespace, 'namespace')
      if (q.subresource !== undefined) assertOneOf(q.subresource, 'subresource', ['scale'])
      const path = resourcePath(await this.#resource(q.context, q.kind), q.namespace, q.name)
      const subresource = q.subresource ? `/${q.subresource}` : ''
      return slim(await this.#getJson<KubeObject>(q.context, `${path}${subresource}`))
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

  change(request: unknown): Promise<Result<KubeObject | null>> {
    return this.#run(async () => {
      const r = assertQuery<ChangeRequest>(request)
      assertString(r.context, 'context')
      assertKind(r.kind)
      const resource = await this.#resource(r.context, r.kind)
      if (resource.namespaced) assertString(r.namespace, 'namespace')
      else if (r.namespace !== undefined) throw invalid(`${r.kind} objects have no namespace`)
      const change = assertQuery<Change>(r.change)
      if (change.action !== 'create') assertString(r.name, 'name')
      if (this.isReadOnly(r.context)) {
        throw new KubeRequestError(
          'read-only',
          `${r.context} is read-only in KubeStacks. Allow changes to it to continue.`,
        )
      }
      const dryRun = r.dryRun === true ? '?dryRun=All' : ''
      const path = resourcePath(resource, r.namespace, r.name)
      const send = async (target: string, options: Omit<RequestOptions, 'timeoutMs'>) =>
        slim(JSON.parse(await this.#request(r.context, target, options)) as KubeObject)

      switch (change.action) {
        case 'patch': {
          assertOneOf(change.patchType, 'patchType', Object.keys(PATCH_TYPES))
          if (change.patchType === 'json') {
            if (!Array.isArray(change.patch)) throw invalid('A JSON patch must be a list')
          } else {
            assertObject(change.patch, 'patch')
          }
          if (change.subresource !== undefined) {
            assertOneOf(change.subresource, 'subresource', SUBRESOURCES)
          }
          const subresource = change.subresource ? `/${change.subresource}` : ''
          return send(`${path}${subresource}${dryRun}`, {
            method: 'PATCH',
            body: change.patch,
            contentType: PATCH_TYPES[change.patchType],
          })
        }
        case 'replace': {
          assertObject(change.object, 'object')
          if (change.object.metadata?.name !== r.name) {
            throw invalid('The object’s name does not match the one being replaced')
          }
          const at = resourcePath(atVersion(resource, change.object), r.namespace, r.name)
          return send(`${at}${dryRun}`, { method: 'PUT', body: change.object })
        }
        case 'create': {
          assertObject(change.object, 'object')
          const collection = resourcePath(atVersion(resource, change.object), r.namespace)
          return send(`${collection}${dryRun}`, { method: 'POST', body: change.object })
        }
        case 'delete': {
          if (change.propagation !== undefined) {
            assertOneOf(change.propagation, 'propagation', PROPAGATION)
          }
          if (change.gracePeriodSeconds !== undefined) {
            assertIntegerInRange(change.gracePeriodSeconds, 'gracePeriodSeconds', 0, 86_400)
          }
          await this.#request(r.context, `${path}${dryRun}`, {
            method: 'DELETE',
            body: {
              apiVersion: 'v1',
              kind: 'DeleteOptions',
              propagationPolicy: change.propagation,
              gracePeriodSeconds: change.gracePeriodSeconds,
            },
          })
          return null
        }
        case 'evict': {
          if (r.kind !== 'Pod') throw invalid('Only pods can be evicted')
          await this.#request(r.context, `${path}/eviction${dryRun}`, {
            method: 'POST',
            body: {
              apiVersion: 'policy/v1',
              kind: 'Eviction',
              metadata: { name: r.name, namespace: r.namespace },
            },
          })
          return null
        }
        case 'debug': {
          if (r.kind !== 'Pod') throw invalid('Only pods can be debugged')
          assertString(change.container, 'container')
          assertString(change.image, 'image')
          optionalString(change.target, 'target')
          return send(`${path}/ephemeralcontainers${dryRun}`, {
            method: 'PATCH',
            contentType: PATCH_TYPES.strategic,
            body: {
              spec: {
                ephemeralContainers: [
                  {
                    name: change.container,
                    image: change.image,
                    targetContainerName: change.target,
                    stdin: true,
                    tty: true,
                    terminationMessagePolicy: 'File',
                    imagePullPolicy: 'IfNotPresent',
                  },
                ],
              },
            },
          })
        }
        default:
          throw invalid(`Unknown change "${String((change as { action: unknown }).action)}"`)
      }
    })
  }

  history(query: unknown): Promise<Result<Revision[]>> {
    return this.#run(async () => {
      const q = assertQuery<HistoryQuery>(query)
      assertOneOf(q.kind, 'kind', ROLLOUT_KINDS)
      assertString(q.namespace, 'namespace')
      assertString(q.name, 'name')
      const owner = await this.#getJson<KubeObject>(
        q.context,
        resourcePath(resourceByKind(q.kind), q.namespace, q.name),
      )
      const ns = `/apis/apps/v1/namespaces/${encodeURIComponent(q.namespace)}`
      const owned = (item: KubeObject) =>
        (item.metadata.ownerReferences ?? []).some((ref) => ref.uid === owner.metadata.uid)
      const changeCause = (item: KubeObject) => item.metadata.annotations?.[CHANGE_CAUSE]
      let revisions: Revision[]
      if (q.kind === 'Deployment') {
        // Only ReplicaSets matching the Deployment's selector can be its own.
        const selector = Object.entries(owner.spec.selector.matchLabels as Record<string, string>)
          .map(([key, value]) => `${key}=${value}`)
          .join(',')
        const { items } = await this.#listChunks(
          q.context,
          `${ns}/replicasets`,
          new URLSearchParams({ labelSelector: selector }),
        )
        const current = owner.metadata.annotations?.[REVISION]
        revisions = items.filter(owned).map((rs) => {
          // ReplicaSets always label their pods, and Deployments number their rollouts.
          const { [TEMPLATE_HASH]: _hash, ...labels } = rs.spec.template.metadata.labels
          return {
            revision: Number(rs.metadata.annotations![REVISION]),
            createdAt: rs.metadata.creationTimestamp!,
            template: { ...rs.spec.template, metadata: { ...rs.spec.template.metadata, labels } },
            changeCause: changeCause(rs),
            current: rs.metadata.annotations![REVISION] === current,
          }
        })
      } else {
        const { items } = await this.#listChunks(
          q.context,
          `${ns}/controllerrevisions`,
          new URLSearchParams(),
        )
        const mine = items.filter(owned)
        const newest = Math.max(...mine.map((item) => Number(item.revision)))
        revisions = mine.map((item) => {
          const { $patch: _patch, ...template } = (
            item.data as { spec: { template: Revision['template'] & { $patch?: string } } }
          ).spec.template
          return {
            revision: Number(item.revision),
            createdAt: item.metadata.creationTimestamp!,
            template,
            changeCause: changeCause(item),
            // StatefulSets name the revision they roll out to; DaemonSets roll out their newest.
            current:
              q.kind === 'StatefulSet'
                ? item.metadata.name === owner.status?.updateRevision
                : Number(item.revision) === newest,
          }
        })
      }
      return revisions.sort((a, b) => b.revision - a.revision)
    })
  }

  /** Asks the API server what the current user may do, one SelfSubjectAccessReview per check. */
  can(context: unknown, checks: unknown): Promise<Result<boolean[]>> {
    return this.#run(async () => {
      assertString(context, 'context')
      if (!Array.isArray(checks) || checks.length > MAX_ACCESS_CHECKS) {
        throw invalid(`checks must be a list of at most ${MAX_ACCESS_CHECKS} access checks`)
      }
      return Promise.all(
        checks.map(async (check: unknown) => {
          const c = assertQuery<AccessCheck>(check)
          assertOneOf(c.verb, 'verb', VERBS)
          assertKind(c.kind)
          optionalString(c.namespace, 'namespace')
          optionalString(c.name, 'name')
          optionalString(c.subresource, 'subresource')
          const resource = await this.#resource(context, c.kind)
          const review = JSON.parse(
            await this.#request(context, ACCESS_REVIEWS, {
              method: 'POST',
              body: {
                apiVersion: 'authorization.k8s.io/v1',
                kind: 'SelfSubjectAccessReview',
                spec: {
                  resourceAttributes: {
                    verb: c.verb,
                    group: resource.group,
                    resource: resource.plural,
                    subresource: c.subresource,
                    namespace: c.namespace,
                    name: c.name,
                  },
                },
              },
            }),
          ) as { status?: { allowed?: boolean } }
          return review.status?.allowed === true
        }),
      )
    })
  }

  async #run<T>(task: () => Promise<T>): Promise<Result<T>> {
    try {
      return { ok: true, data: await task() }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /** GETs any path on the cluster as text, for the usage history's service proxy calls. */
  fetchText(context: string, path: string): Promise<string> {
    return this.#request(context, path, {})
  }

  #get(context: unknown, path: string, accept?: string): Promise<string> {
    return this.#request(context, path, accept ? { accept } : {})
  }

  async #request(
    context: unknown,
    path: string,
    options: Omit<RequestOptions, 'timeoutMs'>,
  ): Promise<string> {
    assertString(context, 'context')
    const kc = this.store.forContext(context)
    await this.envReady
    return kubeRequest(kc, path, { ...options, timeoutMs: this.#timeoutMs })
  }

  async #getJson<T>(context: unknown, path: string, accept?: string): Promise<T> {
    return JSON.parse(await this.#get(context, path, accept)) as T
  }
}

/**
 * `resource` at the API version an object says it's in, as kubectl sends it:
 * the API server refuses objects of another version than the path's.
 */
function atVersion(resource: ResourceDefinition, object: KubeObject): ResourceDefinition {
  const version = object.apiVersion?.split('/').at(-1)
  return version ? { ...resource, version } : resource
}

/** Drops server-side bookkeeping that is large and never shown. */
function slim<T extends KubeObject>(object: T): T {
  delete object.metadata.managedFields
  return object
}

/**
 * List views only need what tables show: drop the (often huge) last-applied
 * annotation, and keep only the keys of Secrets and ConfigMaps so their values
 * reach the page only when an object is opened.
 */
function slimListItem(object: KubeObject): KubeObject {
  slim(object)
  delete object.metadata.annotations?.[LAST_APPLIED]
  for (const field of ['data', 'binaryData'] as const) {
    const values = object[field] as Record<string, string> | undefined
    if (values) object[field] = Object.fromEntries(Object.keys(values).map((key) => [key, '']))
  }
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

/**
 * A small in-memory Kubernetes API server for end-to-end tests and demos.
 *
 * It speaks enough of the real API for a read-only client: /version, list and
 * get for every kind in the app's resource registry, label and field
 * selectors, the metrics API, and pod logs. Responses mirror the real server's
 * shapes (list kinds, Status errors, gzip) so the app is tested against
 * realistic payloads.
 */
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { generate } from 'selfsigned'
import { RESOURCES, type ResourceDefinition } from '../../src/shared/resources.ts'
import type { ClusterFixture, Json, KubeObject } from './types.ts'

export type Fault = { status: number; body?: string; contentType?: string } | { hang: true }

export interface RecordedRequest {
  method: string
  path: string
  /** Raw query string without the leading `?`. */
  search: string
  query: Record<string, string>
  headers: http.IncomingHttpHeaders
}

export interface MockClusterOptions {
  fixture: () => ClusterFixture
  tls?: boolean
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  token?: string
  gitVersion?: string
  /** Let metrics drift slowly over time, for lively demos. */
  jitter?: boolean
}

export interface MockCluster {
  url: string
  port: number
  /** PEM of the self-signed serving certificate (TLS servers only). */
  caPem?: string
  /** Every request received, oldest first. Cleared by `reset()`. */
  requests: RecordedRequest[]
  /**
   * Makes requests whose pathname equals `match` (or matches the RegExp)
   * fail with `fault`. Returns a function that removes the fault.
   */
  fail(match: string | RegExp, fault: Fault): () => void
  /** Adds or replaces an object (keyed by kind, namespace and name). */
  upsert(object: KubeObject): void
  remove(kind: string, namespace: string | undefined, name: string): boolean
  setMetricsAvailable(available: boolean): void
  /** Restores the fixture, clears faults and the request log. */
  reset(): void
  close(): Promise<void>
}

const METRICS_GROUP = 'metrics.k8s.io'
const GZIP_THRESHOLD = 1024

let certificate: Promise<{ key: string; cert: string }> | undefined

/** One self-signed certificate for 127.0.0.1/localhost, shared by all TLS mock servers. */
function serverCertificate(): Promise<{ key: string; cert: string }> {
  certificate ??= generate([{ name: 'commonName', value: 'kubestacks-mock-apiserver' }], {
    keyType: 'ec',
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' },
        ],
      },
    ],
  }).then((pems) => ({ key: pems.private, cert: pems.cert }))
  return certificate
}

function statusBody(code: number, reason: string, message: string, details?: Json): Json {
  return {
    kind: 'Status',
    apiVersion: 'v1',
    metadata: {},
    status: 'Failure',
    message,
    reason,
    ...(details ? { details } : {}),
    code,
  }
}

const REASONS: Record<number, string> = {
  400: 'BadRequest',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'NotFound',
  405: 'MethodNotAllowed',
  409: 'Conflict',
  429: 'TooManyRequests',
  500: 'InternalError',
  503: 'ServiceUnavailable',
  504: 'Timeout',
}

class HttpError extends Error {
  status: number
  body: Json
  constructor(status: number, message: string, details?: Json) {
    super(message)
    this.status = status
    this.body = statusBody(status, REASONS[status] ?? 'Unknown', message, details)
  }
}

const notFoundPath = () => new HttpError(404, 'the server could not find the requested resource')

function objectKey(kind: string, namespace: string | undefined, name: string): string {
  return `${kind}/${namespace ?? ''}/${name}`
}

function groupVersion(def: ResourceDefinition): string {
  return def.group ? `${def.group}/${def.version}` : def.version
}

const RESOURCE_BY_PATH = new Map(RESOURCES.map((r) => [`${r.group}/${r.version}/${r.plural}`, r]))

/** Equality-based label selectors: `a=b`, `a==b`, `a!=b`, `a`, `!a`, comma separated. */
export function matchesLabels(
  labels: Record<string, string> | undefined,
  selector: string,
): boolean {
  return selector
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean)
    .every((term) => {
      const value = (key: string) => labels?.[key]
      const notEqual = term.match(/^([^!=]+)!=(.*)$/)
      if (notEqual) return value(notEqual[1]!.trim()) !== notEqual[2]!.trim()
      const equal = term.match(/^([^!=]+)==?(.*)$/)
      if (equal) return value(equal[1]!.trim()) === equal[2]!.trim()
      if (term.startsWith('!')) return value(term.slice(1)) === undefined
      return value(term) !== undefined
    })
}

function fieldValue(object: Json, path: string): string | undefined {
  let current: Json = object
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[part]
  }
  return current === undefined || current === null ? undefined : String(current)
}

/** Field selectors: `path=value`, `path==value`, `path!=value` on any dotted field path. */
export function matchesFields(object: KubeObject, selector: string): boolean {
  return selector
    .split(',')
    .map((term) => term.trim())
    .filter(Boolean)
    .every((term) => {
      const match = term.match(/^([^!=]+)(!=|==|=)(.*)$/)
      if (!match) throw new HttpError(400, `invalid field selector: '${term}'`)
      const actual = fieldValue(object, match[1]!.trim()) ?? ''
      return match[2] === '!=' ? actual !== match[3] : actual === match[3]
    })
}

function managedFields(object: KubeObject): Json[] {
  return [
    {
      manager: 'kube-controller-manager',
      operation: 'Update',
      apiVersion: object.apiVersion,
      time: object.metadata.creationTimestamp,
      fieldsType: 'FieldsV1',
      fieldsV1: { 'f:metadata': { 'f:labels': {} }, 'f:spec': {}, 'f:status': {} },
    },
  ]
}

function cpuString(cores: number): string {
  return `${Math.max(0, Math.round(cores * 1e9))}n`
}

function memoryString(bytes: number): string {
  return `${Math.max(0, Math.round(bytes / 1024))}Ki`
}

/** Default logs for containers the fixture doesn't describe. */
function genericLogs(pod: KubeObject, container: string): string[] {
  return Array.from(
    { length: 40 },
    (_, i) =>
      `level=info msg="heartbeat" pod=${pod.metadata.name} container=${container} seq=${i + 1}`,
  )
}

function podContainers(pod: KubeObject): { containers: string[]; init: string[] } {
  return {
    containers: (pod.spec?.containers ?? []).map((c: Json) => c.name as string),
    init: (pod.spec?.initContainers ?? []).map((c: Json) => c.name as string),
  }
}

function containerStatus(pod: KubeObject, container: string): Json | undefined {
  const all = [
    ...(pod.status?.containerStatuses ?? []),
    ...(pod.status?.initContainerStatuses ?? []),
  ]
  return all.find((s: Json) => s.name === container)
}

const METRICS_RESOURCES = [
  {
    name: 'nodes',
    singularName: '',
    namespaced: false,
    kind: 'NodeMetrics',
    verbs: ['get', 'list'],
  },
  { name: 'pods', singularName: '', namespaced: true, kind: 'PodMetrics', verbs: ['get', 'list'] },
]

/** Legacy discovery documents, so tools like kubectl work against the mock too. */
function discoveryDocument(pathname: string, metricsEnabled: boolean): Json | undefined {
  const path = pathname.replace(/\/+$/, '')
  if (path === '/api') {
    return {
      kind: 'APIVersions',
      versions: ['v1'],
      serverAddressByClientCIDRs: [{ clientCIDR: '0.0.0.0/0', serverAddress: '127.0.0.1:6443' }],
    }
  }
  const groups = new Map<string, string>()
  for (const r of RESOURCES) if (r.group) groups.set(r.group, r.version)
  if (metricsEnabled) groups.set(METRICS_GROUP, 'v1beta1')
  if (path === '/apis') {
    return {
      kind: 'APIGroupList',
      apiVersion: 'v1',
      groups: [...groups].map(([name, version]) => {
        const groupVersion = { groupVersion: `${name}/${version}`, version }
        return { name, versions: [groupVersion], preferredVersion: groupVersion }
      }),
    }
  }
  const match = path.match(/^\/api\/(v1)$|^\/apis\/([^/]+)\/([^/]+)$/)
  if (!match) return undefined
  const group = match[2] ?? ''
  const version = match[1] ?? match[3]!
  if (group && groups.get(group) !== version) return undefined
  const resources =
    group === METRICS_GROUP
      ? METRICS_RESOURCES
      : RESOURCES.filter((r) => r.group === group && r.version === version).flatMap((r) => [
          {
            name: r.plural,
            singularName: r.kind.toLowerCase(),
            namespaced: r.namespaced,
            kind: r.kind,
            verbs: ['get', 'list'],
          },
          ...(r.kind === 'Pod'
            ? [
                {
                  name: 'pods/log',
                  singularName: '',
                  namespaced: true,
                  kind: 'Pod',
                  verbs: ['get'],
                },
              ]
            : []),
        ])
  return {
    kind: 'APIResourceList',
    apiVersion: 'v1',
    groupVersion: group ? `${group}/${version}` : version,
    resources,
  }
}

function rfc3339Nano(ms: number): string {
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z')
}

export async function startMockCluster(options: MockClusterOptions): Promise<MockCluster> {
  const gitVersion = options.gitVersion ?? 'v1.34.1'
  const requests: RecordedRequest[] = []
  const faults: { match: string | RegExp; fault: Fault }[] = []
  const pending = new Set<http.ServerResponse>()
  let fixture: ClusterFixture
  let store = new Map<string, KubeObject>()
  let metricsAvailable = true
  let resourceVersion = 0

  function load(): void {
    fixture = options.fixture()
    store = new Map()
    resourceVersion = 0
    for (const object of fixture.objects) {
      store.set(
        objectKey(object.kind, object.metadata.namespace, object.metadata.name),
        structuredClone(object),
      )
      resourceVersion = Math.max(resourceVersion, Number(object.metadata.resourceVersion ?? 0))
    }
    metricsAvailable = true
    faults.length = 0
    requests.length = 0
  }
  load()

  const jitter = (seed: string) => {
    if (!options.jitter) return 1
    let h = 0
    for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0
    return 1 + 0.08 * Math.sin(Date.now() / 9000 + (h % 360))
  }

  function list(
    def: ResourceDefinition,
    namespace: string | undefined,
    query: URLSearchParams,
  ): Json {
    const labelSelector = query.get('labelSelector')
    const fieldSelector = query.get('fieldSelector')
    const items: Json[] = []
    for (const object of store.values()) {
      if (object.kind !== def.kind) continue
      if (namespace !== undefined && object.metadata.namespace !== namespace) continue
      if (labelSelector && !matchesLabels(object.metadata.labels, labelSelector)) continue
      if (fieldSelector && !matchesFields(object, fieldSelector)) continue
      // Like the real API server, list items carry no apiVersion/kind.
      const { apiVersion: _apiVersion, kind: _kind, ...rest } = object
      items.push({ ...rest, metadata: { ...rest.metadata, managedFields: managedFields(object) } })
    }
    return {
      kind: `${def.kind}List`,
      apiVersion: groupVersion(def),
      metadata: { resourceVersion: String(resourceVersion) },
      items,
    }
  }

  function get(def: ResourceDefinition, namespace: string | undefined, name: string): KubeObject {
    const object = store.get(objectKey(def.kind, namespace, name))
    if (!object) {
      const resource = def.group ? `${def.plural}.${def.group}` : def.plural
      throw new HttpError(404, `${resource} "${name}" not found`, {
        name,
        ...(def.group ? { group: def.group } : {}),
        kind: def.plural,
      })
    }
    return object
  }

  function metrics(rest: string[]): Json {
    if (!fixture.metrics || !metricsAvailable) throw notFoundPath()
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    const namespaced = rest[0] === 'namespaces'
    const namespace = namespaced ? rest[1] : undefined
    const [plural, name] = namespaced ? rest.slice(2) : rest
    if (plural === 'nodes' && !namespaced) {
      const items = fixture.metrics.nodes
        .filter((n) => store.has(objectKey('Node', undefined, n.name)))
        .filter((n) => name === undefined || n.name === name)
        .map((n) => {
          const node = store.get(objectKey('Node', undefined, n.name))!
          return {
            metadata: { name: n.name, creationTimestamp: timestamp, labels: node.metadata.labels },
            timestamp,
            window: '20.052s',
            usage: {
              cpu: cpuString(n.cpu * jitter(`${n.name}/cpu`)),
              memory: memoryString(n.memory * jitter(`${n.name}/mem`)),
            },
          }
        })
      if (name !== undefined && items.length === 0)
        throw new HttpError(404, `nodemetrics.metrics.k8s.io "${name}" not found`)
      return name === undefined
        ? { kind: 'NodeMetricsList', apiVersion: 'metrics.k8s.io/v1beta1', metadata: {}, items }
        : { kind: 'NodeMetrics', apiVersion: 'metrics.k8s.io/v1beta1', ...items[0] }
    }
    if (plural === 'pods') {
      const items = fixture.metrics.pods
        .filter((p) => store.has(objectKey('Pod', p.namespace, p.name)))
        .filter((p) => namespace === undefined || p.namespace === namespace)
        .filter((p) => name === undefined || p.name === name)
        .map((p) => ({
          metadata: { name: p.name, namespace: p.namespace, creationTimestamp: timestamp },
          timestamp,
          window: '18.21s',
          containers: p.containers.map((c) => ({
            name: c.name,
            usage: {
              cpu: cpuString(c.cpu * jitter(`${p.name}/${c.name}/cpu`)),
              memory: memoryString(c.memory * jitter(`${p.name}/${c.name}/mem`)),
            },
          })),
        }))
      if (name !== undefined && items.length === 0)
        throw new HttpError(404, `podmetrics.metrics.k8s.io "${name}" not found`)
      return name === undefined
        ? { kind: 'PodMetricsList', apiVersion: 'metrics.k8s.io/v1beta1', metadata: {}, items }
        : { kind: 'PodMetrics', apiVersion: 'metrics.k8s.io/v1beta1', ...items[0] }
    }
    throw notFoundPath()
  }

  function logs(namespace: string, name: string, query: URLSearchParams): string {
    const pod = get(
      RESOURCES.find((r) => r.kind === 'Pod')!,
      namespace,
      name,
    )
    const { containers, init } = podContainers(pod)
    let container = query.get('container') ?? undefined
    if (!container) {
      if (containers.length !== 1) {
        throw new HttpError(
          400,
          `a container name must be specified for pod ${name}, choose one of: [${containers.join(' ')}]` +
            (init.length ? ` or one of the init containers: [${init.join(' ')}]` : ''),
        )
      }
      container = containers[0]!
    }
    if (!containers.includes(container) && !init.includes(container)) {
      throw new HttpError(400, `container ${container} is not valid for pod ${name}`)
    }
    const previous = query.get('previous') === 'true'
    const status = containerStatus(pod, container)
    if (previous && !status?.lastState?.terminated) {
      throw new HttpError(
        400,
        `previous terminated container "${container}" in pod "${name}" not found`,
      )
    }
    const waiting = status?.state?.waiting
    if (!previous && (!status || (waiting && waiting.reason !== 'CrashLoopBackOff'))) {
      const reason: string = waiting?.reason ?? 'ContainerCreating'
      const detail = /ImagePull|ErrImage/.test(reason) ? 'trying and failing to pull image' : reason
      throw new HttpError(
        400,
        `container "${container}" in pod "${name}" is waiting to start: ${detail}`,
      )
    }
    let lines = fixture.logs?.(pod, container, previous) ?? genericLogs(pod, container)
    const tail = Number(query.get('tailLines'))
    if (query.has('tailLines') && Number.isInteger(tail) && tail >= 0)
      lines = tail === 0 ? [] : lines.slice(-tail)
    if (query.get('timestamps') !== 'true') return lines.map((line) => `${line}\n`).join('')
    const finished: string | undefined = previous
      ? status?.lastState?.terminated?.finishedAt
      : (status?.state?.terminated?.finishedAt ??
        (waiting ? status?.lastState?.terminated?.finishedAt : undefined))
    const end = finished ? Date.parse(finished) : Date.now()
    const step = 1300 + ((name.length * 97 + container.length * 31) % 900)
    return lines
      .map((line, i) => `${rfc3339Nano(end - (lines.length - 1 - i) * step)} ${line}\n`)
      .join('')
  }

  function route(pathname: string, query: URLSearchParams): { body: Json; contentType?: string } {
    if (pathname === '/version' || pathname === '/version/') {
      const [, major = '1', minor = '34'] = gitVersion.match(/^v(\d+)\.(\d+)/) ?? []
      return {
        body: {
          major,
          minor,
          emulationMajor: major,
          emulationMinor: minor,
          gitVersion,
          gitCommit: 'b2d3c4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1',
          gitTreeState: 'clean',
          buildDate: '2025-09-09T19:34:54Z',
          goVersion: 'go1.24.6',
          compiler: 'gc',
          platform: 'linux/amd64',
        },
      }
    }
    const discovery = discoveryDocument(pathname, Boolean(fixture.metrics && metricsAvailable))
    if (discovery) return { body: discovery }
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
    let group: string
    let version: string | undefined
    let rest: string[]
    if (parts[0] === 'api') {
      group = ''
      version = parts[1]
      rest = parts.slice(2)
    } else if (parts[0] === 'apis') {
      group = parts[1] ?? ''
      version = parts[2]
      rest = parts.slice(3)
    } else {
      throw notFoundPath()
    }
    if (group === METRICS_GROUP && version === 'v1beta1') return { body: metrics(rest) }

    const namespaced = rest[0] === 'namespaces' && rest.length >= 3
    const namespace = namespaced ? rest[1] : undefined
    const [plural, name, subresource, ...extra] = namespaced ? rest.slice(2) : rest
    const def = RESOURCE_BY_PATH.get(`${group}/${version}/${plural}`)
    if (!def || extra.length > 0) throw notFoundPath()
    if (namespaced && !def.namespaced) throw notFoundPath()
    if (name === undefined) return { body: list(def, namespace, query) }
    if (def.namespaced && !namespaced) throw notFoundPath()
    if (subresource === undefined) {
      const object = get(def, namespace, name)
      return {
        body: { ...object, metadata: { ...object.metadata, managedFields: managedFields(object) } },
      }
    }
    if (def.kind === 'Pod' && subresource === 'log') {
      return { body: logs(namespace!, name, query), contentType: 'text/plain' }
    }
    throw notFoundPath()
  }

  function send(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    status: number,
    body: string,
    contentType: string,
  ) {
    let payload: Buffer = Buffer.from(body, 'utf8')
    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, private',
      'Audit-Id': crypto.randomUUID(),
    }
    if (
      /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) &&
      payload.length > GZIP_THRESHOLD
    ) {
      payload = gzipSync(payload)
      headers['Content-Encoding'] = 'gzip'
    }
    headers['Content-Length'] = payload.length
    res.writeHead(status, headers)
    res.end(payload)
  }

  function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://mock')
    requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      search: url.search.slice(1),
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
    })
    const json = (status: number, body: Json) =>
      send(req, res, status, JSON.stringify(body), 'application/json')

    if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`) {
      json(401, statusBody(401, 'Unauthorized', 'Unauthorized'))
      return
    }
    // Like a real API server, refuse media types it cannot produce (even for pod logs).
    const accept = req.headers.accept ?? '*/*'
    if (
      !/application\/json|application\/yaml|application\/vnd\.kubernetes\.protobuf|\*\/\*/.test(
        accept,
      )
    ) {
      json(
        406,
        statusBody(
          406,
          'NotAcceptable',
          'only the following media types are accepted: application/json, application/yaml, application/vnd.kubernetes.protobuf',
        ),
      )
      return
    }
    const fault = faults.find(({ match }) =>
      typeof match === 'string' ? match === url.pathname : match.test(url.pathname),
    )?.fault
    if (fault) {
      if ('hang' in fault) {
        pending.add(res)
        res.on('close', () => pending.delete(res))
        return
      }
      const body =
        fault.body ??
        JSON.stringify(
          statusBody(
            fault.status,
            REASONS[fault.status] ?? 'Unknown',
            `injected fault (HTTP ${fault.status})`,
          ),
        )
      send(req, res, fault.status, body, fault.contentType ?? 'application/json')
      return
    }
    if (req.method !== 'GET') {
      json(
        405,
        statusBody(
          405,
          'MethodNotAllowed',
          'the server does not allow this method on the requested resource',
        ),
      )
      return
    }
    try {
      const { body, contentType } = route(url.pathname, url.searchParams)
      if (typeof body === 'string') send(req, res, 200, body, contentType ?? 'text/plain')
      else json(200, body)
    } catch (error) {
      if (error instanceof HttpError) json(error.status, error.body)
      else json(500, statusBody(500, 'InternalError', (error as Error).message))
    }
  }

  let caPem: string | undefined
  let server: http.Server
  if (options.tls) {
    const { key, cert } = await serverCertificate()
    caPem = cert
    server = https.createServer({ key, cert }, handle)
  } else {
    server = http.createServer(handle)
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo

  return {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    ...(caPem ? { caPem } : {}),
    requests,
    fail(match, fault) {
      const entry = { match, fault }
      faults.unshift(entry)
      return () => {
        const index = faults.indexOf(entry)
        if (index >= 0) faults.splice(index, 1)
      }
    },
    upsert(object) {
      resourceVersion += 1
      const key = objectKey(object.kind, object.metadata.namespace, object.metadata.name)
      const existing = store.get(key)
      store.set(key, {
        ...structuredClone(object),
        metadata: {
          uid: existing?.metadata.uid ?? crypto.randomUUID(),
          creationTimestamp:
            existing?.metadata.creationTimestamp ??
            new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          ...structuredClone(object.metadata),
          resourceVersion: String(resourceVersion),
        },
      })
    },
    remove(kind, namespace, name) {
      resourceVersion += 1
      return store.delete(objectKey(kind, namespace, name))
    },
    setMetricsAvailable(available) {
      metricsAvailable = available
    },
    reset() {
      for (const res of pending) res.destroy()
      load()
    },
    close() {
      for (const res of pending) res.destroy()
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

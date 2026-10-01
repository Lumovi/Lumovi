import type {
  HistorySource,
  InstantResult,
  KubeObject,
  MetricsFlavor,
  MetricsService,
  MetricsSourceSetting,
  RangeResult,
  Result,
} from '@shared/api'
import { KubeRequestError, toKubeError } from './errors'
import type { KubeService } from './service'
import { assertIntegerInRange, assertObject, assertQuery, assertString, invalid } from './validate'

type Matrix = { result: { metric: Record<string, string>; values: [number, string][] }[] }
type Vector = { result: { metric: Record<string, string>; value: [number, string] }[] }

interface Candidate {
  service: MetricsService
  flavor: MetricsFlavor
  score: number
}

/** At most this many services are tried when looking for Prometheus. */
const MAX_PROBES = 4
/** Prometheus refuses ranges of more than 11,000 points per series. */
const MAX_POINTS = 11_000
const MAX_QUERIES = 16
const MAX_EXPR = 4_000

// Services that come with Prometheus but don't answer PromQL themselves.
const NOT_QUERYABLE =
  /alertmanager|operator|exporter|kube-state-metrics|pushgateway|adapter|blackbox|grafana|vmagent|vmalert|vminsert|vmauth|vmstorage|sidecar/
const MONITORING_NAMESPACES = ['monitoring', 'prometheus', 'observability', 'victoria-metrics']

/** How a service looks like it answers PromQL, if it does: what it is and which port to use. */
export function candidateFor(service: KubeObject): Candidate | undefined {
  const { name, namespace, labels = {} } = service.metadata
  if (NOT_QUERYABLE.test(name)) return undefined
  const tags = [name, labels['app.kubernetes.io/name'], labels.app].join(' ')
  // ExternalName services have no ports.
  const ports: { name?: string; port: number }[] = service.spec.ports ?? []
  const portFor = (names: string[], numbers: number[]) => {
    const port =
      ports.find((p) => p.name !== undefined && names.includes(p.name)) ??
      ports.find((p) => numbers.includes(p.port)) ??
      ports[0]!
    return port.name ?? String(port.port)
  }
  const bonus = MONITORING_NAMESPACES.includes(namespace!) ? 5 : 0
  const candidate = (flavor: MetricsFlavor, score: number, port: string, path = '') => ({
    flavor,
    score: score + bonus,
    service: { namespace: namespace!, service: name, port, path },
  })
  if (ports.length === 0) return undefined
  if (/vmselect/.test(tags)) {
    return candidate('victoriametrics', 80, portFor(['http'], [8481]), '/select/0/prometheus')
  }
  if (/vmsingle|victoria-metrics/.test(tags)) {
    return candidate('victoriametrics', 85, portFor(['http'], [8429, 8428]))
  }
  if (!/prometheus/.test(tags)) return undefined
  // The operator's headless service and the usual chart names are the best bets.
  const score =
    labels['operated-prometheus'] === 'true' ||
    /^prometheus(-operated|-server|-k8s)?$|-prometheus$/.test(name)
      ? 90
      : 60
  return candidate('prometheus', score, portFor(['web', 'http-web', 'http'], [9090, 80]))
}

/** VictoriaMetrics is told apart by its name or vmselect's query path. */
function flavorOf(service: MetricsService): MetricsFlavor {
  return /vm|victoria/.test(service.service) || service.path.startsWith('/select/')
    ? 'victoriametrics'
    : 'prometheus'
}

/** A path below a service's proxy (`/select/0/prometheus`): no `.` or `..` to climb out of it. */
export const PROXY_PATH = /^(\/(?!\.\.?(?:\/|$))[\w.~-]+)*$/

export function assertService(value: unknown): asserts value is MetricsService {
  assertObject(value, 'service')
  const service = value as MetricsService
  assertString(service.namespace, 'namespace')
  assertString(service.service, 'service')
  assertString(service.port, 'port')
  if (typeof service.path !== 'string' || !PROXY_PATH.test(service.path)) {
    throw invalid('path must be empty or start with / (like /select/0/prometheus)')
  }
}

function assertQueries(value: unknown): asserts value is { id: string; expr: string }[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUERIES) {
    throw invalid(`queries must be a list of 1 to ${MAX_QUERIES}`)
  }
  for (const query of value as { id: unknown; expr: unknown }[]) {
    assertString(query.id, 'id')
    assertString(query.expr, 'expr')
    if (query.expr.length > MAX_EXPR) throw invalid(`expr must be at most ${MAX_EXPR} characters`)
  }
}

/** Prometheus writes numbers as strings, including "NaN" and "+Inf", which charts can't use. */
function sample(value: string): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

async function run<T>(task: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await task() }
  } catch (error) {
    return { ok: false, error: toKubeError(error) }
  }
}

/**
 * Usage history from a cluster's Prometheus (or VictoriaMetrics), reached
 * through the API server's service proxy with the user's own credentials.
 * The source is detected once per session, or taken from the settings.
 */
export class UsageHistory {
  readonly #sources = new Map<string, Promise<HistorySource>>()

  constructor(
    private readonly kube: KubeService,
    private readonly setting: (context: string) => MetricsSourceSetting,
  ) {}

  source(context: unknown, refresh?: unknown): Promise<Result<HistorySource>> {
    return run(async () => {
      assertString(context, 'context')
      if (refresh === true) this.forget(context)
      return this.#source(context)
    })
  }

  #source(context: string): Promise<HistorySource> {
    let source = this.#sources.get(context)
    if (!source) {
      source = this.#resolve(context)
      this.#sources.set(context, source)
    }
    return source
  }

  /** Looks for the source again next time, e.g. after the setting changed. */
  forget(context: string): void {
    this.#sources.delete(context)
  }

  test(context: unknown, service: unknown): Promise<Result<HistorySource>> {
    return run(async () => {
      assertString(context, 'context')
      assertService(service)
      return this.#probe(context, service, true)
    })
  }

  range(query: unknown): Promise<Result<RangeResult>> {
    return run(async () => {
      const { context, queries, start, end, step } = assertQuery<Record<string, unknown>>(query)
      assertString(context, 'context')
      assertQueries(queries)
      assertIntegerInRange(start, 'start', 0, Number.MAX_SAFE_INTEGER)
      assertIntegerInRange(end, 'end', start + 1, Number.MAX_SAFE_INTEGER)
      assertIntegerInRange(step, 'step', 1_000, 86_400_000)
      const points = Math.floor((end - start) / step) + 1
      if (points > MAX_POINTS) throw invalid(`A range can have at most ${MAX_POINTS} steps`)
      const service = await this.#ready(context)
      const results = await Promise.all(
        queries.map(async ({ id, expr }) => {
          const params = new URLSearchParams({
            query: expr,
            start: String(start / 1000),
            end: String(end / 1000),
            step: String(step / 1000),
          })
          const { result } = await this.#prom<Matrix>(
            context,
            service,
            `/api/v1/query_range?${params}`,
          )
          return {
            id,
            series: result.map(({ metric, values }) => {
              const aligned: (number | null)[] = Array.from({ length: points }, () => null)
              // VictoriaMetrics aligns ranges to whole steps, so a sample can fall just outside.
              for (const [time, value] of values) {
                const i = Math.round((time * 1000 - start) / step)
                if (i >= 0 && i < points) aligned[i] = sample(value)
              }
              return { labels: metric, values: aligned }
            }),
          }
        }),
      )
      return { start, step, points, results }
    })
  }

  instant(query: unknown): Promise<Result<InstantResult>> {
    return run(async () => {
      const { context, queries, time } = assertQuery<Record<string, unknown>>(query)
      assertString(context, 'context')
      assertQueries(queries)
      assertIntegerInRange(time, 'time', 0, Number.MAX_SAFE_INTEGER)
      const service = await this.#ready(context)
      const results = await Promise.all(
        queries.map(async ({ id, expr }) => {
          const params = new URLSearchParams({ query: expr, time: String(time / 1000) })
          const { result } = await this.#prom<Vector>(context, service, `/api/v1/query?${params}`)
          return {
            id,
            series: result.map(({ metric, value }) => ({
              labels: metric,
              value: sample(value[1]),
            })),
          }
        }),
      )
      return { results }
    })
  }

  async #ready(context: string): Promise<MetricsService> {
    const source = await this.#source(context)
    if (source.state !== 'ready') {
      throw new KubeRequestError('not-found', `${context} has no metrics history to query.`)
    }
    return source.service
  }

  async #resolve(context: string): Promise<HistorySource> {
    const setting = this.setting(context)
    if (setting.mode === 'off') return { state: 'off' }
    if (setting.mode === 'service') return this.#probe(context, setting.service, true)
    return this.#detect(context)
  }

  /** Tries the most likely services in turn; the first that answers PromQL wins. */
  async #detect(context: string): Promise<HistorySource> {
    const services = await this.kube.list({ context, kind: 'Service' })
    if (!services.ok) {
      return {
        state: 'error',
        configured: false,
        message:
          services.error.status === 403
            ? 'Your account can’t list services, so KubeStacks can’t look for Prometheus. Choose its service instead.'
            : services.error.message,
      }
    }
    const candidates = services.data.items
      .map(candidateFor)
      .filter((c) => c !== undefined)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_PROBES)
    let failure: HistorySource | undefined
    for (const { service } of candidates) {
      const source = await this.#probe(context, service, false)
      if (source.state === 'ready') return source
      failure ??= source
    }
    return failure ?? { state: 'missing' }
  }

  async #probe(
    context: string,
    service: MetricsService,
    configured: boolean,
  ): Promise<HistorySource> {
    try {
      await this.#prom<Vector>(
        context,
        service,
        `/api/v1/query?query=${encodeURIComponent('vector(1)')}`,
      )
    } catch (error) {
      const { status, message } = toKubeError(error)
      const where = `${service.namespace}/${service.service}`
      return {
        state: 'error',
        configured,
        service,
        message:
          status === 403
            ? `Your account can’t reach ${where} through the API server (it needs get on services/proxy).`
            : `${where} didn’t answer PromQL: ${message}`,
      }
    }
    // Prometheus reports its version; VictoriaMetrics answers with a compatible one, or not at all.
    const build = await this.#prom<{ version: string }>(
      context,
      service,
      '/api/v1/status/buildinfo',
    ).catch(() => undefined)
    const flavor = flavorOf(service)
    return {
      state: 'ready',
      flavor,
      service,
      ...(build && flavor === 'prometheus' ? { version: build.version } : {}),
      configured,
    }
  }

  /** Calls the Prometheus HTTP API behind `service` through the API server's service proxy. */
  async #prom<T>(context: string, service: MetricsService, path: string): Promise<T> {
    const proxy = `/api/v1/namespaces/${encodeURIComponent(service.namespace)}/services/${encodeURIComponent(service.service)}:${encodeURIComponent(service.port)}/proxy${service.path}`
    const text = await this.kube.fetchText(context, `${proxy}${path}`)
    // Errors come with an HTTP error status; a 200 without data isn't Prometheus at all.
    let data: T | undefined
    try {
      data = (JSON.parse(text) as { data?: T }).data
    } catch {
      // An HTML page, say: some other web server.
    }
    if (data === undefined)
      throw new KubeRequestError('server', 'It answered, but not like Prometheus.')
    return data
  }
}

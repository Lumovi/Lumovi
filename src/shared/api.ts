/**
 * The contract between the renderer and the main process.
 *
 * Every call that talks to a cluster resolves to a `Result` instead of
 * throwing, because Electron flattens errors that cross IPC into plain
 * strings and we want the renderer to know *why* a request failed.
 */
import type { AppCommand } from './navigation'
import type { ResourceKind } from './resources'

export type ThemePreference = 'system' | 'light' | 'dark'

export interface AppInfo {
  name: string
  version: string
  platform: string
  electron: string
  chrome: string
  node: string
}

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

export interface Settings {
  theme: ThemePreference
  /** Where the window was when it last closed. */
  window?: WindowState
  /** Contexts the user has made read-only: KubeStacks refuses to change them. */
  readOnly?: string[]
  /** Every context is read-only (KUBESTACKS_READ_ONLY is set); not stored. */
  readOnlyAll?: boolean
  /** Where each context's metrics history comes from, when not detected automatically. */
  metricsSource?: Record<string, MetricsSourceSetting>
}

/** A Prometheus-compatible service, reached through the API server's service proxy. */
export interface MetricsService {
  namespace: string
  service: string
  /** The service port, by name or number. */
  port: string
  /** What comes before /api/v1, e.g. /select/0/prometheus for VictoriaMetrics' vmselect. */
  path: string
}

/** How a cluster's metrics history is found: detected (the default), turned off, or chosen. */
export type MetricsSourceSetting =
  { mode: 'auto' } | { mode: 'off' } | { mode: 'service'; service: MetricsService }

export type MetricsFlavor = 'prometheus' | 'victoriametrics'

/** Where a cluster's metrics history comes from right now, or why there is none. */
export type HistorySource =
  | {
      state: 'ready'
      flavor: MetricsFlavor
      service: MetricsService
      version?: string
      /** Chosen in settings rather than detected. */
      configured: boolean
    }
  /** Turned off in settings: only live usage from the metrics API. */
  | { state: 'off' }
  /** Nothing Prometheus-like was found among the cluster's services. */
  | { state: 'missing' }
  | { state: 'error'; message: string; configured: boolean; service?: MetricsService }

/** PromQL to evaluate over a time range; times in milliseconds. */
export interface RangeQuery {
  context: string
  queries: { id: string; expr: string }[]
  start: number
  end: number
  step: number
}

export interface RangeSeries {
  labels: Record<string, string>
  /** One value per step from `start` (null where there is no sample). */
  values: (number | null)[]
}

export interface RangeResult {
  start: number
  step: number
  /** How many steps each series has. */
  points: number
  results: { id: string; series: RangeSeries[] }[]
}

/** PromQL to evaluate at one moment (milliseconds). */
export interface InstantQuery {
  context: string
  queries: { id: string; expr: string }[]
  time: number
}

export interface InstantResult {
  results: { id: string; series: { labels: Record<string, string>; value: number | null }[] }[]
}

export interface KubeContext {
  name: string
  cluster: string
  user: string
  namespace?: string
  server?: string
}

export interface ContextsResult {
  contexts: KubeContext[]
  currentContext?: string
  /** Where the kubeconfig was loaded from, for display. */
  source: string
  /** Set when the kubeconfig exists but could not be parsed. */
  error?: string
}

export type KubeErrorCode =
  | 'unreachable'
  | 'timeout'
  | 'tls'
  | 'insecure'
  | 'auth'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'server'
  | 'invalid'
  | 'conflict'
  | 'read-only'

export interface KubeError {
  code: KubeErrorCode
  message: string
  status?: number
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: KubeError }

export interface ObjectMeta {
  name: string
  /** For objects being created: the API server appends a random suffix. */
  generateName?: string
  namespace?: string
  uid?: string
  creationTimestamp?: string
  deletionTimestamp?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  ownerReferences?: {
    apiVersion?: string
    kind: string
    name: string
    uid: string
    controller?: boolean
    blockOwnerDeletion?: boolean
  }[]
  resourceVersion?: string
  generation?: number
  managedFields?: unknown[]
}

/** A Kubernetes object. Spec and status are kind specific, so they stay loose here. */
export interface KubeObject {
  apiVersion?: string
  kind?: string
  metadata: ObjectMeta
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spec?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  status?: any
  [key: string]: unknown
}

export interface KubeList {
  items: KubeObject[]
  /** True when the collection has more objects than were loaded (see KUBESTACKS_MAX_LIST_ITEMS). */
  truncated: boolean
  /** How many objects match on the server, when the API reports it. */
  total?: number
}

export interface ClusterVersion {
  gitVersion: string
  platform: string
  /** Round-trip time of the check. */
  latencyMs: number
}

export interface ListQuery {
  context: string
  kind: ResourceKind
  namespace?: string
  labelSelector?: string
  fieldSelector?: string
}

export interface GetQuery {
  context: string
  kind: ResourceKind
  name: string
  namespace?: string
}

export interface MetricsQuery {
  context: string
  target: 'nodes' | 'pods'
  namespace?: string
}

/** Live usage from the metrics API: CPU in cores, memory in bytes. */
export interface ContainerUsage {
  name: string
  cpu: number
  memory: number
}

export interface UsageSample {
  name: string
  namespace?: string
  cpu: number
  memory: number
  containers?: ContainerUsage[]
}

export interface MetricsSnapshot {
  /** False when the cluster has no metrics API (metrics-server is not installed). */
  available: boolean
  items: UsageSample[]
}

export interface LogsQuery {
  context: string
  namespace: string
  pod: string
  container: string
  tailLines: number
  previous: boolean
}

export type PatchType = 'merge' | 'strategic' | 'json'
export type DeletePropagation = 'Background' | 'Foreground' | 'Orphan'

/** What to do to an object (or, for `create`, to a collection). */
export type Change =
  | {
      action: 'patch'
      patchType: PatchType
      /** A merge or strategic merge patch object, or a list of JSON patch operations. */
      patch: Record<string, unknown> | Record<string, unknown>[]
    }
  | { action: 'replace'; object: KubeObject }
  | { action: 'delete'; propagation?: DeletePropagation; gracePeriodSeconds?: number }
  | { action: 'create'; object: KubeObject }
  /** Evicts a pod through the Eviction API, which respects PodDisruptionBudgets. */
  | { action: 'evict' }
  /** Adds an ephemeral debug container to a pod, like `kubectl debug`. */
  | { action: 'debug'; container: string; image: string; target?: string }

export interface ChangeRequest {
  context: string
  kind: ResourceKind
  /** The object to change; omitted for `create`. */
  name?: string
  namespace?: string
  change: Change
  /** Validate the change on the server without saving it (`dryRun=All`). */
  dryRun?: boolean
}

/** Workloads that keep a rollout history. */
export type RolloutKind = 'Deployment' | 'StatefulSet' | 'DaemonSet'

export interface HistoryQuery {
  context: string
  kind: RolloutKind
  namespace: string
  name: string
}

/** One rollout of a workload: a ReplicaSet, or a ControllerRevision. */
export interface Revision {
  revision: number
  createdAt: string
  /** The pod template it ran. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  template: { metadata?: any; spec: any }
  /** Why it was made, from the kubernetes.io/change-cause annotation. */
  changeCause?: string
  /** Whether it is what the workload runs now. */
  current: boolean
}

export interface ShellRequest {
  context: string
  namespace: string
  pod: string
  container: string
}

/** How a shell session ended: the exit code, or why it couldn't run. */
export interface ShellExit {
  code?: number
  message?: string
}

export type ForwardKind = 'Pod' | 'Service'

export interface PortForwardRequest {
  context: string
  namespace: string
  kind: ForwardKind
  name: string
  /** The port on the pod, or on the service. */
  port: number
  /** Where to listen on this machine; a free port is picked when omitted. */
  localPort?: number
}

export interface PortForward {
  id: string
  context: string
  namespace: string
  kind: ForwardKind
  name: string
  port: number
  /** Where the traffic goes: the pod itself, or the service's first ready pod. */
  pod: string
  podPort: number
  localPort: number
  /** Connections open right now. */
  connections: number
  /** The last connection's failure, if it failed. */
  error?: string
}

export type AccessVerb = 'get' | 'list' | 'create' | 'update' | 'patch' | 'delete'

/** Whether the current user may do `verb` (a SelfSubjectAccessReview). */
export interface AccessCheck {
  verb: AccessVerb
  kind: ResourceKind
  namespace?: string
  name?: string
  /** e.g. `eviction` or `scale`. */
  subresource?: string
}

export interface KubestacksApi {
  platform: string
  /** Subscribes to commands from the native menu; returns an unsubscribe function. */
  onCommand(listener: (command: AppCommand) => void): () => void
  app: {
    info(): Promise<AppInfo>
    settings(): Promise<Settings>
    setTheme(theme: ThemePreference): Promise<Settings>
    setReadOnly(context: string, readOnly: boolean): Promise<Settings>
    setMetricsSource(context: string, setting: MetricsSourceSetting): Promise<Settings>
    openExternal(url: string): Promise<boolean>
  }
  /** Usage history from the cluster's Prometheus or VictoriaMetrics. */
  usage: {
    /** Detects the source once per session; `refresh` looks again. */
    source(context: string, refresh?: boolean): Promise<Result<HistorySource>>
    /** Checks that a service answers PromQL, before it's saved as the source. */
    test(context: string, service: MetricsService): Promise<Result<HistorySource>>
    range(query: RangeQuery): Promise<Result<RangeResult>>
    instant(query: InstantQuery): Promise<Result<InstantResult>>
  }
  kube: {
    contexts(): Promise<ContextsResult>
    version(context: string): Promise<Result<ClusterVersion>>
    list(query: ListQuery): Promise<Result<KubeList>>
    get(query: GetQuery): Promise<Result<KubeObject>>
    metrics(query: MetricsQuery): Promise<Result<MetricsSnapshot>>
    logs(query: LogsQuery): Promise<Result<string>>
    /** Resolves with the changed object, or null for deletions and evictions. */
    change(request: ChangeRequest): Promise<Result<KubeObject | null>>
    can(context: string, checks: AccessCheck[]): Promise<Result<boolean[]>>
    /** A workload's rollout history, newest first. */
    history(query: HistoryQuery): Promise<Result<Revision[]>>
  }
  /** Interactive shells in containers (`kubectl exec -it`). */
  terminal: {
    /**
     * Starts a shell. The page picks the session's id, so it can listen for
     * output before the shell's first prompt arrives.
     */
    open(id: string, request: ShellRequest): Promise<Result<null>>
    write(id: string, data: string): void
    resize(id: string, columns: number, rows: number): void
    close(id: string): void
    onData(listener: (id: string, data: string) => void): () => void
    onExit(listener: (id: string, exit: ShellExit) => void): () => void
  }
  /** Local ports forwarded to pods and services (`kubectl port-forward`). */
  forwards: {
    start(request: PortForwardRequest): Promise<Result<PortForward>>
    list(): Promise<PortForward[]>
    stop(id: string): Promise<void>
    onChange(listener: (forwards: PortForward[]) => void): () => void
  }
}

/** IPC channel names, shared so the preload and main process cannot drift apart. */
export const IPC = {
  command: 'app:command',
  appInfo: 'app:info',
  settings: 'app:settings',
  setTheme: 'app:set-theme',
  setReadOnly: 'app:set-read-only',
  setMetricsSource: 'app:set-metrics-source',
  openExternal: 'app:open-external',
  contexts: 'kube:contexts',
  version: 'kube:version',
  list: 'kube:list',
  get: 'kube:get',
  metrics: 'kube:metrics',
  logs: 'kube:logs',
  change: 'kube:change',
  can: 'kube:can',
  history: 'kube:history',
  usageSource: 'usage:source',
  usageTest: 'usage:test',
  usageRange: 'usage:range',
  usageInstant: 'usage:instant',
  terminalOpen: 'terminal:open',
  terminalInput: 'terminal:input',
  terminalResize: 'terminal:resize',
  terminalClose: 'terminal:close',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  forwardStart: 'forward:start',
  forwardList: 'forward:list',
  forwardStop: 'forward:stop',
  forwardsChanged: 'forward:changed',
} as const

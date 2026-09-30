/**
 * The contract between the renderer and the main process.
 *
 * Every call that talks to a cluster resolves to a `Result` instead of
 * throwing, because Electron flattens errors that cross IPC into plain
 * strings and we want the renderer to know *why* a request failed.
 */
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

export interface Settings {
  theme: ThemePreference
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

export interface KubeError {
  code: KubeErrorCode
  message: string
  status?: number
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: KubeError }

export interface ObjectMeta {
  name: string
  namespace?: string
  uid?: string
  creationTimestamp?: string
  deletionTimestamp?: string
  labels?: Record<string, string>
  annotations?: Record<string, string>
  ownerReferences?: { kind: string; name: string; uid: string; controller?: boolean }[]
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
  resourceVersion?: string
}

export interface ClusterVersion {
  gitVersion: string
  platform: string
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

export interface KubestacksApi {
  platform: string
  app: {
    info(): Promise<AppInfo>
    settings(): Promise<Settings>
    setTheme(theme: ThemePreference): Promise<Settings>
    openExternal(url: string): Promise<boolean>
  }
  kube: {
    contexts(): Promise<ContextsResult>
    version(context: string): Promise<Result<ClusterVersion>>
    list(query: ListQuery): Promise<Result<KubeList>>
    get(query: GetQuery): Promise<Result<KubeObject>>
    metrics(query: MetricsQuery): Promise<Result<MetricsSnapshot>>
    logs(query: LogsQuery): Promise<Result<string>>
  }
}

/** IPC channel names, shared so the preload and main process cannot drift apart. */
export const IPC = {
  appInfo: 'app:info',
  settings: 'app:settings',
  setTheme: 'app:set-theme',
  openExternal: 'app:open-external',
  contexts: 'kube:contexts',
  version: 'kube:version',
  list: 'kube:list',
  get: 'kube:get',
  metrics: 'kube:metrics',
  logs: 'kube:logs',
} as const

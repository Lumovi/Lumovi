/**
 * The contract between the page and what runs it: the desktop app's main
 * process (over IPC), or the server (over a WebSocket).
 *
 * Every call that talks to a cluster resolves to a `Result` instead of
 * throwing, because errors that cross IPC or the network are flattened into
 * plain strings and we want the page to know *why* a request failed.
 */
import type { ClusterSettings } from './cluster-settings'
import type { AccessPolicy, AdminAccess, MyAccess } from './access'
import type { AiPermissions, AiPermissionsView } from './ai-permissions'
import type {
  AssistantClient,
  AssistantsSetting,
  AssistantsStatus,
  ChangeProposal,
  ProposalDecision,
  ProposalOutcome,
  ServerAssistantsStatus,
} from './assistants'
import type { AuditEvent, AuditInfo, AuditPage, AuditQuery, AuditVerification } from './audit'
import type { AppCommand } from './navigation'
import type { ResourceDefinition, ResourceKind } from './resources'
import type { SponsorCard } from './sponsor'

export type ThemePreference = 'system' | 'light' | 'dark'

export interface AppInfo {
  name: string
  version: string
  platform: string
  /** The desktop app's. */
  electron?: string
  chrome?: string
  node: string
}

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

/**
 * A cluster's settings, changed where a server keeps them, outside Lumovi, and what Lumovi did:
 * it keeps the stricter (read-only if either was; the rest as it last set them).
 */
export interface ChangedOutside {
  /** When the server found it. */
  at: string
  /** Its setting deleted, or replaced by an older copy of it. */
  how: 'deleted' | 'replaced'
  /**
   * Read-only turned off, and made so again (`restored`); made so by the older copy (`made`); or
   * as it was (`kept`).
   */
  readOnly: 'restored' | 'made' | 'kept'
  /** The others it changed, which Lumovi put back as it last set them. */
  restored: ('metricsSource' | 'nodeShell')[]
}

export interface Settings {
  theme: ThemePreference
  /** Where the window was when it last closed. */
  window?: WindowState
  /** Contexts the user has made read-only: Lumovi refuses to change them. */
  readOnly?: string[]
  /** Every context is read-only (LUMOVI_READ_ONLY is set); not stored. */
  readOnlyAll?: boolean
  /**
   * A server's: who made each cluster read-only for everyone on it, and when (`outside` where an
   * older copy, put back outside Lumovi, made it so: then not who, as that's the copy's); not
   * stored.
   */
  readOnlyBy?: Record<string, { by: string; at: string; outside?: true }>
  /**
   * A server's, for those who may change its settings: clusters whose settings were changed where
   * the server keeps them, outside Lumovi, as each was dealt with (until someone who may sets
   * read-only again); not stored.
   */
  changedOutside?: Record<string, ChangedOutside>
  /**
   * A server's: its clusters' settings (read-only, metrics, node shells) are everyone's, changed by
   * Lumovi's admins, or by anyone where there are none. Whether this person may; not stored.
   */
  shared?: { mayChange: boolean }
  /** Where each context's metrics history comes from, when not detected automatically. */
  metricsSource?: Record<string, MetricsSourceSetting>
  /** Where each context's node shells run, when not where they do by default. */
  nodeShell?: Record<string, NodeShellSetting>
  /** Where node shells run unless set for a context (a server's may differ); not stored. */
  nodeShellDefault?: NodeShellSetting
  /** Node shells are turned off (on a server, LUMOVI_NODE_SHELL=off); not stored. */
  nodeShellsOff?: boolean
  /**
   * The desktop app's: the kubeconfig files chosen in Lumovi in place of KUBECONFIG's (or
   * ~/.kube/config), in the order kubectl would merge them (none: those). Read, never written.
   */
  kubeconfigFiles?: string[]
  /** The desktop app's: kubeconfig files added after those (chosen, or KUBECONFIG's). */
  kubeconfigAdded?: string[]
  /** The desktop app's: how each cluster shows in Lumovi, by its context. */
  clusters?: Record<string, ClusterSettings>
  /** Whether to look for new versions in the background (Help → Check for Updates Automatically). */
  autoUpdate?: boolean
  /** Whether terminals get a kubectl matching each cluster's version (View → Match kubectl to Each Cluster). */
  matchingKubectl?: boolean
  /** The desktop app's MCP server, for AI assistants. */
  assistants?: AssistantsSetting
  /** What AI assistants may do, and where (the desktop app's; a server keeps each person's). */
  aiPermissions?: AiPermissions
  /** What the organization's policy sets on this computer, which can't be changed here. */
  managed?: ManagedSettings
}

/** What a company's policy sets on a computer (the desktop app's), locked; not stored. */
export interface ManagedSettings {
  /** Where the policy is. */
  source: string
  /** Every cluster read-only, or those whose names match (`*` for any characters). */
  readOnly?: true | string[]
  /** AI assistants can't be turned on. */
  assistantsOff?: true
  /** Lumovi doesn't update itself: the organization deploys new versions. */
  updatesOff?: true
  /** Terminals use the kubectl installed: Lumovi gets none to match a cluster. */
  kubectlOff?: true
  /** Where Lumovi gets kubectl from: a mirror of dl.k8s.io. */
  kubectlMirror?: string
  /** A mirror's kubectl too only with Kubernetes' signature, as dl.k8s.io's always. */
  kubectlSignatures?: 'required'
  /** Only KUBECONFIG's kubeconfig, or ~/.kube/config: none can be chosen in Lumovi. */
  kubeconfigFilesLocked?: true
  /** Why it can't be used: it locks the most it could, until it's put right. */
  problem?: string
}

/** Whether the organization's policy makes a cluster read-only. */
export function managedReadOnly(managed: ManagedSettings | undefined, context: string): boolean {
  const readOnly = managed?.readOnly
  if (readOnly === true) return true
  return (readOnly ?? []).some((pattern) =>
    new RegExp(`^${pattern.split('*').map(escaped).join('.*')}$`).test(context),
  )
}

const escaped = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

/** Who brings new versions of Lumovi, when it doesn't update itself. */
export type UpdatesBy = 'organization' | 'store'

/** Where updating Lumovi to a new version is at. */
export type UpdateState =
  /** Nothing to tell: no check yet. */
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'up-to-date' }
  | { status: 'downloading'; version: string; percent: number }
  /** Downloaded: installed when the app restarts or quits. */
  | { status: 'ready'; version: string }
  /** This copy can't update itself, e.g. while developing it. */
  | { status: 'unsupported' }
  /** Someone else brings new versions: the organization's policy deploys them ('organization'), or the Microsoft Store ('store'). */
  | { status: 'managed'; by: UpdatesBy }
  | { status: 'error'; message: string }

export interface UpdateEvent {
  state: UpdateState
  /** The outcome of a check the user asked for (rather than one in the background). */
  manual: boolean
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
  /** The desktop app's: the kubeconfig file it's read from. */
  file?: string
  /** A fleet's: what the cluster is labelled with (env, region…), to filter and group by. */
  labels?: Record<string, string>
}

/** The kubeconfig files the desktop app reads, merged as kubectl would (the first to name a thing wins). */
export interface KubeconfigFiles {
  /**
   * Each, in order, where it is; one that isn't there is skipped, as kubectl does. Those added in
   * Lumovi after the rest are `added`, and those it was given (chosen or added) `removable`. Last,
   * Lumovi's `own`: clusters added in it (see `addedClusters`).
   */
  files: {
    path: string
    exists: boolean
    /** Where it comes from: the default, KUBECONFIG, chosen or added in Lumovi, or Lumovi's own. */
    origin: 'default' | 'env' | 'chosen' | 'added' | 'own'
    added?: true
    removable?: true
    own?: true
    /** As last read: how many contexts it has, or why it couldn't be read (and was left out). */
    contexts?: number
    problem?: string
    /** One of Lumovi's own: when it was added. */
    addedAt?: string
  }[]
  /**
   * Where the files before those added come from: chosen in Lumovi, KUBECONFIG, or the default
   * (~/.kube/config).
   */
  from: 'chosen' | 'env' | 'default'
  /** Why it can't be changed in Lumovi (the organization's policy), if it can't. */
  locked?: string
  /** The person's home folder, to show paths in it from `~`. */
  home: string
  /** The folder Lumovi keeps the clusters added in it in (shown, and shown in Finder, as one). */
  ownFolder: string
}

/** A program a kubeconfig's credentials run on this computer, exactly as it would run. */
export interface CredentialCommand {
  /** The kubeconfig user it signs in as. */
  user: string
  /** As it runs: the program and its arguments, quoted as a shell would need them. */
  line: string
  /** Run through a shell, as written (an auth provider's cmd-path and cmd-args), not as a program. */
  shell?: true
  /** The environment variables set for it, over Lumovi's. */
  env: { name: string; value: string }[]
  /** What the page gives back when the person agrees to it: this, exactly as shown. */
  consent: string
  /** One added in Lumovi, edited: the server it now runs for, where it didn't before. */
  movedTo?: string
}

/** A kubeconfig pasted or imported, read (nothing run, nothing reached). */
export interface PastedKubeconfig {
  contexts: {
    name: string
    server?: string
    namespace?: string
    /** The kubeconfig user it signs in as. */
    user?: string
    /** How it signs in. */
    auth: 'token' | 'certificate' | 'basic' | 'command' | 'none'
    /** Its server isn't verified (`insecure-skip-tls-verify`): its credentials go to whoever answers. */
    insecure?: true
    /** Everything to it goes through this proxy (`proxy-url`). */
    proxy?: string
  }[]
  /** The programs its credentials run: shown, and never run before the person agrees. */
  commands: CredentialCommand[]
  /**
   * Files whose text its credentials send, and the server each goes to: shown, and never read
   * before the person agrees.
   */
  tokenFiles: { user: string; path: string; server: string; consent: string }[]
  /**
   * Servers not verified (`insecure-skip-tls-verify`) its credentials would go to: whatever
   * answers there gets them, so each is agreed to first.
   */
  unverified: { context: string; server: string; consent: string }[]
  /**
   * One added in Lumovi, edited: the contexts its kept credentials (placeholders left as they
   * were) would go to that they weren't kept for (its server moved, or a context added), each to
   * be agreed to before they're sent there.
   */
  keptCredentials: { context: string; server: string; consent: string }[]
  /** The files on this computer its connections read (a token file's text is sent to its server). */
  files: string[]
  /** Its contexts named as some already read are: kubectl would take those, not these. */
  conflicts: string[]
}

/** Whether a context of a pasted kubeconfig can be used: its server answers, and its credentials work. */
export interface ClusterCheck {
  server: { ok: true; version?: string; latencyMs?: number } | { ok: false; message: string }
  /**
   * Signed in (and whether it may list namespaces), refused, or not tried: its credentials run a
   * program the person hasn't agreed to.
   */
  credentials:
    | { ok: true; allowed: boolean }
    | { ok: false; message: string }
    | { ok: false; notTried: 'agreement' | 'server' }
}

export interface ContextsResult {
  contexts: KubeContext[]
  currentContext?: string
  /** Where the kubeconfig was loaded from, for display. */
  source: string
  /** Set when the kubeconfig exists but could not be parsed (nothing else could be read). */
  error?: string
  /** Files that couldn't be read, left out (the desktop app's), and why: the rest are read. */
  problems?: { path: string; message: string }[]
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
  | 'helm'
  /** Lumovi's admins don't let this person do it there (their access, not the cluster's RBAC). */
  | 'not-allowed'
  /** A fleet's agent sent a certificate authority the hub doesn't trust for its cluster. */
  | 'untrusted-agent'

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
  /** True when the collection has more objects than were loaded (see LUMOVI_MAX_LIST_ITEMS). */
  truncated: boolean
  /** How many objects match on the server, when the API reports it. */
  total?: number
  /**
   * For kinds without columns of their own (custom resources and the like): the
   * columns the API server prints for them, like `kubectl get`, and each item's cells.
   */
  table?: { columns: TableColumn[]; cells: unknown[][] }
}

/** A column the API server computes for a list (its Table output). */
export interface TableColumn {
  name: string
  /** `string`, `integer`, `number`, `boolean` or `date`; dates arrive as relative times like "5d". */
  type: string
  format?: string
  description?: string
  /** 0 is shown by default; higher only in kubectl's wide output. */
  priority: number
}

/** The part of a kind's OpenAPI schema Lumovi uses to explain its fields. */
export interface FieldSchema {
  type?: string
  description?: string
  format?: string
  enum?: unknown[]
  properties?: Record<string, FieldSchema>
  items?: FieldSchema
  additionalProperties?: FieldSchema
}

/** A Helm release, as its latest revision describes it. */
export interface HelmRelease {
  name: string
  namespace: string
  revision: number
  /** deployed, failed, pending-install, pending-upgrade, pending-rollback, uninstalling… */
  status: string
  chart: string
  chartVersion: string
  appVersion?: string
  /** When its latest revision was deployed. */
  updated?: string
  description?: string
  /** The Flux HelmRelease that manages it, if one does. */
  managedBy?: { name: string; namespace: string }
}

/** One revision of a release: what it was given, and what it rendered. */
export interface HelmRevision {
  revision: number
  status: string
  updated?: string
  chartVersion: string
  appVersion?: string
  description?: string
  /** The values the user set, not the chart's defaults. */
  values: Record<string, unknown>
  manifest: string
  notes?: string
}

export interface HelmReleaseDetail extends HelmRelease {
  firstDeployed?: string
  chartInfo: {
    description?: string
    home?: string
    sources?: string[]
    /** Its subcharts; a chart without any can be upgraded as the cluster stores it. */
    dependencies: string[]
  }
  /** The chart's default values. */
  defaults: Record<string, unknown>
  /** The chart's values.schema.json, when it has one. */
  schema?: unknown
  /** Newest first. */
  revisions: HelmRevision[]
  /**
   * Why its values and manifests aren't shown (each revision's are empty): they can hold
   * Secrets, and the person's access shows them only the keys of those here.
   */
  withheld?: string
}

/** Where a chart comes from, the way helm takes it. */
export interface ChartSource {
  /** A chart name with `repository`, a repo/chart, an oci:// reference, a URL or a path. */
  chart: string
  /** A chart repository's URL (helm's --repo). */
  repository?: string
  version?: string
}

/** The user's helm, which makes the changes. */
export interface HelmCli {
  available: boolean
  /** What runs: LUMOVI_HELM, the helm Lumovi ships with, or helm on the PATH. */
  command: string
  version?: string
}

export interface HelmRollback {
  context: string
  namespace: string
  name: string
  revision: number
}

export interface HelmUninstall {
  context: string
  namespace: string
  name: string
  keepHistory: boolean
}

/** An upgrade, or with `install`, a new release. */
export interface HelmDeploy {
  context: string
  namespace: string
  name: string
  /** The chart; `stored` upgrades with the chart the release already runs. */
  source: ChartSource | 'stored'
  /** All the values the user sets, as YAML (what `-f values.yaml` would hold). */
  values: string
  install?: boolean
  createNamespace?: boolean
  /** Asks the API server, changes nothing. */
  dryRun: boolean
}

/** What a deploy did, or would do. */
export interface HelmDeployed {
  revision: number
  manifest: string
  notes?: string
}

/** A chart found on Artifact Hub. */
export interface ChartSearchResult {
  name: string
  version: string
  appVersion?: string
  description?: string
  repository: { name: string; url: string }
}

/** A chart on this computer: a folder, or a packaged chart (.tgz). */
export interface LocalChart {
  /** Its full path. */
  path: string
  archive: boolean
  name: string
  version: string
  appVersion?: string
  description?: string
  /** Its subcharts, and whether they're in its charts/ folder (`helm dependency list`). */
  dependencies: { name: string; version: string; repository: string; status: string }[]
  /** Values files beside it (values-prod.yaml, ci/test-values.yaml), relative to it. */
  valuesFiles: string[]
}

/** What `helm lint` found. */
export interface LintResult {
  passed: boolean
  messages: { severity: 'info' | 'warning' | 'error'; text: string }[]
}

/**
 * View files the user keeps next to Lumovi's own (the format:
 * https://docs.lumovi.dev/reference/view-format).
 */
export interface LocalViews {
  directory: string
  /** Each file's text, or why it wasn't read. */
  files: { name: string; text: string; error?: string }[]
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
  /** The object's Scale (from the scale subresource) instead of the object. */
  subresource?: 'scale'
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

/** What's in use of what can be handed out: CPU in cores, memory in bytes. */
export interface Capacity {
  /** Live usage from metrics-server, when available. */
  used: number
  /** What the scheduler can hand out across all nodes. */
  total: number
}

/**
 * A cluster summed up for a fleet, as its overview's tiles do, as whoever is
 * signed in sees it. Each part is what was counted, or why it couldn't be (a
 * person may list deployments but not nodes). Without a version, the cluster
 * didn't answer, and nothing else was asked.
 */
/** A fleet's agent as its admins see it: its cluster's certificate authority, sent and trusted. */
export interface AgentTrust {
  name: string
  connected: boolean
  /**
   * The start of the SHA-256 (hex) of each certificate it sends as its cluster's authority now:
   * enough to tell them apart, never all of it (or it could be given back to trust it).
   */
  sent: string[]
  /** The start of each SHA-256 the hub trusts it with: as LUMOVI_FLEET_AGENTS names them, or kept. */
  trusted: string[]
  /** LUMOVI_FLEET_AGENTS names them: only changed there. */
  named: boolean
  /** Trusted as it first sent it, nobody having checked it. */
  unconfirmed: boolean
  /** What it sends isn't what it's trusted with. */
  refused: boolean
}

export interface ClusterSummary {
  /** When it was taken. */
  at: number
  version: Result<ClusterVersion>
  nodes?: Result<{ ready: number; total: number }>
  /** Pods in every namespace: running, and those failing or waiting too long. */
  pods?: Result<{ running: number; unhealthy: number; total: number; truncated: boolean }>
  /** Deployments, StatefulSets and DaemonSets: healthy (or scaled to zero), of all. */
  workloads?: Result<{ healthy: number; total: number }>
  /** Warning events in the last hour. */
  warnings?: Result<{ lastHour: number }>
  /** CPU (cores) and memory (bytes) in use, of what the nodes can allocate; absent without metrics-server. */
  usage?: Result<{ cpu: Capacity; memory: Capacity } | null>
}

/** A container's logs to stream (`kubectl logs`), and where to start. */
export interface LogStreamRequest {
  context: string
  namespace: string
  pod: string
  container: string
  /** Start with its last lines… */
  tailLines?: number
  /** …or with those written in the last so many seconds… */
  sinceSeconds?: number
  /** …or since a time (RFC 3339), to carry on after a stream ends. */
  sinceTime?: string
  /** The container's previous instance: its lines arrive, then the stream ends. */
  previous: boolean
  /** Keep the stream open for new lines (`-f`). */
  follow: boolean
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
      /** Patches the object's status or scale instead of the object itself. */
      subresource?: 'status' | 'scale'
    }
  | { action: 'replace'; object: KubeObject }
  | {
      action: 'delete'
      propagation?: DeletePropagation
      gracePeriodSeconds?: number
      /** Only the object with this uid: not one made again since, under its name. */
      uid?: string
    }
  | { action: 'create'; object: KubeObject }
  /** Evicts a pod through the Eviction API, which respects PodDisruptionBudgets. */
  | { action: 'evict' }
  /** Adds an ephemeral debug container to a pod, like `kubectl debug`. */
  | { action: 'debug'; container: string; image: string; target?: string }
  /**
   * Server-side apply (`kubectl apply --server-side`): creates the object, or
   * sets the fields `object` has, as `fieldManager`; `force` takes them over
   * from other managers instead of failing on their conflicts
   * (`--force-conflicts`).
   */
  | { action: 'apply'; object: KubeObject; fieldManager: string; force: boolean }

/** A container's logs as they are (not followed): `kubectl logs`. */
export interface PodLogsQuery {
  context: string
  namespace: string
  pod: string
  /** The pod's only container unless named. */
  container?: string
  /** The last so many lines. */
  tailLines: number
  /** Its run before the last restart. */
  previous?: boolean
  sinceSeconds?: number
  /** At most so many bytes, from the start of the lines asked for. */
  limitBytes: number
}

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

/** A shell in one of a pod's containers (`kubectl exec -it`). */
export interface ContainerShellRequest {
  target: 'container'
  context: string
  namespace: string
  pod: string
  container: string
}

/**
 * A shell on a node, through a short-lived privileged pod there (as
 * `kubectl debug node` makes): in the node's own namespaces, as root on the
 * node, or in the pod itself, with the node's files under /host (for nodes
 * without a shell of their own).
 */
export interface NodeShellRequest {
  target: 'node'
  context: string
  node: string
  mode: 'node' | 'pod'
}

/** A shell on this computer, with kubectl pointed at `context` (the desktop app's). */
export interface LocalShellRequest {
  target: 'local'
  context: string
  /** The namespace kubectl uses there; the context's own unless set. */
  namespace?: string
}

export type ShellRequest = ContainerShellRequest | NodeShellRequest | LocalShellRequest

/** Where a context's node shells run: the namespace of their pods, and its image. */
export interface NodeShellSetting {
  namespace: string
  image: string
}

/**
 * Unless set otherwise: kube-system, where privileged pods are usually allowed,
 * and an image with nsenter (as the kubectl node-shell plugin uses).
 */
export const NODE_SHELL_DEFAULTS: NodeShellSetting = {
  namespace: 'kube-system',
  image: 'alpine:3.22',
}

/** How a shell session ended: the exit code, or why it couldn't run. */
export interface ShellExit {
  code?: number
  message?: string
  /** What's left that Lumovi couldn't clean up, and why (a node shell's pod). */
  left?: string
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

/** Where Lumovi runs: the desktop app, or a server in a cluster that pages connect to. */
export type Host = 'desktop' | 'server'

export interface LumoviApi {
  /** The operating system the page runs on, as Node.js names it (darwin, win32, linux). */
  platform: string
  host: Host
  /** The desktop app's window: its native menu, and full screen. */
  desktop?: {
    /** Subscribes to commands from the native menu; returns an unsubscribe function. */
    onCommand(listener: (command: AppCommand) => void): () => void
    /** Called when the window enters or leaves full screen (where macOS hides its window controls). */
    onFullScreen(listener: (fullScreen: boolean) => void): () => void
    /**
     * Says whether a terminal on this computer has focus: its ⌘ keys are then its own
     * (⌘T, ⌘W…), not the menu's.
     */
    setTerminalFocus(focused: boolean): void
    /**
     * Opens the app's menu at a point of the page (its CSS pixels), for a window without a menu
     * bar (Windows', Linux's); done once it closes.
     */
    openMenu(x: number, y: number): Promise<void>
  }
  app: {
    info(): Promise<AppInfo>
    settings(): Promise<Settings>
    /**
     * What Lumovi couldn't set up as it started (the desktop app): its organization's policy,
     * a certificate authority's file, a proxy. Once the network is set up.
     */
    problems?(): Promise<string[]>
    setTheme(theme: ThemePreference): Promise<Settings>
    setReadOnly(context: string, readOnly: boolean): Promise<Settings>
    /** The desktop app's: how a cluster shows in Lumovi (all of it: what's left out is unset). */
    setCluster?(context: string, settings: ClusterSettings): Promise<Result<Settings>>
    setMetricsSource(context: string, setting: MetricsSourceSetting): Promise<Settings>
    /** Where `context`'s node shells run; NODE_SHELL_DEFAULTS (or the server's) to reset. */
    setNodeShell(context: string, setting: NodeShellSetting | null): Promise<Settings>
    /** Opens a web page in the browser. */
    openExternal(url: string): Promise<boolean>
    /** Saves `text` as a file named `name` (asking where, on the desktop); false if the user cancels. */
    saveFile(name: string, text: string): Promise<Result<boolean>>
    /** The user's own view files, read when asked. */
    views(): Promise<LocalViews>
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
    /** Every kind the cluster serves that can be listed, built-in kinds included, looked up afresh. */
    resources(context: string): Promise<Result<ResourceDefinition[]>>
    /** A kind's schema, from the cluster's OpenAPI documents; null when it publishes none. */
    schema(context: string, kind: ResourceKind): Promise<Result<FieldSchema | null>>
    list(query: ListQuery): Promise<Result<KubeList>>
    get(query: GetQuery): Promise<Result<KubeObject>>
    metrics(query: MetricsQuery): Promise<Result<MetricsSnapshot>>
    /** Resolves with the changed object, or null for deletions and evictions. */
    change(request: ChangeRequest): Promise<Result<KubeObject | null>>
    can(context: string, checks: AccessCheck[]): Promise<Result<boolean[]>>
    /** A workload's rollout history, newest first. */
    history(query: HistoryQuery): Promise<Result<Revision[]>>
  }
  /**
   * Helm releases: read from the cluster (where Helm keeps them), changed with
   * helm.
   */
  helm: {
    releases(context: string, namespace?: string): Promise<Result<HelmRelease[]>>
    release(context: string, namespace: string, name: string): Promise<Result<HelmReleaseDetail>>
    cli(): Promise<HelmCli>
    rollback(request: HelmRollback): Promise<Result<null>>
    uninstall(request: HelmUninstall): Promise<Result<null>>
    deploy(request: HelmDeploy): Promise<Result<HelmDeployed>>
    /** A chart's default values, as YAML. */
    defaults(source: ChartSource): Promise<Result<string>>
    /** The versions a chart repository has of a chart, newest first. */
    versions(repository: string, chart: string): Promise<Result<string[]>>
    /** Charts on Artifact Hub. */
    search(query: string): Promise<Result<ChartSearchResult[]>>
  }
  /** Helm charts on this computer: the desktop app's. */
  /**
   * The desktop app's kubeconfig files: which it reads, chosen here or by KUBECONFIG. Lumovi
   * never writes them. Each change reads them again (kube.contexts says what they hold).
   */
  kubeconfigFiles?: {
    list(): Promise<KubeconfigFiles>
    /**
     * Asks for kubeconfig files: in place of those read (`replace`), or after them (`add`: those
     * before still come from KUBECONFIG, if that's where they come from); null if the user
     * cancels.
     */
    choose(how: 'replace' | 'add'): Promise<Result<KubeconfigFiles | null>>
    /** One Lumovi was given (chosen or added) no longer read; the file itself is left as it is. */
    remove(path: string): Promise<Result<KubeconfigFiles>>
    /** Back to KUBECONFIG's, or ~/.kube/config. */
    useDefault(): Promise<Result<KubeconfigFiles>>
    /**
     * One Lumovi was given that's gone, chosen again where it is now (the system's file picker),
     * in its place; null if the user cancels.
     */
    chooseAgain(path: string): Promise<Result<KubeconfigFiles | null>>
    /** Shows one of them, or Lumovi's own folder, in Finder or Explorer. */
    show(path: string): Promise<void>
  }
  /**
   * The desktop app's: clusters added in Lumovi from a pasted or imported kubeconfig, each kept as
   * a file of its own (0600, in Lumovi's data folder) after those read. The person's own files
   * are never written. What a credential does on this computer (runs a program, sends a file) is
   * done only once the person agrees to that very thing: `agreed` holds the `consent` of each.
   * An added cluster's secrets stay in the main process: the page gets placeholders.
   */
  addedClusters?: {
    /** Asks for a kubeconfig file to import, and gives its text; null if the user cancels. */
    import(): Promise<Result<string | null>>
    /**
     * What a kubeconfig holds, and what it would run or send: nothing run, nothing reached. Of one
     * Lumovi keeps being edited (`editing`, its path), as its placeholders' secrets make it.
     */
    inspect(text: string, editing?: string): Promise<Result<PastedKubeconfig>>
    /** Whether one of its contexts can be used (of one being edited, with its secrets). */
    check(
      text: string,
      context: string,
      agreed: string[],
      editing?: string,
    ): Promise<Result<ClusterCheck>>
    /**
     * Kept, as a file of Lumovi's own, and read after the rest: its contexts (or those named),
     * each renamed as `names` says (to not be taken for one already read).
     */
    add(
      text: string,
      options: { contexts?: string[]; names?: Record<string, string>; agreed: string[] },
    ): Promise<Result<{ path: string; files: KubeconfigFiles }>>
    /** The text of one Lumovi keeps, to edit: its secrets as placeholders. */
    read(path: string): Promise<Result<string>>
    /**
     * One Lumovi keeps, written again (checked as add checks it): a placeholder left as it was
     * keeps its secret, and what was agreed to before needn't be again.
     */
    edit(path: string, text: string, agreed: string[]): Promise<Result<KubeconfigFiles>>
    /** One Lumovi keeps, no longer read, and its file deleted. */
    remove(path: string): Promise<Result<KubeconfigFiles>>
    /**
     * The line for a terminal (`export KUBECONFIG=…`, or PowerShell's) that has kubectl read the
     * same: one of the files read, or all of them, in order.
     */
    forKubectl(path?: string): Promise<Result<string>>
  }
  localCharts?: {
    /** Asks for a chart folder or a packaged chart; null if the user cancels. */
    choose(kind: 'folder' | 'archive'): Promise<string | null>
    /** What a chart on this computer is, and what it needs. */
    read(path: string): Promise<Result<LocalChart>>
    /** Checks a local chart with these values (`helm lint`). */
    lint(path: string, values: string): Promise<Result<LintResult>>
    /** One of a local chart's values files. */
    valuesFile(path: string, file: string): Promise<Result<string>>
    /** Downloads a local chart's subcharts into its charts/ folder (`helm dependency update`). */
    updateDependencies(path: string): Promise<Result<null>>
  }
  /**
   * Interactive shells: in containers (`kubectl exec -it`), on nodes, and, in
   * the desktop app, on this computer.
   */
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
  /** Container logs as they're written (`kubectl logs -f --timestamps`). */
  logs: {
    /** Starts a stream; the page picks its id, so it can listen before lines arrive. */
    start(id: string, request: LogStreamRequest): Promise<Result<null>>
    stop(id: string): void
    /** Lines, each starting with its timestamp, in batches as they arrive. */
    onLines(listener: (id: string, lines: string[]) => void): () => void
    /** A stream ended: its container stopped, the connection closed, or it failed. */
    onEnd(listener: (id: string, error?: KubeError) => void): () => void
  }
  /** Ports on this computer forwarded to pods and services (`kubectl port-forward`): the desktop app's. */
  forwards?: {
    start(request: PortForwardRequest): Promise<Result<PortForward>>
    list(): Promise<PortForward[]>
    stop(id: string): Promise<void>
    onChange(listener: (forwards: PortForward[]) => void): () => void
  }
  /** A fleet's: each cluster summed up, for the page of every cluster (a server with a fleet). */
  fleet?: {
    summary(context: string): Promise<ClusterSummary>
    /** An admin's: each agent's certificate authority, as it sends it and as it's trusted. */
    agents(): Promise<AgentTrust[]>
    /**
     * An admin's: trusts an agent with the certificate authority it sends now, if it's the one
     * whose SHA-256 they give (from its cluster itself).
     */
    trustAgent(name: string, sha256: string): Promise<void>
  }
  /** Changes AI assistants ask for, waiting for the person's approval: the desktop app's or a server's. */
  approvals?: {
    decide(id: string, decision: ProposalDecision): Promise<void>
    /** Changes waiting for approval now, for a page that has just loaded. */
    pending(): Promise<ChangeProposal[]>
    onProposal(listener: (proposal: ChangeProposal) => void): () => void
    onOutcome(listener: (outcome: ProposalOutcome) => void): () => void
  }
  /** The desktop app's MCP server, for AI assistants on this computer. */
  assistants?: {
    status(): Promise<AssistantsStatus>
    /** Turns it on or off, or moves it to another port. */
    configure(setting: { enabled?: boolean; port?: number }): Promise<AssistantsStatus>
    /** A new token: assistants set up with the old one are set up again. */
    resetToken(): Promise<AssistantsStatus>
    /** Sets an assistant up: Claude Desktop's settings, or Cursor's or VS Code's install link. */
    install(client: AssistantClient): Promise<Result<string>>
    onStatus(listener: (status: AssistantsStatus) => void): () => void
  }
  /**
   * What AI assistants may do, and where: the person's own (the desktop app's, or theirs on a
   * server), under a server's administrator's rules.
   */
  aiPermissions?: {
    get(): Promise<AiPermissionsView>
    /** Keeps them (they're checked first): what's kept, or why it couldn't be. */
    set(permissions: AiPermissions): Promise<AiPermissionsView>
    /** Another page (or window) changed them. */
    onChanged(listener: (view: AiPermissionsView) => void): () => void
  }
  /**
   * The audit log: what's been done through Lumovi, by whom, and how it came out. The person's
   * own, or (an auditor on a server) everyone's.
   */
  audit: {
    info(): Promise<AuditInfo>
    query(query: AuditQuery): Promise<AuditPage>
    /** Checks that every event kept follows from the one before it. */
    verify(): Promise<AuditVerification>
    /** Each event the person may see, as it's recorded, until let go of. */
    onEvent(listener: (event: AuditEvent) => void): () => void
  }
  /** A server's: who may do what through Lumovi. The person's own; all of it, for an admin. */
  access?: {
    mine(): Promise<MyAccess>
    /** An admin's: all of it, and the version read (saving says it). */
    admin(): Promise<AdminAccess>
    /** An admin's: keeps it, checked, unless someone saved since `version` (a conflict). */
    set(policy: AccessPolicy, version: string): Promise<Result<AdminAccess>>
    /** An admin's: how access changed, the newest first, from the audit log. */
    history(after?: string): Promise<AuditPage>
    /** It changed (here, or on another page): ask again. */
    onChanged(listener: () => void): () => void
  }
  /** A server's MCP server: where assistants connect, and the person's. */
  serverAssistants?: {
    status(): Promise<ServerAssistantsStatus>
    /** Lets one of the person's assistants go: it signs in again to come back. */
    revoke(id: string): Promise<ServerAssistantsStatus>
    onStatus(listener: (status: ServerAssistantsStatus) => void): () => void
  }
  /** The sidebar's sponsor card, from Lumovi/main-sponsor (see shared/sponsor). */
  sponsor: {
    card(): Promise<SponsorCard>
    onChange(listener: (card: SponsorCard) => void): () => void
  }
  /** New versions of the desktop app, from its GitHub releases. */
  updates?: {
    state(): Promise<UpdateEvent>
    /** Looks for a new version now, as Help → Check for Updates does. */
    check(): Promise<void>
    /** Restarts into the downloaded version. */
    install(): Promise<void>
    onChange(listener: (event: UpdateEvent) => void): () => void
  }
}

/** Channel names, shared so the page and what answers it cannot drift apart. */
export const IPC = {
  command: 'app:command',
  terminalFocus: 'terminal:focus',
  openMenu: 'app:open-menu',
  appInfo: 'app:info',
  appProblems: 'app:problems',
  settings: 'app:settings',
  /** A server's: someone changed its clusters' settings (everyone's pages read them again). */
  settingsChanged: 'app:settings-changed',
  setTheme: 'app:set-theme',
  setReadOnly: 'app:set-read-only',
  setCluster: 'app:set-cluster',
  setMetricsSource: 'app:set-metrics-source',
  setNodeShell: 'app:set-node-shell',
  openExternal: 'app:open-external',
  saveFile: 'app:save-file',
  views: 'app:views',
  contexts: 'kube:contexts',
  kubeconfigFiles: 'kubeconfig:files',
  kubeconfigChoose: 'kubeconfig:choose',
  kubeconfigRemove: 'kubeconfig:remove',
  kubeconfigUseDefault: 'kubeconfig:use-default',
  kubeconfigShow: 'kubeconfig:show',
  kubeconfigChooseAgain: 'kubeconfig:choose-again',
  addedImport: 'added:import',
  addedInspect: 'added:inspect',
  addedCheck: 'added:check',
  addedAdd: 'added:add',
  addedRead: 'added:read',
  addedEdit: 'added:edit',
  addedRemove: 'added:remove',
  addedForKubectl: 'added:for-kubectl',
  version: 'kube:version',
  resources: 'kube:resources',
  schema: 'kube:schema',
  list: 'kube:list',
  get: 'kube:get',
  metrics: 'kube:metrics',
  change: 'kube:change',
  can: 'kube:can',
  history: 'kube:history',
  fleetSummary: 'fleet:summary',
  fleetAgents: 'fleet:agents',
  fleetTrustAgent: 'fleet:trust-agent',
  helmReleases: 'helm:releases',
  helmRelease: 'helm:release',
  helmCli: 'helm:cli',
  helmRollback: 'helm:rollback',
  helmUninstall: 'helm:uninstall',
  helmDeploy: 'helm:deploy',
  helmDefaults: 'helm:defaults',
  helmVersions: 'helm:versions',
  helmSearch: 'helm:search',
  helmChoose: 'helm:choose',
  helmLocal: 'helm:local',
  helmLint: 'helm:lint',
  helmValuesFile: 'helm:values-file',
  helmDependencies: 'helm:dependencies',
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
  logsStart: 'logs:start',
  logsStop: 'logs:stop',
  logsLines: 'logs:lines',
  logsEnd: 'logs:end',
  fullScreen: 'window:full-screen',
  updateState: 'update:state',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateChanged: 'update:changed',
  sponsorCard: 'sponsor:card',
  sponsorChanged: 'sponsor:changed',
  assistantsStatus: 'assistants:status',
  assistantsConfigure: 'assistants:configure',
  assistantsResetToken: 'assistants:reset-token',
  assistantsInstall: 'assistants:install',
  aiPermissionsGet: 'ai-permissions:get',
  aiPermissionsSet: 'ai-permissions:set',
  aiPermissionsChanged: 'ai-permissions:changed',
  assistantsDecide: 'assistants:decide',
  assistantsPending: 'assistants:pending',
  assistantsStatusChanged: 'assistants:status-changed',
  assistantsProposal: 'assistants:proposal',
  assistantsOutcome: 'assistants:outcome',
  serverAssistantsStatus: 'server-assistants:status',
  serverAssistantsRevoke: 'server-assistants:revoke',
  serverAssistantsStatusChanged: 'server-assistants:status-changed',
  auditInfo: 'audit:info',
  auditQuery: 'audit:query',
  auditVerify: 'audit:verify',
  /** Starts (true) or stops (false) telling the page of events as they're recorded. */
  auditWatch: 'audit:watch',
  auditEvent: 'audit:event',
  accessMine: 'access:mine',
  accessAdmin: 'access:admin',
  accessSet: 'access:set',
  accessHistory: 'access:history',
  accessChanged: 'access:changed',
} as const

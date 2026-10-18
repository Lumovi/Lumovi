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
import type {
  FleetAddRequest,
  FleetAddSource,
  FleetChecked,
  FleetClusterSettings,
  FleetJoinRequest,
  FleetJoins,
  FleetSetting,
  NewFleetJoin,
} from './fleet'
import type {
  FileCopyBegun,
  FileCopyEnd,
  FileCopyProgress,
  FileCopyResult,
  FileDownloadRequest,
  FileUploadRequest,
  PickedFiles,
} from './files'
import type { Marks } from './marks'
import type { PreferenceKey, Preferences } from './preferences'
import type { AppCommand } from './navigation'
import type { KeyPress } from './shortcuts'
import type { BoxCheckRole } from './box-check'
import type { NotHanded, PluginCode } from './plugin-hand-over'
import type { PluginChangeAnswer, PluginChangeRequest } from './plugin-changes'
import type {
  PluginEvents,
  PluginEventsQuery,
  PluginLogs,
  PluginLogsQuery,
  PluginRead,
  PluginReadQuery,
} from './plugin-reads'
import type { Installed, InstalledRecord, StoreCheck } from './plugin-store'
import type { PluginServerAnswer, PluginServerQuery } from './plugin-server'
import type { ResourceDefinition, ResourceKind } from './resources'
import type { LinkArrival } from './links'
import type { SponsorCard } from './sponsor'

export type ThemePreference = 'system' | 'light' | 'dark'

/** The desktop app's: how a cluster's notifications of new warnings stand, for its settings. */
export interface WarningNoticesState {
  /** The credential plugin a look starts, where its user signs in through one. */
  signsInWith?: string
  /** When signing in failed, where they're paused until it answers in Lumovi. */
  pausedAt?: number
}

export interface AppInfo {
  name: string
  version: string
  platform: string
  /** The desktop app's. */
  electron?: string
  chrome?: string
  node: string
}

/**
 * A tab below, moved into a window of its own (and back): a kept object, or a terminal, whose
 * shell, while it runs, goes with it (its id, and what it showed).
 */
export type MovedTab =
  | {
      kind: 'kept'
      context: string
      object: { kind: string; name: string; namespace?: string }
      tab: string
      /** Not read yet: its cluster signs in through a program (see the tabs below). */
      waiting?: true
    }
  | {
      kind: 'terminal'
      context: string
      namespace?: string
      title?: string
      shell?: { id: string; lines: string }
    }

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
  /** Its page's address, as it was (`#/cluster/…`, the panel's object with it). */
  page?: string
  /** What its page said it had below (the page's own: it reads it back, and checks it). */
  below?: unknown
  /** A window of one tab: that tab (a terminal's shell isn't kept: it comes back ended). */
  tab?: unknown
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
  restored: ('metricsSource' | 'nodeShell' | 'fleet')[]
}

export interface Settings {
  theme: ThemePreference
  /** The person's own settings, as they are: the defaults, theirs, and what policy sets over them. */
  preferences?: Preferences
  /** Those an organization's policy sets: shown locked, and refused if changed. */
  locked?: PreferenceKey[]
  /** Where Lumovi's windows were when it last closed: each opens there again, the first first. */
  windows?: WindowState[]
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
  /** The desktop app's: folders whose kubeconfigs are read after those, in the order added. */
  kubeconfigFolders?: string[]
  /**
   * The desktop app's: what a folder's kubeconfigs have their credentials do that the person
   * agreed to, by file: keyed digests only (consent.ts), never a command or a secret.
   */
  kubeconfigConsents?: Record<string, string[]>
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
  /**
   * Whether each plugin's code runs for this person, as they chose on the Plugins page (one they
   * haven't chosen for: as `CODE_ON` says). On a server, kept for each person.
   */
  pluginCode?: Record<string, boolean>
  /**
   * A server's: the plugins whose code may run on it (LUMOVI_PLUGIN_CODE's names; none, where it's
   * off). Unset: every plugin's. Not stored.
   */
  pluginCodeOnServer?: string[]
  /**
   * The desktop app's: the highest serial of Lumovi-plugins' releases it has taken, so it takes
   * none older (src/main/plugin-store.ts).
   */
  pluginStoreSerial?: number
  /**
   * The desktop app's: the plugins installed from Lumovi-plugins, each as it was agreed to, and
   * the copy before it (src/main/plugins-installed.ts).
   */
  pluginsInstalled?: Record<string, InstalledRecord>
  /**
   * The desktop app's: Developer mode, which lets plugins in the person's own folder run their
   * code, each once they've agreed to it. Off unless turned on.
   */
  pluginDeveloperMode?: boolean
  /**
   * The desktop app's: what the person agreed to run of each of their own plugins' code, by name
   * (src/main/plugins-agreed.ts).
   */
  pluginsAgreed?: Record<string, AgreedRecord>
}

/**
 * What a person agreed to run of one of their own plugins' code: what its file asked then
 * (`asksOf`'s text), its code's digest, its file, and when.
 */
export interface AgreedRecord {
  asks: string
  code: string
  file: string
  at: string
}

/** Why one of a person's own plugins' code waits: never agreed to, its code changed, or its asks. */
export type Waiting = 'first' | 'code' | 'asks'

/** One of a person's own plugins with code, as it stands against what they agreed to. */
export interface OwnCode {
  standing: Waiting | 'agreed'
  /** What its file asks now (`asksOf`'s text): what an agreement agrees to. */
  asks: string
  /** Its code's digest, as Lumovi read it now. */
  code: string
  /** What was agreed to before, where anything was: what "New in" is worked out from. */
  agreed?: string
}

/**
 * Whether the organization's policy keeps Developer mode off: said so, or by keeping plugins to
 * Lumovi's own, to none, or to no code.
 */
export const developerModeLocked = (managed: ManagedSettings | undefined): boolean =>
  managed?.pluginDeveloperModeOff === true ||
  managed?.pluginsOff === true ||
  managed?.pluginsBundledOnly === true ||
  managed?.pluginCodeOff === true

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
  /** No metrics stack is offered, installed or removed by Lumovi. */
  metricsStackOff?: true
  /** No files are copied out of containers or into them. */
  fileCopyOff?: true
  /** The most one copy of files carries, in bytes. */
  fileCopyMaxBytes?: number
  /** No plugins at all: none of Lumovi's own, none of a person's. */
  pluginsOff?: true
  /** Only the plugins that come with Lumovi: a person's own aren't read. */
  pluginsBundledOnly?: true
  /** Plugins as data, with none of their code: no page or tab their code draws runs. */
  pluginCodeOff?: true
  /** Only these plugins, by name (any version) or name@version (only that one). */
  pluginsAllowed?: string[]
  /** No plugin's page may propose a change. */
  pluginProposalsOff?: true
  /** No plugin's page may show what's in a Secret. */
  pluginSecretsOff?: true
  /** No plugin's page may show or read containers' logs. */
  pluginLogsOff?: true
  /** Lumovi doesn't check Lumovi-plugins for newer plugins: nothing is asked of GitHub. */
  pluginStoreOff?: true
  /** No plugin may talk to a server in the cluster. */
  pluginServersOff?: true
  /** Developer mode stays off: no plugin of a person's own runs code. */
  pluginDeveloperModeOff?: true
  /** lumovi:// links open nothing, and Copy link isn't offered. */
  linksOff?: true
  /** The person's own settings it sets (and locks): Settings shows them, its controls off. */
  settings?: Partial<Preferences> & { theme?: ThemePreference }
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

/**
 * The metrics stack Lumovi can install where a cluster has no history: a chart it ships, with
 * the values it sets, as one Helm release in a namespace of its own.
 */
export interface MetricsStack {
  /** Where it is, or would go; and whether that's taken (a namespace of that name, not Lumovi's). */
  state: 'absent' | 'installed' | 'taken'
  namespace: string
  release: string
  chart: {
    name: string
    version: string
    appVersion: string
    /** The packaged chart's SHA-256, as its repository publishes it. */
    sha256: string
    repository: string
  }
  /** The values it's installed with. */
  values: string
  /** The images it runs, each by its digest. */
  images: string[]
  /** Installed: whether both its Deployments are up. */
  ready?: boolean
  /** Installed: when (ISO), as Helm records it. */
  installedAt?: string
  /** Installed and not up: why, as its Deployments and pods say (an image that can't be pulled…). */
  problems?: string[]
  /** Why it can't be installed or removed here, whoever asks (a policy, a read-only cluster…). */
  off?: { reason: 'policy' | 'read-only' | 'admins'; message: string }
  /**
   * What the cluster doesn't let this person create, of what installing it takes, and delete, of
   * what removing it does. Not asked (and so empty) where it's off for them.
   */
  missing: { install: string[]; remove: string[] }
  /** The cluster, where it's more than the stack is sized for. */
  large?: { nodes: number; pods: number }
}

export interface MetricsStackRequest {
  context: string
  /** Asks the API server, and changes nothing. */
  dryRun?: boolean
}

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

/** An alert Prometheus holds: one an instance of an alerting rule, firing or pending. */
export interface PrometheusAlert {
  /** Its rule's name (`alertname`). */
  name: string
  state: 'firing' | 'pending'
  /** When its condition began to hold (milliseconds), or none where Prometheus didn't say. */
  activeAt?: number
  /** Its value when last evaluated, as Prometheus writes it. */
  value?: string
  /** Every label, `alertname` and `severity` among them, as Prometheus has them. */
  labels: Record<string, string>
  /** Its rule's annotations: `summary`, `description`, `runbook_url`, and any other. */
  annotations: Record<string, string>
  /** How long its condition must hold before it fires (seconds), and its rule's group. */
  for: number
  group: string
}

/** The alerts Prometheus holds, from its alerting rules, and how many of those rules there are. */
export interface PrometheusAlerts {
  alerts: PrometheusAlert[]
  /** Its alerting rules, by severity (none where the rule says none): to count the quiet ones. */
  rules: { name: string; severity?: string; active: boolean }[]
  /** Where they came from, as the Metrics page reads it. */
  service: MetricsService
  /** When they were read (milliseconds). */
  at: number
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
  /** A fleet's: the name it's shown by, as the Fleet page sets it. */
  title?: string
  /**
   * The credential plugin its user signs in through, where it has one (an exec plugin's command,
   * an auth provider's name): one can open a browser or ask in a terminal, so nothing reads the
   * cluster by itself, unasked (a tab restored below waits to be shown).
   */
  signsInWith?: string
  /** One that signs in through a program, and has answered Lumovi since it started: signed in. */
  signedIn?: true
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
    /**
     * It couldn't be read (`problem`, from `failedAt`), and what it said when it last could is
     * kept: as it was written at `keptFrom`.
     */
    keptFrom?: string
    failedAt?: string
    /** Why those of its contexts that take a cluster or user from a folder's kubeconfig aren't used. */
    refused?: string[]
    /** One of Lumovi's own: when it was added. */
    addedAt?: string
  }[]
  /**
   * The folders added, in the order added: the kubeconfigs in each (directly in it, by name,
   * read after the files above), and the files in it that aren't read, with why.
   */
  folders: {
    path: string
    /** Why it can't be read at all; it stays, to be removed. */
    problem?: 'gone' | 'not-a-folder' | 'not-allowed'
    files: {
      /** Its name in the folder. */
      name: string
      /** Where it's read from (a link's: the file it leads to, in the folder). */
      path: string
      contexts?: number
      problem?: string
      keptFrom?: string
      failedAt?: string
      /** How many of its contexts ask before their credentials are used (agreed to: none). */
      asks?: number
      /**
       * Why those of its contexts that take a cluster or user from another kubeconfig aren't used
       * (a folder's kubeconfig is used whole).
       */
      refused?: string[]
    }[]
    skipped: {
      name: string
      why: 'folder' | 'link-out' | 'hidden' | 'large' | 'not-kubeconfig' | 'not-allowed'
    }[]
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

/** An EKS cluster `aws` found (Add a cluster → From AWS). */
export interface AwsCluster {
  name: string
  version?: string
  status?: string
  /** Its group on the clusters page: "AWS · prod (123456789012) · eu-west-1". */
  group: string
  /** Its API server's address, as EKS gave it (to tell one added already). */
  server?: string
  /** Its kubeconfig, as `aws eks update-kubeconfig` writes one; or why it can't be added. */
  kubeconfig?: string
  unaddable?: string
}

/** What `aws` found for one profile in one region: its clusters, or why there are none. */
export interface AwsFound {
  profile: string
  region: string
  /** Its account, once `aws` has said whose it is. */
  account?: string
  clusters: AwsCluster[]
  problem?: string
  /** Nothing wrong, nothing there: "No EKS clusters in eu-west-1 for prod." */
  note?: string
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
  /**
   * The desktop app's: what a folder's kubeconfig has its credentials do (run a program, send a
   * file, go to a server not verified) isn't agreed to yet, so nothing of it is used.
   */
  | 'consent'

export interface KubeError {
  code: KubeErrorCode
  message: string
  status?: number
  /**
   * What the API server found wrong, field by field (its Status' `details.causes`), where it
   * says: a refused object's fields, by their paths. An admission webhook's refusal has none.
   */
  causes?: KubeErrorCause[]
}

/** One thing wrong with an object, as the API server says it. */
export interface KubeErrorCause {
  /** `spec.template.spec.containers[0].image`: often the parent of what's wrong. */
  field?: string
  message: string
  /** `FieldValueInvalid`, `FieldValueRequired`… */
  reason?: string
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
  /**
   * Secrets': what the certificates in each one's values say, by `namespace/name`, for those
   * whose values the person may see (and only those holding a certificate).
   */
  certificates?: Record<string, CertificateSummary[]>
}

/**
 * What the certificates in a Secret's value say (LMV-194): read by the backend, where the person
 * may see the Secret's values, and nothing of the value itself, nor of any key. A value of
 * certificates that don't chain (a bundle of roots) says only how many; one Lumovi couldn't read
 * says only that.
 */
export type CertificateSummary =
  | { key: string; as: 'unreadable' }
  | {
      key: string
      as: 'bundle'
      /** How many certificates it holds; at least that many, where it's longer than was read. */
      count: number
      atLeast?: true
    }
  | {
      key: string
      as: 'certificate'
      /** Its subject's common name, and the rest of its subject as written (`O=…, C=…`). */
      subject: { commonName?: string; rest?: string }
      issuer: { commonName?: string; organization?: string }
      /** Issued by its subject itself. */
      selfSigned: boolean
      /** The names it's for: DNS names, then IP addresses (the first of them, see `moreNames`). */
      names: string[]
      moreNames: number
      /** When it's valid from and until, as ISO times. */
      notBefore: string
      notAfter: string
      /** How many more certificates follow it in the value (its chain). */
      chain: number
      /** The one of those that's valid the shortest, where it ends before this one does. */
      chainEnds?: { commonName?: string; notAfter: string }
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

/** The part of a kind's OpenAPI schema Lumovi uses to explain its fields, and check them. */
export interface FieldSchema {
  type?: string
  description?: string
  format?: string
  enum?: unknown[]
  properties?: Record<string, FieldSchema>
  items?: FieldSchema
  additionalProperties?: FieldSchema
  /** Its fields that must be set. */
  required?: string[]
  /** An object that takes any field (one whose fields its schema keeps, or doesn't say). */
  open?: true
  /** A value that's a number or text (a port by number or name, a quantity: 1, "500m"). */
  numberOrText?: true
  /** One that may be null. */
  nullable?: true
  /** The name of the type it is, where the schema names it: "PodSpec", "Container". */
  named?: string
  /** What it is when it isn't set, where the schema says. */
  default?: unknown
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
  /** The repository Lumovi installed or upgraded it from (its id: the release's label). */
  repository?: string
  /** Where its chart says it's from: what tells a repository's chart by the same name for it. */
  chartHome?: string
  chartSources?: string[]
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
  /**
   * A repository Lumovi keeps (its id): `chart` is a chart's name there, and `version` one of its
   * versions. Lumovi fetches it, with its sign-in, and hands Helm the file.
   */
  saved?: string
}

/** A chart repository, or an OCI registry, Lumovi reads charts from: Lumovi's, not Helm's. */
export interface HelmRepository {
  /** 16 hex digits: what a release installed from it is labelled with. */
  id: string
  name: string
  kind: 'http' | 'oci'
  /** https://… (a repository), or oci://host/path (a registry). */
  url: string
  /** A registry's: the charts Lumovi looks for there (a registry has no index to list them). */
  charts: string[]
  /** Its sign-in's user name, where one is saved: its password or token never leaves the backend. */
  username?: string
  /** When Lumovi last read it, and how many charts it had; or why it couldn't. */
  read?: { at: string; charts: number } | { at: string; error: string }
}

/** A chart in a repository Lumovi keeps. */
export interface RepositoryChart {
  /** The repository's id. */
  repository: string
  name: string
  description?: string
  keywords?: string[]
  home?: string
  sources?: string[]
  /** Whether it names an icon (helm.repositories.icon fetches it). */
  icon: boolean
  /** Newest first. */
  versions: { version: string; appVersion?: string; created?: string }[]
}

/** The repositories Lumovi keeps, and what's in them. */
export interface HelmRepositories {
  repositories: HelmRepository[]
  charts: RepositoryChart[]
  /** Where they're kept: on this computer, for every cluster; or on the server, for everyone. */
  kept: 'computer' | 'server'
  /** Whether this person may add, edit and remove them. */
  mayChange: boolean
  /** A server's admins, who may (where the person may not). */
  admins?: string[]
  /** Why no sign-in can be kept here (no keychain), where none can. */
  noSignIns?: string
}

/** A repository added, or one changed (`id`). */
export interface HelmRepositoryInput {
  id?: string
  name: string
  kind: 'http' | 'oci'
  url: string
  charts?: string[]
  /** None; or a user name and its password or token, which left out keeps the saved one. */
  signIn: { username: string; secret?: string } | null
}

/** What Test connection found: a repository's charts, or each chart's versions in a registry. */
export type HelmRepositoryTest =
  { charts: number } | { found: { chart: string; versions: number }[] }

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
  /** Waits until what it made is ready (Helm's --wait), or fails at the timeout. */
  wait?: boolean
  /** Undoes it if it fails: an upgrade rolled back, an install uninstalled (and waits, as `wait`). */
  rollbackOnFailure?: boolean
  /** How long Helm waits for any one thing it does, in seconds (its --timeout; else 5 minutes). */
  timeoutSeconds?: number
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
 * Plugin files the user keeps next to Lumovi's own (the format:
 * https://docs.lumovi.dev/reference/plugin-format).
 */
export interface LocalPlugins {
  directory: string
  /** Each file's text, or why it wasn't read. */
  files: { name: string; text: string; error?: string }[]
  /** Only ever from the build the tests run: files for it to take as plugins that came inside it. */
  included?: { name: string; text: string; error?: string }[]
  /** Only ever from the build the tests run: which of those have code beside them. */
  includedCoded?: string[]
  /** The desktop app's: what's installed from Lumovi-plugins, and why any of it isn't used. */
  installed?: Installed
}

export interface ClusterVersion {
  gitVersion: string
  platform: string
  /** Round-trip time of the check. */
  latencyMs: number
}

/** One kind's objects as Search reads them (LMV-171): in a namespace, or all; by labels, or all. */
export interface SearchQuery {
  context: string
  kind: ResourceKind
  namespace?: string
  labelSelector?: string
}

/** An object as Search knows it: its metadata alone, never what it holds. */
export interface SearchItem {
  name: string
  namespace?: string
  uid: string
  labels?: Record<string, string>
  created: string
}

/** What Search read of a kind: at most as many as a list reads, and how many there are. */
export interface SearchList {
  items: SearchItem[]
  /** There were more than were read. */
  truncated: boolean
  /** How many there are, where the cluster says (it doesn't, past a read cut short by labels). */
  total?: number
}

export interface ListQuery {
  context: string
  kind: ResourceKind
  namespace?: string
  labelSelector?: string
  fieldSelector?: string
}

/** One Secret, for what the certificates in its values say. */
export interface CertificatesQuery {
  context: string
  namespace: string
  name: string
}

export interface GetQuery {
  context: string
  kind: ResourceKind
  name: string
  namespace?: string
  /** The object's Scale (from the scale subresource) instead of the object. */
  subresource?: 'scale'
}

/** How many of a Secret's keys one read may ask for. */
export const SECRET_KEYS_AT_MOST = 20

/**
 * A Secret's values, asked for by key. The keys are picked where the Secret is read, in Lumovi's
 * backend, and never on the page: a value that wasn't asked for doesn't cross to it.
 */
export interface SecretValuesQuery {
  context: string
  namespace: string
  name: string
  /** One to `SECRET_KEYS_AT_MOST` of its keys, none twice. */
  keys: string[]
  /**
   * The plugin whose page shows it, by its name: filled by Lumovi's own page code alone, from
   * what it knows of the page, never from anything a plugin sent. The backend knows the rest of
   * the plugin, and reads only keys its file says its pages show.
   */
  forPlugin?: string
  /**
   * What named the Secret on that plugin's page, as the door handed it (`SecretRef.namedBy`):
   * the backend reads that object as the person, holds that it names this Secret by that path,
   * and reads only the keys that path's item declares.
   */
  namedBy?: { kind: ResourceKind; name: string; path: string }
  /**
   * What that plugin's page was handed its code with (`PluginCode`): a Secret is shown only
   * for the file and the code the page runs, as any read of a plugin's.
   */
  digest?: string
  codeDigest?: string
}

/**
 * What a read of a Secret by key answers: the asked keys' values, and nothing else of it. Not
 * its other keys' values, and not their names either: nothing that wasn't asked for.
 */
export interface SecretValues {
  /** The Secret, as the cluster has it. */
  namespace: string
  name: string
  uid?: string
  /**
   * Each asked key the Secret has, with its value as the cluster keeps it (base64). Pairs, not
   * a map: a key may have any name Kubernetes allows, `__proto__` among them. None where the
   * person's access shows only a Secret's keys.
   */
  values: [key: string, value: string][]
  /** The asked keys it doesn't have. */
  missing: string[]
  /** The person's access shows only a Secret's keys here: no value was answered. */
  withheld: boolean
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
  /** Shown on a plugin's page (its Logs part): which plugin's page asked Lumovi to show them. */
  via?: PluginVia
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
  /** Evicted as kubectl drain does; `gracePeriodSeconds`: how long it has to stop (its own unless set). */
  | { action: 'evict'; gracePeriodSeconds?: number }
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
  /** Each line with the time it was written, first (`kubectl logs --timestamps`). */
  timestamps?: boolean
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
  /** How its pods are told from the others: a label (its hash), and the values that mean it. */
  pods: { label: string; values: string[] }
}

/**
 * Which plugin's page brought the person to one of Lumovi's own places (a link, `spec.links`):
 * how they got there, which the audit says. The person does there what they do; the plugin does
 * nothing.
 */
export interface PluginVia {
  plugin: string
  version: string
  /** Its name as a person reads it: what the history says. */
  label: string
}

/** A shell in one of a pod's containers (`kubectl exec -it`). */
export interface ContainerShellRequest {
  target: 'container'
  context: string
  namespace: string
  pod: string
  container: string
  /** Started on the Shell tab a plugin's link opened. */
  via?: PluginVia
}

/**
 * Attached to the main process of one of a pod's containers (`kubectl attach -it`): what it
 * prints, and what's typed, where its stdin is open and stays open after a session. Detaching
 * leaves it running.
 */
export interface ContainerAttachRequest {
  target: 'attach'
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

export type ShellRequest =
  ContainerShellRequest | ContainerAttachRequest | NodeShellRequest | LocalShellRequest

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
  /** Started from the Port forward dialog a plugin's link opened. */
  via?: PluginVia
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

/** A file saved: the name it was saved as, and on the desktop a token to show it by. */
export interface SavedFile {
  name: string
  /** For `app.showSaved`: it stands for where the file is, which the page isn't told. */
  token?: string
}

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
     * Called when Lumovi ended a plugin's process: over its memory, over its processor time, or
     * found not apart from the rest.
     */
    onPluginEnded(
      listener: (plugin: string, over: 'memory' | 'processor' | 'shared') => void,
    ): () => void
    /**
     * Says whether a terminal on this computer has focus: its ⌘ keys are then its own (⌘T,
     * ⌘W…), not the menu's. `below`: something else in the tabs below has it, whose ⌘W closes
     * the tab shown.
     */
    setTerminalFocus(focused: boolean | 'below'): void
    /**
     * While Settings records a command's new keys: every key pressed in this window is sent to
     * it (onKeyRecorded), not the menu's nor the page's (LMV-358).
     */
    recordKeys(on: boolean): void
    /** A key pressed while keys are recorded; returns an unsubscribe function. */
    onKeyRecorded(listener: (press: KeyPress) => void): () => void
    /**
     * Opens the app's menu at a point of the page (its CSS pixels), for a window without a menu
     * bar (Windows', Linux's); done once it closes.
     */
    openMenu(x: number, y: number): Promise<void>
    /**
     * Opens another window, on the start screen: its own pages, and its own streams. Or, where a
     * link's card was answered New window, at its view (the app's address) and its object's tab:
     * asked for, so it goes there even where the cluster signs in through a program.
     */
    newWindow(opens?: { address: string; tab?: string }): Promise<void>
    /** What the page has below now, kept for when Lumovi opens this window again. */
    keepBelow(below: unknown): void
    /**
     * Where this window was when Lumovi last closed, and what it had below: once, nothing after
     * that. Its page opens on the start screen and goes there itself, when that reads nothing
     * by itself (a cluster that signs in through a program waits for a press).
     */
    restored(): Promise<{ page?: string; below?: unknown; asked?: true; tab?: string }>
    /** Moves a tab below into a window of its own, over this one. */
    moveToWindow(tab: MovedTab): Promise<void>
    /**
     * A window of one tab: its tab (checked by the page: it's only data), and whether it's opened
     * again as Lumovi did (`restored`) rather than just moved.
     */
    movedTab(): Promise<{ tab?: unknown; restored?: true }>
    /** A shell handed to this page listens now: what it said meanwhile comes, then as it goes. */
    adoptShell(id: string): void
    /**
     * Puts a window's one tab back below: in the window it came from, else the one in front on its
     * cluster, else the one in front. This window then closes, the tab gone from it, not ended.
     * Where there's no other (`here`), this window becomes Lumovi's own, the tab below in it.
     */
    putBack(tab: MovedTab): Promise<{ here?: true }>
    /** A tab put back below here, from a window of its own. */
    onTabReturned(listener: (tab: unknown) => void): () => void
    /** Told when a lumovi:// link is waiting for this window: it takes it with `takeLink`. */
    onLinkWaiting(listener: () => void): () => void
    /** Told, once after an answered card, that a link came too soon after it and was let go. */
    onLinkSkipped(listener: () => void): () => void
    /** This window's link card was answered, whatever the answer. */
    linkAnswered(): void
    /**
     * The link handed to Lumovi, read and matched with the clusters here, or why it can't be
     * opened: once, and only for the window in front. Nothing is opened: the page asks first.
     */
    takeLink(): Promise<LinkArrival | null>
    /** The lumovi:// link to a view (the app's address of it), with its object's tab. */
    linkFor(address: string, tab?: string): Promise<string>
  }
  app: {
    info(): Promise<AppInfo>
    settings(): Promise<Settings>
    /**
     * What Lumovi couldn't set up as it started (the desktop app): its organization's policy,
     * a certificate authority's file, a proxy. Once the network is set up.
     */
    problems?(): Promise<string[]>
    /**
     * The desktop app's: what Lumovi has to say as it goes, once, that isn't any one page's (a
     * kubeconfig it couldn't save a renewed token to, say).
     */
    onNote?(listener: (note: { title: string; description: string }) => void): () => void
    setTheme(theme: ThemePreference): Promise<Settings>
    /**
     * Changes the person's own settings (null puts one back to its default): at once, in every
     * window, and kept. One a policy sets is refused.
     */
    setPreferences(
      patch: Partial<Record<keyof Preferences | 'autoUpdate', unknown>>,
    ): Promise<Result<Settings>>
    /** The desktop app's: its settings changed (in another window, say). */
    onSettingsChanged?(listener: () => void): () => void
    /** The desktop app's: the shells this computer has, for Settings to offer, and the login one. */
    shells?(): Promise<{ login: string; shells: string[] }>
    setReadOnly(context: string, readOnly: boolean): Promise<Settings>
    /** The desktop app's: how a cluster shows in Lumovi (all of it: what's left out is unset). */
    setCluster?(context: string, settings: ClusterSettings): Promise<Result<Settings>>
    /** The desktop app's: how a cluster's notifications of new warnings stand. */
    warningNotices?(context: string): Promise<WarningNoticesState>
    setMetricsSource(context: string, setting: MetricsSourceSetting): Promise<Settings>
    /** Where `context`'s node shells run; NODE_SHELL_DEFAULTS (or the server's) to reset. */
    setNodeShell(context: string, setting: NodeShellSetting | null): Promise<Settings>
    /** Turns a plugin's code on or off for this person (the Plugins page's "Run its code"). */
    setPluginCode(plugin: string, on: boolean): Promise<Settings>
    /** Opens a web page in the browser. */
    openExternal(url: string): Promise<boolean>
    /**
     * Saves `text` as a file named `name` (asking where, on the desktop): the name it was saved
     * as, never where; null if the user cancels.
     */
    saveFile(name: string, text: string): Promise<Result<SavedFile | null>>
    /**
     * The desktop app's: shows a file `saveFile` saved in the file manager, by the token it gave
     * back; nothing else is shown (false).
     */
    showSaved?(token: string): Promise<boolean>
    /** The user's own plugin files, read when asked. */
    plugins(): Promise<LocalPlugins>
  }
  /** Usage history from the cluster's Prometheus or VictoriaMetrics. */
  /**
   * A server's: the signed-in person's pins and saved views in a cluster, kept for them by the
   * server (sealed, with who's signed in) and never in the browser. None on the desktop, which keeps
   * them with its own settings.
   */
  marks?: {
    get(context: string): Promise<Result<Marks>>
    /** Keeps them as given; refused, in Lumovi's words, past a cap or the server's budget. */
    set(context: string, marks: Marks): Promise<Result<Marks>>
  }
  usage: {
    /** Detects the source once per session; `refresh` looks again. */
    source(context: string, refresh?: boolean): Promise<Result<HistorySource>>
    /** Checks that a service answers PromQL, before it's saved as the source. */
    test(context: string, service: MetricsService): Promise<Result<HistorySource>>
    range(query: RangeQuery): Promise<Result<RangeResult>>
    instant(query: InstantQuery): Promise<Result<InstantResult>>
    /** The alerts the source holds, firing and pending, with its alerting rules. */
    alerts(context: string): Promise<Result<PrometheusAlerts>>
  }
  /** A metrics stack of Lumovi's own, where a cluster has no history. */
  metricsStack: {
    status(context: string): Promise<Result<MetricsStack>>
    /** Installs it, or (a dry run) answers with what it would make. */
    install(request: MetricsStackRequest): Promise<Result<HelmDeployed>>
    /** Removes it, and its namespace: only one Lumovi installed. */
    uninstall(request: MetricsStackRequest): Promise<Result<null>>
  }
  kube: {
    contexts(): Promise<ContextsResult>
    version(context: string): Promise<Result<ClusterVersion>>
    /** Every kind the cluster serves that can be listed, built-in kinds included, looked up afresh. */
    resources(context: string): Promise<Result<ResourceDefinition[]>>
    /** A kind's schema, from the cluster's OpenAPI documents; null when it publishes none. */
    schema(context: string, kind: ResourceKind): Promise<Result<FieldSchema | null>>
    list(query: ListQuery): Promise<Result<KubeList>>
    /** A kind's names, namespaces, labels and ages, for Search: its metadata alone. */
    search(query: SearchQuery): Promise<Result<SearchList>>
    get(query: GetQuery): Promise<Result<KubeObject>>
    /** Some of a Secret's values, picked by key where it's read: the rest never reach the page. */
    secretValues(query: SecretValuesQuery): Promise<Result<SecretValues>>
    /**
     * What the certificates in a Secret's values say, read by the backend: none where the person
     * may see only its keys, and nothing of a value.
     */
    certificates(query: CertificatesQuery): Promise<Result<CertificateSummary[]>>
    /**
     * A read for a plugin's page: made, checked against the plugin's file and picked where it's
     * read, so the page holds only what the plugin may have. A refusal is a code, never what
     * the cluster said.
     */
    pluginRead(query: PluginReadQuery): Promise<PluginRead>
    /** A pod's logs, once, for a plugin's code its file lets read them (`spec.logs: read`). */
    pluginLogs(query: PluginLogsQuery): Promise<PluginLogs>
    /** An object's warning events, for a plugin's code its file lets read them (`events: true`). */
    pluginEvents(query: PluginEventsQuery): Promise<PluginEvents>
    /** A path its file lists, of a plugin's tool's own server, once, as JSON (`spec.server`). */
    pluginServer(query: PluginServerQuery): Promise<PluginServerAnswer>
    /**
     * A plugin's code, for its page's box: the only way any plugin's code reaches a page, and
     * only where the backend's `mayHandOver` says this page may have it.
     */
    pluginCode(plugin: string): Promise<PluginCode>
    /** What `pluginCode` would answer, without the code: for a page that only says so. */
    pluginHandOver(plugin: string): Promise<true | NotHanded>
    /**
     * A change a plugin's page proposed, from Lumovi's own dialog: whether it may be asked, what
     * the cluster would make of it, made once the person confirms, or recorded as cancelled.
     * Made as the person, and recorded with the plugin's name, version and digests.
     */
    pluginChange(request: PluginChangeRequest): Promise<PluginChangeAnswer>
    /**
     * A server's: a check of this browser's plugin box, with its one-time nonce, the code a box
     * runs for it, and the address this page hands the check's own sealed frame to ask, so the
     * server knows a request shaped as a box's can reach its catcher (none for a session whose
     * code wouldn't be handed over anyway).
     */
    boxCheckStart?(): Promise<
      { nonce: string; code: Record<BoxCheckRole, string>; control: string } | undefined
    >
    /**
     * And how it came out, judged by the server: what each box sent up (nothing, where one didn't
     * answer), and what the page heard.
     */
    boxCheckEnd?(
      nonce: string,
      reports: Record<BoxCheckRole, string | null>,
      /** The ways Lumovi's own page found under the check's name, as it never should. */
      heard: string[],
      /** Where Lumovi's own page couldn't look or listen: no pass rests on those. */
      unlooked: string[],
    ): Promise<'passed' | 'failed' | 'unfinished' | undefined>
    /**
     * A server's: this browser's check failed after all (something got out after it was judged).
     * Every plugin's page it shows ends.
     */
    onBoxCheckFailed?(listener: () => void): () => void
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
    /**
     * The chart repositories and registries Lumovi keeps (on the desktop for every cluster, on a
     * server for everyone): read every 30 minutes and when the Helm page opens.
     */
    repositories: {
      list(): Promise<Result<HelmRepositories>>
      /** Every one read again now. */
      refresh(): Promise<Result<HelmRepositories>>
      /** Whether one can be read as given (a sign-in left out: the saved one's, where it holds). */
      test(input: HelmRepositoryInput): Promise<Result<HelmRepositoryTest>>
      save(input: HelmRepositoryInput): Promise<Result<HelmRepositories>>
      /** Forgotten, and its sign-in with it. */
      remove(id: string): Promise<Result<HelmRepositories>>
      /** A chart's icon, as a data: URL; null where it has none Lumovi fetches. */
      icon(repository: string, chart: string): Promise<Result<string | null>>
    }
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
    /** Asks for a folder whose kubeconfigs are read after the rest; null if the user cancels. */
    addFolder(): Promise<Result<KubeconfigFiles | null>>
    /**
     * One Lumovi was given (chosen, added, or a folder) no longer read; the file or folder itself
     * is left as it is.
     */
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
    /**
     * What a folder's context has its credentials do on this computer that isn't agreed to yet
     * (programs run, files sent, servers not verified), exactly as it would do it.
     */
    asks(context: string): Promise<Result<PastedKubeconfig>>
    /** Allows that (`consents`, as `asks` gave them); kept until what it does changes. */
    agree(context: string, consents: string[]): Promise<Result<KubeconfigFiles>>
    /** Something read changed on disk (a context added elsewhere, a file in a folder). */
    onChange(listener: () => void): () => void
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
    /**
     * The profiles the person's `aws` CLI knows, and each one's region where it's set: run only
     * as they ask (From AWS).
     */
    awsProfiles(): Promise<Result<{ profiles: string[]; regions: Record<string, string> }>>
    /** The EKS clusters each profile has in each of its regions, found with `aws` as them. */
    awsFind(asks: { profile: string; regions: string[] }[]): Promise<Result<AwsFound[]>>
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
  /**
   * Lists watched, so a change shows at once: each told when it changed (never how), for the
   * page to read it again.
   */
  watches: {
    /** Watches what a list reads (as `kube.list` takes it); the page picks its id. */
    start(id: string, query: ListQuery): Promise<Result<null>>
    stop(id: string): void
    /** What it watches changed: read it again. */
    onChanged(listener: (id: string) => void): () => void
    /** It can't go on (refused, or its kind gone): the list is polled, as it was. */
    onEnded(listener: (id: string, error?: KubeError) => void): () => void
  }
  /** Files copied out of a container and into one, as `kubectl cp` does it. */
  files: {
    /**
     * Asks what to upload: a file, or a folder. The page gets its name and size and a handle
     * for it, never where it is; null if nothing was picked.
     */
    pick(what: 'file' | 'folder'): Promise<FileCopyResult<PickedFiles | null>>
    /**
     * Starts copying a file or a folder out. The page picks the copy's id, to hear of it from
     * the start. It's begun once the container sent the first of it; where it's saved is asked
     * then (the desktop app's), or it's the browser's download.
     */
    download(id: string, request: FileDownloadRequest): Promise<FileCopyResult<FileCopyBegun>>
    /** Starts copying what was picked into a folder of a container. */
    upload(id: string, request: FileUploadRequest): Promise<FileCopyResult<FileCopyBegun>>
    cancel(id: string): void
    onProgress(listener: (id: string, progress: FileCopyProgress) => void): () => void
    /** A copy ended: it's all there, it failed (and what there was of it is gone), or it was stopped. */
    onEnd(listener: (id: string, end: FileCopyEnd) => void): () => void
    /** Shows a download where it was saved (the desktop app's). */
    show?(saved: string): void
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
    /** An admin's: the clusters being connected from the page, and why none may be, if so. */
    joins(): Promise<FleetJoins>
    /** An admin's: a cluster to connect, and its agent's join token (shown once). */
    connect(request: FleetJoinRequest): Promise<NewFleetJoin>
    /** An admin's: stops connecting a cluster, whose token no longer works. */
    cancelJoin(name: string): Promise<void>
    /**
     * An admin's: removes a cluster connected or added from the page: an agent is let go at once
     * by the replica that's asked, and by the others as they next read (within 10 s); a cluster
     * added by kubeconfig or token, its Secret deleted.
     */
    remove(name: string): Promise<void>
    /** An admin's, where the server allows it: a cluster to add by kubeconfig or token, checked. */
    check(source: FleetAddSource): Promise<FleetChecked>
    /** An admin's, where the server allows it: a cluster added, kept as Lumovi's Secret. */
    add(request: FleetAddRequest): Promise<void>
    /** An admin's: a cluster's settings, each with what sets it, where that isn't the page. */
    settings(name: string): Promise<FleetClusterSettings>
    /**
     * An admin's: what the page sets for a cluster, of what its source leaves unset. A field left
     * out stays as it is; given empty, it's unset.
     */
    saveSettings(name: string, setting: FleetSetting): Promise<FleetClusterSettings>
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
  /** The desktop app's: what's newer in Lumovi-plugins' latest release (shared/plugin-store). */
  pluginStore?: {
    /** As last checked, within ten minutes; `now`: checked again now, as Check now does. */
    check(now?: boolean): Promise<StoreCheck>
    /**
     * Installs a plugin at a version from the latest release, checked again first: only if what
     * it asks is `agreed` (what the person was shown, `asksOf`).
     */
    install(name: string, version: string, agreed: string): Promise<void>
    /**
     * Back to the copy kept (what it asks `agreed`, which the main process holds it to), or to the
     * one that comes with Lumovi.
     */
    goBack(name: string, to: 'kept' | 'lumovi', agreed?: string): Promise<void>
    /** Removes one installed that doesn't come with Lumovi. */
    remove(name: string): Promise<void>
  }
  /**
   * The desktop app's: Developer mode, and what the person agrees to run of their own plugins'
   * code (src/main/plugins-agreed.ts).
   */
  ownCode?: {
    /** Turns it on or off: never on while the organization's policy keeps it off. */
    developerMode(on: boolean): Promise<Settings>
    /** One of their own plugins with code, as it stands against what they agreed to. */
    standing(name: string): Promise<OwnCode | undefined>
    /** Agrees to run its code as they were shown it: what its file asks, and its code's digest. */
    agree(name: string, asks: string, code: string): Promise<void>
    /** In Developer mode, their plugins folder changed: read the plugins again. */
    onChange(listener: () => void): () => void
  }
}

/** Channel names, shared so the page and what answers it cannot drift apart. */
export const IPC = {
  command: 'app:command',
  terminalFocus: 'terminal:focus',
  recordKeys: 'keys:record',
  keyRecorded: 'keys:recorded',
  openMenu: 'app:open-menu',
  newWindow: 'app:new-window',
  keepBelow: 'window:keep-below',
  restored: 'window:restored',
  moveToWindow: 'window:move-tab',
  movedTab: 'window:moved-tab',
  putBack: 'window:put-back',
  tabReturned: 'window:tab-returned',
  adoptShell: 'window:adopt-shell',
  linkWaiting: 'link:waiting',
  linkSkipped: 'link:skipped',
  linkAnswered: 'link:answered',
  takeLink: 'link:take',
  linkFor: 'link:for',
  appInfo: 'app:info',
  appProblems: 'app:problems',
  appNote: 'app:note',
  settings: 'app:settings',
  /** A server's: someone changed its clusters' settings (everyone's pages read them again). */
  settingsChanged: 'app:settings-changed',
  setTheme: 'app:set-theme',
  setPreferences: 'app:set-preferences',
  shells: 'app:shells',
  setReadOnly: 'app:set-read-only',
  setCluster: 'app:set-cluster',
  warningNotices: 'app:warning-notices',
  setMetricsSource: 'app:set-metrics-source',
  setNodeShell: 'app:set-node-shell',
  setPluginCode: 'app:set-plugin-code',
  openExternal: 'app:open-external',
  saveFile: 'app:save-file',
  showSaved: 'app:show-saved',
  plugins: 'app:plugins',
  pluginStore: 'plugins:store',
  pluginInstall: 'plugins:install',
  pluginGoBack: 'plugins:go-back',
  pluginRemove: 'plugins:remove',
  pluginDeveloperMode: 'plugins:developer-mode',
  pluginOwnCode: 'plugins:own-code',
  pluginAgree: 'plugins:agree',
  pluginsChanged: 'plugins:changed',
  marks: 'marks:get',
  setMarks: 'marks:set',
  contexts: 'kube:contexts',
  kubeconfigFiles: 'kubeconfig:files',
  kubeconfigChoose: 'kubeconfig:choose',
  kubeconfigRemove: 'kubeconfig:remove',
  kubeconfigUseDefault: 'kubeconfig:use-default',
  kubeconfigShow: 'kubeconfig:show',
  kubeconfigChooseAgain: 'kubeconfig:choose-again',
  kubeconfigAddFolder: 'kubeconfig:add-folder',
  kubeconfigAsks: 'kubeconfig:asks',
  kubeconfigAgree: 'kubeconfig:agree',
  kubeconfigChanged: 'kubeconfig:changed',
  addedImport: 'added:import',
  addedInspect: 'added:inspect',
  addedCheck: 'added:check',
  addedAdd: 'added:add',
  addedRead: 'added:read',
  addedAwsProfiles: 'added:aws-profiles',
  addedAwsFind: 'added:aws-find',
  addedEdit: 'added:edit',
  addedRemove: 'added:remove',
  addedForKubectl: 'added:for-kubectl',
  version: 'kube:version',
  resources: 'kube:resources',
  schema: 'kube:schema',
  list: 'kube:list',
  search: 'kube:search',
  get: 'kube:get',
  secretValues: 'kube:secret-values',
  certificates: 'kube:certificates',
  pluginRead: 'kube:plugin-read',
  pluginLogs: 'kube:plugin-logs',
  pluginEvents: 'kube:plugin-events',
  pluginServer: 'kube:plugin-server',
  pluginChange: 'kube:plugin-change',
  pluginCode: 'kube:plugin-code',
  pluginHandOver: 'kube:plugin-hand-over',
  boxCheckStart: 'kube:box-check-start',
  boxCheckEnd: 'kube:box-check-end',
  boxCheckFailed: 'kube:box-check-failed',
  metrics: 'kube:metrics',
  change: 'kube:change',
  can: 'kube:can',
  history: 'kube:history',
  fleetSummary: 'fleet:summary',
  fleetAgents: 'fleet:agents',
  fleetTrustAgent: 'fleet:trust-agent',
  fleetJoins: 'fleet:joins',
  fleetConnect: 'fleet:connect',
  fleetCancelJoin: 'fleet:cancel-join',
  fleetRemove: 'fleet:remove',
  fleetCheck: 'fleet:check',
  fleetAdd: 'fleet:add',
  fleetSettings: 'fleet:settings',
  fleetSaveSettings: 'fleet:save-settings',
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
  helmRepositories: 'helm:repositories',
  helmRepositoriesRefresh: 'helm:repositories-refresh',
  helmRepositoryTest: 'helm:repository-test',
  helmRepositorySave: 'helm:repository-save',
  helmRepositoryRemove: 'helm:repository-remove',
  helmChartIcon: 'helm:chart-icon',
  usageSource: 'usage:source',
  usageTest: 'usage:test',
  usageRange: 'usage:range',
  usageInstant: 'usage:instant',
  usageAlerts: 'usage:alerts',
  metricsStackStatus: 'metrics-stack:status',
  metricsStackInstall: 'metrics-stack:install',
  metricsStackUninstall: 'metrics-stack:uninstall',
  terminalOpen: 'terminal:open',
  terminalInput: 'terminal:input',
  terminalResize: 'terminal:resize',
  terminalClose: 'terminal:close',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  /** Lumovi ended a plugin's process: which plugin, and what it was over. */
  pluginEnded: 'plugin:ended',
  forwardStart: 'forward:start',
  forwardList: 'forward:list',
  forwardStop: 'forward:stop',
  forwardsChanged: 'forward:changed',
  logsStart: 'logs:start',
  logsStop: 'logs:stop',
  logsLines: 'logs:lines',
  logsEnd: 'logs:end',
  watchStart: 'watch:start',
  watchStop: 'watch:stop',
  watchChanged: 'watch:changed',
  watchEnded: 'watch:ended',
  filesPick: 'files:pick',
  filesDownload: 'files:download',
  filesUpload: 'files:upload',
  filesCancel: 'files:cancel',
  filesShow: 'files:show',
  filesProgress: 'files:progress',
  filesEnd: 'files:end',
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

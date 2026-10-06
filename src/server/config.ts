/**
 * The server's settings, from its environment (the Helm chart sets them; see
 * https://docs.lumovi.dev/server/configuration). One that doesn't make
 * sense stops the server, saying why.
 */
import { createHash } from 'node:crypto'
import { delimiter, join } from 'node:path'
import { parse } from 'yaml'
import { NODE_SHELL_DEFAULTS, type MetricsSourceSetting, type NodeShellSetting } from '@shared/api'
import {
  AI_SETTINGS,
  checkedRule,
  parseMatcher,
  type AiRule,
  type AiSetting,
  type Matcher,
} from '@shared/ai-permissions'
import { isAiChanges, type AiChanges } from '@shared/assistants'
import { checkedPolicy, type BasePolicy } from '@shared/access'
import { AUDIT_EXPORT_LIMIT, isAuditLevel, type AuditLevel } from '@shared/audit'
import type { AuthMode } from '@shared/server'
import type { WebhookFormat } from '@backend/audit/sinks'
import type { Keeping } from './kept'
import { isMetricsSourceSetting, isNodeShellSetting } from '@backend/settings'
import { MAX_SESSION_HOURS } from './sessions'

export type AuthConfig =
  | { mode: 'token' }
  | {
      mode: 'oidc'
      issuer: string
      clientId: string
      clientSecret?: string
      scopes: string
      /** The ID token claims that name the user, and list their groups. */
      usernameClaim: string
      groupsClaim: string
      /** What the sign-in button calls the provider. */
      provider: string
      /**
       * Which of the person's own tokens requests carry, when the API server
       * trusts the provider itself; unset, the server impersonates them.
       */
      forwardToken?: 'id' | 'access'
    }
  | {
      mode: 'proxy'
      /** The request headers the proxy names the user and their groups in. */
      userHeader: string
      groupsHeader: string
      signOutUrl?: string
    }

/** Secrets that describe clusters: Lumovi's own, Cluster API's, Argo CD's. */
export type SecretSource = 'lumovi' | 'cluster-api' | 'argocd'
const SECRET_SOURCES: readonly SecretSource[] = ['lumovi', 'cluster-api', 'argocd']

/** A cluster whose agent connects to the server, from inside a network the server can't reach. */
export interface AgentConfig {
  name: string
  /** The SHA-256 of the token it signs in with, in hex. */
  tokenSha256: string
  labels: Record<string, string>
  /** Only people in these groups see it; everyone unless set. */
  groups?: string[]
  /** Requests carry each person's own token, rather than impersonating them. */
  forwardToken: boolean
}

/** Where a fleet's clusters come from. */
export interface FleetConfig {
  /** A kubeconfig, every context of which is a cluster (LUMOVI_FLEET_KUBECONFIG). */
  kubeconfig?: string
  /** Kubeconfig files likewise, read again every refresh. */
  kubeconfigFiles: string[]
  /** In Kubernetes: Secrets that describe clusters, read again every refresh. */
  secrets: SecretSource[]
  /** Where those Secrets are; the server's own namespace unless set. */
  secretNamespaces?: string[]
  agents: AgentConfig[]
  /** Whether the cluster the server runs in is one of them. */
  local: boolean
  /** How often files and Secrets are read again. */
  refreshSeconds: number
}

export interface ServerConfig {
  port: number
  /** The address to listen on; every interface unless set. */
  address?: string
  /** Where the server is below its origin: `/`, or e.g. `/lumovi/`. */
  basePath: string
  /** The address people open (single sign-on returns there). */
  publicUrl?: URL
  /** The name pages use for the cluster, as for a kubeconfig context. */
  clusterName?: string
  /**
   * What the cluster the server runs in is labelled with: in a fleet, as one of its clusters;
   * alone, for AI assistants' rules to match.
   */
  clusterLabels: Record<string, string>
  /** Many clusters, rather than one; unset, the server shows one. */
  fleet?: FleetConfig
  auth: AuthConfig
  /** Prefixed to the names of impersonated users and groups, as the API server's own OIDC flags do. */
  usernamePrefix: string
  groupsPrefix: string
  sessionHours: number
  /** How often pages' connections are checked, so proxies don't close quiet ones. */
  heartbeatSeconds: number
  /** The metrics source pages start with. */
  metricsSource: MetricsSourceSetting
  /** Where node shells run unless a page says otherwise, and whether they're turned off. */
  nodeShell: { setting: NodeShellSetting; off: boolean }
  /** Whether charts may come from addresses inside private networks. */
  allowPrivateCharts: boolean
  /** Where the views everyone shares are (a ConfigMap's, say). */
  viewsDir: string
  /** Where the page's files are: the renderer's build, next to the server's. */
  rendererDir: string
  /**
   * AI assistants over MCP: whether they may connect, the administrator's rules (limits on
   * what they may do, which nothing loosens), where people's own rules are kept, and the
   * sites (host names) they may be sent back to over https, besides the person's computer
   * and apps.
   */
  assistants: {
    enabled: boolean
    rules: AiRule[]
    keep: RulesKeeping
    redirectHosts: string[]
  }
  audit: AuditConfig
  access: AccessConfig
}

/**
 * Who may do what through Lumovi: who administers it (LUMOVI_ADMINS); what the chart (or the
 * server's settings) says (LUMOVI_ACCESS), which admins can't change here; and where what they
 * set is kept.
 */
export interface AccessConfig {
  admins: { groups: string[]; users: string[] }
  base?: BasePolicy
  keep: Keeping
}

/** The audit log: how much it records, where it keeps and sends it, and who reads everyone's. */
export interface AuditConfig {
  level: AuditLevel
  /** Where its history is kept (a volume's folder); unset, in memory since the server started. */
  dir?: string
  retentionDays: number
  /** Without a folder: how many of the most recent events memory keeps. */
  memoryEvents: number
  /** How many events one search looks through before it stops, and offers to look further. */
  scanLimit: number
  /** How many events an export holds, at most. */
  exportLimit: number
  /** Each event as a JSON line on the server's output. */
  stdout: boolean
  webhook?: {
    url: URL
    headers: Record<string, string>
    format: WebhookFormat
    /** How many events wait to be sent, at most, while it can't take them. */
    buffer: number
  }
  /** Who sees everyone's events, not only their own: people in these groups, and these people. */
  auditors: { groups: string[]; users: string[] }
}

/**
 * Where people's own AI rules are kept: in a ConfigMap of the namespace
 * Lumovi runs in (the chart's), a file, or only in memory.
 */
export type RulesKeeping = Keeping

export class ConfigError extends Error {}

const AUTH_MODES: readonly AuthMode[] = ['token', 'oidc', 'proxy']
/** `monitoring/prometheus-operated:9090`, or with a path: `vm/vmselect:8481/select/0/prometheus`. */
const METRICS_SERVICE = /^([^/:]+)\/([^/:]+):([^/]+)(\/.*)?$/

export function readConfig(env: NodeJS.ProcessEnv, rendererDir: string): ServerConfig {
  const value = (name: string) => env[name]?.trim() || undefined
  const required = (name: string, why: string) => {
    const setting = value(name)
    if (!setting) throw new ConfigError(`${name} must be set ${why}.`)
    return setting
  }
  const url = (name: string, setting: string) => {
    if (!/^https?:\/\//.test(setting) || !URL.canParse(setting)) {
      throw new ConfigError(`${name} must be an http or https URL, not "${setting}".`)
    }
    return new URL(setting)
  }
  /** A number above 0, at most `max`: fractions are fine (sessions of a few minutes). */
  const number = (name: string, fallback: number, max: number) => {
    const setting = Number(value(name) ?? fallback)
    if (!(setting > 0 && setting <= max)) {
      throw new ConfigError(`${name} must be a number from 1 to ${max}, not "${value(name)}".`)
    }
    return setting
  }

  const mode = (value('LUMOVI_AUTH') ?? 'token') as AuthMode
  if (!AUTH_MODES.includes(mode)) {
    throw new ConfigError(
      `LUMOVI_AUTH must be ${AUTH_MODES.join(', ')} or unset (token), not "${mode}".`,
    )
  }
  const publicSetting = value('LUMOVI_URL')
  const publicUrl = publicSetting ? url('LUMOVI_URL', publicSetting) : undefined
  let auth: AuthConfig = { mode: 'token' }
  if (mode === 'oidc') {
    const issuer = required('LUMOVI_OIDC_ISSUER', 'for single sign-on')
    url('LUMOVI_OIDC_ISSUER', issuer)
    if (!publicUrl) {
      throw new ConfigError(
        'LUMOVI_URL must be set for single sign-on: the provider sends people back there.',
      )
    }
    auth = {
      mode,
      issuer: issuer.replace(/\/+$/, ''),
      clientId: required('LUMOVI_OIDC_CLIENT_ID', 'for single sign-on'),
      clientSecret: value('LUMOVI_OIDC_CLIENT_SECRET'),
      scopes: value('LUMOVI_OIDC_SCOPES') ?? 'openid email profile',
      usernameClaim: value('LUMOVI_OIDC_USERNAME_CLAIM') ?? 'email',
      groupsClaim: value('LUMOVI_OIDC_GROUPS_CLAIM') ?? 'groups',
      provider: value('LUMOVI_OIDC_PROVIDER_NAME') ?? 'single sign-on',
      forwardToken: forwardToken(value('LUMOVI_OIDC_FORWARD_TOKEN')),
    }
  } else if (mode === 'proxy') {
    const signOut = value('LUMOVI_PROXY_SIGN_OUT_URL')
    auth = {
      mode,
      userHeader: (value('LUMOVI_PROXY_USER_HEADER') ?? 'X-Forwarded-User').toLowerCase(),
      groupsHeader: (value('LUMOVI_PROXY_GROUPS_HEADER') ?? 'X-Forwarded-Groups').toLowerCase(),
      signOutUrl: signOut && url('LUMOVI_PROXY_SIGN_OUT_URL', signOut).href,
    }
  }

  const basePath = `/${(value('LUMOVI_BASE_PATH') ?? '').replace(/^\/+|\/+$/g, '')}/`.replace(
    '//',
    '/',
  )
  if (!/^\/([\w.~-]+\/)*$/.test(basePath)) {
    throw new ConfigError(
      `LUMOVI_BASE_PATH must be a path like /lumovi, not "${value('LUMOVI_BASE_PATH')}".`,
    )
  }

  // PORT is what hosts like Sevalla set for the process that answers the web.
  const portName = value('LUMOVI_PORT') !== undefined || !value('PORT') ? 'LUMOVI_PORT' : 'PORT'
  const port = Number(value(portName) ?? 8080)
  // 0: any free port (the log says which).
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigError(`${portName} must be a port number, not "${value(portName)}".`)
  }

  const fleet = fleetConfig(env, value)
  if (fleet && auth.mode === 'token') {
    throw new ConfigError(
      'A fleet needs single sign-on or a proxy (LUMOVI_AUTH=oidc or proxy): a pasted token only says who someone is to one cluster.',
    )
  }

  const clusterLabels = labels('LUMOVI_CLUSTER_LABELS', value('LUMOVI_CLUSTER_LABELS'))
  const assistants = assistantsConfig(env, value)
  // One cluster: a rule matching clusters by a label it doesn't have would do nothing.
  if (!fleet) {
    for (const rule of assistants.rules) {
      for (const text of rule.clusters) {
        const matcher = parseMatcher(text) as Matcher
        if (matcher.kind === 'label' && !(matcher.key! in clusterLabels)) {
          throw new ConfigError(
            `The AI rule “${rule.name}” matches clusters by the label ${matcher.key}, which this server’s cluster doesn’t have: give it its labels (LUMOVI_CLUSTER_LABELS, the chart’s clusterLabels), or name it.`,
          )
        }
      }
    }
  }

  return {
    port,
    address: value('LUMOVI_ADDRESS'),
    basePath,
    publicUrl,
    clusterName: value('LUMOVI_CLUSTER_NAME'),
    clusterLabels,
    fleet,
    auth,
    usernamePrefix: value('LUMOVI_USERNAME_PREFIX') ?? '',
    groupsPrefix: value('LUMOVI_GROUPS_PREFIX') ?? '',
    sessionHours: number('LUMOVI_SESSION_HOURS', 12, MAX_SESSION_HOURS),
    heartbeatSeconds: number('LUMOVI_HEARTBEAT_SECONDS', 30, 3600),
    metricsSource: metricsSource(value('LUMOVI_METRICS_SOURCE')),
    nodeShell: nodeShell(value),
    allowPrivateCharts: ['1', 'true'].includes(value('LUMOVI_ALLOW_PRIVATE_CHARTS') ?? ''),
    viewsDir: value('LUMOVI_VIEWS_DIR') ?? '/etc/lumovi/views',
    rendererDir,
    assistants,
    audit: auditConfig(value),
    access: accessConfig(env, value),
  }
}

/** Who may do what: LUMOVI_ADMINS, LUMOVI_ACCESS, and LUMOVI_ACCESS_CONFIGMAP (or a file, or memory). */
function accessConfig(
  env: NodeJS.ProcessEnv,
  value: (name: string) => string | undefined,
): AccessConfig {
  const admins = list(value('LUMOVI_ADMINS'))
  const setting = value('LUMOVI_ACCESS')
  let base: BasePolicy | undefined
  if (setting) {
    let parsed: unknown
    try {
      parsed = parse(document('LUMOVI_ACCESS', setting))
    } catch (error) {
      if (error instanceof ConfigError) throw error
      throw new ConfigError(
        `LUMOVI_ACCESS isn’t YAML: ${(error as Error).message.split('\n')[0]}`,
        {
          cause: error,
        },
      )
    }
    try {
      base = {
        policy: checkedPolicy(parsed, 'LUMOVI_ACCESS'),
        // (A map, once it's checked.)
        setsEveryone: 'everyone' in (parsed as object),
      }
    } catch (error) {
      throw new ConfigError((error as Error).message, { cause: error })
    }
  }
  const configMap = value('LUMOVI_ACCESS_CONFIGMAP')
  if (configMap && !/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(configMap)) {
    throw new ConfigError(
      `LUMOVI_ACCESS_CONFIGMAP must name a ConfigMap, like lumovi-access, not "${configMap}".`,
    )
  }
  if (configMap && !env.KUBERNETES_SERVICE_HOST) {
    throw new ConfigError(
      'LUMOVI_ACCESS_CONFIGMAP keeps who may do what in the cluster Lumovi runs in, and it isn’t running in one (KUBERNETES_SERVICE_HOST isn’t set).',
    )
  }
  const dataDir = value('LUMOVI_DATA_DIR')
  return {
    admins: {
      groups: admins.filter((entry) => !entry.startsWith('user:')),
      users: admins.filter((entry) => entry.startsWith('user:')).map((entry) => entry.slice(5)),
    },
    base,
    keep: configMap
      ? { kind: 'configmap', name: configMap }
      : dataDir
        ? { kind: 'file', path: join(dataDir, 'access.json') }
        : { kind: 'memory' },
  }
}

/**
 * The audit log: LUMOVI_AUDIT_LEVEL (changes, or access: what's opened and read too);
 * its history in LUMOVI_AUDIT_DIR (else LUMOVI_DATA_DIR/audit, else memory), kept for
 * LUMOVI_AUDIT_RETENTION_DAYS; each event on the server's output unless LUMOVI_AUDIT_STDOUT
 * is false, and to LUMOVI_AUDIT_WEBHOOK_URL (with LUMOVI_AUDIT_WEBHOOK_HEADERS, as
 * LUMOVI_AUDIT_WEBHOOK_FORMAT); everyone's read by LUMOVI_AUDITORS (groups, and user:names).
 */
function auditConfig(value: (name: string) => string | undefined): AuditConfig {
  /** A whole number from `min` to `max`. */
  const count = (name: string, fallback: number, min: number, max: number) => {
    const setting = value(name) ?? String(fallback)
    const n = Number(setting)
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new ConfigError(
        `${name} must be a whole number from ${min.toLocaleString('en')} to ${max.toLocaleString('en')}, not "${setting}".`,
      )
    }
    return n
  }
  const level = value('LUMOVI_AUDIT_LEVEL') ?? 'access'
  if (!isAuditLevel(level)) {
    throw new ConfigError(`LUMOVI_AUDIT_LEVEL must be changes or access, not "${level}".`)
  }
  const stdout = value('LUMOVI_AUDIT_STDOUT') ?? 'true'
  if (!['true', 'false'].includes(stdout)) {
    throw new ConfigError(`LUMOVI_AUDIT_STDOUT must be true or false, not "${stdout}".`)
  }
  const dataDir = value('LUMOVI_DATA_DIR')
  const auditors = list(value('LUMOVI_AUDITORS'))
  return {
    level,
    dir: value('LUMOVI_AUDIT_DIR') ?? (dataDir && join(dataDir, 'audit')),
    retentionDays: count('LUMOVI_AUDIT_RETENTION_DAYS', 90, 1, 3650),
    memoryEvents: count('LUMOVI_AUDIT_MEMORY_EVENTS', 10_000, 100, 1_000_000),
    scanLimit: count('LUMOVI_AUDIT_SCAN_LIMIT', 200_000, 100, 10_000_000),
    exportLimit: count('LUMOVI_AUDIT_EXPORT_LIMIT', AUDIT_EXPORT_LIMIT, 10, 1_000_000),
    stdout: stdout === 'true',
    webhook: auditWebhook(value, count('LUMOVI_AUDIT_WEBHOOK_BUFFER', 10_000, 10, 1_000_000)),
    auditors: {
      groups: auditors.filter((entry) => !entry.startsWith('user:')),
      users: auditors.filter((entry) => entry.startsWith('user:')).map((entry) => entry.slice(5)),
    },
  }
}

function auditWebhook(
  value: (name: string) => string | undefined,
  buffer: number,
): AuditConfig['webhook'] {
  const setting = value('LUMOVI_AUDIT_WEBHOOK_URL')
  const headers = value('LUMOVI_AUDIT_WEBHOOK_HEADERS')
  const format = value('LUMOVI_AUDIT_WEBHOOK_FORMAT') ?? 'json'
  if (!setting) {
    if (headers || value('LUMOVI_AUDIT_WEBHOOK_FORMAT') || value('LUMOVI_AUDIT_WEBHOOK_BUFFER')) {
      throw new ConfigError(
        'LUMOVI_AUDIT_WEBHOOK_HEADERS, _FORMAT and _BUFFER say how events are sent to LUMOVI_AUDIT_WEBHOOK_URL, which isn’t set.',
      )
    }
    return undefined
  }
  if (!/^https?:\/\//.test(setting) || !URL.canParse(setting)) {
    throw new ConfigError(
      `LUMOVI_AUDIT_WEBHOOK_URL must be an http or https URL, not "${setting}".`,
    )
  }
  const url = new URL(setting)
  if (url.username || url.password) {
    throw new ConfigError(
      'LUMOVI_AUDIT_WEBHOOK_URL can’t carry a user and password: put an Authorization header in LUMOVI_AUDIT_WEBHOOK_HEADERS.',
    )
  }
  if (format !== 'json' && format !== 'ndjson') {
    throw new ConfigError(`LUMOVI_AUDIT_WEBHOOK_FORMAT must be json or ndjson, not "${format}".`)
  }
  let parsed: unknown
  try {
    parsed =
      headers === undefined ? undefined : parse(document('LUMOVI_AUDIT_WEBHOOK_HEADERS', headers))
  } catch (error) {
    if (error instanceof ConfigError) throw error
    throw new ConfigError(
      `LUMOVI_AUDIT_WEBHOOK_HEADERS isn’t YAML: ${(error as Error).message.split('\n')[0]}`,
      { cause: error },
    )
  }
  const given = stringMap('LUMOVI_AUDIT_WEBHOOK_HEADERS', parsed)
  for (const name of Object.keys(given)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new ConfigError(`LUMOVI_AUDIT_WEBHOOK_HEADERS: "${name}" isn’t a header’s name.`)
    }
  }
  return { url, headers: given, format, buffer }
}

/**
 * AI assistants: on unless LUMOVI_ASSISTANTS is off; the administrator's
 * rules (LUMOVI_ASSISTANT_RULES, and LUMOVI_ASSISTANT_CHANGES, which came
 * first); where people's own rules are kept (LUMOVI_ASSISTANT_RULES_CONFIGMAP,
 * else a file under LUMOVI_DATA_DIR, else memory); and the sites they may be
 * sent back to (LUMOVI_ASSISTANT_REDIRECT_HOSTS).
 */
function assistantsConfig(
  env: NodeJS.ProcessEnv,
  value: (name: string) => string | undefined,
): ServerConfig['assistants'] {
  const switched = value('LUMOVI_ASSISTANTS') ?? 'on'
  if (!['on', 'off'].includes(switched)) {
    throw new ConfigError(`LUMOVI_ASSISTANTS must be on or off, not "${switched}".`)
  }
  const rules = [
    ...changesRules(value('LUMOVI_ASSISTANT_CHANGES')),
    ...adminRules(value('LUMOVI_ASSISTANT_RULES')),
  ]
  const hosts = value('LUMOVI_ASSISTANT_REDIRECT_HOSTS')
  const redirectHosts = list(hosts).map((host) => host.toLowerCase())
  if (!redirectHosts.every((host) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host))) {
    throw new ConfigError(
      `LUMOVI_ASSISTANT_REDIRECT_HOSTS must be host names, like assistant.example.com, not "${hosts}".`,
    )
  }
  return { enabled: switched === 'on', rules, keep: rulesKeeping(env, value), redirectHosts }
}

/**
 * LUMOVI_ASSISTANT_CHANGES, as rules: ask, allow or never, with clusters' own
 * after it (ask,staging=allow,production=never). Ask and never are limits;
 * allow is none, so people choose.
 */
function changesRules(setting: string | undefined): AiRule[] {
  let fallback: AiChanges | undefined
  const clusters: [string, AiChanges][] = []
  for (const entry of list(setting)) {
    const [, cluster, policy] = /^(?:([^=]*)=)?(.*)$/.exec(entry)!
    const name = cluster?.trim()
    if (
      !isAiChanges(policy!.trim()) ||
      name === '' ||
      (name !== undefined && typeof parseMatcher(name) === 'string')
    ) {
      throw new ConfigError(
        `LUMOVI_ASSISTANT_CHANGES must be ask, allow or never, with clusters' own after it (ask,staging=allow), not "${setting}".`,
      )
    }
    if (name === undefined) fallback = policy!.trim() as AiChanges
    else clusters.push([name, policy!.trim() as AiChanges])
  }
  const named = 'LUMOVI_ASSISTANT_CHANGES'
  return [
    ...(fallback && fallback !== 'allow'
      ? [
          {
            name: `Changes (${named})`,
            clusters: clusters.map(([cluster]) => `!${cluster}`),
            namespaces: [],
            set: { changes: fallback },
          },
        ]
      : []),
    ...clusters
      .filter(([, changes]) => changes !== 'allow')
      .map(([cluster, changes]) => ({
        name: `Changes to ${cluster} (${named})`,
        clusters: [cluster],
        namespaces: [],
        set: { changes },
      })),
  ]
}

/**
 * LUMOVI_ASSISTANT_RULES: the administrator's rules, as YAML (or JSON, or
 * either in base64), a list of { name, clusters, namespaces, and the settings
 * each limits: visibility, changes, secrets, env, logs }.
 */
function adminRules(setting: string | undefined): AiRule[] {
  if (!setting) return []
  const name = 'LUMOVI_ASSISTANT_RULES'
  let entries: unknown
  try {
    entries = parse(document(name, setting))
  } catch (error) {
    if (error instanceof ConfigError) throw error
    throw new ConfigError(`${name} isn’t YAML: ${(error as Error).message.split('\n')[0]}`)
  }
  if (!Array.isArray(entries)) {
    throw new ConfigError(
      `${name} must be a list of rules, each with a name, where it applies, and what it limits.`,
    )
  }
  return entries.map((entry: unknown, i) => {
    const at = `${name}[${i}]`
    const { name: called, clusters, namespaces, ...set } = Object(entry) as Record<string, unknown>
    let rule: AiRule
    try {
      rule = checkedRule(
        typeof entry === 'object' && entry !== null && !Array.isArray(entry)
          ? { name: called, clusters, namespaces, set }
          : entry,
        at,
        false,
      )
    } catch (error) {
      throw new ConfigError((error as Error).message)
    }
    if (Object.keys(rule.set).length === 0) {
      throw new ConfigError(
        `${at} (${rule.name}) limits nothing: give it visibility, changes, secrets, env or logs.`,
      )
    }
    // The loosest of a setting is no limit at all.
    for (const [key, value] of Object.entries(rule.set) as [AiSetting, string][]) {
      if ((AI_SETTINGS[key] as readonly string[]).indexOf(value) === 0) {
        throw new ConfigError(
          `${at} (${rule.name}) says ${key}: ${value}, which limits nothing: it’s the loosest there is.`,
        )
      }
    }
    return rule
  })
}

/** Where people's own AI rules are kept: see RulesKeeping. */
function rulesKeeping(
  env: NodeJS.ProcessEnv,
  value: (name: string) => string | undefined,
): RulesKeeping {
  const configMap = value('LUMOVI_ASSISTANT_RULES_CONFIGMAP')
  if (configMap) {
    if (!/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(configMap)) {
      throw new ConfigError(
        `LUMOVI_ASSISTANT_RULES_CONFIGMAP must name a ConfigMap, like lumovi-assistant-rules, not "${configMap}".`,
      )
    }
    if (!env.KUBERNETES_SERVICE_HOST) {
      throw new ConfigError(
        'LUMOVI_ASSISTANT_RULES_CONFIGMAP keeps people’s AI rules in the cluster Lumovi runs in, and it isn’t running in one (KUBERNETES_SERVICE_HOST isn’t set).',
      )
    }
    return { kind: 'configmap', name: configMap }
  }
  const dir = value('LUMOVI_DATA_DIR')
  return dir ? { kind: 'file', path: join(dir, 'assistant-rules.json') } : { kind: 'memory' }
}

/** A fleet's sources, when any is set. */
function fleetConfig(
  env: NodeJS.ProcessEnv,
  value: (name: string) => string | undefined,
): FleetConfig | undefined {
  const kubeconfig = value('LUMOVI_FLEET_KUBECONFIG')
  const files = (value('LUMOVI_FLEET_KUBECONFIG_FILE') ?? '').split(delimiter).filter(Boolean)
  const secrets = list(value('LUMOVI_FLEET_SECRETS'))
  for (const source of secrets) {
    if (!SECRET_SOURCES.includes(source as SecretSource)) {
      throw new ConfigError(
        `LUMOVI_FLEET_SECRETS takes ${SECRET_SOURCES.join(', ')}, not "${source}".`,
      )
    }
  }
  const agents = agentsConfig(value('LUMOVI_FLEET_AGENTS'))
  const inKubernetes = Boolean(env.KUBERNETES_SERVICE_HOST)
  const localSetting = value('LUMOVI_FLEET_LOCAL')
  if (localSetting !== undefined && !['true', 'false'].includes(localSetting)) {
    throw new ConfigError(`LUMOVI_FLEET_LOCAL must be true or false, not "${localSetting}".`)
  }
  if (localSetting === 'true' && !inKubernetes) {
    throw new ConfigError(
      'LUMOVI_FLEET_LOCAL is true, but Lumovi isn’t running in a cluster (KUBERNETES_SERVICE_HOST isn’t set).',
    )
  }
  if (secrets.length > 0 && !inKubernetes) {
    throw new ConfigError(
      'LUMOVI_FLEET_SECRETS reads Secrets of the cluster Lumovi runs in, and it isn’t running in one (KUBERNETES_SERVICE_HOST isn’t set).',
    )
  }
  if (!kubeconfig && files.length === 0 && secrets.length === 0 && agents.length === 0) {
    return localSetting === 'true' ? fleetOf({ local: true }) : undefined
  }
  const refreshSeconds = Number(value('LUMOVI_FLEET_REFRESH_SECONDS') ?? 30)
  if (!(refreshSeconds >= 1 && refreshSeconds <= 3600)) {
    throw new ConfigError(
      `LUMOVI_FLEET_REFRESH_SECONDS must be a number from 1 to 3600, not "${value('LUMOVI_FLEET_REFRESH_SECONDS')}".`,
    )
  }
  return fleetOf({
    kubeconfig: kubeconfig && document('LUMOVI_FLEET_KUBECONFIG', kubeconfig),
    kubeconfigFiles: files,
    secrets: secrets as SecretSource[],
    secretNamespaces: value('LUMOVI_FLEET_SECRETS_NAMESPACES')
      ? list(value('LUMOVI_FLEET_SECRETS_NAMESPACES'))
      : undefined,
    agents,
    local: localSetting === undefined ? inKubernetes : localSetting === 'true',
    refreshSeconds,
  })
}

const fleetOf = (settings: Partial<FleetConfig>): FleetConfig => ({
  kubeconfigFiles: [],
  secrets: [],
  agents: [],
  local: false,
  refreshSeconds: 30,
  ...settings,
})

/** A comma-separated setting's entries. */
const list = (setting = '') =>
  setting
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

/** `env=production,region=eu`: labels, as a cluster's. */
export function labels(name: string, setting: string | undefined): Record<string, string> {
  const pairs = list(setting).map((entry) => entry.split('='))
  for (const pair of pairs) {
    if (pair.length !== 2 || !pair[0] || !pair[1]) {
      throw new ConfigError(
        `${name} must be labels like env=production,region=eu, not "${setting}".`,
      )
    }
  }
  return Object.fromEntries(pairs)
}

/**
 * A setting that holds a document: its YAML (or JSON), or that base64-encoded,
 * on one line, for hosts whose settings take one (Sevalla's).
 */
export function document(name: string, setting: string): string {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(setting)) return setting
  const text = Buffer.from(setting, 'base64').toString('utf8')
  if (!text.trim() || text.includes('\uFFFD')) {
    throw new ConfigError(`${name} must be YAML, or YAML encoded in base64.`)
  }
  return text
}

/** The agents allowed to connect: a list of { name, token or tokenSha256, labels, groups, forwardToken }. */
function agentsConfig(setting: string | undefined): AgentConfig[] {
  if (!setting) return []
  const name = 'LUMOVI_FLEET_AGENTS'
  let entries: unknown
  try {
    entries = parse(document(name, setting))
  } catch (error) {
    if (error instanceof ConfigError) throw error
    throw new ConfigError(`${name} isn’t YAML: ${(error as Error).message.split('\n')[0]}`)
  }
  if (!Array.isArray(entries)) {
    throw new ConfigError(`${name} must be a list of agents, each with a name and a token.`)
  }
  const seen = new Set<string>()
  return entries.map((entry: Record<string, unknown>, i) => {
    const at = `${name}[${i}]`
    if (typeof entry !== 'object' || entry === null || typeof entry.name !== 'string') {
      throw new ConfigError(`${at} needs a name.`)
    }
    if (seen.has(entry.name))
      throw new ConfigError(`${at}: there are two agents called ${entry.name}.`)
    seen.add(entry.name)
    let tokenSha256: string
    if (typeof entry.tokenSha256 === 'string' && /^[0-9a-f]{64}$/i.test(entry.tokenSha256)) {
      tokenSha256 = entry.tokenSha256.toLowerCase()
    } else if (typeof entry.token === 'string' && entry.token.length >= 32) {
      tokenSha256 = createHash('sha256').update(entry.token).digest('hex')
    } else {
      throw new ConfigError(
        `${at} (${entry.name}) needs a token of at least 32 characters, or its tokenSha256.`,
      )
    }
    return {
      name: entry.name,
      tokenSha256,
      labels: stringMap(`${at}.labels`, entry.labels),
      groups: entry.groups === undefined ? undefined : strings(`${at}.groups`, entry.groups),
      forwardToken: entry.forwardToken === true,
    }
  })
}

/** A map of text, as labels are; empty unless set. */
export function stringMap(at: string, value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.values(value).some((v) => typeof v !== 'string')
  ) {
    throw new ConfigError(`${at} must be a map of text, like { env: production }.`)
  }
  return value as Record<string, string>
}

/** A list of text, as groups are. */
export function strings(at: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ConfigError(`${at} must be a list of text, like [platform, sre].`)
  }
  return value as string[]
}

/** Which token requests carry: the ID token, the access token, or (unset) none. */
function forwardToken(setting: string | undefined): 'id' | 'access' | undefined {
  if (setting === undefined || setting === 'id' || setting === 'access') return setting
  throw new ConfigError(
    `LUMOVI_OIDC_FORWARD_TOKEN must be id, access or unset (impersonate), not "${setting}".`,
  )
}

/** Node shells: on unless LUMOVI_NODE_SHELL is off, and where their pods run. */
function nodeShell(value: (name: string) => string | undefined): ServerConfig['nodeShell'] {
  const namespace = value('LUMOVI_NODE_SHELL_NAMESPACE') ?? NODE_SHELL_DEFAULTS.namespace
  const image = value('LUMOVI_NODE_SHELL_IMAGE') ?? NODE_SHELL_DEFAULTS.image
  const setting = { namespace, image }
  if (!isNodeShellSetting(setting)) {
    throw new ConfigError(
      `LUMOVI_NODE_SHELL_NAMESPACE must be a namespace's name and LUMOVI_NODE_SHELL_IMAGE an image, not "${namespace}" and "${image}".`,
    )
  }
  const switched = value('LUMOVI_NODE_SHELL') ?? 'on'
  if (!['on', 'off'].includes(switched)) {
    throw new ConfigError(`LUMOVI_NODE_SHELL must be on or off, not "${switched}".`)
  }
  return { setting, off: switched === 'off' }
}

/** `auto` (detected), `off`, or the service to use. */
function metricsSource(setting = 'auto'): MetricsSourceSetting {
  if (setting === 'auto' || setting === 'off') return { mode: setting }
  const [, namespace, service, port, path = ''] = METRICS_SERVICE.exec(setting) ?? []
  const source = { mode: 'service', service: { namespace, service, port, path } }
  if (!isMetricsSourceSetting(source)) {
    throw new ConfigError(
      `LUMOVI_METRICS_SOURCE must be auto, off, or a service like monitoring/prometheus:9090, not "${setting}".`,
    )
  }
  return source
}

/** Where the page's files are when the server runs from its build (out/server). */
export const RENDERER_DIR = join(import.meta.dirname, '../renderer')

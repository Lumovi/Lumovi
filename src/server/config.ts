/**
 * The server's settings, from its environment (the Helm chart sets them; see
 * https://docs.lumovi.dev/server/configuration). One that doesn't make
 * sense stops the server, saying why.
 */
import { createHash } from 'node:crypto'
import { delimiter, join } from 'node:path'
import { parse } from 'yaml'
import type { MetricsSourceSetting } from '@shared/api'
import type { AuthMode } from '@shared/server'
import { isMetricsSourceSetting } from '@backend/settings'
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
  /** What the cluster the server runs in is labelled with, in a fleet. */
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
  /** Whether charts may come from addresses inside private networks. */
  allowPrivateCharts: boolean
  /** Where the views everyone shares are (a ConfigMap's, say). */
  viewsDir: string
  /** Where the page's files are: the renderer's build, next to the server's. */
  rendererDir: string
}

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

  return {
    port,
    address: value('LUMOVI_ADDRESS'),
    basePath,
    publicUrl,
    clusterName: value('LUMOVI_CLUSTER_NAME'),
    clusterLabels: labels('LUMOVI_CLUSTER_LABELS', value('LUMOVI_CLUSTER_LABELS')),
    fleet,
    auth,
    usernamePrefix: value('LUMOVI_USERNAME_PREFIX') ?? '',
    groupsPrefix: value('LUMOVI_GROUPS_PREFIX') ?? '',
    sessionHours: number('LUMOVI_SESSION_HOURS', 12, MAX_SESSION_HOURS),
    heartbeatSeconds: number('LUMOVI_HEARTBEAT_SECONDS', 30, 3600),
    metricsSource: metricsSource(value('LUMOVI_METRICS_SOURCE')),
    allowPrivateCharts: ['1', 'true'].includes(value('LUMOVI_ALLOW_PRIVATE_CHARTS') ?? ''),
    viewsDir: value('LUMOVI_VIEWS_DIR') ?? '/etc/lumovi/views',
    rendererDir,
  }
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

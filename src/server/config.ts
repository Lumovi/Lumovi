/**
 * The server's settings, from its environment (the Helm chart sets them; see
 * docs/server.md). One that doesn't make sense stops the server, saying why.
 */
import { join } from 'node:path'
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

export interface ServerConfig {
  port: number
  /** The address to listen on; every interface unless set. */
  address?: string
  /** Where the server is below its origin: `/`, or e.g. `/kubestacks/`. */
  basePath: string
  /** The address people open (single sign-on returns there). */
  publicUrl?: URL
  /** The name pages use for the cluster, as for a kubeconfig context. */
  clusterName?: string
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

  const mode = (value('KUBESTACKS_AUTH') ?? 'token') as AuthMode
  if (!AUTH_MODES.includes(mode)) {
    throw new ConfigError(
      `KUBESTACKS_AUTH must be ${AUTH_MODES.join(', ')} or unset (token), not "${mode}".`,
    )
  }
  const publicSetting = value('KUBESTACKS_URL')
  const publicUrl = publicSetting ? url('KUBESTACKS_URL', publicSetting) : undefined
  let auth: AuthConfig = { mode: 'token' }
  if (mode === 'oidc') {
    const issuer = required('KUBESTACKS_OIDC_ISSUER', 'for single sign-on')
    url('KUBESTACKS_OIDC_ISSUER', issuer)
    if (!publicUrl) {
      throw new ConfigError(
        'KUBESTACKS_URL must be set for single sign-on: the provider sends people back there.',
      )
    }
    auth = {
      mode,
      issuer: issuer.replace(/\/+$/, ''),
      clientId: required('KUBESTACKS_OIDC_CLIENT_ID', 'for single sign-on'),
      clientSecret: value('KUBESTACKS_OIDC_CLIENT_SECRET'),
      scopes: value('KUBESTACKS_OIDC_SCOPES') ?? 'openid email profile',
      usernameClaim: value('KUBESTACKS_OIDC_USERNAME_CLAIM') ?? 'email',
      groupsClaim: value('KUBESTACKS_OIDC_GROUPS_CLAIM') ?? 'groups',
      provider: value('KUBESTACKS_OIDC_PROVIDER_NAME') ?? 'single sign-on',
      forwardToken: forwardToken(value('KUBESTACKS_OIDC_FORWARD_TOKEN')),
    }
  } else if (mode === 'proxy') {
    const signOut = value('KUBESTACKS_PROXY_SIGN_OUT_URL')
    auth = {
      mode,
      userHeader: (value('KUBESTACKS_PROXY_USER_HEADER') ?? 'X-Forwarded-User').toLowerCase(),
      groupsHeader: (value('KUBESTACKS_PROXY_GROUPS_HEADER') ?? 'X-Forwarded-Groups').toLowerCase(),
      signOutUrl: signOut && url('KUBESTACKS_PROXY_SIGN_OUT_URL', signOut).href,
    }
  }

  const basePath = `/${(value('KUBESTACKS_BASE_PATH') ?? '').replace(/^\/+|\/+$/g, '')}/`.replace(
    '//',
    '/',
  )
  if (!/^\/([\w.~-]+\/)*$/.test(basePath)) {
    throw new ConfigError(
      `KUBESTACKS_BASE_PATH must be a path like /kubestacks, not "${value('KUBESTACKS_BASE_PATH')}".`,
    )
  }

  const port = Number(value('KUBESTACKS_PORT') ?? 8080)
  // 0: any free port (the log says which).
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigError(
      `KUBESTACKS_PORT must be a port number, not "${value('KUBESTACKS_PORT')}".`,
    )
  }

  return {
    port,
    address: value('KUBESTACKS_ADDRESS'),
    basePath,
    publicUrl,
    clusterName: value('KUBESTACKS_CLUSTER_NAME'),
    auth,
    usernamePrefix: value('KUBESTACKS_USERNAME_PREFIX') ?? '',
    groupsPrefix: value('KUBESTACKS_GROUPS_PREFIX') ?? '',
    sessionHours: number('KUBESTACKS_SESSION_HOURS', 12, MAX_SESSION_HOURS),
    heartbeatSeconds: number('KUBESTACKS_HEARTBEAT_SECONDS', 30, 3600),
    metricsSource: metricsSource(value('KUBESTACKS_METRICS_SOURCE')),
    allowPrivateCharts: ['1', 'true'].includes(value('KUBESTACKS_ALLOW_PRIVATE_CHARTS') ?? ''),
    viewsDir: value('KUBESTACKS_VIEWS_DIR') ?? '/etc/kubestacks/views',
    rendererDir,
  }
}

/** Which token requests carry: the ID token, the access token, or (unset) none. */
function forwardToken(setting: string | undefined): 'id' | 'access' | undefined {
  if (setting === undefined || setting === 'id' || setting === 'access') return setting
  throw new ConfigError(
    `KUBESTACKS_OIDC_FORWARD_TOKEN must be id, access or unset (impersonate), not "${setting}".`,
  )
}

/** `auto` (detected), `off`, or the service to use. */
function metricsSource(setting = 'auto'): MetricsSourceSetting {
  if (setting === 'auto' || setting === 'off') return { mode: setting }
  const [, namespace, service, port, path = ''] = METRICS_SERVICE.exec(setting) ?? []
  const source = { mode: 'service', service: { namespace, service, port, path } }
  if (!isMetricsSourceSetting(source)) {
    throw new ConfigError(
      `KUBESTACKS_METRICS_SOURCE must be auto, off, or a service like monitoring/prometheus:9090, not "${setting}".`,
    )
  }
  return source
}

/** Where the page's files are when the server runs from its build (out/server). */
export const RENDERER_DIR = join(import.meta.dirname, '../renderer')

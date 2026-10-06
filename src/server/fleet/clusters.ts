/**
 * A fleet's clusters, from where they're described: a kubeconfig's contexts,
 * each with Lumovi's settings for it in a `lumovi.dev` extension.
 */
import { withProxy } from '@backend/network'
import { KubeConfig, type Cluster, type User } from '@kubernetes/client-node'
import { parse } from 'yaml'
import { ConfigError, stringMap, strings } from '../config'

/** One cluster of a fleet, and how the server reaches it. */
export interface FleetCluster {
  name: string
  /** Where it's described, for the log. */
  source: string
  /** What it's labelled with (env, region…), to filter and group by. */
  labels: Record<string, string>
  /** Only people in these groups see it; everyone unless set. */
  groups?: string[]
  /** Requests carry each person's own token, rather than impersonating them. */
  forwardToken: boolean
  /** Prefixes for impersonated names here, each set one instead of the server's. */
  prefixes?: Prefixes
  /** Its API server: absent for a cluster reached through its agent, before it connects. */
  cluster?: Cluster
  /** The server's credentials there, to impersonate people with. */
  account?: User
  /** Reached through this agent's tunnel. */
  agent?: string
  /** Why it can't be used now, as people are told. */
  problem?: string
}

/** Lumovi's settings for a cluster, as a context's `lumovi.dev` extension (or a Secret's annotations) has them. */
export interface ClusterSettings {
  labels: Record<string, string>
  groups?: string[]
  forwardToken: boolean
  prefixes?: Prefixes
}

/** A cluster's own prefixes for impersonated names (usernamePrefix and groupsPrefix). */
export type Prefixes = Partial<{ user: string; groups: string }>

const EXTENSION = 'lumovi.dev'

/** Every context of a kubeconfig, as a cluster; `dir` resolves its relative file paths. */
export function kubeconfigClusters(text: string, source: string, dir?: string): FleetCluster[] {
  const kc = new KubeConfig()
  let raw: { contexts?: { name?: string; context?: { extensions?: unknown } }[] }
  try {
    kc.loadFromString(text)
    if (dir) kc.makePathsAbsolute(dir)
    raw = parse(text) as typeof raw
  } catch (error) {
    // Only the reason: the parser quotes the lines around it, credentials and all.
    throw new ConfigError(
      `${source} isn’t a kubeconfig: ${(error as Error).message.split('\n')[0]}`,
    )
  }
  return kc.contexts.map((context) => {
    const extensions = raw.contexts?.find((c) => c.name === context.name)?.context?.extensions
    let settings: ClusterSettings
    try {
      settings = extensionSettings(extensions)
    } catch (error) {
      return broken(context.name, source, `Its ${EXTENSION} extension: ${(error as Error).message}`)
    }
    const cluster = kc.getCluster(context.cluster)
    const account = kc.getUser(context.user)
    return described(context.name, source, settings, cluster ?? undefined, account ?? undefined)
  })
}

/** A cluster as described, with what's wrong with it, if anything. */
export function described(
  name: string,
  source: string,
  settings: ClusterSettings,
  cluster: Cluster | undefined,
  account: User | undefined,
): FleetCluster {
  // Through the proxy the environment says, as kubectl would, unless its own says otherwise.
  const found: FleetCluster = {
    name,
    source,
    ...settings,
    cluster: cluster && withProxy(cluster, process.env),
    account,
  }
  if (!cluster) return { ...found, problem: 'Its kubeconfig names a cluster it doesn’t have.' }
  if (!settings.forwardToken && !hasCredentials(account)) {
    return {
      ...found,
      problem:
        'Lumovi has no credentials for it: give its user a token or a client certificate, or set forwardToken to pass on each person’s own.',
    }
  }
  return found
}

/** A cluster that can't be used, and why. */
export function broken(name: string, source: string, problem: string): FleetCluster {
  return { name, source, labels: {}, forwardToken: false, problem }
}

/** What a kubeconfig user can sign in with. */
const CREDENTIALS = ['token', 'certData', 'certFile', 'exec', 'authProvider', 'username'] as const

/** Whether a kubeconfig user has anything to sign in with. */
function hasCredentials(user: User | undefined): boolean {
  return CREDENTIALS.some((field) => Boolean(user?.[field]))
}

/** Lumovi's settings from a context's extensions: everything optional. */
function extensionSettings(extensions: unknown): ClusterSettings {
  const found = Array.isArray(extensions)
    ? (extensions as { name?: unknown; extension?: unknown }[]).find((e) => e.name === EXTENSION)
    : undefined
  const extension = (found?.extension ?? {}) as Record<string, unknown>
  if (typeof extension !== 'object' || Array.isArray(extension)) {
    throw new ConfigError('should be a map, like { labels: { env: production } }.')
  }
  return settingsFrom({
    labels: stringMap('labels', extension.labels),
    groups: extension.groups === undefined ? undefined : strings('groups', extension.groups),
    forwardToken: extension.forwardToken,
    usernamePrefix: extension.usernamePrefix,
    groupsPrefix: extension.groupsPrefix,
  })
}

/** Settings, checked: forwardToken a boolean, prefixes text. */
export function settingsFrom(given: {
  labels: Record<string, string>
  groups?: string[]
  forwardToken?: unknown
  usernamePrefix?: unknown
  groupsPrefix?: unknown
}): ClusterSettings {
  const { labels, groups, forwardToken, usernamePrefix, groupsPrefix } = given
  if (forwardToken !== undefined && typeof forwardToken !== 'boolean') {
    throw new ConfigError('forwardToken must be true or false.')
  }
  for (const [key, prefix] of Object.entries({ usernamePrefix, groupsPrefix })) {
    if (prefix !== undefined && typeof prefix !== 'string') {
      throw new ConfigError(`${key} must be text.`)
    }
  }
  const prefixes = Object.entries({ user: usernamePrefix, groups: groupsPrefix })
  return {
    labels,
    groups,
    forwardToken: forwardToken === true,
    prefixes: Object.fromEntries(prefixes.filter(([, prefix]) => prefix !== undefined)),
  }
}

/**
 * What a server shows, and how each cluster is reached for each person: with
 * their own token, or with the server's credentials, impersonating them. One
 * cluster (HostedCluster, here) or a fleet of them (HostedFleet, in fleet/).
 */
import { existsSync } from 'node:fs'
import type https from 'node:https'
import { join } from 'node:path'
import { format } from 'node:url'
import { KubeConfig, type Cluster, type User } from '@kubernetes/client-node'
import type { ContextsResult } from '@shared/api'
import type { SessionUser } from '@shared/server'
import { KubeRequestError } from '@backend/kube/errors'
import { kubeconfigPaths, loadKubeConfig, type ClusterConfigs } from '@backend/kube/kubeconfig'
import { ConfigError } from './config'
import type { Agents } from './fleet/agents'

/** Where Kubernetes mounts a pod's service account. */
const SERVICE_ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount'

/**
 * Someone signed in. With a token (theirs, or one their provider issued and
 * renews), requests carry it, so the cluster checks it; without, the server
 * vouches for them and impersonates them.
 */
export interface Identity {
  user: SessionUser
  token?: string
}

/** What a server shows: one cluster, or a fleet. */
export interface Hosted {
  /** Whether it's a fleet: many clusters, each shown as its own. */
  readonly fleet: boolean
  /** The one cluster's name, without a fleet. */
  readonly name?: string
  /** A fleet's agents, when it has any to accept. */
  readonly agents?: Agents
  /** What it shows, for the log: "demo (https://…)", "a fleet of 3 clusters". */
  describe(): string
  /** The clusters someone may see, and how their requests reach each. */
  configsFor(identity: Identity): ClusterConfigs
  /**
   * A kubeconfig for a helm run on `context` that acts as `identity`, as
   * `configsFor` does, and what to do once helm is done.
   */
  helmTarget(identity: Identity, context: string): Promise<{ kubeconfig: object; done(): void }>
  /** Why the server won't act as someone, if it won't: never as one of Kubernetes' own (system:…). */
  refuses(user: SessionUser): string | undefined
  /** Stops what it watches. */
  close(): void
}

/**
 * Credentials for one person's requests: the server's own, acting as `as`
 * (the API server checks that the server may impersonate, then applies their
 * RBAC), or, without `as`, the person's own token, as it is when each request
 * is made (one a provider renews takes over at once, on every page). Through
 * `agent` when the cluster is reached through its agent's tunnel.
 */
export class RequestsAs extends KubeConfig {
  constructor(private readonly how: { as?: SessionUser; identity: Identity; agent?: https.Agent }) {
    super()
  }

  override async applyToHTTPSOptions(options: https.RequestOptions): Promise<void> {
    await super.applyToHTTPSOptions(options)
    const { as, identity, agent } = this.how
    if (agent) options.agent = agent
    options.headers = {
      ...options.headers,
      ...(as
        ? { 'Impersonate-User': as.name, 'Impersonate-Group': as.groups }
        : { Authorization: `Bearer ${identity.token}` }),
    }
  }
}

/** Who to impersonate: the person, with prefixes, never in Kubernetes' own groups. */
export function impersonated(
  user: SessionUser,
  prefixes: { user: string; groups: string },
): SessionUser {
  return {
    name: `${prefixes.user}${user.name}`,
    groups: user.groups
      .map((group) => `${prefixes.groups}${group}`)
      .filter((group) => !group.startsWith('system:')),
  }
}

/** Why a person can't be impersonated, if they can't: names starting with system: are Kubernetes' own. */
export function refusal(
  user: SessionUser,
  prefixes: { user: string; groups: string },
): string | undefined {
  const name = `${prefixes.user}${user.name}`
  return name.startsWith('system:')
    ? `Lumovi doesn’t act as ${name}: names starting with system: are Kubernetes’ own.`
    : undefined
}

/** A kubeconfig's cluster entry for helm, as client-node keeps it. */
export function helmCluster(
  cluster: Cluster,
  server = cluster.server,
  tlsServerName = cluster.tlsServerName,
) {
  return {
    server,
    'certificate-authority': cluster.caFile,
    'certificate-authority-data': cluster.caData,
    'insecure-skip-tls-verify': cluster.skipTLSVerify || undefined,
    'tls-server-name': tlsServerName,
  }
}

/** A kubeconfig's user entry for helm: the person's token, or the server's own credentials. */
export function helmUser(identity: Identity, account: User, as: SessionUser | undefined) {
  const tokenFile = (account.authProvider?.config as { tokenFile?: string } | undefined)?.tokenFile
  const credentials = as
    ? {
        token: account.token,
        tokenFile,
        'client-certificate': account.certFile,
        'client-certificate-data': account.certData,
        'client-key': account.keyFile,
        'client-key-data': account.keyData,
      }
    : { token: identity.token }
  return { ...credentials, as: as?.name, 'as-groups': as?.groups }
}

export class HostedCluster implements Hosted {
  readonly fleet = false

  private constructor(
    /** The name pages use for it. */
    readonly name: string,
    /** Where its credentials came from, for the record. */
    readonly source: string,
    private readonly cluster: Cluster,
    /** The server's own credentials. */
    private readonly account: User,
    private readonly prefixes: { user: string; groups: string },
  ) {}

  /** The cluster the server runs in, or, given a KUBECONFIG, a context of it. */
  static fromEnvironment(
    env: NodeJS.ProcessEnv,
    settings: { name?: string; usernamePrefix: string; groupsPrefix: string },
  ): HostedCluster {
    const found = env.KUBECONFIG ? fromKubeconfig(env) : inCluster(env)
    return new HostedCluster(
      settings.name ?? found.name,
      found.source,
      found.cluster,
      found.account,
      { user: settings.usernamePrefix, groups: settings.groupsPrefix },
    )
  }

  get server(): string {
    return this.cluster.server
  }

  describe(): string {
    return `${this.name} (${this.server})`
  }

  /**
   * How someone's requests reach the cluster: with their token, or with the
   * server's credentials, as them. Impersonated names get the configured prefixes.
   */
  configsFor(identity: Identity): ClusterConfigs {
    const as = this.#as(identity)
    const contexts: ContextsResult = {
      source: this.source,
      currentContext: this.name,
      contexts: [
        {
          name: this.name,
          cluster: this.name,
          user: identity.user.name,
          server: this.server,
        },
      ],
    }
    const kc = new RequestsAs({ as, identity })
    kc.loadFromOptions({
      clusters: [{ ...this.cluster, name: this.name }],
      users: [as ? { ...this.account, name: 'user' } : { name: 'user' }],
      contexts: [{ name: this.name, cluster: this.name, user: 'user' }],
      currentContext: this.name,
    })
    return {
      load: () => contexts,
      forContext: (name) => {
        if (name !== this.name) {
          throw new KubeRequestError('invalid', `This server shows ${this.name}, not "${name}".`)
        }
        return kc
      },
    }
  }

  /** A kubeconfig for helm that acts as `identity`, as `configsFor` does. */
  async helmTarget(identity: Identity): Promise<{ kubeconfig: object; done(): void }> {
    return {
      kubeconfig: {
        apiVersion: 'v1',
        kind: 'Config',
        'current-context': this.name,
        clusters: [{ name: this.name, cluster: helmCluster(this.cluster) }],
        users: [{ name: 'user', user: helmUser(identity, this.account, this.#as(identity)) }],
        contexts: [{ name: this.name, context: { cluster: this.name, user: 'user' } }],
      },
      done: () => undefined,
    }
  }

  refuses(user: SessionUser): string | undefined {
    return refusal(user, this.prefixes)
  }

  close(): void {}

  /** Who to impersonate, for people without a token of their own. */
  #as(identity: Identity): SessionUser | undefined {
    return identity.token ? undefined : impersonated(identity.user, this.prefixes)
  }
}

export interface Found {
  /** What the cluster is called unless LUMOVI_CLUSTER_NAME says. */
  name: string
  source: string
  cluster: Cluster
  account: User
}

/** A kubeconfig's context: LUMOVI_CONTEXT, or its current one. */
function fromKubeconfig(env: NodeJS.ProcessEnv): Found {
  const kc = loadKubeConfig(kubeconfigPaths(env))
  const context = env.LUMOVI_CONTEXT || kc.getCurrentContext()
  const found = kc.getContextObject(context)
  const cluster = found && kc.getCluster(found.cluster)
  if (!found || !cluster) {
    throw new ConfigError(`The kubeconfig in KUBECONFIG has no context "${context}" to show.`)
  }
  return {
    name: context,
    source: `${env.KUBECONFIG} (${context})`,
    cluster,
    account: kc.getUser(found.user)!,
  }
}

/** The cluster the server runs in, with its pod's service account. */
export function inCluster(env: NodeJS.ProcessEnv): Found {
  const host = env.KUBERNETES_SERVICE_HOST
  if (!host) {
    throw new ConfigError(
      'Lumovi isn’t running in a cluster (KUBERNETES_SERVICE_HOST isn’t set). Set KUBECONFIG to show a cluster from a kubeconfig.',
    )
  }
  const dir = env.LUMOVI_SERVICE_ACCOUNT_DIR || SERVICE_ACCOUNT
  if (!existsSync(join(dir, 'token'))) {
    throw new ConfigError(
      `No service account token in ${dir}: Lumovi needs its pod’s (automountServiceAccountToken).`,
    )
  }
  return {
    name: 'in-cluster',
    source: dir,
    cluster: {
      name: 'in-cluster',
      server: format({ protocol: 'https:', hostname: host, port: env.KUBERNETES_SERVICE_PORT }),
      caFile: join(dir, 'ca.crt'),
      skipTLSVerify: false,
    },
    // Read again from time to time: Kubernetes rotates projected tokens.
    account: {
      name: 'lumovi',
      authProvider: { name: 'tokenFile', config: { tokenFile: join(dir, 'token') } },
    },
  }
}

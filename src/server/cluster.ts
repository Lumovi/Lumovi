/**
 * The one cluster a server shows, and how it's reached for each person: with
 * their own token, or with the server's credentials, impersonating them.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:url'
import https from 'node:https'
import { KubeConfig, type Cluster, type User } from '@kubernetes/client-node'
import type { ContextsResult } from '@shared/api'
import type { SessionUser } from '@shared/server'
import { KubeRequestError } from '@backend/kube/errors'
import { kubeconfigPaths, loadKubeConfig, type ClusterConfigs } from '@backend/kube/kubeconfig'
import { ConfigError } from './config'

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

/**
 * Sends the server's own credentials and acts as `as`: the API server checks
 * that the server may impersonate, then applies the user's RBAC.
 */
class Impersonating extends KubeConfig {
  constructor(private readonly as: SessionUser) {
    super()
  }

  override async applyToHTTPSOptions(options: https.RequestOptions): Promise<void> {
    await super.applyToHTTPSOptions(options)
    options.headers = {
      ...options.headers,
      'Impersonate-User': this.as.name,
      'Impersonate-Group': this.as.groups,
    }
  }
}

/**
 * Sends the person's own token, as it is when each request is made: one a
 * provider renews takes over at once, on every page.
 */
class Carrying extends KubeConfig {
  constructor(private readonly identity: Identity) {
    super()
  }

  override async applyToHTTPSOptions(options: https.RequestOptions): Promise<void> {
    await super.applyToHTTPSOptions(options)
    options.headers = { ...options.headers, Authorization: `Bearer ${this.identity.token}` }
  }
}

export class HostedCluster {
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

  /**
   * How someone's requests reach the cluster: with their token, or with the
   * server's credentials, as them. Impersonated names get the configured prefixes.
   */
  configsFor(identity: Identity): ClusterConfigs {
    const as = this.impersonated(identity)
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
    const kc = as ? new Impersonating(as) : new Carrying(identity)
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

  /**
   * A kubeconfig for helm that acts as `identity`, as `configsFor` does. Its
   * user's credentials are the person's token or the server's own.
   */
  helmKubeconfig(identity: Identity): object {
    const as = this.impersonated(identity)
    const account = this.account
    const tokenFile = (account.authProvider?.config as { tokenFile?: string } | undefined)
      ?.tokenFile
    const credentials = identity.token
      ? { token: identity.token }
      : {
          token: account.token,
          tokenFile,
          'client-certificate': account.certFile,
          'client-certificate-data': account.certData,
          'client-key': account.keyFile,
          'client-key-data': account.keyData,
        }
    return {
      apiVersion: 'v1',
      kind: 'Config',
      'current-context': this.name,
      clusters: [
        {
          name: this.name,
          cluster: {
            server: this.server,
            'certificate-authority': this.cluster.caFile,
            'certificate-authority-data': this.cluster.caData,
            'insecure-skip-tls-verify': this.cluster.skipTLSVerify || undefined,
            'tls-server-name': this.cluster.tlsServerName,
          },
        },
      ],
      users: [{ name: 'user', user: { ...credentials, as: as?.name, 'as-groups': as?.groups } }],
      contexts: [{ name: this.name, context: { cluster: this.name, user: 'user' } }],
    }
  }

  /**
   * Why the server won't act as someone, if it won't: never as one of
   * Kubernetes' own users (system:…), whatever a provider or proxy says.
   */
  refuses(user: SessionUser): string | undefined {
    const name = `${this.prefixes.user}${user.name}`
    if (name.startsWith('system:')) {
      return `KubeStacks doesn’t act as ${name}: names starting with system: are Kubernetes’ own.`
    }
    return undefined
  }

  /** Who to impersonate, for people without a token of their own; never in Kubernetes' own groups. */
  private impersonated(identity: Identity): SessionUser | undefined {
    if (identity.token) return undefined
    return {
      name: `${this.prefixes.user}${identity.user.name}`,
      groups: identity.user.groups
        .map((group) => `${this.prefixes.groups}${group}`)
        .filter((group) => !group.startsWith('system:')),
    }
  }
}

interface Found {
  /** What the cluster is called unless KUBESTACKS_CLUSTER_NAME says. */
  name: string
  source: string
  cluster: Cluster
  account: User
}

/** A kubeconfig's context: KUBESTACKS_CONTEXT, or its current one. */
function fromKubeconfig(env: NodeJS.ProcessEnv): Found {
  const kc = loadKubeConfig(kubeconfigPaths(env))
  const context = env.KUBESTACKS_CONTEXT || kc.getCurrentContext()
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
function inCluster(env: NodeJS.ProcessEnv): Found {
  const host = env.KUBERNETES_SERVICE_HOST
  if (!host) {
    throw new ConfigError(
      'KubeStacks isn’t running in a cluster (KUBERNETES_SERVICE_HOST isn’t set). Set KUBECONFIG to show a cluster from a kubeconfig.',
    )
  }
  const dir = env.KUBESTACKS_SERVICE_ACCOUNT_DIR || SERVICE_ACCOUNT
  if (!existsSync(join(dir, 'token'))) {
    throw new ConfigError(
      `No service account token in ${dir}: KubeStacks needs its pod’s (automountServiceAccountToken).`,
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
      name: 'kubestacks',
      authProvider: { name: 'tokenFile', config: { tokenFile: join(dir, 'token') } },
    },
  }
}

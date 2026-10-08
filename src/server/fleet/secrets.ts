/**
 * Clusters that Secrets of the cluster the server runs in describe, each
 * tool's way: Lumovi's own (a kubeconfig, labelled lumovi.dev/cluster),
 * Cluster API's (each cluster's <name>-kubeconfig) and Argo CD's (its cluster
 * Secrets). The server reads them with its own service account.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KubeConfig } from '@kubernetes/client-node'
import { kubeRequest } from '@backend/kube/client'
import { toKubeError } from '@backend/kube/errors'
import { inCluster } from '../cluster'
import { labels, type FleetConfig, type SecretSource } from '../config'
import { broken, described, kubeconfigClusters, settingsFrom, type FleetCluster } from './clusters'

interface Secret {
  metadata: {
    name: string
    namespace: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
  }
  type?: string
  data?: Record<string, string>
}

/** Argo CD's description of a cluster's credentials (its Secret's `config`). */
interface ArgoConfig {
  bearerToken?: string
  /** The proxy it's reached through (Argo CD's own setting). */
  proxyUrl?: string
  username?: string
  password?: string
  tlsClientConfig?: {
    insecure?: boolean
    serverName?: string
    caData?: string
    certData?: string
    keyData?: string
  }
  awsAuthConfig?: unknown
  execProviderConfig?: { command: string; args?: string[]; env?: Record<string, string> }
}

/** Which Secrets each source reads. */
const SELECTORS: Record<SecretSource, string> = {
  lumovi: 'lumovi.dev/cluster',
  'cluster-api': 'cluster.x-k8s.io/cluster-name',
  argocd: 'argocd.argoproj.io/secret-type=cluster',
}

/** What a Secret sets of a cluster's settings is set by it: said so on the Fleet page. */
const itsSecret = (secret: Secret) => `its Secret, ${secret.metadata.name}`

const READERS: Record<SecretSource, (secret: Secret, source: string) => FleetCluster[]> = {
  lumovi: (secret, source) => {
    const kubeconfig = decoded(secret, 'kubeconfig')
    return kubeconfig === undefined
      ? [broken(secret.metadata.name, source, 'It has no kubeconfig (data.kubeconfig).')]
      : kubeconfigClusters(kubeconfig, source, () => itsSecret(secret)).map((cluster) =>
          annotated(cluster, secret),
        )
  },
  // Cluster API labels every Secret of a cluster; its kubeconfig is <name>-kubeconfig, under value.
  'cluster-api': (secret, source) => {
    const kubeconfig = decoded(secret, 'value')
    if (!secret.metadata.name.endsWith('-kubeconfig') || kubeconfig === undefined) return []
    const [cluster] = kubeconfigClusters(kubeconfig, source, () => itsSecret(secret))
    return cluster
      ? [
          annotated(
            { ...cluster, name: secret.metadata.labels!['cluster.x-k8s.io/cluster-name']! },
            secret,
          ),
        ]
      : []
  },
  argocd: (secret, source) => {
    const name = decoded(secret, 'name')
    const server = decoded(secret, 'server')
    if (!name || !server) {
      return [broken(secret.metadata.name, source, 'It has no name or server.')]
    }
    const config = JSON.parse(decoded(secret, 'config') ?? '{}') as ArgoConfig
    if (config.awsAuthConfig) {
      return [
        broken(
          name,
          source,
          'Argo CD signs in to it with AWS (awsAuthConfig), which Lumovi can’t: give it a bearerToken.',
        ),
      ]
    }
    const tlsConfig = config.tlsClientConfig ?? {}
    // Its own labels are the cluster's, but for Argo CD's.
    const own = Object.entries(secret.metadata.labels!).filter(
      ([key]) => !key.startsWith('argocd.argoproj.io/'),
    )
    const exec = config.execProviderConfig
    const found = described(
      name,
      source,
      { labels: Object.fromEntries(own), forwardToken: false },
      {
        name,
        server,
        caData: tlsConfig.caData,
        skipTLSVerify: tlsConfig.insecure === true,
        tlsServerName: tlsConfig.serverName,
        proxyUrl: config.proxyUrl,
      },
      {
        name,
        token: config.bearerToken,
        username: config.username,
        password: config.password,
        certData: tlsConfig.certData,
        keyData: tlsConfig.keyData,
        exec: exec && {
          apiVersion: 'client.authentication.k8s.io/v1beta1',
          command: exec.command,
          args: exec.args,
          env: Object.entries(exec.env ?? {}).map(([key, value]) => ({ name: key, value })),
        },
      },
    )
    // Those labels are set by its Secret.
    const cluster = own.length
      ? { ...found, managed: { labels: { by: itsSecret(secret), key: 'metadata.labels' } } }
      : found
    return [annotated(cluster, secret)]
  },
}

/** A Secret's value, decoded. */
function decoded(secret: Secret, key: string): string | undefined {
  const value = secret.data?.[key]
  return value === undefined ? undefined : Buffer.from(value, 'base64').toString('utf8')
}

/**
 * A cluster with Lumovi's settings from its Secret's annotations
 * (lumovi.dev/labels, groups and forward-token): each one set wins over the
 * cluster's own. One that can't be reached at all stays as it is.
 */
function annotated(cluster: FleetCluster, secret: Secret): FleetCluster {
  if (!cluster.cluster) return cluster
  const annotations = secret.metadata.annotations ?? {}
  const groups = annotations['lumovi.dev/groups']
  const forward = annotations['lumovi.dev/forward-token']
  const settings = settingsFrom({
    labels: { ...cluster.labels, ...labels('lumovi.dev/labels', annotations['lumovi.dev/labels']) },
    groups: groups === undefined ? cluster.groups : groups.split(',').map((g) => g.trim()),
    forwardToken: forward === undefined ? cluster.forwardToken : forward === 'true',
  })
  // What its annotations set is its Secret's: its labels, with those it had (they're merged);
  // its groups, instead.
  const managed = { ...cluster.managed }
  for (const field of ['labels', 'groups'] as const) {
    const key = `lumovi.dev/${field}`
    if (annotations[key] === undefined) continue
    const had = field === 'labels' ? managed.labels : undefined
    managed[field] = { by: itsSecret(secret), key: had ? `${had.key} and ${key}` : key }
  }
  return {
    ...described(
      cluster.name,
      cluster.source,
      { ...settings, prefixes: cluster.prefixes },
      cluster.cluster,
      cluster.account,
    ),
    ...(Object.keys(managed).length ? { managed } : {}),
  }
}

/**
 * The clusters the configured Secrets describe, by the list they're in
 * (Secrets for argocd in argocd, say), and what couldn't be listed (said in
 * the log): a list that can't be read now is left out, so it keeps what it had.
 */
export async function secretClusters(
  env: NodeJS.ProcessEnv,
  config: FleetConfig,
): Promise<{ lists: Map<string, FleetCluster[]>; problems: string[] }> {
  const found = inCluster(env)
  const kc = new KubeConfig()
  kc.loadFromOptions({
    clusters: [found.cluster],
    users: [found.account],
    contexts: [{ name: 'in-cluster', cluster: found.cluster.name, user: found.account.name }],
    currentContext: 'in-cluster',
  })
  const namespaces = config.secretNamespaces ?? [
    readFileSync(join(found.source, 'namespace'), 'utf8').trim(),
  ]
  const lists = new Map<string, FleetCluster[]>()
  const problems: string[] = []
  for (const namespace of namespaces) {
    for (const kind of config.secrets) {
      const list = `Secrets for ${kind} in ${namespace}`
      let secrets: Secret[]
      try {
        const path = `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets?labelSelector=${encodeURIComponent(SELECTORS[kind])}`
        secrets = (
          JSON.parse(await kubeRequest(kc, path, { timeoutMs: 20_000 })) as { items: Secret[] }
        ).items
      } catch (error) {
        problems.push(`${list} can’t be listed: ${toKubeError(error).message}`)
        continue
      }
      const clusters: FleetCluster[] = []
      for (const secret of secrets) {
        const source = `Secret ${namespace}/${secret.metadata.name}`
        const origin = {
          kind: 'secret',
          tool: kind,
          secret: secret.metadata.name,
          namespace,
        } as const
        try {
          clusters.push(...READERS[kind](secret, source).map((cluster) => ({ ...cluster, origin })))
        } catch (error) {
          clusters.push({
            ...broken(secret.metadata.name, source, (error as Error).message),
            origin,
          })
        }
      }
      lists.set(list, clusters)
    }
  }
  return { lists, problems }
}

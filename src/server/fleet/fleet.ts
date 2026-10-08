/**
 * A fleet: many clusters, shown to everyone who signs in, each as their own
 * RBAC allows there. Clusters come from kubeconfigs (in a setting or files),
 * from Secrets of the cluster the server runs in, from agents that connect to
 * it, and from that cluster itself.
 */
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { KubeConfig } from '@kubernetes/client-node'
import type { ContextsResult, KubeErrorCode } from '@shared/api'
import type { SessionUser } from '@shared/server'
import { KubeRequestError } from '@backend/kube/errors'
import type { ClusterConfigs } from '@backend/kube/kubeconfig'
import {
  helmCluster,
  helmUser,
  impersonated,
  inCluster,
  refusal,
  RequestsAs,
  type Hosted,
  type Identity,
} from '../cluster'
import type { FleetConfig, ServerConfig } from '../config'
import { log } from '../log'
import { AGENT_SERVER, Agents } from './agents'
import { kubeconfigClusters, type FleetCluster } from './clusters'
import { secretClusters } from './secrets'

/** Why a cluster can't be used for someone: as a request's error. */
interface Problem {
  code: KubeErrorCode
  message: string
}

export class HostedFleet implements Hosted {
  readonly fleet = true
  readonly agents: Agents
  /**
   * Each source's clusters, as last read (a file, a list of Secrets…): one that fails to be
   * read again keeps them.
   */
  readonly #sources = new Map<string, FleetCluster[]>()
  #clusters: FleetCluster[] = []
  /** What was last said about each source's problems, so each is said once. */
  readonly #said = new Map<string, string>()
  readonly #timer: NodeJS.Timeout
  readonly #prefixes: { user: string; groups: string }

  private constructor(
    private readonly config: FleetConfig,
    private readonly env: NodeJS.ProcessEnv,
    settings: ServerConfig,
  ) {
    this.#prefixes = { user: settings.usernamePrefix, groups: settings.groupsPrefix }
    this.agents = new Agents(config.agents, settings.heartbeatSeconds, () => this.#merge())
    if (config.kubeconfig) {
      this.#sources.set(
        'LUMOVI_FLEET_KUBECONFIG',
        kubeconfigClusters(config.kubeconfig, 'LUMOVI_FLEET_KUBECONFIG'),
      )
    }
    if (config.local) {
      const found = inCluster(env)
      this.#sources.set('local', [
        {
          name: settings.clusterName ?? found.name,
          source: found.source,
          labels: settings.clusterLabels,
          forwardToken: false,
          cluster: found.cluster,
          account: found.account,
        },
      ])
    }
    this.#timer = setInterval(() => void this.#refresh(), config.refreshSeconds * 1000).unref()
  }

  /** A fleet, with every source read once. */
  static async start(
    config: FleetConfig,
    env: NodeJS.ProcessEnv,
    settings: ServerConfig,
  ): Promise<HostedFleet> {
    const fleet = new HostedFleet(config, env, settings)
    await fleet.#refresh()
    return fleet
  }

  hasCluster(name: string): boolean {
    return this.#clusters.some((cluster) => cluster.name === name)
  }

  describe(): string {
    const names = this.#clusters.map((c) => c.name)
    return `a fleet of ${names.length} ${names.length === 1 ? 'cluster' : 'clusters'} (${names.join(', ')})`
  }

  configsFor(identity: Identity): ClusterConfigs {
    const configs = new WeakMap<FleetCluster, KubeConfig>()
    // (One joined from the page, until its certificate authority is checked: nobody's yet.)
    const visible = () =>
      this.#clusters.filter(
        (c) =>
          !c.unchecked &&
          (!c.groups || c.groups.some((group) => identity.user.groups.includes(group))),
      )
    return {
      load: (): ContextsResult => ({
        source: 'this server’s fleet',
        contexts: visible().map((c) => ({
          name: c.name,
          cluster: c.name,
          user: identity.user.name,
          server: c.agent ? undefined : c.cluster?.server,
          labels: c.labels,
        })),
      }),
      forContext: (name) => {
        const cluster = visible().find((c) => c.name === name)
        if (!cluster) {
          throw new KubeRequestError(
            'not-found',
            `This server has no cluster called “${name}” that you can see.`,
          )
        }
        const problem = this.#problem(cluster, identity)
        if (problem) throw new KubeRequestError(problem.code, problem.message)
        let kc = configs.get(cluster)
        if (!kc) {
          kc = this.#configFor(cluster, identity)
          configs.set(cluster, kc)
        }
        return kc
      },
    }
  }

  async helmTarget(
    identity: Identity,
    context: string,
  ): Promise<{ kubeconfig: object; done(): void }> {
    // configsFor checked it's there, and can be used.
    const cluster = this.#clusters.find((c) => c.name === context)!
    const as = this.#as(cluster, identity)
    // An agent's cluster is reached through a port of the server's own, while helm runs.
    const loopback = cluster.agent ? await this.agents.loopback(cluster.agent) : undefined
    return {
      kubeconfig: {
        apiVersion: 'v1',
        kind: 'Config',
        'current-context': context,
        clusters: [
          {
            name: context,
            cluster: loopback
              ? helmCluster(
                  cluster.cluster!,
                  `https://127.0.0.1:${loopback.port}`,
                  new URL(AGENT_SERVER).hostname,
                )
              : helmCluster(cluster.cluster!),
          },
        ],
        users: [{ name: 'user', user: helmUser(identity, cluster.account!, as) }],
        contexts: [{ name: context, context: { cluster: context, user: 'user' } }],
      },
      done: () => loopback?.close(),
    }
  }

  refuses(user: SessionUser): string | undefined {
    return refusal(user, this.#prefixes)
  }

  close(): void {
    clearInterval(this.#timer)
    this.agents.close()
  }

  /** How someone's requests reach a cluster that can be used. */
  #configFor(cluster: FleetCluster, identity: Identity): KubeConfig {
    const as = this.#as(cluster, identity)
    const kc = new RequestsAs({
      as,
      identity,
      agent: cluster.agent ? this.agents.httpsAgent(cluster.agent) : undefined,
    })
    kc.loadFromOptions({
      clusters: [{ ...cluster.cluster!, name: cluster.name }],
      users: [as ? { ...cluster.account!, name: 'user' } : { name: 'user' }],
      contexts: [{ name: cluster.name, cluster: cluster.name, user: 'user' }],
      currentContext: cluster.name,
    })
    return kc
  }

  /** Who to impersonate on a cluster, unless requests carry the person's own token there. */
  #as(cluster: FleetCluster, identity: Identity): SessionUser | undefined {
    return cluster.forwardToken ? undefined : impersonated(identity.user, this.#prefixesOf(cluster))
  }

  /** The prefixes for impersonated names in a cluster: its own, or else the server's. */
  #prefixesOf(cluster: FleetCluster): { user: string; groups: string } {
    return { ...this.#prefixes, ...cluster.prefixes }
  }

  /** Why someone can't use a cluster now, if they can't. */
  #problem(cluster: FleetCluster, identity: Identity): Problem | undefined {
    if (cluster.problem) {
      const code =
        cluster.untrusted === 'first'
          ? 'untrusted-agent'
          : cluster.untrusted
            ? 'tls'
            : cluster.agent
              ? 'unreachable'
              : 'invalid'
      return { code, message: cluster.problem }
    }
    if (cluster.forwardToken) {
      return identity.token
        ? undefined
        : {
            code: 'auth',
            message:
              'It takes each person’s own token, and this server doesn’t pass tokens on: set LUMOVI_OIDC_FORWARD_TOKEN.',
          }
    }
    const refused = refusal(identity.user, this.#prefixesOf(cluster))
    return refused ? { code: 'forbidden', message: refused } : undefined
  }

  /** Reads the sources that change (files, Secrets) again, then merges. */
  async #refresh(): Promise<void> {
    for (const file of this.config.kubeconfigFiles) {
      this.#read(file, () => kubeconfigClusters(readFileSync(file, 'utf8'), file, dirname(file)))
    }
    if (this.config.secrets.length > 0) {
      const { lists, problems } = await secretClusters(this.env, this.config)
      for (const [list, clusters] of lists) this.#sources.set(list, clusters)
      this.#say('secrets', problems.join('\n'))
    }
    this.#merge()
  }

  /** Reads a source; one that can't be read keeps what it had, and says why (once). */
  #read(source: string, read: () => FleetCluster[]): void {
    try {
      this.#sources.set(source, read())
      this.#say(source, '')
    } catch (error) {
      this.#say(source, `${source} can’t be read: ${(error as Error).message}`)
    }
  }

  /** Logs what's wrong with a source (a line for each problem), when that changes. */
  #say(source: string, problem: string): void {
    if ((this.#said.get(source) ?? '') === problem) return
    this.#said.set(source, problem)
    for (const line of problem.split('\n').filter(Boolean)) log(`Fleet: ${line}`)
  }

  /** Every source's clusters together: the first of two by the same name stays. */
  #merge(): void {
    const merged: FleetCluster[] = []
    for (const cluster of [...[...this.#sources.values()].flat(), ...this.agents.clusters()]) {
      const first = merged.find((c) => c.name === cluster.name)
      if (first) {
        this.#say(
          `name ${cluster.name}`,
          `Two clusters are called ${cluster.name}: the one from ${cluster.source} is left out (the one from ${first.source} stays).`,
        )
        continue
      }
      merged.push(cluster)
    }
    const before = new Set(this.#clusters.map((c) => c.name))
    const after = new Set(merged.map((c) => c.name))
    for (const name of after) if (!before.has(name)) log(`Fleet: ${name} added`)
    for (const name of before) if (!after.has(name)) log(`Fleet: ${name} removed`)
    this.#clusters = merged
  }
}

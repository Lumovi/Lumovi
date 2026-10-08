/**
 * Clusters added from the Fleet page by kubeconfig or token, where the server allows it
 * (LUMOVI_FLEET_ADD_FROM_PAGE, the chart's fleet.addFromPage: off unless it's set). Each is
 * checked, then kept as one of Lumovi's own Secrets in its namespace (labelled
 * lumovi.dev/cluster), which the hub reads as it reads any such Secret; only then does the chart
 * let the hub write Secrets there, and nowhere else.
 *
 * A credential plugin (a kubeconfig user's exec, or its auth provider) is refused, not asked
 * about: the hub runs no programs. What it signs in with must be in the kubeconfig itself (no
 * files on someone's computer), and its server reached over https and checked against its
 * certificate authority (never "insecure").
 *
 * Admins only, and recorded. Removed from the page, the Secret Lumovi made is deleted (that one,
 * by its UID), never one it didn't make.
 */
import { X509Certificate } from 'node:crypto'
import { KubeConfig, type Cluster, type User } from '@kubernetes/client-node'
import type { AuditActor } from '@shared/audit'
import {
  clusterNameError,
  originKey,
  type FleetCheck,
  type FleetChecked,
  type FleetSetting,
} from '@shared/fleet'
import type { SessionUser } from '@shared/server'
import type { AuditLog } from '@backend/audit/log'
import { kubeRequest } from '@backend/kube/client'
import { KubeRequestError, toKubeError } from '@backend/kube/errors'
import { withProxy } from '@backend/network'
import type { ServerAccess } from '../access'
import type { Hosted } from '../cluster'
import type { ClusterSettings } from '../cluster-settings'
import { log } from '../log'
import type { ServerState } from '../state'
import { hubKubeConfig } from './secrets'
import { checkedGroups, checkedLabels } from './settings'

/** A cluster added from the page, as kept (by its name): the Secret Lumovi made for it. */
interface Kept {
  secret: string
  namespace: string
  /** The Secret's UID: only that one is deleted when it's removed. */
  uid: string
  server: string
  by: string
  at: string
}

/** How long each check waits for the cluster. */
const CHECK_MS = 10_000

const invalid = (message: string) => new KubeRequestError('invalid', message)

/** A kubeconfig's context, as a name the fleet takes (lowercase letters, digits and dashes). */
const nameFrom = (context: string) =>
  context
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '')

/** A cluster to add, read: its server and what it signs in with. */
interface Read {
  cluster: Cluster
  user: User
  /** Its kubeconfig's context's name (none, for a token). */
  context?: string
}

/** A host, as a check says it: the server's address without its scheme. */
const hostOf = (server: string) => URL.parse(server)?.host ?? server

/** Why a cluster to add can't be used from the hub, as checks: none, where it can. */
function signInProblems({ cluster, user }: Read): FleetCheck[] {
  const problems: FleetCheck[] = []
  const plugin =
    'This server can’t run programs, so it can’t use this kubeconfig. Use a token instead, such as a service account’s, or connect the cluster with an agent.'
  if (user.exec) {
    problems.push({
      result: 'bad',
      title: 'It signs in by running a program',
      detail: [user.exec.command, ...(user.exec.args ?? [])].join(' '),
      hint: plugin,
      plugin: true,
    })
  } else if (user.authProvider) {
    problems.push({
      result: 'bad',
      title: 'It signs in with a plugin',
      detail: user.authProvider.name,
      hint: plugin,
      plugin: true,
    })
  }
  const files = [
    ['certificate-authority', cluster.caFile],
    ['client-certificate', user.certFile],
    ['client-key', user.keyFile],
  ].flatMap(([key, file]) => (file ? [key!] : []))
  if (files.length) {
    problems.push({
      result: 'bad',
      title: 'It points at files on your computer',
      detail: files.join(', '),
      hint: 'Paste what’s in them into it instead: certificate-authority-data, client-certificate-data, client-key-data.',
    })
  }
  // (Files it points at, or a plugin, are what it signs in with: said already.)
  if (!problems.length) {
    const credentials =
      user.token || (user.certData && user.keyData) || (user.username && user.password)
    if (!credentials) {
      problems.push({
        result: 'bad',
        title: 'It has no credentials',
        hint: 'Give its user a token or a client certificate.',
      })
    }
  }
  if (!cluster.server.startsWith('https://')) {
    problems.push({
      result: 'bad',
      title: 'Its server isn’t https',
      detail: cluster.server,
      hint: 'Its credentials would cross the network as they are: give its https address.',
    })
  } else if (cluster.skipTLSVerify) {
    problems.push({
      result: 'bad',
      title: 'It doesn’t check the server’s certificate',
      hint: 'insecure-skip-tls-verify sends its credentials to whoever answers: give it the server’s certificate authority (certificate-authority-data) instead.',
    })
  }
  return problems
}

/** How often what's kept is read again (another replica may have added or removed one). */
const REFRESH_MS = 10_000

/** Where a namespace's Secrets are, in the API. */
const secretsPath = (namespace: string) =>
  `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`

export class AddedClusters {
  readonly #refresher?: NodeJS.Timeout

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    /** Whether the server allows it (LUMOVI_FLEET_ADD_FROM_PAGE). */
    private readonly enabled: boolean,
    /** Where they're kept: a namespace of their own (LUMOVI_FLEET_ADD_NAMESPACE). */
    private readonly namespace: string | undefined,
    private readonly state: ServerState,
    private readonly access: ServerAccess,
    private readonly audit: AuditLog,
    private readonly clusters: ClusterSettings,
    private readonly hosted: Hosted,
  ) {
    if (enabled && state.kept !== 'memory') {
      this.#refresher = setInterval(() => void this.#read(), REFRESH_MS)
      this.#refresher.unref()
    }
  }

  close(): void {
    clearInterval(this.#refresher)
  }

  /** Whether a Secret is one Lumovi made for a cluster added here: the hub reads those alone. */
  keeps(namespace: string, name: string, uid: string | undefined): boolean {
    return this.state
      .entries<Kept>('added')
      .some(([, kept]) => kept.namespace === namespace && kept.secret === name && kept.uid === uid)
  }

  async #read(): Promise<void> {
    if (this.state.kept !== 'memory') await this.state.refresh('added')
  }

  /** Why `user` may not add clusters here, or nothing when they may. */
  whyNot(user: SessionUser): string | undefined {
    if (!this.enabled) {
      return 'Adding clusters by kubeconfig or token is off on this server. It’s turned on with the Helm value fleet.addFromPage.'
    }
    if (!this.access.administered) {
      return 'Clusters are added on this page by Lumovi’s admins, and it has none: name them in LUMOVI_ADMINS (the chart’s access.admins).'
    }
    if (!this.access.isAdmin(user)) return 'Only Lumovi’s admins add clusters to the fleet.'
    if (this.state.kept === 'memory') {
      return 'This server keeps nothing when it restarts, so it would forget which clusters were added here: keep its state (the chart’s auth.keepSessions, or LUMOVI_DATA_DIR).'
    }
    return undefined
  }

  get on(): boolean {
    return this.enabled
  }

  /** The clusters added from the page. */
  names(): string[] {
    return this.state.entries<Kept>('added').map(([name]) => name)
  }

  has(name: string): boolean {
    return this.state.get<Kept>('added', name) !== undefined
  }

  /** When a cluster was added from the page, and by whom, if it was. */
  addedOf(name: string): { at: string; by: string } | undefined {
    const kept = this.state.get<Kept>('added', name)
    return kept && { at: kept.at, by: kept.by }
  }

  /** An admin's: a cluster to add, checked (nothing's kept). */
  async check(source: unknown, user: SessionUser): Promise<FleetChecked> {
    this.#allowed(user)
    return (await this.#check(source)).checked
  }

  /**
   * An admin's: a cluster added, checked again, then kept as Lumovi's Secret in its namespace,
   * with what the page sets for it (its labels and groups). Recorded.
   */
  async add(request: unknown, user: SessionUser, actor: AuditActor): Promise<void> {
    const why = this.whyNot(user)
    if (why) {
      this.audit.record({
        action: 'cluster.added',
        outcome: 'refused',
        actor,
        summary: 'Wasn’t let add a cluster to the fleet',
        error: why,
      })
      throw new KubeRequestError('not-allowed', why, 403)
    }
    const { name, labels, groups, source } = (request ?? {}) as Partial<Record<string, unknown>>
    if (typeof name !== 'string') throw invalid('Give the cluster a name.')
    const nameError = clusterNameError(name)
    if (nameError) throw invalid(`Its name: ${nameError}.`)
    const wanted = { labels: checkedLabels(labels ?? {}), groups: checkedGroups(groups ?? []) }
    if (this.hosted.hasCluster?.(name) || this.has(name)) {
      throw invalid(`The fleet has a cluster called ${name} already: give this one another name.`)
    }
    const { checked, read } = await this.#check(source)
    if (!checked.passed || !read) {
      const failed = checked.checks.find((check) => check.result === 'bad')
      throw invalid(`It can’t be added: ${failed?.title ?? 'it wasn’t checked'}.`)
    }
    const namespace = this.namespace!
    const secret = `lumovi-cluster-${name}`
    const { cluster, user: credentials } = read
    const kubeconfig = {
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [
        {
          name,
          cluster: {
            server: cluster.server,
            'certificate-authority-data': cluster.caData,
            ...(cluster.tlsServerName ? { 'tls-server-name': cluster.tlsServerName } : {}),
            ...(cluster.proxyUrl ? { 'proxy-url': cluster.proxyUrl } : {}),
          },
        },
      ],
      users: [
        {
          name,
          user: credentials.token
            ? { token: credentials.token }
            : credentials.certData
              ? {
                  'client-certificate-data': credentials.certData,
                  'client-key-data': credentials.keyData,
                }
              : { username: credentials.username, password: credentials.password },
        },
      ],
      contexts: [{ name, context: { cluster: name, user: name } }],
      'current-context': name,
    }
    let uid: string
    try {
      const made = JSON.parse(
        await kubeRequest(hubKubeConfig(this.env), secretsPath(namespace), {
          method: 'POST',
          body: {
            apiVersion: 'v1',
            kind: 'Secret',
            metadata: {
              name: secret,
              namespace,
              labels: { 'lumovi.dev/cluster': '', 'app.kubernetes.io/managed-by': 'lumovi' },
            },
            type: 'Opaque',
            data: { kubeconfig: Buffer.from(JSON.stringify(kubeconfig)).toString('base64') },
          },
          timeoutMs: CHECK_MS,
        }),
      ) as { metadata: { uid: string } }
      uid = made.metadata.uid
    } catch (error) {
      const failed = toKubeError(error)
      if (failed.code === 'conflict') {
        await this.#read()
        throw invalid(
          this.has(name)
            ? `${name} was added meanwhile, from another of Lumovi’s replicas: it’s in the fleet.`
            : `A Secret called ${secret} is in the ${namespace} namespace already: Lumovi doesn’t replace one it didn’t make.`,
        )
      }
      if (failed.code === 'not-found') {
        throw invalid(
          `The namespace ${namespace}, where the clusters added here are kept, doesn’t exist: the chart makes it (fleet.createAddNamespace), or make it.`,
        )
      }
      throw new KubeRequestError(failed.code, `Its Secret couldn’t be made: ${failed.message}`)
    }
    const at = new Date().toISOString()
    this.state.set('added', name, {
      secret,
      namespace,
      uid,
      server: cluster.server,
      by: user.name,
      at,
    })
    try {
      await this.state.flush({ strict: true })
    } catch (error) {
      // Not kept: its Secret goes too, or it'd be a cluster the page couldn't remove.
      this.state.delete('added', name)
      await kubeRequest(
        hubKubeConfig(this.env),
        `${secretsPath(namespace)}/${encodeURIComponent(secret)}`,
        { method: 'DELETE', body: { preconditions: { uid } }, timeoutMs: CHECK_MS },
      ).catch(() => undefined)
      throw new KubeRequestError(
        'server',
        `It couldn’t be kept, so its Secret was deleted again: ${(error as Error).message}`,
      )
    }
    // What the page sets for it is the page's, for this cluster (as any page setting is).
    const setting: FleetSetting = {
      origin: originKey({
        kind: 'secret',
        tool: 'lumovi',
        secret,
        namespace,
        server: cluster.server,
      }),
      ...(Object.keys(wanted.labels).length ? { labels: wanted.labels } : {}),
      ...(wanted.groups.length ? { groups: wanted.groups } : {}),
    }
    if (setting.labels || setting.groups) this.clusters.setFleet(name, setting, user)
    await this.hosted.reread?.()
    this.audit.record({
      action: 'cluster.added',
      outcome: 'success',
      actor,
      cluster: name,
      summary: `Added ${name} to the fleet, kept as the Secret ${namespace}/${secret}`,
      details: {
        server: hostOf(cluster.server),
        secret: `${namespace}/${secret}`,
        labels: Object.entries(wanted.labels).map(([key, value]) => `${key}=${value}`),
        groups: wanted.groups,
      },
    })
    log(`${user.name} added ${name} to the fleet (the Secret ${namespace}/${secret})`)
  }

  /**
   * An admin's: a cluster added from the page, removed: the Secret Lumovi made for it deleted
   * (that one, by its UID: one made again since isn't Lumovi's to delete). Recorded.
   */
  async remove(name: string, user: SessionUser, actor: AuditActor): Promise<void> {
    this.#allowed(user)
    const kept = this.state.get<Kept>('added', name)
    if (!kept) throw new KubeRequestError('not-found', `No cluster called ${name} was added here.`)
    const path = `/api/v1/namespaces/${encodeURIComponent(kept.namespace)}/secrets/${encodeURIComponent(kept.secret)}`
    try {
      await kubeRequest(hubKubeConfig(this.env), path, {
        method: 'DELETE',
        body: { preconditions: { uid: kept.uid } },
        timeoutMs: CHECK_MS,
      })
    } catch (error) {
      const failed = toKubeError(error)
      if (failed.code === 'conflict') {
        // Made again by someone else: theirs, and the cluster's no longer Lumovi's to remove.
        this.state.delete('added', name)
        await this.state.flush({ strict: true })
        this.audit.record({
          action: 'cluster.removed',
          outcome: 'refused',
          actor,
          cluster: name,
          summary: `Didn’t remove ${name}: its Secret was made again, not by Lumovi`,
          details: { secret: `${kept.namespace}/${kept.secret}` },
        })
        throw invalid(
          `The Secret ${kept.namespace}/${kept.secret} was made again since Lumovi made it: it’s left as it is, and no longer Lumovi’s to remove.`,
        )
      }
      // (Gone already: it's removed.)
      if (failed.code !== 'not-found') {
        throw new KubeRequestError(failed.code, `Its Secret couldn’t be deleted: ${failed.message}`)
      }
    }
    this.state.delete('added', name)
    await this.state.flush({ strict: true })
    await this.hosted.reread?.()
    this.audit.record({
      action: 'cluster.removed',
      outcome: 'success',
      actor,
      cluster: name,
      summary: `Removed ${name} from the fleet: Lumovi deleted the Secret it kept it as`,
      details: { secret: `${kept.namespace}/${kept.secret}` },
    })
  }

  #allowed(user: SessionUser): void {
    const why = this.whyNot(user)
    if (why) throw new KubeRequestError('not-allowed', why, 403)
  }

  /** A cluster to add, read and checked: each check, in order, and what was read. */
  async #check(source: unknown): Promise<{ checked: FleetChecked; read?: Read }> {
    const checks: FleetCheck[] = []
    const done = (read?: Read): { checked: FleetChecked; read?: Read } => ({
      checked: {
        checks,
        passed: checks.length > 0 && checks.every((check) => check.result !== 'bad'),
        ...(read?.context ? { name: nameFrom(read.context) } : {}),
      },
      ...(read ? { read } : {}),
    })
    const given = (source ?? {}) as Partial<Record<string, unknown>>
    let read: Read
    if (typeof given.kubeconfig === 'string') {
      const kc = new KubeConfig()
      try {
        kc.loadFromString(given.kubeconfig)
      } catch (error) {
        // Only the reason: the parser quotes the lines around it, credentials and all.
        checks.push({
          result: 'bad',
          title: 'It doesn’t read as a kubeconfig',
          detail: (error as Error).message.split('\n')[0],
        })
        return done()
      }
      if (kc.contexts.length !== 1) {
        checks.push({
          result: 'bad',
          title: kc.contexts.length ? `It has ${kc.contexts.length} contexts` : 'It has no context',
          hint: 'Paste one: Lumovi adds a cluster at a time.',
        })
        return done()
      }
      const context = kc.contexts[0]!
      const cluster = kc.getCluster(context.cluster)
      const user = kc.getUser(context.user)
      if (!cluster || !user) {
        checks.push({
          result: 'bad',
          title: `Its context names a ${cluster ? 'user' : 'cluster'} it doesn’t have`,
          detail: context.name,
        })
        return done()
      }
      checks.push({
        result: 'ok',
        title: 'It reads as a kubeconfig',
        detail: `${context.name} · user ${context.user}`,
      })
      read = { cluster, user, context: context.name }
    } else if (
      typeof given.server === 'string' &&
      typeof given.token === 'string' &&
      typeof given.ca === 'string'
    ) {
      const server = given.server.trim().replace(/\/+$/, '')
      const token = given.token.trim()
      if (!URL.canParse(server) || !/^https?:\/\//.test(server)) {
        checks.push({
          result: 'bad',
          title: 'Its server isn’t an address',
          detail: server,
          hint: 'Its API server’s address, like https://10.0.0.1:6443.',
        })
        return done()
      }
      if (!token || /\s/.test(token)) {
        checks.push({ result: 'bad', title: 'Its token isn’t one', hint: 'Paste the token alone.' })
        return done()
      }
      let ca: string
      try {
        ca = new X509Certificate(given.ca.trim()).toString()
      } catch {
        checks.push({
          result: 'bad',
          title: 'Its CA isn’t a certificate',
          hint: 'The certificate authority its server presents, as PEM (-----BEGIN CERTIFICATE-----).',
        })
        return done()
      }
      checks.push({ result: 'ok', title: 'Its server, token and CA read', detail: hostOf(server) })
      read = {
        cluster: {
          name: 'cluster',
          server,
          caData: Buffer.from(ca).toString('base64'),
          skipTLSVerify: false,
        },
        user: { name: 'user', token },
      }
    } else {
      throw invalid('Give a kubeconfig, or a server, a token and its CA.')
    }
    // A proxy it's reached through: shown, as it's kept (its server is still checked against its CA).
    if (read.cluster.proxyUrl) {
      checks.push({
        result: 'warn',
        title: 'It’s reached through a proxy',
        // Where, never who it signs in to it as.
        detail: URL.parse(read.cluster.proxyUrl)?.host ?? 'its proxy-url',
        hint: 'Its server is still checked against its certificate authority, so the proxy sees only where it connects.',
      })
    }
    const problems = signInProblems(read)
    if (problems.length) {
      checks.push(...problems)
      return done(read)
    }
    const kc = new KubeConfig()
    kc.loadFromOptions({
      clusters: [{ ...withProxy(read.cluster, this.env), name: 'cluster' }],
      users: [{ ...read.user, name: 'user' }],
      contexts: [{ name: 'it', cluster: 'cluster', user: 'user' }],
      currentContext: 'it',
    })
    const started = Date.now()
    let refused: string | undefined
    try {
      const version = JSON.parse(await kubeRequest(kc, '/version', { timeoutMs: CHECK_MS })) as {
        gitVersion?: string
      }
      checks.push({
        result: 'ok',
        title: 'The server answers',
        detail: `${hostOf(read.cluster.server)} · ${version.gitVersion ?? 'Kubernetes'} · ${Date.now() - started} ms`,
      })
    } catch (error) {
      const failed = toKubeError(error)
      // It answered, but not to these credentials.
      if (failed.code === 'unauthorized' || failed.code === 'forbidden') {
        checks.push({
          result: 'ok',
          title: 'The server answers',
          detail: hostOf(read.cluster.server),
        })
        refused = failed.message
      } else {
        checks.push({ result: 'bad', title: 'The server doesn’t answer', detail: failed.message })
        return done(read)
      }
    }
    let username: string | undefined
    try {
      if (refused) throw new KubeRequestError('unauthorized', refused)
      const review = JSON.parse(
        await kubeRequest(kc, '/apis/authentication.k8s.io/v1/selfsubjectreviews', {
          method: 'POST',
          body: { apiVersion: 'authentication.k8s.io/v1', kind: 'SelfSubjectReview' },
          timeoutMs: CHECK_MS,
        }),
      ) as { status?: { userInfo?: { username?: string } } }
      username = review.status?.userInfo?.username
    } catch (error) {
      const failed = toKubeError(error)
      if (failed.code === 'unauthorized') {
        checks.push({ result: 'bad', title: 'The credentials don’t work', detail: failed.message })
        return done(read)
      }
      // (A cluster too old to say who it is.)
    }
    const may = async (verb: string, resource: string, group?: string) => {
      const review = JSON.parse(
        await kubeRequest(kc, '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
          method: 'POST',
          body: {
            apiVersion: 'authorization.k8s.io/v1',
            kind: 'SelfSubjectAccessReview',
            spec: {
              resourceAttributes: { verb, resource, ...(group === undefined ? {} : { group }) },
            },
          },
          timeoutMs: CHECK_MS,
        }),
      ) as { status?: { allowed?: boolean } }
      return review.status?.allowed === true
    }
    const who = username ?? 'its user'
    const impersonates = await (async () => {
      try {
        return (await may('impersonate', 'users')) && (await may('impersonate', 'groups'))
      } catch {
        return false
      }
    })()
    // More than it needs (anything at all, as cluster-admin may): said, not refused.
    const everything =
      impersonates &&
      (await (async () => {
        try {
          return await may('*', '*', '*')
        } catch {
          return false
        }
      })())
    checks.push(
      impersonates
        ? {
            result: 'ok',
            title: 'The credentials work',
            detail: `Signed in as ${who} · may act as each person`,
          }
        : {
            result: 'bad',
            title: 'It can’t act as each person',
            detail: `Signed in as ${who}`,
            hint: `Lumovi acts as whoever signs in, so their own access applies: give ${who} a ClusterRole that may impersonate users and groups, as Lumovi’s chart gives its own.`,
          },
    )
    if (everything) {
      checks.push({
        result: 'warn',
        title: 'It may do anything there, not only act as each person',
        hint: 'Lumovi needs only that, and keeps the credentials: a service account that may only impersonate users and groups is safer.',
      })
    }
    return done(read)
  }
}

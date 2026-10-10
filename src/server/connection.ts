/**
 * A page's connection to the server: one WebSocket, over which it calls the
 * same handlers the desktop app answers over IPC, as whoever is signed in.
 * Shells and log streams belong to the page, and end with its connection.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RawData, WebSocket } from 'ws'
import {
  IPC,
  type AppInfo,
  type KubeError,
  type MetricsSourceSetting,
  type NodeShellSetting,
  type Result,
  type Settings,
} from '@shared/api'
import type { ClientMessage, ServerMessage, SessionUser } from '@shared/server'
import type { AuditActor } from '@shared/audit'
import { auditHandlers } from '@backend/audit/handlers'
import type { AuditLog } from '@backend/audit/log'
import { recorder } from '@backend/audit/recorder'
import { handlers, type Handler } from '@backend/handlers'
import { MetricsStackService } from '@backend/helm/metrics-stack'
import { HelmService } from '@backend/helm/service'
import { LogStreams } from '@backend/kube/logs'
import { KubeRequestError } from '@backend/kube/errors'
import type { ClusterConfigs } from '@backend/kube/kubeconfig'
import { KubeService } from '@backend/kube/service'
import { clusterSummary } from '@backend/kube/summary'
import { Terminals } from '@backend/kube/streams'
import { UsageHistory } from '@backend/kube/usage'
import type { SettingsAccess } from '@backend/settings'
import type { SponsorSource } from '@backend/sponsor/source'
import { accessHandlers, type ServerAccess } from './access'
import { readerFor } from './audit'
import type { Hosted, Identity } from './cluster'
import { fingerprint, type ServerConfig } from './config'
import { readOnlyWhy, type ClusterSettings } from './cluster-settings'
import type { Joins } from './fleet/joins'
import type { FleetSettings } from './fleet/settings'
import type { AddedClusters } from './fleet/added'
import { checkChartUrl } from './network'

/**
 * A page's preferences: the server's, the same for everyone on it (its clusters' settings, which
 * Lumovi's admins change, or anyone where there are none), over its defaults, LUMOVI_READ_ONLY
 * and LUMOVI_NODE_SHELL. Changed as the page's person.
 */
class PagePreferences implements SettingsAccess {
  constructor(
    private readonly readOnlyAll: boolean,
    private readonly defaultSource: MetricsSourceSetting,
    private readonly nodeShells: ServerConfig['nodeShell'],
    private readonly clusters: ClusterSettings,
    private readonly user: SessionUser,
    /** The clusters the server shows: only theirs are set (what's kept is kept small). */
    private readonly configs: ClusterConfigs,
  ) {}

  get(): Settings {
    const readOnlyBy = this.clusters.readOnlyBy()
    const mayChange = !this.clusters.whyNot(this.user)
    // For those who may set it: what's to look at, changed outside Lumovi.
    const outside = mayChange ? this.clusters.changedOutside() : {}
    return {
      // The browser keeps the theme itself.
      theme: 'system',
      readOnly: Object.keys(readOnlyBy),
      readOnlyBy,
      metricsSource: this.clusters.metricsSources(),
      nodeShell: this.clusters.nodeShells(),
      nodeShellDefault: this.nodeShells.setting,
      shared: { mayChange },
      ...(Object.keys(outside).length ? { changedOutside: outside } : {}),
      ...(this.readOnlyAll ? { readOnlyAll: true } : {}),
      ...(this.nodeShells.off ? { nodeShellsOff: true } : {}),
    }
  }

  nodeShell(context: string): NodeShellSetting | null {
    return this.nodeShells.off
      ? null
      : (this.clusters.nodeShells()[context] ?? this.nodeShells.setting)
  }

  setNodeShell(context: string, setting: NodeShellSetting | null): Settings {
    this.#known(context)
    this.clusters.setNodeShell(context, setting, this.user)
    return this.get()
  }

  isReadOnly(context: string): boolean {
    return this.readOnlyAll || this.clusters.isReadOnly(context)
  }

  /** Whether changes to `context` are refused, and why where it's the server's setting. */
  readOnly(context: string): boolean | string {
    return this.readOnlyAll || readOnlyWhy(this.clusters.readOnly(context), context) || false
  }

  setReadOnly(context: string, readOnly: boolean): Settings {
    this.#known(context)
    this.clusters.setReadOnly(context, readOnly, this.user)
    return this.get()
  }

  /** Refuses a cluster the server doesn't show this person. */
  #known(context: string): void {
    if (!this.configs.load().contexts.some((c) => c.name === context)) {
      throw new KubeRequestError(
        'not-found',
        `This server has no cluster called “${context}” that you can see.`,
      )
    }
  }

  metricsSource(context: string): MetricsSourceSetting {
    return this.clusters.metricsSources()[context] ?? this.defaultSource
  }

  setMetricsSource(context: string, setting: MetricsSourceSetting): Settings {
    // Kept even when it's detection: the server's default may be a service.
    this.#known(context)
    this.clusters.setMetricsSource(context, setting, this.user)
    return this.get()
  }
}

export interface ConnectionOptions {
  hosted: Hosted
  config: ServerConfig
  identity: Identity
  version: string
  env: NodeJS.ProcessEnv
  /** The audit log; who the page's person is to it (and where from); whether they read everyone's. */
  audit: AuditLog
  actor: AuditActor
  /** Whether they read everyone's events (asked each time: their access can change). */
  auditor: () => boolean
  /** Who may do what: Lumovi's services ask before they act as the page's person. */
  access: ServerAccess
  /** The clusters' settings, everyone's on this server. */
  clusters: ClusterSettings
  /** A fleet's: the clusters its admins connect from the Fleet page. */
  joins?: Joins
  /** A fleet's: its clusters' names, labels and groups, as its admins set them on its page. */
  fleetSettings?: FleetSettings
  /** A fleet's: the clusters its admins add by kubeconfig or token, where it allows it. */
  added?: AddedClusters
  /**
   * Called when the cluster refuses the person's own token: it expired, or was revoked. (In a
   * fleet, one cluster refusing it is that cluster's error.)
   */
  rejected: () => void
  /** The sidebar's sponsor card, the same for every page. */
  sponsor: SponsorSource
  /** The person's AI assistants: their changes, shown on this page, and its calls about them. */
  assistants: {
    invoke: Record<string, Handler>
    detach(): void
  }
}

/** Whether an answer is the cluster refusing the credentials (401). */
const isRejection = (value: unknown) =>
  (value as Result<unknown> | undefined)?.ok === false &&
  (value as { error: KubeError }).error.code === 'unauthorized'

/** What a message from a page must look like; anything else ends the connection. */
function isMessage(value: unknown): value is ClientMessage {
  const message = value as Partial<{ type: unknown; id: unknown; channel: unknown; args: unknown }>
  if (typeof message !== 'object' || message === null) return false
  return (
    (message.type === 'send' || (message.type === 'invoke' && Number.isInteger(message.id))) &&
    typeof message.channel === 'string' &&
    Array.isArray(message.args)
  )
}

export class PageConnection {
  /** Once its page has gone and what it started is cleaned up (node shells' pods deleted). */
  readonly ended: Promise<void>
  readonly #invoke: Record<string, Handler>
  readonly #send: Record<string, Handler>
  readonly #rejected: () => void

  constructor(
    private readonly socket: WebSocket,
    {
      hosted,
      config,
      identity,
      version,
      env,
      rejected,
      assistants,
      audit,
      actor,
      auditor,
      access,
      clusters,
      joins,
      fleetSettings,
      added,
      sponsor,
    }: ConnectionOptions,
  ) {
    const recording = recorder(audit, () => actor)
    // Only a token of the person's own can be refused for them: the server's are its problem.
    this.#rejected = identity.token && !hosted.fleet ? rejected : () => undefined
    const configs = hosted.configsFor(identity)
    const preferences = new PagePreferences(
      ['1', 'true'].includes(env.LUMOVI_READ_ONLY ?? ''),
      config.metricsSource,
      config.nodeShell,
      clusters,
      identity.user,
      configs,
    )
    const isReadOnly = (context: string) => preferences.readOnly(context)
    const ready = Promise.resolve()
    // What the person may do: asked with namespaces' labels as they may read them.
    const guard = access.guard(identity.user, new KubeService(configs, ready, isReadOnly))
    const kube = new KubeService(configs, ready, isReadOnly, env, guard)
    const helm = new HelmService(kube, {
      envReady: ready,
      isReadOnly,
      guard,
      localCharts: false,
      checkUrl: config.allowPrivateCharts ? undefined : checkChartUrl,
      // A kubeconfig of its own for each run, acting as this person, removed after.
      target: async (context) => {
        configs.forContext(context)
        const target = await hosted.helmTarget(identity, context)
        const dir = await mkdtemp(join(tmpdir(), 'lumovi-helm-'))
        const kubeconfig = join(dir, 'kubeconfig')
        await writeFile(kubeconfig, JSON.stringify(target.kubeconfig), { mode: 0o600 })
        return {
          args: ['--kube-context', context],
          env: { KUBECONFIG: kubeconfig },
          done: async () => {
            target.done()
            await rm(dir, { recursive: true, force: true })
          },
        }
      },
    })
    const deps = { store: configs, envReady: ready, isReadOnly, audit: recording, guard }
    const terminals = new Terminals(
      {
        ...deps,
        nodeShell: (context) => preferences.nodeShell(context),
        timeoutMs: kube.timeoutMs,
      },
      {
        data: (id, data) => this.emit(IPC.terminalData, id, data),
        exit: (id, exit) => this.emit(IPC.terminalExit, id, exit),
      },
    )
    const logs = new LogStreams(
      { ...deps, timeoutMs: kube.timeoutMs },
      {
        lines: (id, lines) => this.emit(IPC.logsLines, id, lines),
        end: (id, error) => this.emit(IPC.logsEnd, id, error),
      },
    )
    // Lumovi's metrics stack makes cluster roles, and is everyone's once it's there: its admins'
    // to install and remove, and nobody's where it names none (as connecting clusters is).
    const metricsStack = new MetricsStackService(kube, helm, {
      isReadOnly,
      chartFile: env.LUMOVI_TEST_STACK_CHART,
      off: () => {
        if (!config.metricsStack) {
          return {
            reason: 'policy',
            message:
              'Installing a metrics stack is turned off on this Lumovi server (LUMOVI_METRICS_STACK=off).',
          }
        }
        if (!access.administered) {
          return {
            reason: 'admins',
            message:
              'Lumovi’s admins install or remove its metrics stack, and this server names none. Whoever runs it sets them with LUMOVI_ADMINS (the chart’s access.admins).',
          }
        }
        return access.isAdmin(identity.user)
          ? undefined
          : {
              reason: 'admins',
              message: 'Only Lumovi’s admins install or remove its metrics stack. Ask one of them.',
            }
      },
    })
    const shared = handlers({
      kube,
      helm,
      metricsStack,
      usage: new UsageHistory(kube, (context) => preferences.metricsSource(context)),
      settings: preferences,
      terminals,
      logs,
      viewsDirectory: { path: config.viewsDir, shown: config.viewsDir },
      audit: recording,
    })
    const auditing = auditHandlers(
      audit,
      {
        get everyone() {
          return auditor()
        },
        may: (event) => readerFor(auditor(), identity.user)(event),
      },
      (channel, ...args) => this.emit(channel, ...args),
    )
    const accessing = accessHandlers(
      access,
      identity.user,
      actor,
      audit,
      auditor,
      (channel, ...args) => this.emit(channel, ...args),
    )
    const info: AppInfo = {
      name: 'Lumovi',
      version,
      platform: process.platform,
      node: process.versions.node,
    }
    this.#invoke = {
      ...shared.invoke,
      ...auditing.invoke,
      ...accessing.invoke,
      ...assistants.invoke,
      [IPC.appInfo]: () => info,
      [IPC.sponsorCard]: () => sponsor.card(),
      // A fleet's page sums each cluster up; and an admin trusts an agent again, whose cluster's
      // certificate authority changed.
      ...(hosted.fleet
        ? {
            [IPC.fleetSummary]: (context: unknown) => clusterSummary(kube, context as string),
            // An admin's: the agents, as sent and trusted; and one trusted with what it sends now,
            // as the SHA-256 they give (from its cluster) says.
            // (Where Lumovi has no admins, anyone signed in, as for the clusters' settings.)
            [IPC.fleetAgents]: () => {
              if (access.administered && !access.isAdmin(identity.user)) {
                throw new KubeRequestError('not-allowed', 'Only Lumovi’s admins see its agents.')
              }
              return hosted.agents?.status() ?? []
            },
            [IPC.fleetTrustAgent]: (name: unknown, given: unknown) => {
              if (typeof name !== 'string' || !hosted.agents) {
                throw new Error('Expected an agent’s name')
              }
              if (access.administered && !access.isAdmin(identity.user)) {
                throw new KubeRequestError('not-allowed', 'Only Lumovi’s admins trust an agent.')
              }
              const sha256 = fingerprint(given)
              if (!sha256) {
                throw new KubeRequestError(
                  'invalid',
                  'Give the SHA-256 of its cluster’s certificate authority, as openssl x509 -noout -fingerprint -sha256 prints it.',
                )
              }
              hosted.agents.trust(name, sha256, actor)
            },
            // An admin's (Lumovi must have some): the clusters they connect, each with a join
            // token for its agent, shown once.
            [IPC.fleetJoins]: () => ({
              ...joins!.list(identity.user),
              addFromPage: added?.on ?? false,
              ...(added?.where ? { addNamespace: added.where } : {}),
              added: added?.names() ?? [],
            }),
            [IPC.fleetConnect]: (request: unknown) => joins!.create(request, identity.user, actor),
            [IPC.fleetCancelJoin]: (name: unknown) => joins!.cancel(name, identity.user, actor),
            [IPC.fleetRemove]: (name: unknown) =>
              typeof name === 'string' && added?.has(name)
                ? added.remove(name, identity.user, actor)
                : joins!.remove(name, identity.user, actor),
            // Where the server allows it: clusters added by kubeconfig or token.
            [IPC.fleetCheck]: (source: unknown) => added!.check(source, identity.user),
            [IPC.fleetAdd]: (request: unknown) => added!.add(request, identity.user, actor),
            // An admin's (Lumovi must have some): a cluster's settings, each with where it's set,
            // and what the page sets of them.
            [IPC.fleetSettings]: (name: unknown) => fleetSettings!.get(name, identity.user),
            [IPC.fleetSaveSettings]: (name: unknown, setting: unknown) =>
              fleetSettings!.save(name, setting, identity.user, actor),
          }
        : {}),
    }
    this.#send = shared.send
    socket.on('message', (data) => void this.#receive(data))
    // Someone changed the clusters' settings (here, or on another replica): the page reads them again.
    const unlisten = clusters.onChange(() => this.emit(IPC.settingsChanged))
    const unsponsor = sponsor.onChange((card) => this.emit(IPC.sponsorChanged, card))
    this.ended = new Promise((resolve) => {
      socket.on('close', () => {
        unlisten()
        unsponsor()
        auditing.stop()
        accessing.stop()
        assistants.detach()
        logs.stopAll()
        void terminals.closeAll().then(resolve)
      })
    })
  }

  async #receive(data: RawData): Promise<void> {
    let message: unknown
    try {
      message = JSON.parse(String(data))
    } catch {
      message = undefined
    }
    if (!isMessage(message)) {
      this.socket.close(1008, 'Not a Lumovi message')
      return
    }
    // JSON has no undefined: arguments left out arrive as null.
    const args = message.args.map((arg) => arg ?? undefined)
    // Only the handlers' own channels: never what every object has (toString, say).
    const { channel } = message
    if (message.type === 'send') {
      if (Object.hasOwn(this.#send, channel)) this.#send[channel]!(...args)
    } else {
      let reply: ServerMessage
      try {
        if (!Object.hasOwn(this.#invoke, channel)) throw new Error(`There’s no ${channel} to call`)
        const value = await this.#invoke[channel]!(...args)
        if (isRejection(value)) this.#rejected()
        reply = { type: 'result', id: message.id, value }
      } catch (error) {
        reply = { type: 'result', id: message.id, error: (error as Error).message }
      }
      this.#write(reply)
    }
  }

  /** Tells the page of something (its shells' output, its person's assistants' changes). */
  emit(channel: string, ...args: unknown[]): void {
    this.#write({ type: 'event', channel, args })
  }

  #write(message: ServerMessage): void {
    // A page that went away isn't told any more.
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(message))
  }
}

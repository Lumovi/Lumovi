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
import type { ClientMessage, PageSettings, ServerMessage } from '@shared/server'
import { handlers, type Handler } from '@backend/handlers'
import { HelmService } from '@backend/helm/service'
import { LogStreams } from '@backend/kube/logs'
import { KubeService } from '@backend/kube/service'
import { clusterSummary } from '@backend/kube/summary'
import { Terminals } from '@backend/kube/streams'
import { UsageHistory } from '@backend/kube/usage'
import { isMetricsSourceSetting, isNodeShellSetting, type SettingsAccess } from '@backend/settings'
import type { Hosted, Identity } from './cluster'
import type { ServerConfig } from './config'
import { checkChartUrl } from './network'

/**
 * A page's preferences: its browser's, over the server's defaults,
 * LUMOVI_READ_ONLY and LUMOVI_NODE_SHELL.
 */
class PagePreferences implements SettingsAccess {
  #readOnly: string[] = []
  #metricsSource: Record<string, MetricsSourceSetting> = {}
  #nodeShell: Record<string, NodeShellSetting> = {}

  constructor(
    private readonly readOnlyAll: boolean,
    private readonly defaultSource: MetricsSourceSetting,
    private readonly nodeShells: ServerConfig['nodeShell'],
  ) {}

  /** The browser's, as it sent them; anything that doesn't make sense is left out. */
  replace(settings: PageSettings): void {
    const { readOnly, metricsSource, nodeShell } = settings
    this.#readOnly = Array.isArray(readOnly)
      ? readOnly.filter((name) => typeof name === 'string')
      : []
    this.#metricsSource = Object.fromEntries(
      Object.entries(metricsSource ?? {}).filter(([, setting]) => isMetricsSourceSetting(setting)),
    )
    this.#nodeShell = Object.fromEntries(
      Object.entries(nodeShell ?? {}).filter(([, setting]) => isNodeShellSetting(setting)),
    )
  }

  get(): Settings {
    return {
      // The browser keeps the theme itself.
      theme: 'system',
      readOnly: this.#readOnly,
      metricsSource: this.#metricsSource,
      nodeShell: this.#nodeShell,
      nodeShellDefault: this.nodeShells.setting,
      ...(this.readOnlyAll ? { readOnlyAll: true } : {}),
      ...(this.nodeShells.off ? { nodeShellsOff: true } : {}),
    }
  }

  nodeShell(context: string): NodeShellSetting | null {
    return this.nodeShells.off ? null : (this.#nodeShell[context] ?? this.nodeShells.setting)
  }

  setNodeShell(context: string, setting: NodeShellSetting | null): Settings {
    const { [context]: _previous, ...others } = this.#nodeShell
    this.#nodeShell = setting ? { ...others, [context]: setting } : others
    return this.get()
  }

  isReadOnly(context: string): boolean {
    return this.readOnlyAll || this.#readOnly.includes(context)
  }

  setReadOnly(context: string, readOnly: boolean): Settings {
    const others = this.#readOnly.filter((name) => name !== context)
    this.#readOnly = readOnly ? [...others, context] : others
    return this.get()
  }

  metricsSource(context: string): MetricsSourceSetting {
    return this.#metricsSource[context] ?? this.defaultSource
  }

  setMetricsSource(context: string, setting: MetricsSourceSetting): Settings {
    // Kept even when it's detection: the server's default may be a service.
    this.#metricsSource = { ...this.#metricsSource, [context]: setting }
    return this.get()
  }
}

export interface ConnectionOptions {
  hosted: Hosted
  config: ServerConfig
  identity: Identity
  version: string
  env: NodeJS.ProcessEnv
  /**
   * Called when the cluster refuses the person's own token: it expired, or was revoked. (In a
   * fleet, one cluster refusing it is that cluster's error.)
   */
  rejected: () => void
  /** The person's AI assistants: their changes, shown on this page, and its calls about them. */
  assistants: { invoke: Record<string, Handler>; detach(): void }
}

/** Whether an answer is the cluster refusing the credentials (401). */
const isRejection = (value: unknown) =>
  (value as Result<unknown> | undefined)?.ok === false &&
  (value as { error: KubeError }).error.code === 'unauthorized'

/** What a message from a page must look like; anything else ends the connection. */
function isMessage(value: unknown): value is ClientMessage {
  const message = value as Partial<{
    type: unknown
    id: unknown
    channel: unknown
    args: unknown
    settings: unknown
  }>
  if (typeof message !== 'object' || message === null) return false
  if (message.type === 'settings')
    return typeof message.settings === 'object' && message.settings !== null
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
  readonly #preferences: PagePreferences
  readonly #rejected: () => void

  constructor(
    private readonly socket: WebSocket,
    { hosted, config, identity, version, env, rejected, assistants }: ConnectionOptions,
  ) {
    // Only a token of the person's own can be refused for them: the server's are its problem.
    this.#rejected = identity.token && !hosted.fleet ? rejected : () => undefined
    const configs = hosted.configsFor(identity)
    const preferences = new PagePreferences(
      ['1', 'true'].includes(env.LUMOVI_READ_ONLY ?? ''),
      config.metricsSource,
      config.nodeShell,
    )
    const isReadOnly = (context: string) => preferences.isReadOnly(context)
    const ready = Promise.resolve()
    const kube = new KubeService(configs, ready, isReadOnly)
    const helm = new HelmService(kube, {
      envReady: ready,
      isReadOnly,
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
    const deps = { store: configs, envReady: ready, isReadOnly }
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
    const shared = handlers({
      kube,
      helm,
      usage: new UsageHistory(kube, (context) => preferences.metricsSource(context)),
      settings: preferences,
      terminals,
      logs,
      viewsDirectory: { path: config.viewsDir, shown: config.viewsDir },
    })
    const info: AppInfo = {
      name: 'Lumovi',
      version,
      platform: process.platform,
      node: process.versions.node,
    }
    this.#invoke = {
      ...shared.invoke,
      ...assistants.invoke,
      [IPC.appInfo]: () => info,
      // A fleet's page sums each cluster up.
      ...(hosted.fleet
        ? { [IPC.fleetSummary]: (context: unknown) => clusterSummary(kube, context as string) }
        : {}),
    }
    this.#send = shared.send
    this.#preferences = preferences
    socket.on('message', (data) => void this.#receive(data))
    this.ended = new Promise((resolve) => {
      socket.on('close', () => {
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
    if (message.type === 'settings') {
      this.#preferences.replace(message.settings)
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

/**
 * A page's connection to the server: one WebSocket, over which it calls the
 * same handlers the desktop app answers over IPC, as whoever is signed in.
 * Shells and log streams belong to the page, and end with its connection.
 */
import { randomUUID } from 'node:crypto'
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
import { browserOf, type BoxCheckControl } from '@shared/box-check'
import { PATHS, type ClientMessage, type ServerMessage, type SessionUser } from '@shared/server'
import type { AuditActor } from '@shared/audit'
import { auditHandlers } from '@backend/audit/handlers'
import type { AuditLog } from '@backend/audit/log'
import { recorder, type Recorder } from '@backend/audit/recorder'
import { pluginHistory } from '@backend/plugin-history'
import { handlers, type Handler } from '@backend/handlers'
import { MetricsStackService } from '@backend/helm/metrics-stack'
import { plugins } from '@backend/plugins-known'
import { HelmService } from '@backend/helm/service'
import { LogStreams } from '@backend/kube/logs'
import { ListWatches, MOST_WATCHED, WatchAllowance } from '@backend/kube/watches'
import { FileCopies, fileCopyLimits } from '@backend/kube/files'
import { KubeRequestError, toKubeError } from '@backend/kube/errors'
import type { ClusterConfigs } from '@backend/kube/kubeconfig'
import { KubeService } from '@backend/kube/service'
import { clusterSummary } from '@backend/kube/summary'
import { Terminals } from '@backend/kube/streams'
import { UsageHistory } from '@backend/kube/usage'
import type { SettingsAccess } from '@backend/settings'
import type { SponsorSource } from '@backend/sponsor/source'
import { accessHandlers, type ServerAccess } from './access'
import { checkCode, type BoxChecks, type Judged } from './box-check'
import { readerFor } from './audit'
import type { Hosted, Identity } from './cluster'
import { fingerprint, type ServerConfig } from './config'
import { PageFiles, type Transfers } from './file-transfers'
import { readOnlyWhy, type ClusterSettings } from './cluster-settings'
import type { Joins } from './fleet/joins'
import type { FleetSettings } from './fleet/settings'
import type { AddedClusters } from './fleet/added'
import type { ServerRepositories } from './helm-repositories'
import type { PeopleMarks } from './marks'
import type { PeoplePreferences } from './preferences'
import { checkChartUrl, fetchChart } from './network'
import { ChartRepositories, recordOf } from '@backend/helm/repositories'
import { log } from './log'
import type { PluginCodeStore } from './plugin-code'

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
    /** Each person's choices of whose plugins' code runs, and the plugins whose code the server lets run. */
    private readonly code: { store: PluginCodeStore; only?: string[] },
    /** The person's own settings (Settings), kept for them. */
    private readonly own: ReturnType<PeoplePreferences['of']>,
  ) {}

  /** Changes the person's own settings (refused where whoever runs the server set them). */
  setPreferences(patch: unknown): Promise<void> {
    return this.own.set(patch)
  }

  get(): Settings {
    const readOnlyBy = this.clusters.readOnlyBy()
    const mayChange = !this.clusters.whyNot(this.user)
    // For those who may set it: what's to look at, changed outside Lumovi.
    const outside = mayChange ? this.clusters.changedOutside() : {}
    // (Its choices of plugins' code, where it made any: as the desktop app says them.)
    const chosen = this.code.store.get(this.user.name)
    const own = this.own.settings()
    return {
      // The person's, where they chose one here; else the browser's own, which it keeps.
      theme: own.theme ?? 'system',
      ...(own.preferences ? { preferences: own.preferences } : {}),
      ...(own.locked ? { locked: own.locked } : {}),
      readOnly: Object.keys(readOnlyBy),
      readOnlyBy,
      metricsSource: this.clusters.metricsSources(),
      nodeShell: this.clusters.nodeShells(),
      nodeShellDefault: this.nodeShells.setting,
      shared: { mayChange },
      ...(Object.keys(outside).length ? { changedOutside: outside } : {}),
      ...(this.readOnlyAll ? { readOnlyAll: true } : {}),
      ...(this.nodeShells.off ? { nodeShellsOff: true } : {}),
      ...(Object.keys(chosen).length ? { pluginCode: { ...chosen } } : {}),
      ...(this.code.only ? { pluginCodeOnServer: [...this.code.only] } : {}),
    }
  }

  pluginCode(): Readonly<Record<string, boolean>> {
    return this.code.store.get(this.user.name)
  }

  async setPluginCode(plugin: string, on: boolean): Promise<Settings> {
    // (Off on the server, for everyone or for this plugin: nothing on a page turns it on.)
    if (on && this.code.only && !this.code.only.includes(plugin)) {
      throw new Error(
        this.code.only.length === 0
          ? 'This server doesn’t run plugins’ code.'
          : 'This server doesn’t run this plugin’s code.',
      )
    }
    await this.code.store.set(this.user.name, plugin, on)
    return this.get()
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
  /** Whether the second wall holds for this page's session: what a plugin's hand-over asks. */
  held: boolean
  /** Its session, where it has one (a sign-in proxy's has none). */
  session?: string
  /** Lumovi's checks of the box in people's browsers: none where the server has no box. */
  checks?: BoxChecks
  /** The browser, as it says of itself: what a check's line and record name it by. */
  userAgent?: string
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
  /** Everyone's pins and saved views: the page's person's are theirs alone. */
  marks?: PeopleMarks
  /** The chart repositories its admins added, and what's read of them: everyone's. */
  repositories: ServerRepositories
  /** Everyone's own settings (Settings): the page's person's are theirs alone. */
  preferences: PeoplePreferences
  /** Each person's choices of whose plugins' code runs. */
  pluginCode: PluginCodeStore
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
  /** Why the server takes no more work, once it doesn't (asked for every message). */
  refusing?: () => string | undefined
  /** Where the browser fetches files copied out of containers, and sends those copied in. */
  transfers: Transfers
  /** The person's AI assistants: their changes, shown on this page, and its calls about them. */
  assistants: {
    invoke: Record<string, Handler>
    detach(): void
  }
}

/** Where a check couldn't look, by the names a person knows: "Cache Storage, IndexedDB or …". */
const UNLOOKED_NAMES: Readonly<Record<string, string>> = {
  caches: 'Cache Storage',
  'indexed-db': 'IndexedDB',
  'broadcast-channel': 'broadcast channels',
}
function unlookedWords(unlooked: readonly string[]): string {
  const names = Object.keys(UNLOOKED_NAMES)
    .filter((look) => unlooked.includes(look))
    .map((look) => UNLOOKED_NAMES[look]!)
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0]!
}

/**
 * How the check's own request didn't arrive, as it's said: as a request (in either shape of one),
 * as a socket, or neither. (Which shape is in the history's entry.)
 */
function unreachedWords(unreached: readonly BoxCheckControl[]): string {
  const socket = unreached.includes('socket')
  const http = unreached.some((shape) => shape !== 'socket')
  return http && socket ? 'either way' : http ? 'over HTTP' : 'as a WebSocket'
}

/**
 * A check of a browser's box, said once a session: on the server's log (a failure, with the
 * browser and the ways that got out; one that didn't finish), and in the history (a failure, and
 * a pass, which every later hand-over rests on). Never its nonce. `under` is where the check's
 * catcher is, as whoever runs Lumovi would name it to what stands in front of it.
 */
function told(judged: Judged, audit: Recorder, browser: string, under: string): void {
  // Its own request didn't arrive: it can't be judged, whatever the boxes said, and whoever runs
  // Lumovi is told what must be passed on.
  if (judged.result === 'unfinished' && judged.unreached.length > 0) {
    const how = unreachedWords(judged.unreached)
    log(
      `Lumovi’s check of a plugin’s box in ${browser} couldn’t be judged: its own request didn’t arrive ${how}. What’s in front of Lumovi must pass everything under ${under} on, as it passes the rest.`,
    )
    audit.record({
      action: 'plugin.box-check',
      outcome: 'failure',
      target: { kind: 'Browser', name: browser },
      summary: 'Lumovi couldn’t check this browser: its own request didn’t reach the server',
      error: `The check’s own request didn’t reach the server (${how}).`,
      details: { browser, unreached: judged.unreached },
    })
    return
  }
  // Couldn't look: unfinished, and in the history with where (it stays so in this browser), by
  // the names a person knows them by.
  if (judged.result === 'unfinished' && judged.unlooked.length > 0) {
    const where = unlookedWords(judged.unlooked)
    log(
      `Lumovi couldn’t check ${browser}: it can’t look in this browser’s ${where}. This browser isn’t handed any plugin’s code.`,
    )
    audit.record({
      action: 'plugin.box-check',
      outcome: 'failure',
      target: { kind: 'Browser', name: browser },
      summary: `Lumovi couldn’t check this browser: it can’t look in its ${where}`,
      details: { browser, unlooked: judged.unlooked },
    })
    return
  }
  if (judged.result === 'unfinished') {
    log(`Lumovi’s check of a plugin’s box in ${browser} didn’t finish in time.`)
    return
  }
  // Failed on a report it couldn't read: nothing is known to have got out, and nothing says so.
  if (judged.result === 'failed' && judged.out.length === 0) {
    log(
      `Lumovi’s check of ${browser} failed: a box’s report came back in a form Lumovi couldn’t read. This browser isn’t handed any plugin’s code.`,
    )
    audit.record({
      action: 'plugin.box-check',
      outcome: 'failure',
      target: { kind: 'Browser', name: browser },
      summary:
        'Lumovi’s check of this browser failed: a box’s report came back in a form it couldn’t read',
      // (A failure with nothing out is always one it couldn't read: it says whose.)
      details: { browser, unreadable: judged.unreadable! },
    })
    return
  }
  if (judged.result === 'failed') {
    log(
      `Lumovi’s check found that ${browser} lets a plugin’s code out of its box: ${judged.out.join(', ')}. This browser isn’t handed any plugin’s code.`,
    )
  }
  audit.record({
    action: 'plugin.box-check',
    outcome: judged.result === 'passed' ? 'success' : 'failure',
    target: { kind: 'Browser', name: browser },
    summary:
      judged.result === 'passed'
        ? 'Lumovi checked this browser: a plugin’s code stays in its box'
        : `Lumovi’s check found this browser lets a plugin’s code out: ${judged.out.join(', ')}`,
    details: { browser, ...(judged.result === 'failed' ? { ways: judged.out } : {}) },
  })
}

/**
 * Whether an answer is the cluster refusing the credentials (401). (Not every answer that isn't
 * one is a cluster's error: a plugin's read is refused with a code of its own.)
 */
const isRejection = (value: unknown) =>
  (value as Result<unknown> | undefined)?.ok === false &&
  (value as { error?: KubeError }).error?.code === 'unauthorized'

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
  readonly #refusing: () => string | undefined

  constructor(
    private readonly socket: WebSocket,
    {
      hosted,
      config,
      identity,
      held,
      session,
      checks,
      userAgent,
      version,
      env,
      rejected,
      assistants,
      audit,
      actor,
      auditor,
      access,
      clusters,
      marks,
      repositories,
      preferences: people,
      joins,
      fleetSettings,
      added,
      sponsor,
      transfers,
      pluginCode,
      refusing = () => undefined,
    }: ConnectionOptions,
  ) {
    this.#refusing = refusing
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
      { store: pluginCode, ...(config.pluginCode ? { only: config.pluginCode } : {}) },
      people.of(identity.user),
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
      repositories: new ChartRepositories({
        keeper: repositories,
        reads: repositories.reads,
        checkUrl: config.allowPrivateCharts ? undefined : checkChartUrl,
        ...(config.allowPrivateCharts ? {} : { fetch: fetchChart }),
        person: {
          // Only its admins: and where it names none, nobody.
          mayChange: () => access.administered && access.isAdmin(identity.user),
          admins: () => access.mine(identity.user).admins,
          record: (change) => recording.record(recordOf(change)),
        },
      }),
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
    // The plugins this server has, as its backend reads them: read each time they're asked.
    const knownPlugins = () =>
      plugins({ path: config.pluginsDir, shown: config.pluginsDir }, 'server', version)
    const deps = {
      store: configs,
      envReady: ready,
      isReadOnly,
      audit: recording,
      guard,
      // (Which plugin a link that brought the person came from, for the history: the backend's own.)
      plugin: async (name: string) => (await knownPlugins()).find((each) => each.name === name),
    }
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
    // The lists the page shows, watched as its person: it's told when one changed.
    const watches = new ListWatches(
      kube,
      {
        changed: (id) => this.emit(IPC.watchChanged, id),
        ended: (id, error) => this.emit(IPC.watchEnded, id, error),
      },
      allowanceOf(identity.user.name, env),
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
    // Files copied out of containers are the browser's downloads, and those copied in its
    // uploads: for this page's person only.
    const pageFiles = new PageFiles(transfers, identity.user.name)
    const files = new FileCopies(deps, fileCopyLimits(env), pageFiles, {
      progress: (id, progress) => this.emit(IPC.filesProgress, id, progress),
      end: (id, end) => this.emit(IPC.filesEnd, id, end),
    })
    pageFiles.cancel = (id) => files.cancel(id)
    /**
     * What a check of this browser is kept by: its session, which is one browser's. A sign-in
     * proxy's page has none, and its person may use more than one browser: there, this page's
     * own, so each page checks its browser, and its result goes with the page.
     */
    const checkKey = session ?? `page:${randomUUID()}`
    // A check that fails after it was judged ends what this page shows of plugins' code.
    const unwatch = checks?.watch(checkKey, () => this.emit(IPC.boxCheckFailed))
    // What plugins' pages add to the history, counted for this page: said when it goes.
    const pluginsListed = pluginHistory(recording)
    const shared = handlers({
      kube,
      helm,
      metricsStack,
      usage: new UsageHistory(kube, (context) => preferences.metricsSource(context)),
      settings: preferences,
      terminals,
      logs,
      watches,
      files,
      pluginsDirectory: { path: config.pluginsDir, shown: config.pluginsDir },
      knownPlugins,
      // (Read each time it's asked: how this browser's box check came out, for the box's walls as
      // they are. A server without a box has no check, and hands code to no one.)
      handOverTo: () => ({
        host: 'server',
        // Off on the server, for everyone or for some; and this person's own.
        switches: {
          ...(config.pluginCode ? { serverOnly: config.pluginCode } : {}),
          chosen: pluginCode.get(identity.user.name),
        },
        held,
        check: checks?.result(checkKey),
        unlooked: checks?.unlooked(checkKey) ?? false,
        unreached: checks?.unreached(checkKey) ?? false,
      }),
      audit: recording,
      pluginHistory: pluginsListed,
      // (Only of a cluster the server shows this person: another's name is no key of theirs.)
      marks: marks?.of(identity.user, (context) => {
        if (!configs.load().contexts.some((c) => c.name === context)) {
          throw new KubeRequestError(
            'not-found',
            `This server has no cluster called “${context}” that you can see.`,
          )
        }
      }),
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
      ...(checks && config.publicUrl
        ? (() => {
            const catcher = new URL(`${config.basePath}${PATHS.boxCheck}`, config.publicUrl).href
            const under = `${config.basePath}${PATHS.boxCheck}/`
            const browser = browserOf(userAgent)
            return {
              // A check of this browser's box: its nonce, and its code with the nonce in its aim.
              // Only for a session the second wall holds: no code is handed to any other.
              [IPC.boxCheckStart]: () => {
                if (!held) return undefined
                const { nonce, control } = checks.start(checkKey)
                return {
                  nonce,
                  code: checkCode(`${catcher}/${nonce}`, nonce, env),
                  // (What this page hands the check's own sealed frame to ask: the same catcher,
                  // with a nonce no box is told.)
                  control: `${catcher}/${control}`,
                }
              },
              [IPC.boxCheckEnd]: (
                nonce: unknown,
                reports: unknown,
                heard: unknown,
                unlooked: unknown,
              ) => {
                if (typeof nonce !== 'string') return undefined
                const ways = (said: unknown) =>
                  Array.isArray(said)
                    ? said.filter((way): way is string => typeof way === 'string')
                    : []
                const judged = checks.end(
                  checkKey,
                  nonce,
                  reports,
                  ways(heard),
                  ways(unlooked),
                  (late) => told(late, recording, browser, under),
                )
                if (judged?.first) told(judged, recording, browser, under)
                return judged?.result
              },
            }
          })()
        : {}),
      [IPC.appInfo]: () => info,
      // The person's own settings: kept for them, on whatever device they sign in from.
      [IPC.setPreferences]: async (patch: unknown) => {
        try {
          await preferences.setPreferences(patch)
          return { ok: true, data: preferences.get() }
        } catch (error) {
          return { ok: false, error: { code: 'invalid', message: (error as Error).message } }
        }
      },
      [IPC.sponsorCard]: () => sponsor.card(),
      // What's uploaded was picked in the browser: the page says what it will send, and that's
      // checked and held for the copy it's for, and no longer: one that's refused holds nothing.
      [IPC.filesUpload]: async (id: unknown, request: unknown, sent: unknown) => {
        let handle: string | undefined
        try {
          handle = pageFiles.picked(sent)
          return await files.upload(id, { ...Object(request), source: handle })
        } catch (error) {
          return { ok: false, error: toKubeError(error) }
        } finally {
          if (handle) pageFiles.forget(handle)
        }
      },
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
        unwatch?.()
        pluginsListed.stop()
        // (A page's own check goes with it; a session's is kept for its other pages.)
        if (!session) checks?.forget(checkKey)
        auditing.stop()
        accessing.stop()
        assistants.detach()
        logs.stopAll()
        watches.stopAll()
        void files.cancelAll()
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
    // A server that takes no more work (it's stopping for having lost its audit history) says
    // so to whatever is still asked of it, and does none of it.
    const refused = this.#refusing()
    if (refused) {
      if (message.type !== 'send') this.#write({ type: 'result', id: message.id, error: refused })
      return
    }
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

/** Each person's watches, on every page of theirs together (`LUMOVI_WATCHES_PER_PERSON`). */
const allowances = new Map<string, WatchAllowance>()

function allowanceOf(person: string, env: NodeJS.ProcessEnv): WatchAllowance {
  let allowance = allowances.get(person)
  if (!allowance) {
    const most = Number(env.LUMOVI_WATCHES_PER_PERSON)
    allowance = new WatchAllowance(Number.isInteger(most) && most > 0 ? most : MOST_WATCHED)
    allowances.set(person, allowance)
  }
  return allowance
}

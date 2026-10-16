/**
 * What the page can ask for wherever Lumovi runs, by channel: the desktop
 * app answers these over IPC, the server over each page's WebSocket. Each adds
 * its own on top (windows, files and updates on the desktop; who is signed in
 * on the server).
 */
import {
  IPC,
  type ChangeRequest,
  type CertificateSummary,
  type CertificatesQuery,
  type GetQuery,
  type KubeList,
  type ListQuery,
  type SecretValues,
  type SecretValuesQuery,
  type HelmDeploy,
  type HelmRollback,
  type HelmUninstall,
  type KubeObject,
  type MetricsStackRequest,
  type Result,
  type Settings,
} from '@shared/api'
import { marksProblem, type Marks } from '@shared/marks'
import type { Installed } from '@shared/plugin-store'
import type { KnownPlugin } from '@shared/plugins-known'
import {
  describeChange,
  describeDeploy,
  describeRollback,
  describeStackInstall,
  describeStackUninstall,
  describeUninstall,
  isRefusal,
  malformed,
  outcomeOf,
} from './audit/describe'
import type { Recorded, Recorder } from './audit/recorder'
import type { MetricsStackService } from './helm/metrics-stack'
import type { HelmService } from './helm/service'
import type { LogStreams } from './kube/logs'
import type { ListWatches } from './kube/watches'
import { KubeRequestError } from './kube/errors'
import type { FileCopies } from './kube/files'
import type { KubeService } from './kube/service'
import type { Terminals } from './kube/streams'
import type { UsageHistory } from './kube/usage'
import { isMetricsSourceSetting, isNodeShellSetting, type SettingsAccess } from './settings'
import { readPlugins } from './plugins'
import { pluginChanges } from './plugin-changes'
import { pluginCodes, type HandOverTo } from './plugin-code'
import { PLUGIN_NAME } from '@shared/plugins'
import { pluginHistory, type PluginHistory } from './plugin-history'
import { pluginEvents } from './plugin-events'
import { pluginLogs } from './plugin-logs'
import { pluginServer } from './plugin-server'
import { pluginReads, secretsAskedFor } from './plugin-reads'

/** Answers a call from the page. Its arguments come from the page, so they're checked. */
export type Handler = (...args: unknown[]) => unknown

/**
 * Where a person's pins and saved views are kept, as the backend is given it: a server's, for
 * each signed-in person, in its sealed state (src/server/marks.ts). The desktop keeps them in the
 * page's own settings, and gives the backend none.
 */
export interface MarksAccess {
  /** This person's in a cluster: none yet is nothing. */
  get(context: string): Marks
  /** Keeps them as given, or says why not in Lumovi's words (past the server's budget). */
  set(context: string, marks: Marks): string | undefined
}

export interface Backend {
  kube: KubeService
  helm: HelmService
  metricsStack: MetricsStackService
  usage: UsageHistory
  settings: SettingsAccess
  terminals: Terminals
  logs: LogStreams
  watches: ListWatches
  files: FileCopies
  /** Where the plugins of one's own are, and how that folder is shown. */
  pluginsDirectory: { path: string; shown: string }
  /** The plugins in use, as the backend reads them now (`plugins` in `./plugins-known`). */
  knownPlugins: () => Promise<readonly Readonly<KnownPlugin>[]>
  /** Where the page is, for the hand-over: a desktop window, or a server's browser and its walls. */
  handOverTo: () => HandOverTo
  /** The audit log, as the page's person records to it. */
  audit: Recorder
  /**
   * What plugins' pages add to it, under their ceiling: made by whoever stops it, so that what
   * wasn't listed is said as Lumovi stops or the page's connection ends.
   */
  pluginHistory?: PluginHistory
  /** A server's: where the page's person's pins and saved views are kept. */
  marks?: MarksAccess
  /** The desktop app's: the plugins installed from Lumovi-plugins, as they're read now. */
  installedPlugins?: () => Promise<Installed>
}

export interface Handlers {
  /** Calls the page waits for an answer to. */
  invoke: Record<string, Handler>
  /** One-way messages, for keystrokes that shouldn't wait for an answer. */
  send: Record<string, Handler>
}

export function handlers({
  kube,
  helm,
  metricsStack,
  usage,
  settings,
  terminals,
  logs,
  watches,
  files,
  pluginsDirectory,
  knownPlugins,
  handOverTo,
  audit,
  pluginHistory: listed = pluginHistory(audit),
  marks,
  installedPlugins,
}: Backend): Handlers {
  /** Recorded once it's done, as it came out: but not what was only tried (a dry run). */
  const recorded =
    <R, T>(
      run: (request: R) => Promise<Result<T>>,
      describe: (request: R, result: Result<T>) => ReturnType<typeof describeChange>,
    ) =>
    async (request: unknown): Promise<Result<T>> => {
      const result = await run(request as R)
      if (!malformed(result) && (request as { dryRun?: unknown }).dryRun !== true) {
        audit.record(describe(request as R, result))
      }
      return result
    }
  /**
   * A Secret that went to the page (its values, unless the person's access shows only its
   * keys), or that it was refused: who read which, a while at a time.
   */
  const secretRead = (q: GetQuery, result: Result<KubeObject | null>) => {
    const object = result.ok ? result.data : undefined
    const kept = object && Object.keys(Object((object as { data?: object }).data))
    audit.read(`secret:${q.context}/${q.namespace}/${q.name}:${result.ok}`, {
      action: 'secret.read',
      ...outcomeOf(result),
      cluster: q.context,
      target: {
        kind: 'Secret',
        name: q.name,
        namespace: q.namespace,
        ...(object ? { uid: object.metadata.uid } : {}),
      },
      summary: `Read Secret ${q.name}`,
      ...(kept ? { details: { keys: kept } } : {}),
    })
  }
  /**
   * What a Secret's certificates say that went to the page (read out of its values, though a
   * certificate is anyone's to see), or that it was refused: who read which Secret's, and which
   * keys', a while at a time.
   */
  const certificatesRead = (q: CertificatesQuery, result: Result<CertificateSummary[]>) => {
    const keys = result.ok ? result.data.map((each) => each.key) : []
    // (None said, nothing of its values went: no read.)
    if (result.ok && keys.length === 0) return
    audit.read(`certificates:${q.context}/${q.namespace}/${q.name}:${result.ok}:${keys.join()}`, {
      action: 'secret.read',
      ...outcomeOf(result),
      cluster: q.context,
      target: { kind: 'Secret', name: q.name, namespace: q.namespace },
      summary: `Read the certificates of Secret ${q.name}`,
      ...(keys.length > 0 ? { details: { certificates: keys } } : {}),
    })
  }
  /**
   * What a list of Secrets said of their certificates: one read for the list, naming the Secrets
   * whose certificates went to the page, a while at a time.
   */
  const listedCertificatesRead = (q: ListQuery, list: KubeList) => {
    const secrets = Object.keys(list.certificates ?? {}).sort()
    if (secrets.length === 0) return
    const namespaces = new Set(secrets.map((each) => each.slice(0, each.indexOf('/'))))
    const where =
      namespaces.size === 1 ? `in ${[...namespaces][0]}` : `in ${namespaces.size} namespaces`
    audit.read(`listed-certificates:${q.context}:${JSON.stringify(secrets)}`, {
      action: 'secret.read',
      outcome: 'success',
      cluster: q.context,
      target: {
        kind: 'Secret',
        ...(namespaces.size === 1 ? { namespace: [...namespaces][0] } : {}),
      },
      summary: `Read the certificates of ${secrets.length} ${secrets.length === 1 ? 'Secret' : 'Secrets'} ${where}`,
      details: { secrets },
    })
  }
  /**
   * Some of a Secret's values that went to the page, picked by key: exactly the keys handed
   * over (none where the person's access shows only keys), or that it was refused. Counted
   * apart from a read of the whole Secret, and by which keys, so neither hides the other.
   */
  const secretKeysRead = (
    q: SecretValuesQuery,
    result: Result<SecretValues>,
    /** The plugin whose page it was read on, as the backend knows it: counted apart. */
    plugin?: Readonly<KnownPlugin>,
  ) => {
    const handed = result.ok ? result.data.values.map(([key]) => key) : []
    // The Secret as the cluster named it, where it answered; as it was asked for, where refused.
    const { name, namespace } = result.ok ? result.data : q
    // Where the person's access shows only a Secret's keys, no value was handed: it's said so.
    const namesOnly = result.ok && result.data.withheld
    // (With the code its page runs, as its hand-over has it: a Secret shown is part of what that
    // code was granted.)
    const who = plugin
      ? {
          plugin: plugin.name,
          pluginVersion: plugin.version,
          pluginDigest: plugin.digest,
          ...(plugin.codeDigest ? { codeDigest: plugin.codeDigest } : {}),
        }
      : undefined
    audit.read(
      `secret-keys:${q.context}/${namespace}/${name}:${result.ok}:${namesOnly}:${JSON.stringify([...handed].sort())}:${JSON.stringify(who ?? null)}`,
      {
        action: 'secret.read',
        ...outcomeOf(result),
        cluster: q.context,
        target: {
          kind: 'Secret',
          name,
          namespace,
          ...(result.ok && result.data.uid ? { uid: result.data.uid } : {}),
        },
        summary: `${
          namesOnly
            ? `Read the keys’ names of Secret ${name}`
            : `Read ${handed.length} ${handed.length === 1 ? 'key' : 'keys'} of Secret ${name}`
        }${plugin ? ` for the plugin ${plugin.name}` : ''}`,
        ...(result.ok || who
          ? { details: { ...(result.ok ? { keys: handed } : {}), ...who } }
          : {}),
      },
    )
  }
  /** Whether the clusters' settings are everyone's (on a server), rather than this person's. */
  const forEveryone = () => settings.get().shared !== undefined
  /**
   * A cluster's setting changed, recorded: or, where this person may not change it (on a server,
   * only Lumovi's admins may, where it has them, and only for the clusters it shows), its refusal.
   */
  const changeSetting = (input: Omit<Recorded, 'outcome'>, change: () => Settings) => {
    try {
      const updated = change()
      audit.record({ ...input, outcome: 'success' })
      return updated
    } catch (error) {
      if (
        error instanceof KubeRequestError &&
        (error.code === 'not-allowed' || error.code === 'not-found')
      ) {
        audit.record({ ...input, outcome: 'refused', error: error.message })
      }
      throw error
    }
  }
  /** A person's own: what they pinned and saved, kept only as Lumovi would make it. */
  const ownMarks: Record<string, Handler> = marks
    ? {
        [IPC.marks]: (context): Result<Marks> => {
          if (typeof context !== 'string' || context === '')
            throw new Error('Expected a context name')
          return { ok: true, data: marks.get(context) }
        },
        [IPC.setMarks]: (context, given): Result<Marks> => {
          if (typeof context !== 'string' || context === '')
            throw new Error('Expected a context name')
          const problem = marksProblem(given) ?? marks.set(context, given as Marks)
          return problem
            ? { ok: false, error: { code: 'invalid', message: problem } }
            : { ok: true, data: given as Marks }
        },
      }
    : {}
  return {
    invoke: {
      ...ownMarks,
      [IPC.settings]: () => settings.get(),
      [IPC.setReadOnly]: (context, readOnly) => {
        if (typeof context !== 'string' || context === '' || typeof readOnly !== 'boolean') {
          throw new Error('Expected a context name and whether it is read-only')
        }
        return changeSetting(
          {
            action: 'read-only.changed',
            cluster: context,
            summary: `Made ${context} ${readOnly ? 'read-only' : 'changeable'} ${forEveryone() ? 'for everyone on this server' : 'in Lumovi'}`,
            details: { readOnly },
          },
          () => settings.setReadOnly(context, readOnly),
        )
      },
      [IPC.setMetricsSource]: (context, setting) => {
        if (typeof context !== 'string' || context === '' || !isMetricsSourceSetting(setting)) {
          throw new Error('Expected a context name and a metrics source')
        }
        const updated = changeSetting(
          {
            action: 'metrics-source.changed',
            cluster: context,
            summary:
              setting.mode === 'service'
                ? `Made ${context}’s metrics come from ${setting.service.namespace}/${setting.service.service}`
                : setting.mode === 'off'
                  ? `Turned off ${context}’s metrics history`
                  : `Made Lumovi find ${context}’s metrics`,
            details:
              setting.mode === 'service'
                ? {
                    mode: setting.mode,
                    namespace: setting.service.namespace,
                    service: setting.service.service,
                  }
                : { mode: setting.mode },
          },
          () => settings.setMetricsSource(context, setting),
        )
        usage.forget(context)
        return updated
      },
      [IPC.setNodeShell]: (context, setting) => {
        // None, back to the defaults: null, or from a page (whose nulls arrive as undefined).
        const reset = setting === null || setting === undefined
        if (
          typeof context !== 'string' ||
          context === '' ||
          (!reset && !isNodeShellSetting(setting))
        ) {
          throw new Error('Expected a context name and where its node shells run')
        }
        // Where privileged pods are made, and from what: who changed it.
        return changeSetting(
          {
            action: 'node-shell.changed',
            cluster: context,
            summary: reset
              ? `Made node shells in ${context} run as Lumovi’s defaults`
              : `Made node shells in ${context} run ${setting.image} in ${setting.namespace}`,
            ...(reset ? {} : { details: { namespace: setting.namespace, image: setting.image } }),
          },
          () => settings.setNodeShell(context, reset ? null : setting),
        )
      },
      [IPC.setPluginCode]: async (plugin, on) => {
        if (typeof plugin !== 'string' || !PLUGIN_NAME.test(plugin) || typeof on !== 'boolean') {
          throw new Error('Expected a plugin’s name and whether its code runs')
        }
        // Only a plugin Lumovi has in use whose code it has: the name a person reads it by.
        const known = (await knownPlugins()).find((p) => p.name === plugin && p.code !== undefined)
        if (!known) throw new Error(`No plugin called “${plugin}” has code in this Lumovi.`)
        const label = known.label ?? known.name
        const input: Omit<Recorded, 'outcome'> = {
          action: 'plugin.code-switch',
          target: { kind: 'Plugin', name: plugin },
          summary: `Turned ${on ? 'on' : 'off'} the ${label} plugin’s code`,
          details: { plugin, on },
        }
        try {
          const updated = await settings.setPluginCode(plugin, on)
          audit.record({ ...input, outcome: 'success' })
          return updated
        } catch (error) {
          audit.record({ ...input, outcome: 'refused', error: (error as Error).message })
          throw error
        }
      },
      [IPC.plugins]: async () => {
        // (A person's own plugins in folders of their own: the desktop app's alone.)
        const read = await readPlugins(pluginsDirectory, process.env, {
          folders: handOverTo().host === 'desktop',
        })
        // (Lumovi's own only, or none, by the organization's policy: a person's folder isn't read,
        // and none installed from Lumovi-plugins is used.)
        const managed = settings.get().managed
        if (managed?.pluginsOff || managed?.pluginsBundledOnly) return { ...read, files: [] }
        // (Only what the page reads of them: not their code, which is handed over as Lumovi's own.)
        const installed = await installedPlugins?.()
        return installed
          ? { ...read, installed: { plugins: installed.plugins, notUsed: installed.notUsed } }
          : read
      },

      // (Each with the credential plugin it signs in through, where it has one: read, not run;
      // and whether it's answered since Lumovi started, signed in.)
      [IPC.contexts]: () => {
        const result = kube.contexts()
        return {
          ...result,
          contexts: result.contexts.map((context) => {
            const plugin = kube.credentialPlugin(context.name)
            if (!plugin) return context
            const signedIn = kube.answeredAt(context.name) !== undefined
            return { ...context, signsInWith: plugin, ...(signedIn ? { signedIn: true } : {}) }
          }),
        }
      },
      [IPC.version]: (context) => kube.version(context),
      [IPC.resources]: (context) => kube.resources(context),
      [IPC.schema]: (context, kind) => kube.schema(context, kind),
      [IPC.list]: async (query) => {
        const result = await kube.list(query)
        if (result.ok && result.data.certificates) {
          listedCertificatesRead(query as ListQuery, result.data)
        }
        return result
      },
      [IPC.certificates]: async (query) => {
        const result = await kube.certificates(query)
        if (result.ok || isRefusal(result.error.code)) {
          certificatesRead(query as CertificatesQuery, result)
        }
        return result
      },
      [IPC.get]: async (query) => {
        const result = await kube.get(query)
        const q = query as GetQuery
        if (q.kind === 'Secret' && (result.ok || isRefusal(result.error.code))) {
          secretRead(q, result)
        }
        return result
      },
      [IPC.secretValues]: async (query) => {
        // On a plugin's page: whose page, as the backend knows it, and only keys its file says
        // its pages show (`secretsAskedFor`).
        const asked = await secretsAskedFor(
          query,
          knownPlugins,
          kube,
          handOverTo().switches?.secretsOff === true,
          handOverTo,
        )
        if ('refused' in asked) {
          const refused = { ok: false as const, error: asked.refused }
          if (asked.recorded) secretKeysRead(asked.recorded.query, refused, asked.recorded.plugin)
          return refused
        }
        const result = await kube.secretValues(asked.query)
        if (result.ok || isRefusal(result.error.code)) {
          secretKeysRead(asked.query as SecretValuesQuery, result, asked.plugin)
        }
        return result
      },
      // (A plugin's code chooses what these read: what they add to the history has a ceiling.)
      [IPC.pluginRead]: pluginReads({ kube, known: knownPlugins, audit: listed, to: handOverTo }),
      [IPC.pluginLogs]: pluginLogs({ kube, known: knownPlugins, audit: listed, to: handOverTo }),
      [IPC.pluginEvents]: pluginEvents({
        kube,
        known: knownPlugins,
        audit: listed,
        to: handOverTo,
      }),
      [IPC.pluginServer]: pluginServer({
        kube,
        known: knownPlugins,
        audit: listed,
        to: handOverTo,
      }),
      [IPC.pluginChange]: pluginChanges({ kube, known: knownPlugins, to: handOverTo, audit }),
      ...(() => {
        const codes = pluginCodes({ known: knownPlugins, to: handOverTo, audit })
        return { [IPC.pluginCode]: codes.code, [IPC.pluginHandOver]: codes.whether }
      })(),
      [IPC.metrics]: (query) => kube.metrics(query),
      [IPC.change]: recorded(async (request: ChangeRequest) => {
        const result = await kube.change(request)
        // Only tried, a Secret's change answers with it as it'd be: read, as a get is.
        if (request.kind === 'Secret' && request.dryRun === true && result.ok && result.data) {
          secretRead({ ...request, name: result.data.metadata.name }, result)
        }
        return result
      }, describeChange),
      [IPC.can]: (context, checks) => kube.can(context, checks),
      [IPC.history]: (query) => kube.history(query),

      [IPC.helmReleases]: (context, namespace) => helm.releases(context, namespace),
      [IPC.helmRelease]: async (context, namespace, name) => {
        const result = await helm.release(context, namespace, name)
        // Its values and manifests (a Secret's data, they may hold) went to the page.
        if (result.ok && !result.data.withheld) {
          audit.read(`helm:${context}/${namespace}/${name}`, {
            action: 'helm.values.read',
            outcome: 'success',
            cluster: context as string,
            target: { kind: 'HelmRelease', name: name as string, namespace: namespace as string },
            summary: `Read release ${name as string}’s values and manifests`,
          })
        }
        return result
      },
      [IPC.helmCli]: () => helm.cli(),
      [IPC.helmRollback]: recorded(
        (request: HelmRollback) => helm.rollback(request),
        describeRollback,
      ),
      [IPC.helmUninstall]: recorded(
        (request: HelmUninstall) => helm.uninstall(request),
        describeUninstall,
      ),
      // A chart from a repository Lumovi keeps is recorded with it: by name, as it's named now.
      [IPC.helmDeploy]: async (request) => {
        const saved = (request as { source?: { saved?: unknown } } | undefined)?.source?.saved
        const from = typeof saved === 'string' ? await helm.repositories.named(saved) : undefined
        return recorded(
          (r: HelmDeploy) => helm.deploy(r),
          (r, result) => describeDeploy(r, result, from),
        )(request)
      },
      [IPC.helmDefaults]: (source) => helm.defaults(source),
      [IPC.helmVersions]: (repository, chart) => helm.versions(repository, chart),
      [IPC.helmSearch]: (query) => helm.search(query),
      [IPC.helmRepositories]: () => helm.repositories.list(),
      [IPC.helmRepositoriesRefresh]: () => helm.repositories.refresh(),
      [IPC.helmRepositoryTest]: (input) => helm.repositories.test(input),
      [IPC.helmRepositorySave]: (input) => helm.repositories.save(input),
      [IPC.helmRepositoryRemove]: (id) => helm.repositories.remove(id),
      [IPC.helmChartIcon]: (repository, chart) => helm.repositories.icon(repository, chart),

      [IPC.metricsStackStatus]: (context) => metricsStack.status(context),
      // History is looked for again after either: there's a source now, or there's none.
      [IPC.metricsStackInstall]: recorded(async (request: MetricsStackRequest) => {
        const result = await metricsStack.install(request)
        if (result.ok && request.dryRun !== true) usage.forget(request.context)
        return result
      }, describeStackInstall),
      [IPC.metricsStackUninstall]: recorded(async (request: MetricsStackRequest) => {
        const result = await metricsStack.uninstall(request)
        if (result.ok) usage.forget(request.context)
        return result
      }, describeStackUninstall),
      [IPC.usageSource]: (context, refresh) => usage.source(context, refresh),
      [IPC.usageTest]: (context, service) => usage.test(context, service),
      [IPC.usageRange]: (query) => usage.range(query),
      [IPC.usageInstant]: (query) => usage.instant(query),
      [IPC.usageAlerts]: (context) => usage.alerts(context),

      [IPC.terminalOpen]: (id, request) => terminals.open(id, request),
      [IPC.logsStart]: (id, request) => logs.start(id, request),
      [IPC.watchStart]: (id, query) => watches.start(id, query),
      [IPC.filesDownload]: (id, request) => files.download(id, request),
      [IPC.filesUpload]: (id, request) => files.upload(id, request),
    },
    send: {
      [IPC.terminalInput]: (id, data) => terminals.write(id, data),
      [IPC.terminalResize]: (id, columns, rows) => terminals.resize(id, columns, rows),
      [IPC.terminalClose]: (id) => terminals.close(id),
      [IPC.logsStop]: (id) => logs.stop(id),
      [IPC.watchStop]: (id) => watches.stop(id),
      [IPC.filesCancel]: (id) => files.cancel(id),
    },
  }
}

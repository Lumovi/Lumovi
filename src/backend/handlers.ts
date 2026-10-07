/**
 * What the page can ask for wherever Lumovi runs, by channel: the desktop
 * app answers these over IPC, the server over each page's WebSocket. Each adds
 * its own on top (windows, files and updates on the desktop; who is signed in
 * on the server).
 */
import {
  IPC,
  type ChangeRequest,
  type GetQuery,
  type HelmDeploy,
  type HelmRollback,
  type HelmUninstall,
  type KubeObject,
  type Result,
  type Settings,
} from '@shared/api'
import {
  describeChange,
  describeDeploy,
  describeRollback,
  describeUninstall,
  isRefusal,
  malformed,
  outcomeOf,
} from './audit/describe'
import type { Recorded, Recorder } from './audit/recorder'
import type { HelmService } from './helm/service'
import type { LogStreams } from './kube/logs'
import { KubeRequestError } from './kube/errors'
import type { KubeService } from './kube/service'
import type { Terminals } from './kube/streams'
import type { UsageHistory } from './kube/usage'
import { isMetricsSourceSetting, isNodeShellSetting, type SettingsAccess } from './settings'
import { readViews } from './views'

/** Answers a call from the page. Its arguments come from the page, so they're checked. */
export type Handler = (...args: unknown[]) => unknown

export interface Backend {
  kube: KubeService
  helm: HelmService
  usage: UsageHistory
  settings: SettingsAccess
  terminals: Terminals
  logs: LogStreams
  /** Where the views of one's own are, and how that folder is shown. */
  viewsDirectory: { path: string; shown: string }
  /** The audit log, as the page's person records to it. */
  audit: Recorder
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
  usage,
  settings,
  terminals,
  logs,
  viewsDirectory,
  audit,
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
  return {
    invoke: {
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
      [IPC.views]: () => readViews(viewsDirectory),

      [IPC.contexts]: () => kube.contexts(),
      [IPC.version]: (context) => kube.version(context),
      [IPC.resources]: (context) => kube.resources(context),
      [IPC.schema]: (context, kind) => kube.schema(context, kind),
      [IPC.list]: (query) => kube.list(query),
      [IPC.get]: async (query) => {
        const result = await kube.get(query)
        const q = query as GetQuery
        if (q.kind === 'Secret' && (result.ok || isRefusal(result.error.code))) {
          secretRead(q, result)
        }
        return result
      },
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
      [IPC.helmDeploy]: recorded((request: HelmDeploy) => helm.deploy(request), describeDeploy),
      [IPC.helmDefaults]: (source) => helm.defaults(source),
      [IPC.helmVersions]: (repository, chart) => helm.versions(repository, chart),
      [IPC.helmSearch]: (query) => helm.search(query),

      [IPC.usageSource]: (context, refresh) => usage.source(context, refresh),
      [IPC.usageTest]: (context, service) => usage.test(context, service),
      [IPC.usageRange]: (query) => usage.range(query),
      [IPC.usageInstant]: (query) => usage.instant(query),

      [IPC.terminalOpen]: (id, request) => terminals.open(id, request),
      [IPC.logsStart]: (id, request) => logs.start(id, request),
    },
    send: {
      [IPC.terminalInput]: (id, data) => terminals.write(id, data),
      [IPC.terminalResize]: (id, columns, rows) => terminals.resize(id, columns, rows),
      [IPC.terminalClose]: (id) => terminals.close(id),
      [IPC.logsStop]: (id) => logs.stop(id),
    },
  }
}

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
} from '@shared/api'
import {
  describeChange,
  describeDeploy,
  describeRollback,
  describeUninstall,
  malformed,
} from './audit/describe'
import type { Recorder } from './audit/recorder'
import type { HelmService } from './helm/service'
import type { LogStreams } from './kube/logs'
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
  return {
    invoke: {
      [IPC.settings]: () => settings.get(),
      [IPC.setReadOnly]: (context, readOnly) => {
        if (typeof context !== 'string' || context === '' || typeof readOnly !== 'boolean') {
          throw new Error('Expected a context name and whether it is read-only')
        }
        const updated = settings.setReadOnly(context, readOnly)
        audit.record({
          action: 'read-only.changed',
          outcome: 'success',
          cluster: context,
          summary: `Made ${context} ${readOnly ? 'read-only' : 'changeable'} in Lumovi`,
          details: { readOnly },
        })
        return updated
      },
      [IPC.setMetricsSource]: (context, setting) => {
        if (typeof context !== 'string' || context === '' || !isMetricsSourceSetting(setting)) {
          throw new Error('Expected a context name and a metrics source')
        }
        const updated = settings.setMetricsSource(context, setting)
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
        return settings.setNodeShell(context, reset ? null : setting)
      },
      [IPC.views]: () => readViews(viewsDirectory),

      [IPC.contexts]: () => kube.contexts(),
      [IPC.version]: (context) => kube.version(context),
      [IPC.resources]: (context) => kube.resources(context),
      [IPC.schema]: (context, kind) => kube.schema(context, kind),
      [IPC.list]: (query) => kube.list(query),
      [IPC.get]: async (query) => {
        const result = await kube.get(query)
        // A Secret's values went to the page: who read which, a while at a time.
        const q = query as GetQuery
        if (result.ok && result.data.kind === 'Secret') {
          audit.read(`secret:${q.context}/${q.namespace}/${q.name}`, {
            action: 'secret.read',
            outcome: 'success',
            cluster: q.context,
            target: {
              kind: 'Secret',
              name: q.name,
              namespace: q.namespace,
              uid: result.data.metadata.uid,
            },
            summary: `Read Secret ${q.name}`,
            details: {
              keys: Object.keys(Object((result.data as KubeObject & { data?: object }).data)),
            },
          })
        }
        return result
      },
      [IPC.metrics]: (query) => kube.metrics(query),
      [IPC.change]: recorded((request: ChangeRequest) => kube.change(request), describeChange),
      [IPC.can]: (context, checks) => kube.can(context, checks),
      [IPC.history]: (query) => kube.history(query),

      [IPC.helmReleases]: (context, namespace) => helm.releases(context, namespace),
      [IPC.helmRelease]: (context, namespace, name) => helm.release(context, namespace, name),
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

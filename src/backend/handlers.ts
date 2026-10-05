/**
 * What the page can ask for wherever Lumovi runs, by channel: the desktop
 * app answers these over IPC, the server over each page's WebSocket. Each adds
 * its own on top (windows, files and updates on the desktop; who is signed in
 * on the server).
 */
import { IPC } from '@shared/api'
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
}: Backend): Handlers {
  return {
    invoke: {
      [IPC.settings]: () => settings.get(),
      [IPC.setReadOnly]: (context, readOnly) => {
        if (typeof context !== 'string' || context === '' || typeof readOnly !== 'boolean') {
          throw new Error('Expected a context name and whether it is read-only')
        }
        return settings.setReadOnly(context, readOnly)
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
      [IPC.get]: (query) => kube.get(query),
      [IPC.metrics]: (query) => kube.metrics(query),
      [IPC.change]: (request) => kube.change(request),
      [IPC.can]: (context, checks) => kube.can(context, checks),
      [IPC.history]: (query) => kube.history(query),

      [IPC.helmReleases]: (context, namespace) => helm.releases(context, namespace),
      [IPC.helmRelease]: (context, namespace, name) => helm.release(context, namespace, name),
      [IPC.helmCli]: () => helm.cli(),
      [IPC.helmRollback]: (request) => helm.rollback(request),
      [IPC.helmUninstall]: (request) => helm.uninstall(request),
      [IPC.helmDeploy]: (request) => helm.deploy(request),
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

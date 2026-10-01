import {
  app,
  ipcMain,
  nativeTheme,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import { IPC, type AppInfo } from '@shared/api'
import type { HelmService } from './helm/service'
import type { KubeService } from './kube/service'
import type { Forwards, Terminals } from './kube/streams'
import type { UsageHistory } from './kube/usage'
import { isMetricsSourceSetting, isTheme, type SettingsStore } from './settings'
import { readViews } from './views'

interface Dependencies {
  kube: KubeService
  helm: HelmService
  usage: UsageHistory
  settings: SettingsStore
  terminals: Terminals
  forwards: Forwards
  /** Where the user's own views are, and how that folder is shown. */
  viewsDirectory: { path: string; shown: string }
  /** Only frames showing this URL may call into the main process. */
  rendererUrl: string
}

export function registerIpc({
  kube,
  helm,
  usage,
  settings,
  terminals,
  forwards,
  viewsDirectory,
  rendererUrl,
}: Dependencies): void {
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    event.senderFrame?.url.startsWith(rendererUrl) === true
  const handle = (channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error(`Blocked ${channel} from an untrusted frame`)
      return handler(...args)
    })
  }
  /** One-way messages, for keystrokes that shouldn't wait for an answer; others are dropped. */
  const on = (channel: string, handler: (...args: unknown[]) => void) => {
    ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
      if (trusted(event)) handler(...args)
    })
  }

  handle(IPC.appInfo, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }))
  handle(IPC.settings, () => settings.get())
  handle(IPC.setTheme, (theme) => {
    if (!isTheme(theme)) throw new Error(`Unknown theme "${String(theme)}"`)
    nativeTheme.themeSource = theme
    return settings.update({ theme })
  })
  handle(IPC.setReadOnly, (context, readOnly) => {
    if (typeof context !== 'string' || context === '' || typeof readOnly !== 'boolean') {
      throw new Error('Expected a context name and whether it is read-only')
    }
    return settings.setReadOnly(context, readOnly)
  })
  handle(IPC.setMetricsSource, (context, setting) => {
    if (typeof context !== 'string' || context === '' || !isMetricsSourceSetting(setting)) {
      throw new Error('Expected a context name and a metrics source')
    }
    const updated = settings.setMetricsSource(context, setting)
    usage.forget(context)
    return updated
  })
  handle(IPC.openExternal, async (url) => {
    // Only hand web links to the OS (plain HTTP only for forwarded ports on this machine);
    // never file:// or custom protocol handlers.
    const allowed =
      typeof url === 'string' &&
      (url.startsWith('https://') || /^http:\/\/localhost:\d+(\/|$)/.test(url))
    if (allowed) await shell.openExternal(url)
    return allowed
  })
  handle(IPC.views, () => readViews(viewsDirectory))

  handle(IPC.contexts, () => kube.contexts())
  handle(IPC.version, (context) => kube.version(context))
  handle(IPC.resources, (context) => kube.resources(context))
  handle(IPC.schema, (context, kind) => kube.schema(context, kind))
  handle(IPC.list, (query) => kube.list(query))
  handle(IPC.get, (query) => kube.get(query))
  handle(IPC.metrics, (query) => kube.metrics(query))
  handle(IPC.logs, (query) => kube.logs(query))
  handle(IPC.change, (request) => kube.change(request))
  handle(IPC.can, (context, checks) => kube.can(context, checks))
  handle(IPC.history, (query) => kube.history(query))
  handle(IPC.helmReleases, (context, namespace) => helm.releases(context, namespace))
  handle(IPC.helmRelease, (context, namespace, name) => helm.release(context, namespace, name))
  handle(IPC.helmCli, () => helm.cli())
  handle(IPC.helmRollback, (request) => helm.rollback(request))
  handle(IPC.helmUninstall, (request) => helm.uninstall(request))
  handle(IPC.helmDeploy, (request) => helm.deploy(request))
  handle(IPC.helmDefaults, (source) => helm.defaults(source))
  handle(IPC.helmVersions, (repository, chart) => helm.versions(repository, chart))
  handle(IPC.helmSearch, (query) => helm.search(query))
  handle(IPC.usageSource, (context, refresh) => usage.source(context, refresh))
  handle(IPC.usageTest, (context, service) => usage.test(context, service))
  handle(IPC.usageRange, (query) => usage.range(query))
  handle(IPC.usageInstant, (query) => usage.instant(query))

  handle(IPC.terminalOpen, (id, request) => terminals.open(id, request))
  on(IPC.terminalInput, (id, data) => terminals.write(id, data))
  on(IPC.terminalResize, (id, columns, rows) => terminals.resize(id, columns, rows))
  on(IPC.terminalClose, (id) => terminals.close(id))
  handle(IPC.forwardStart, (request) => forwards.start(request))
  handle(IPC.forwardList, () => forwards.list())
  handle(IPC.forwardStop, (id) => forwards.stop(id))
}

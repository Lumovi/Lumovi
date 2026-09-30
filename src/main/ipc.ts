import { app, ipcMain, nativeTheme, shell, type IpcMainInvokeEvent } from 'electron'
import { IPC, type AppInfo } from '@shared/api'
import type { KubeService } from './kube/service'
import { isTheme, type SettingsStore } from './settings'

interface Dependencies {
  kube: KubeService
  settings: SettingsStore
  /** Only frames showing this URL may call into the main process. */
  rendererUrl: string
}

export function registerIpc({ kube, settings, rendererUrl }: Dependencies): void {
  const handle = (channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!event.senderFrame?.url.startsWith(rendererUrl)) {
        throw new Error(`Blocked ${channel} from an untrusted frame`)
      }
      return handler(...args)
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
  handle(IPC.openExternal, async (url) => {
    // Only hand web links to the OS; never file:// or custom protocol handlers.
    const allowed = typeof url === 'string' && url.startsWith('https://')
    if (allowed) await shell.openExternal(url)
    return allowed
  })

  handle(IPC.contexts, () => kube.contexts())
  handle(IPC.version, (context) => kube.version(context))
  handle(IPC.list, (query) => kube.list(query))
  handle(IPC.get, (query) => kube.get(query))
  handle(IPC.metrics, (query) => kube.metrics(query))
  handle(IPC.logs, (query) => kube.logs(query))
}

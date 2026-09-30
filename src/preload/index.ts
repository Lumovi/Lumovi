import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type KubestacksApi } from '@shared/api'

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

// The renderer gets this narrow, typed API and nothing else from Electron or Node.
const api: KubestacksApi = {
  platform: process.platform,
  app: {
    info: () => invoke(IPC.appInfo),
    settings: () => invoke(IPC.settings),
    setTheme: (theme) => invoke(IPC.setTheme, theme),
    openExternal: (url) => invoke(IPC.openExternal, url),
  },
  kube: {
    contexts: () => invoke(IPC.contexts),
    version: (context) => invoke(IPC.version, context),
    list: (query) => invoke(IPC.list, query),
    get: (query) => invoke(IPC.get, query),
    metrics: (query) => invoke(IPC.metrics, query),
    logs: (query) => invoke(IPC.logs, query),
  },
}

contextBridge.exposeInMainWorld('kubestacks', api)

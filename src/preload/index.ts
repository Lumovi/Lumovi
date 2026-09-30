import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type KubestacksApi } from '@shared/api'

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

// The renderer gets this narrow, typed API and nothing else from Electron or Node.
const api: KubestacksApi = {
  platform: process.platform,
  onCommand: (listener) => {
    const handler = (_event: unknown, command: Parameters<typeof listener>[0]) => listener(command)
    ipcRenderer.on(IPC.command, handler)
    return () => ipcRenderer.removeListener(IPC.command, handler)
  },
  app: {
    info: () => invoke(IPC.appInfo),
    settings: () => invoke(IPC.settings),
    setTheme: (theme) => invoke(IPC.setTheme, theme),
    setReadOnly: (context, readOnly) => invoke(IPC.setReadOnly, context, readOnly),
    openExternal: (url) => invoke(IPC.openExternal, url),
  },
  kube: {
    contexts: () => invoke(IPC.contexts),
    version: (context) => invoke(IPC.version, context),
    list: (query) => invoke(IPC.list, query),
    get: (query) => invoke(IPC.get, query),
    metrics: (query) => invoke(IPC.metrics, query),
    logs: (query) => invoke(IPC.logs, query),
    change: (request) => invoke(IPC.change, request),
    can: (context, checks) => invoke(IPC.can, context, checks),
    history: (query) => invoke(IPC.history, query),
  },
}

contextBridge.exposeInMainWorld('kubestacks', api)

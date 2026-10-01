import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type KubestacksApi } from '@shared/api'

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

/** Subscribes to messages from the main process; returns an unsubscribe function. */
function subscribe<T extends unknown[]>(channel: string, listener: (...args: T) => void) {
  const handler = (_event: unknown, ...args: unknown[]) => listener(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => void ipcRenderer.removeListener(channel, handler)
}

// The renderer gets this narrow, typed API and nothing else from Electron or Node.
const api: KubestacksApi = {
  platform: process.platform,
  onCommand: (listener) => subscribe(IPC.command, listener),
  app: {
    info: () => invoke(IPC.appInfo),
    settings: () => invoke(IPC.settings),
    setTheme: (theme) => invoke(IPC.setTheme, theme),
    setReadOnly: (context, readOnly) => invoke(IPC.setReadOnly, context, readOnly),
    setMetricsSource: (context, setting) => invoke(IPC.setMetricsSource, context, setting),
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
  usage: {
    source: (context, refresh) => invoke(IPC.usageSource, context, refresh),
    test: (context, service) => invoke(IPC.usageTest, context, service),
    range: (query) => invoke(IPC.usageRange, query),
    instant: (query) => invoke(IPC.usageInstant, query),
  },
  terminal: {
    open: (id, request) => invoke(IPC.terminalOpen, id, request),
    write: (id, data) => ipcRenderer.send(IPC.terminalInput, id, data),
    resize: (id, columns, rows) => ipcRenderer.send(IPC.terminalResize, id, columns, rows),
    close: (id) => ipcRenderer.send(IPC.terminalClose, id),
    onData: (listener) => subscribe(IPC.terminalData, listener),
    onExit: (listener) => subscribe(IPC.terminalExit, listener),
  },
  forwards: {
    start: (request) => invoke(IPC.forwardStart, request),
    list: () => invoke(IPC.forwardList),
    stop: (id) => invoke(IPC.forwardStop, id),
    onChange: (listener) => subscribe(IPC.forwardsChanged, listener),
  },
}

contextBridge.exposeInMainWorld('kubestacks', api)

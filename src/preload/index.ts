import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type LumoviApi } from '@shared/api'

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

/** Subscribes to messages from the main process; returns an unsubscribe function. */
function subscribe<T extends unknown[]>(channel: string, listener: (...args: T) => void) {
  const handler = (_event: unknown, ...args: unknown[]) => listener(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => void ipcRenderer.removeListener(channel, handler)
}

/** How many listen for audit events: the main process sends them while any does. */
let auditListeners = 0

// The renderer gets this narrow, typed API and nothing else from Electron or Node.
const api: LumoviApi = {
  platform: process.platform,
  host: 'desktop',
  desktop: {
    onCommand: (listener) => subscribe(IPC.command, listener),
    onFullScreen: (listener) => subscribe(IPC.fullScreen, listener),
    setTerminalFocus: (focused) => ipcRenderer.send(IPC.terminalFocus, focused),
  },
  app: {
    info: () => invoke(IPC.appInfo),
    settings: () => invoke(IPC.settings),
    problems: () => invoke(IPC.appProblems),
    setTheme: (theme) => invoke(IPC.setTheme, theme),
    setReadOnly: (context, readOnly) => invoke(IPC.setReadOnly, context, readOnly),
    setMetricsSource: (context, setting) => invoke(IPC.setMetricsSource, context, setting),
    setNodeShell: (context, setting) => invoke(IPC.setNodeShell, context, setting),
    openExternal: (url) => invoke(IPC.openExternal, url),
    saveFile: (name, text) => invoke(IPC.saveFile, name, text),
    views: () => invoke(IPC.views),
  },
  kube: {
    contexts: () => invoke(IPC.contexts),
    version: (context) => invoke(IPC.version, context),
    resources: (context) => invoke(IPC.resources, context),
    schema: (context, kind) => invoke(IPC.schema, context, kind),
    list: (query) => invoke(IPC.list, query),
    get: (query) => invoke(IPC.get, query),
    metrics: (query) => invoke(IPC.metrics, query),
    change: (request) => invoke(IPC.change, request),
    can: (context, checks) => invoke(IPC.can, context, checks),
    history: (query) => invoke(IPC.history, query),
  },
  helm: {
    releases: (context, namespace) => invoke(IPC.helmReleases, context, namespace),
    release: (context, namespace, name) => invoke(IPC.helmRelease, context, namespace, name),
    cli: () => invoke(IPC.helmCli),
    rollback: (request) => invoke(IPC.helmRollback, request),
    uninstall: (request) => invoke(IPC.helmUninstall, request),
    deploy: (request) => invoke(IPC.helmDeploy, request),
    defaults: (source) => invoke(IPC.helmDefaults, source),
    versions: (repository, chart) => invoke(IPC.helmVersions, repository, chart),
    search: (query) => invoke(IPC.helmSearch, query),
  },
  kubeconfigFiles: {
    list: () => invoke(IPC.kubeconfigFiles),
    choose: (how) => invoke(IPC.kubeconfigChoose, how),
    remove: (path) => invoke(IPC.kubeconfigRemove, path),
    useDefault: () => invoke(IPC.kubeconfigUseDefault),
    show: (path) => invoke(IPC.kubeconfigShow, path),
  },
  localCharts: {
    choose: (kind) => invoke(IPC.helmChoose, kind),
    read: (path) => invoke(IPC.helmLocal, path),
    lint: (path, values) => invoke(IPC.helmLint, path, values),
    valuesFile: (path, file) => invoke(IPC.helmValuesFile, path, file),
    updateDependencies: (path) => invoke(IPC.helmDependencies, path),
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
  approvals: {
    decide: (id, decision) => invoke(IPC.assistantsDecide, id, decision),
    pending: () => invoke(IPC.assistantsPending),
    onProposal: (listener) => subscribe(IPC.assistantsProposal, listener),
    onOutcome: (listener) => subscribe(IPC.assistantsOutcome, listener),
  },
  assistants: {
    status: () => invoke(IPC.assistantsStatus),
    configure: (setting) => invoke(IPC.assistantsConfigure, setting),
    resetToken: () => invoke(IPC.assistantsResetToken),
    install: (client) => invoke(IPC.assistantsInstall, client),
    onStatus: (listener) => subscribe(IPC.assistantsStatusChanged, listener),
  },
  audit: {
    info: () => invoke(IPC.auditInfo),
    query: (query) => invoke(IPC.auditQuery, query),
    verify: () => invoke(IPC.auditVerify),
    onEvent: (listener) => {
      const off = subscribe(IPC.auditEvent, listener)
      if (auditListeners++ === 0) void invoke(IPC.auditWatch, true)
      return () => {
        off()
        if (--auditListeners === 0) void invoke(IPC.auditWatch, false)
      }
    },
  },
  aiPermissions: {
    get: () => invoke(IPC.aiPermissionsGet),
    set: (permissions) => invoke(IPC.aiPermissionsSet, permissions),
    onChanged: (listener) => subscribe(IPC.aiPermissionsChanged, listener),
  },
  sponsor: {
    card: () => invoke(IPC.sponsorCard),
    onChange: (listener) => subscribe(IPC.sponsorChanged, listener),
  },
  updates: {
    state: () => invoke(IPC.updateState),
    check: () => invoke(IPC.updateCheck),
    install: () => invoke(IPC.updateInstall),
    onChange: (listener) => subscribe(IPC.updateChanged, listener),
  },
  logs: {
    start: (id, request) => invoke(IPC.logsStart, id, request),
    stop: (id) => ipcRenderer.send(IPC.logsStop, id),
    onLines: (listener) => subscribe(IPC.logsLines, listener),
    onEnd: (listener) => subscribe(IPC.logsEnd, listener),
  },
}

contextBridge.exposeInMainWorld('lumovi', api)

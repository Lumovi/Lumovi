/**
 * The LumoviApi of a page a Lumovi server serves: the calls the
 * desktop app's preload script makes over IPC, over the page's WebSocket.
 * What only a desktop app can do (files, port forwards, updates) isn't there.
 */
import {
  IPC,
  type KubeError,
  type LumoviApi,
  type Result,
  type Settings,
  type ShellExit,
} from '@shared/api'
import { PATHS } from '@shared/server'
import { Connection, LOST, useConnection } from './connection'
import { storedTheme, storeTheme } from './preferences'
import { serverUrl, stillSignedIn } from './session'

/** Dispatched when another tab changes the preferences, for this page to read them again. */
export const SETTINGS_CHANGED = 'lumovi:settings-changed'

/** The computer's operating system, as Node.js names it (for its keyboard shortcuts). */
function platform(): string {
  return /^Mac/.test(navigator.platform)
    ? 'darwin'
    : /^Win/.test(navigator.platform)
      ? 'win32'
      : 'linux'
}

/** The last download's file, kept until the next (the browser may still be saving it). */
let downloaded: string | undefined

/** Saves text as a download. */
function download(name: string, text: string): void {
  if (downloaded) URL.revokeObjectURL(downloaded)
  downloaded = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const link = document.createElement('a')
  link.href = downloaded
  link.download = name
  link.click()
}

export function createWebApi(): LumoviApi {
  // Shells and log streams this page has open: they stop when the connection drops.
  const shells = new Set<string>()
  const streams = new Set<string>()
  const socketUrl = serverUrl(PATHS.socket)
  socketUrl.protocol = socketUrl.protocol.replace('http', 'ws')
  const connection = new Connection(socketUrl.href, stillSignedIn, () => {
    for (const id of shells)
      connection.emit(IPC.terminalExit, id, { message: LOST } satisfies ShellExit)
    for (const id of streams) {
      connection.emit(IPC.logsEnd, id, { code: 'unreachable', message: LOST } satisfies KubeError)
    }
  })
  // Audit events come while a page listens: asked for again on each connection (a new server
  // knows nothing of the last one's).
  let auditListeners = 0
  useConnection.subscribe((now, before) => {
    if (auditListeners > 0 && now.state === 'open' && before.state !== 'open') {
      void connection.invoke(IPC.auditWatch, true)
    }
  })
  connection.on(IPC.terminalExit, (id) => shells.delete(id as string))
  connection.on(IPC.logsEnd, (id) => streams.delete(id as string))
  // Someone changed the clusters' settings, which are everyone's on a server: read them again.
  connection.on(IPC.settingsChanged, () => dispatchEvent(new Event(SETTINGS_CHANGED)))

  const invoke =
    <T>(channel: string) =>
    (...args: unknown[]) =>
      connection.invoke(channel, ...args) as Promise<T>
  const listen =
    <A extends unknown[]>(channel: string) =>
    (listener: (...args: A) => void) =>
      connection.on(channel, listener as (...args: unknown[]) => void)
  /** The server's settings for this page, with the browser's theme. */
  const settings = async (pending: Promise<unknown>): Promise<Settings> => ({
    ...((await pending) as Settings),
    theme: storedTheme(),
  })
  /** Starts a stream, and keeps track of it while it runs. */
  const started = (ids: Set<string>) => async (id: string, pending: Promise<unknown>) => {
    const result = (await pending) as Result<null>
    if (result.ok) ids.add(id)
    return result
  }

  return {
    platform: platform(),
    host: 'server',
    app: {
      info: invoke(IPC.appInfo),
      settings: () => settings(connection.invoke(IPC.settings)),
      setTheme: (theme) => {
        storeTheme(theme)
        return settings(connection.invoke(IPC.settings))
      },
      setReadOnly: (context, readOnly) =>
        settings(connection.invoke(IPC.setReadOnly, context, readOnly)),
      setMetricsSource: (context, setting) =>
        settings(connection.invoke(IPC.setMetricsSource, context, setting)),
      setNodeShell: (context, setting) =>
        settings(connection.invoke(IPC.setNodeShell, context, setting)),
      openExternal: async (url) => {
        // In a tab of its own, which can't reach back into this page.
        window.open(url, '_blank', 'noopener,noreferrer')
        return true
      },
      saveFile: async (name, text) => {
        download(name, text)
        return { ok: true, data: true }
      },
      views: invoke(IPC.views),
    },
    usage: {
      source: invoke(IPC.usageSource),
      test: invoke(IPC.usageTest),
      range: invoke(IPC.usageRange),
      instant: invoke(IPC.usageInstant),
    },
    kube: {
      contexts: invoke(IPC.contexts),
      version: invoke(IPC.version),
      resources: invoke(IPC.resources),
      schema: invoke(IPC.schema),
      list: invoke(IPC.list),
      get: invoke(IPC.get),
      metrics: invoke(IPC.metrics),
      change: invoke(IPC.change),
      can: invoke(IPC.can),
      history: invoke(IPC.history),
    },
    // Answered by servers with a fleet: the page asks only when its session says it has one.
    fleet: {
      summary: invoke(IPC.fleetSummary),
      agents: invoke(IPC.fleetAgents),
      trustAgent: invoke(IPC.fleetTrustAgent),
      joins: invoke(IPC.fleetJoins),
      connect: invoke(IPC.fleetConnect),
      cancelJoin: invoke(IPC.fleetCancelJoin),
      remove: invoke(IPC.fleetRemove),
    },
    // The signed-in person's AI assistants, and the changes they ask for.
    approvals: {
      decide: invoke(IPC.assistantsDecide),
      pending: invoke(IPC.assistantsPending),
      onProposal: listen(IPC.assistantsProposal),
      onOutcome: listen(IPC.assistantsOutcome),
    },
    sponsor: {
      card: invoke(IPC.sponsorCard),
      onChange: listen(IPC.sponsorChanged),
    },
    aiPermissions: {
      get: invoke(IPC.aiPermissionsGet),
      set: invoke(IPC.aiPermissionsSet),
      onChanged: listen(IPC.aiPermissionsChanged),
    },
    audit: {
      info: invoke(IPC.auditInfo),
      query: invoke(IPC.auditQuery),
      verify: invoke(IPC.auditVerify),
      onEvent: (listener) => {
        const off = connection.on(IPC.auditEvent, listener as (...args: unknown[]) => void)
        if (auditListeners++ === 0) void connection.invoke(IPC.auditWatch, true)
        return () => {
          off()
          if (--auditListeners === 0) void connection.invoke(IPC.auditWatch, false)
        }
      },
    },
    access: {
      mine: invoke(IPC.accessMine),
      admin: invoke(IPC.accessAdmin),
      set: invoke(IPC.accessSet),
      history: invoke(IPC.accessHistory),
      onChanged: listen(IPC.accessChanged),
    },
    serverAssistants: {
      status: invoke(IPC.serverAssistantsStatus),
      revoke: invoke(IPC.serverAssistantsRevoke),
      onStatus: listen(IPC.serverAssistantsStatusChanged),
    },
    helm: {
      releases: invoke(IPC.helmReleases),
      release: invoke(IPC.helmRelease),
      cli: invoke(IPC.helmCli),
      rollback: invoke(IPC.helmRollback),
      uninstall: invoke(IPC.helmUninstall),
      deploy: invoke(IPC.helmDeploy),
      defaults: invoke(IPC.helmDefaults),
      versions: invoke(IPC.helmVersions),
      search: invoke(IPC.helmSearch),
    },
    terminal: {
      open: (id, request) => started(shells)(id, connection.invoke(IPC.terminalOpen, id, request)),
      write: (id, data) => connection.send(IPC.terminalInput, id, data),
      resize: (id, columns, rows) => connection.send(IPC.terminalResize, id, columns, rows),
      close: (id) => {
        shells.delete(id)
        connection.send(IPC.terminalClose, id)
      },
      onData: listen(IPC.terminalData),
      onExit: listen(IPC.terminalExit),
    },
    logs: {
      start: (id, request) => started(streams)(id, connection.invoke(IPC.logsStart, id, request)),
      stop: (id) => {
        streams.delete(id)
        connection.send(IPC.logsStop, id)
      },
      onLines: listen(IPC.logsLines),
      onEnd: listen(IPC.logsEnd),
    },
  }
}

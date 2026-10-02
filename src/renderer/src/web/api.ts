/**
 * The KubestacksApi of a page a KubeStacks server serves: the calls the
 * desktop app's preload script makes over IPC, over the page's WebSocket.
 * What only a desktop app can do (files, port forwards, updates) isn't there.
 */
import {
  IPC,
  type KubeError,
  type KubestacksApi,
  type Result,
  type Settings,
  type ShellExit,
} from '@shared/api'
import { PATHS } from '@shared/server'
import { Connection, LOST } from './connection'
import {
  onStoredSettings,
  storedSettings,
  storedTheme,
  storeSettings,
  storeTheme,
} from './preferences'
import { serverUrl, stillSignedIn } from './session'

/** Dispatched when another tab changes the preferences, for this page to read them again. */
export const SETTINGS_CHANGED = 'kubestacks:settings-changed'

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

export function createWebApi(): KubestacksApi {
  // Shells and log streams this page has open: they stop when the connection drops.
  const shells = new Set<string>()
  const streams = new Set<string>()
  const socketUrl = serverUrl(PATHS.socket)
  socketUrl.protocol = socketUrl.protocol.replace('http', 'ws')
  const connection = new Connection(
    socketUrl.href,
    () => ({ type: 'settings', settings: storedSettings() }),
    stillSignedIn,
    () => {
      for (const id of shells)
        connection.emit(IPC.terminalExit, id, { message: LOST } satisfies ShellExit)
      for (const id of streams) {
        connection.emit(IPC.logsEnd, id, { code: 'unreachable', message: LOST } satisfies KubeError)
      }
    },
  )
  connection.on(IPC.terminalExit, (id) => shells.delete(id as string))
  connection.on(IPC.logsEnd, (id) => streams.delete(id as string))
  onStoredSettings(() => {
    connection.greet()
    dispatchEvent(new Event(SETTINGS_CHANGED))
  })

  const invoke =
    <T>(channel: string) =>
    (...args: unknown[]) =>
      connection.invoke(channel, ...args) as Promise<T>
  const listen =
    <A extends unknown[]>(channel: string) =>
    (listener: (...args: A) => void) =>
      connection.on(channel, listener as (...args: unknown[]) => void)
  /** The server's preferences for this page, kept by the browser, with its theme. */
  const settings = async (pending: Promise<unknown>): Promise<Settings> => {
    const current = (await pending) as Settings
    storeSettings(current)
    return { ...current, theme: storedTheme() }
  }
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

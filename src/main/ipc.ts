import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  app,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import { IPC, type AppInfo, type Result } from '@shared/api'
import { handlers, type Backend, type Handler } from '@backend/handlers'
import { toKubeError } from '@backend/kube/errors'
import type { Forwards } from '@backend/kube/streams'
import { assertString, invalid } from '@backend/kube/validate'
import { isTheme } from '@backend/settings'
import type { SettingsStore } from './settings'
import type { Updates } from './updates'

interface Dependencies extends Backend {
  settings: SettingsStore
  forwards: Forwards
  updates: Updates
  /** Only frames showing this URL may call into the main process. */
  rendererUrl: string
}

export function registerIpc(deps: Dependencies): void {
  const { helm, settings, forwards, updates, rendererUrl } = deps
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    event.senderFrame?.url.startsWith(rendererUrl) === true
  const handle = (channel: string, handler: Handler) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error(`Blocked ${channel} from an untrusted frame`)
      return handler(...args)
    })
  }
  /** One-way messages, for keystrokes that shouldn't wait for an answer; others are dropped. */
  const on = (channel: string, handler: Handler) => {
    ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
      if (trusted(event)) handler(...args)
    })
  }

  const shared = handlers(deps)
  // What only the desktop app does: its window, the user's files, and updating itself.
  const desktop: Record<string, Handler> = {
    [IPC.appInfo]: (): AppInfo => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    }),
    [IPC.setTheme]: (theme) => {
      if (!isTheme(theme)) throw new Error(`Unknown theme "${String(theme)}"`)
      nativeTheme.themeSource = theme
      return settings.update({ theme })
    },
    [IPC.openExternal]: async (url) => {
      // Only hand web links to the OS (plain HTTP only for forwarded ports on this machine);
      // never file:// or custom protocol handlers.
      const allowed =
        typeof url === 'string' &&
        (url.startsWith('https://') || /^http:\/\/localhost:\d+(\/|$)/.test(url))
      if (allowed) await shell.openExternal(url)
      return allowed
    },
    [IPC.saveFile]: async (name, text): Promise<Result<boolean>> => {
      try {
        assertString(name, 'name')
        if (typeof text !== 'string') throw invalid('text must be a string')
        // Only a file name is offered; the user picks where it goes.
        const { canceled, filePath } = await dialog.showSaveDialog({
          defaultPath: join(app.getPath('downloads'), basename(name)),
        })
        if (canceled) return { ok: true, data: false }
        await writeFile(filePath, text)
        return { ok: true, data: true }
      } catch (error) {
        return { ok: false, error: toKubeError(error) }
      }
    },
    [IPC.helmChoose]: async (kind) => {
      const archive = kind === 'archive'
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: archive ? 'Choose a packaged chart' : 'Choose a chart folder',
        properties: [archive ? 'openFile' : 'openDirectory'],
        filters: archive ? [{ name: 'Helm charts', extensions: ['tgz'] }] : [],
      })
      return canceled ? null : filePaths[0]
    },
    [IPC.helmLocal]: (path) => helm.local(path),
    [IPC.helmLint]: (path, values) => helm.lint(path, values),
    [IPC.helmValuesFile]: (path, file) => helm.valuesFile(path, file),
    [IPC.helmDependencies]: (path) => helm.updateDependencies(path),
    [IPC.updateState]: () => updates.state(),
    [IPC.updateCheck]: () => updates.check(true),
    [IPC.updateInstall]: () => updates.install(),
    [IPC.forwardStart]: (request) => forwards.start(request),
    [IPC.forwardList]: () => forwards.list(),
    [IPC.forwardStop]: (id) => forwards.stop(id),
  }

  for (const [channel, handler] of Object.entries({ ...shared.invoke, ...desktop })) {
    handle(channel, handler)
  }
  for (const [channel, handler] of Object.entries(shared.send)) on(channel, handler)
}

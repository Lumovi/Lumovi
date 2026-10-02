import { homedir } from 'node:os'
import { app, Menu, nativeTheme, session } from 'electron'
import { IPC } from '@shared/api'
import icon from '../../build/icon.png?asset'
import { HelmService } from '@backend/helm/service'
import { KubeConfigStore } from '@backend/kube/kubeconfig'
import { LogStreams } from '@backend/kube/logs'
import { KubeService } from '@backend/kube/service'
import { Forwards, Terminals } from '@backend/kube/streams'
import { UsageHistory } from '@backend/kube/usage'
import { viewsDirectory } from '@backend/views'
import { registerIpc } from './ipc'
import { buildMenu } from './menu'
import { SettingsStore } from './settings'
import { loadLoginShellPath } from './shell-env'
import { Updates } from './updates'
import { createMainWindow, rendererUrl } from './window'

if (!app.requestSingleInstanceLock()) {
  // Another KubeStacks window is already open; it will be focused instead.
  app.quit()
} else {
  const envReady = loadLoginShellPath()

  app.on('window-all-closed', () => app.quit())

  void app.whenReady().then(() => {
    // The app's own icon in the Dock, also when it runs as plain Electron (npm run dev).
    app.dock?.setIcon(icon)
    const settings = new SettingsStore(app.getPath('userData'))
    nativeTheme.themeSource = settings.get().theme
    // The page needs none of the browser's permissions (camera, notifications…), only to copy.
    const allowed = (permission: string) => permission === 'clipboard-sanitized-write'
    session.defaultSession.setPermissionRequestHandler((_contents, permission, grant) =>
      grant(allowed(permission)),
    )
    session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed(permission))

    const url = rendererUrl()
    const store = new KubeConfigStore()
    const isReadOnly = (context: string) => settings.isReadOnly(context)
    const kube = new KubeService(store, envReady, isReadOnly)
    const usage = new UsageHistory(kube, (context) => settings.metricsSource(context))
    const helm = new HelmService(kube, { envReady, isReadOnly, localCharts: true })
    // The page loads asynchronously, so the handlers below are in place before it can call them.
    const win = createMainWindow(url, settings.get().window, (window) =>
      settings.update({ window }),
    )
    // Streams can end after the window is gone, as the app quits.
    const send = (channel: string, ...args: unknown[]) => {
      if (!win.isDestroyed()) win.webContents.send(channel, ...args)
    }
    const deps = { store, envReady, isReadOnly }
    const terminals = new Terminals(deps, {
      data: (id, data) => send(IPC.terminalData, id, data),
      exit: (id, exit) => send(IPC.terminalExit, id, exit),
    })
    const forwards = new Forwards(deps, (list) => send(IPC.forwardsChanged, list))
    const logs = new LogStreams(
      { ...deps, timeoutMs: kube.timeoutMs },
      {
        lines: (id, lines) => send(IPC.logsLines, id, lines),
        end: (id, error) => send(IPC.logsEnd, id, error),
      },
    )
    const updates = new Updates(
      (event) => send(IPC.updateChanged, event),
      settings.get().autoUpdate!,
    )
    win.on('enter-full-screen', () => send(IPC.fullScreen, true))
    win.on('leave-full-screen', () => send(IPC.fullScreen, false))
    // A page that (re)loads learns how the window is now.
    win.webContents.on('did-finish-load', () => send(IPC.fullScreen, win.isFullScreen()))
    registerIpc({
      kube,
      helm,
      usage,
      settings,
      terminals,
      forwards,
      logs,
      updates,
      viewsDirectory: viewsDirectory(homedir()),
      rendererUrl: url,
    })
    // Shells, forwards and log streams belong to the page that started them.
    const closeStreams = () => {
      terminals.closeAll()
      forwards.stopAll()
      logs.stopAll()
    }
    win.webContents.on('did-start-navigation', (details) => {
      if (!details.isSameDocument) closeStreams()
    })
    app.on('will-quit', closeStreams)
    Menu.setApplicationMenu(buildMenu(win, { updates, settings }))
    app.on('second-instance', () => {
      if (win.isMinimized()) win.restore()
      win.focus()
    })
  })
}

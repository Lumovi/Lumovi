import { homedir } from 'node:os'
import { app, Menu, nativeTheme } from 'electron'
import { IPC } from '@shared/api'
import { registerIpc } from './ipc'
import { KubeConfigStore } from './kube/kubeconfig'
import { KubeService } from './kube/service'
import { UsageHistory } from './kube/usage'
import { Forwards, Terminals } from './kube/streams'
import { buildMenu } from './menu'
import { SettingsStore } from './settings'
import { loadLoginShellPath } from './shell-env'
import { viewsDirectory } from './views'
import { createMainWindow, rendererUrl } from './window'

if (!app.requestSingleInstanceLock()) {
  // Another KubeStacks window is already open; it will be focused instead.
  app.quit()
} else {
  const envReady = loadLoginShellPath()

  app.on('window-all-closed', () => app.quit())

  void app.whenReady().then(() => {
    const settings = new SettingsStore(app.getPath('userData'))
    nativeTheme.themeSource = settings.get().theme

    const url = rendererUrl()
    const store = new KubeConfigStore()
    const isReadOnly = (context: string) => settings.isReadOnly(context)
    const kube = new KubeService(store, envReady, isReadOnly)
    const usage = new UsageHistory(kube, (context) => settings.metricsSource(context))
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
    registerIpc({
      kube,
      usage,
      settings,
      terminals,
      forwards,
      viewsDirectory: viewsDirectory(homedir()),
      rendererUrl: url,
    })
    // Shells and forwards belong to the page that started them.
    const closeStreams = () => {
      terminals.closeAll()
      forwards.stopAll()
    }
    win.webContents.on('did-start-navigation', (details) => {
      if (!details.isSameDocument) closeStreams()
    })
    app.on('will-quit', closeStreams)
    Menu.setApplicationMenu(buildMenu(win))
    app.on('second-instance', () => {
      if (win.isMinimized()) win.restore()
      win.focus()
    })
  })
}

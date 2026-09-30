import { app, nativeTheme } from 'electron'
import { registerIpc } from './ipc'
import { KubeConfigStore } from './kube/kubeconfig'
import { KubeService } from './kube/service'
import { SettingsStore } from './settings'
import { loadLoginShellPath } from './shell-env'
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
    const kube = new KubeService(new KubeConfigStore(), envReady)
    registerIpc({ kube, settings, rendererUrl: url })

    const win = createMainWindow(url)
    app.on('second-instance', () => {
      if (win.isMinimized()) win.restore()
      win.focus()
    })
  })
}

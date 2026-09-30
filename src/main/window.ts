import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, nativeTheme } from 'electron'

/** Keep in sync with the `--app-bg`/`--text-2` tokens in the renderer's theme. */
const CHROME = {
  dark: { color: '#0c0c0e', symbolColor: '#a1a1aa' },
  light: { color: '#f5f5f6', symbolColor: '#52525b' },
}
const TITLE_BAR_HEIGHT = 52

/** The dev server URL under `electron-vite dev`, otherwise the bundled page. */
export function rendererUrl(): string {
  return (
    process.env.ELECTRON_RENDERER_URL ??
    pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href
  )
}

function chrome() {
  return nativeTheme.shouldUseDarkColors ? CHROME.dark : CHROME.light
}

function applyTitleBarColors(win: BrowserWindow): void {
  // macOS draws native traffic lights that follow the theme on their own.
  if (process.platform === 'darwin') return
  win.setTitleBarOverlay({ ...chrome(), height: TITLE_BAR_HEIGHT })
}

export function createMainWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'KubeStacks',
    backgroundColor: chrome().color,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...chrome(), height: TITLE_BAR_HEIGHT },
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  const onThemeUpdated = () => applyTitleBarColors(win)
  nativeTheme.on('updated', onThemeUpdated)
  win.on('closed', () => nativeTheme.off('updated', onThemeUpdated))
  win.once('ready-to-show', () => win.show())

  // Only the app's own page is ever shown: block navigation and pop-ups.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  void win.loadURL(url)
  return win
}

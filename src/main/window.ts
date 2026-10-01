import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, nativeTheme, screen, type Rectangle } from 'electron'
import type { WindowState } from '@shared/api'

/** Keep in sync with the `--app-bg`/`--text-2` tokens in the renderer's theme. */
const CHROME = {
  dark: { color: '#0c0c0e', symbolColor: '#a1a1aa' },
  light: { color: '#f5f5f6', symbolColor: '#52525b' },
}
const TITLE_BAR_HEIGHT = 52

/**
 * The dev server URL under `electron-vite dev`, otherwise the bundled page.
 * A packaged app never loads another page, whatever its environment says.
 */
export function rendererUrl(): string {
  return (
    (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) ||
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

const DEFAULT_SIZE = { width: 1440, height: 920 }

function overlaps(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** Saved bounds, if they are still on a connected display (monitors come and go). */
function restorableBounds(saved: WindowState | undefined): Partial<Rectangle> {
  const visible = saved && screen.getAllDisplays().some((d) => overlaps(d.workArea, saved))
  return visible ? saved : DEFAULT_SIZE
}

export function createMainWindow(
  url: string,
  saved: WindowState | undefined,
  onSaveState: (state: WindowState) => void,
): BrowserWindow {
  const win = new BrowserWindow({
    ...restorableBounds(saved),
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
  win.once('ready-to-show', () => {
    if (saved?.maximized) win.maximize()
    win.show()
  })
  win.on('close', () => onSaveState({ ...win.getNormalBounds(), maximized: win.isMaximized() }))
  // Recover from a crashed or killed renderer instead of leaving a blank window.
  win.webContents.on('render-process-gone', () => win.webContents.reload())

  // Only the app's own page is ever shown: block pop-ups and navigation
  // elsewhere, but let the page reload itself (e.g. from the error page).
  const page = (href: string) => href.split('#')[0]
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => {
    if (page(event.url) !== page(url)) event.preventDefault()
  })

  void win.loadURL(url)
  return win
}

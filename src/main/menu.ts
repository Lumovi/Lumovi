import { Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { SettingsStore } from './settings'
import type { Updates } from './updates'
import { IPC } from '@shared/api'
import { DOCS_URL, REPO_URL, SPONSOR_URL } from '@shared/app'
import { navLabel, QUICK_NAV, type AppCommand } from '@shared/navigation'

/**
 * The native menu. Its commands are sent to the page, which runs them exactly
 * like the matching keyboard shortcuts.
 */
export function buildMenu(
  win: BrowserWindow,
  { updates, settings }: { updates: Updates; settings: SettingsStore },
): Menu {
  // Brought by someone else: the organization's policy, or the Microsoft Store.
  const managedUpdates = settings.get().managed?.updatesOff
    ? 'Updates Are Set by Your Organization'
    : process.windowsStore
      ? 'Updates Come from the Microsoft Store'
      : undefined
  const command = (
    id: AppCommand,
    label: string,
    accelerator?: string,
  ): MenuItemConstructorOptions => ({
    id,
    label,
    accelerator,
    click: () => win.webContents.send(IPC.command, id),
  })
  const link = (id: string, label: string, url: string): MenuItemConstructorOptions => ({
    id,
    label,
    click: () => void shell.openExternal(url),
  })

  const template: MenuItemConstructorOptions[] = [
    // macOS puts About, Hide and Quit under the app's own menu.
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        command('create', 'Create…', 'CmdOrCtrl+N'),
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        command('refresh', 'Refresh', 'CmdOrCtrl+R'),
        command('palette', 'Command Palette…', 'CmdOrCtrl+K'),
        command('filter', 'Filter List'),
        command('terminal', 'Terminal', 'Ctrl+`'),
        command('new-terminal', 'New Terminal', 'Ctrl+Shift+`'),
        // For terminals opened from now on; off, and locked, where the organization's policy says.
        {
          id: 'matching-kubectl',
          label: 'Match kubectl to Each Cluster',
          type: 'checkbox',
          checked: settings.get().matchingKubectl,
          enabled: !settings.get().managed?.kubectlOff,
          click: ({ checked }) => settings.update({ matchingKubectl: checked }),
        },
        { type: 'separator' },
        command('assistants', 'AI Assistants…'),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        command('back', 'Back', 'CmdOrCtrl+['),
        command('forward', 'Forward', 'CmdOrCtrl+]'),
        { type: 'separator' },
        ...QUICK_NAV.map((target, i) =>
          command(`go:${target}`, navLabel(target), `CmdOrCtrl+${i + 1}`),
        ),
        { type: 'separator' },
        command('clusters', 'All Clusters', 'CmdOrCtrl+Shift+C'),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        command('shortcuts', 'Keyboard Shortcuts', 'CmdOrCtrl+/'),
        { type: 'separator' },
        link('docs', 'Documentation', DOCS_URL),
        link('github', 'Lumovi on GitHub', REPO_URL),
        link('issue', 'Report an Issue…', `${REPO_URL}/issues/new/choose`),
        link('sponsor', 'Sponsor Lumovi…', SPONSOR_URL),
        { type: 'separator' },
        // Off, and locked, where the organization's policy deploys new versions.
        {
          id: 'check-updates',
          label: managedUpdates ?? 'Check for Updates…',
          enabled: !managedUpdates,
          click: () => void updates.check(true),
        },
        {
          id: 'auto-updates',
          label: 'Check for Updates Automatically',
          type: 'checkbox',
          checked: settings.get().autoUpdate,
          enabled: !managedUpdates,
          click: ({ checked }) => {
            settings.update({ autoUpdate: checked })
            updates.setAuto(checked)
          },
        },
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}

/**
 * The application menu, opened at a point of the page (in its CSS pixels): Windows and Linux reach
 * it from a button, their window having no menu bar. Done once it closes.
 */
export function popupMenu(win: BrowserWindow, x: number, y: number): Promise<void> {
  const menu = Menu.getApplicationMenu()
  if (!menu) return Promise.resolve()
  // The window's pixels are the page's, zoomed.
  const zoom = win.webContents.getZoomFactor()
  return new Promise((done) =>
    menu.popup({ window: win, x: Math.round(x * zoom), y: Math.round(y * zoom), callback: done }),
  )
}

import { Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { IPC } from '@shared/api'
import { REPO_URL, SPONSOR_URL } from '@shared/app'
import { navLabel, QUICK_NAV, type AppCommand } from '@shared/navigation'

/**
 * The native menu. Its commands are sent to the page, which runs them exactly
 * like the matching keyboard shortcuts.
 */
export function buildMenu(win: BrowserWindow): Menu {
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
        command('create', 'New from YAML…', 'CmdOrCtrl+N'),
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
        link('github', 'KubeStacks on GitHub', REPO_URL),
        link('issue', 'Report an Issue…', `${REPO_URL}/issues/new/choose`),
        link('sponsor', 'Sponsor KubeStacks…', SPONSOR_URL),
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}

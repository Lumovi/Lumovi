import {
  app,
  BrowserWindow,
  Menu,
  shell,
  type BaseWindow,
  type MenuItemConstructorOptions,
} from 'electron'
import type { SettingsStore } from './settings'
import type { Updates } from './updates'
import { IPC } from '@shared/api'
import { DOCS_URL, REPO_URL, SPONSOR_URL } from '@shared/app'
import { navLabel, QUICK_NAV, type AppCommand } from '@shared/navigation'

/**
 * The native menu. Its commands are sent to the page of the window they're chosen in (or the one
 * in front), which runs them exactly like the matching keyboard shortcuts.
 */
export function buildMenu({
  front,
  newWindow,
  updates,
  settings,
}: {
  /** The window in front, or the one last there. */
  front: () => BrowserWindow | undefined
  /** Opens another window. */
  newWindow: () => void
  updates: Updates
  settings: SettingsStore
}): Menu {
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
    click: (_item, chosenIn?: BaseWindow) => {
      const win = chosenIn instanceof BrowserWindow ? chosenIn : front()
      win?.webContents.send(IPC.command, id)
    },
  })
  const link = (id: string, label: string, url: string): MenuItemConstructorOptions => ({
    id,
    label,
    click: () => void shell.openExternal(url),
  })

  const template: MenuItemConstructorOptions[] = [
    // macOS puts About, Settings…, Hide and Quit under the app's own menu.
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              command('settings', 'Settings…', 'CmdOrCtrl+,'),
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          id: 'new-window',
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: newWindow,
        },
        command('create', 'Create…', 'CmdOrCtrl+N'),
        { type: 'separator' },
        ...(process.platform === 'darwin'
          ? []
          : [command('settings', 'Settings…', 'CmdOrCtrl+,'), { type: 'separator' as const }]),
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
        // The text size Settings has too: one setting, kept, in every window.
        command('text-actual', 'Actual Size', 'CmdOrCtrl+0'),
        command('text-bigger', 'Zoom In', 'CmdOrCtrl+Plus'),
        {
          ...command('text-bigger', 'Zoom In', 'CmdOrCtrl+='),
          id: 'text-bigger-equals',
          visible: false,
        },
        command('text-smaller', 'Zoom Out', 'CmdOrCtrl+-'),
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

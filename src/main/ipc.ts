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
import { describePermissions } from '@backend/audit/describe'
import { auditHandlers } from '@backend/audit/handlers'
import type { AuditLog } from '@backend/audit/log'
import { handlers, type Backend, type Handler } from '@backend/handlers'
import { toKubeError } from '@backend/kube/errors'
import type { Forwards } from '@backend/kube/streams'
import { assertString, invalid } from '@backend/kube/validate'
import { isTheme } from '@backend/settings'
import type { AiPermissionsView } from '@shared/ai-permissions'
import { isPort } from '@shared/assistants'
import { checkedDecision } from '@backend/mcp/approvals'
import type { Assistants } from './assistants'
import { LocalTerminals } from './local-terminal'
import type { SettingsStore } from './settings'
import type { TerminalKeys } from './terminal-keys'
import type { Updates } from './updates'

interface Dependencies extends Backend {
  assistants: Assistants
  settings: SettingsStore
  local: LocalTerminals
  terminalKeys: TerminalKeys
  forwards: Forwards
  updates: Updates
  /** The audit log itself, for the Audit page (everything in it is this computer's person's). */
  auditLog: AuditLog
  /** Tells the page of something. */
  send: (channel: string, ...args: unknown[]) => void
  /** Only frames showing this URL may call into the main process. */
  rendererUrl: string
  /** What couldn't be set up as Lumovi started, once the network is. */
  problems: () => Promise<string[]>
}

export function registerIpc(deps: Dependencies): void {
  const {
    assistants,
    helm,
    settings,
    terminals,
    local,
    terminalKeys,
    forwards,
    updates,
    rendererUrl,
    problems,
    audit,
    auditLog,
    send,
  } = deps
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
    [IPC.appProblems]: () => problems(),
    [IPC.updateCheck]: () => updates.check(true),
    [IPC.updateInstall]: () => updates.install(),
    // Terminals on this computer, besides the cluster's shells (each ignores the other's).
    [IPC.terminalOpen]: (id, request) =>
      LocalTerminals.handles(request) ? local.open(id, request) : terminals.open(id, request),
    // AI assistants over MCP: whether and where they connect, and the changes they ask for.
    [IPC.assistantsStatus]: () => assistants.status(),
    [IPC.assistantsConfigure]: async (change) => {
      const { enabled, port } = Object(change) as { enabled?: unknown; port?: unknown }
      if (
        (enabled !== undefined && typeof enabled !== 'boolean') ||
        (port !== undefined && !isPort(port))
      ) {
        throw new Error('Expected whether assistants may connect, and a port from 1024 to 65535')
      }
      const status = await assistants.configure({
        ...(enabled !== undefined ? { enabled } : {}),
        ...(port !== undefined ? { port } : {}),
      })
      // As it came out: a port that can't be listened on, say.
      audit.record({
        action: 'assistants.changed',
        outcome: status.error ? 'failure' : 'success',
        ...(status.error ? { error: status.error } : {}),
        summary: [
          ...(enabled === undefined
            ? []
            : [enabled ? 'Let AI assistants connect' : 'Stopped AI assistants connecting']),
          ...(port === undefined ? [] : [`Moved where AI assistants connect to port ${port}`]),
        ].join('; '),
        details: {
          ...(enabled !== undefined ? { enabled } : {}),
          ...(port !== undefined ? { port } : {}),
        },
      })
      return status
    },
    [IPC.assistantsResetToken]: async () => {
      const status = await assistants.resetToken()
      audit.record({
        action: 'assistants.changed',
        outcome: 'success',
        summary: 'Made a new token for AI assistants: those set up with the old one can’t connect',
      })
      return status
    },
    [IPC.assistantsInstall]: (client) => {
      if (client !== 'claude-desktop' && client !== 'cursor' && client !== 'vscode') {
        throw new Error(`Lumovi can’t set ${String(client)} up itself`)
      }
      return assistants.install(client)
    },
    // What they may do, and where: kept with the app's settings.
    [IPC.aiPermissionsGet]: () => aiPermissions(),
    [IPC.aiPermissionsSet]: (given) => {
      settings.setAiPermissions(given)
      audit.record(describePermissions(settings.aiPermissions()))
      return aiPermissions()
    },
    [IPC.assistantsDecide]: (id, decision) =>
      assistants.approvals.decide(...checkedDecision(id, decision)),
    [IPC.assistantsPending]: () => assistants.approvals.pending(),
    [IPC.forwardStart]: (request) => forwards.start(request),
    [IPC.forwardList]: () => forwards.list(),
    [IPC.forwardStop]: (id) => forwards.stop(id),
  }

  function aiPermissions(): AiPermissionsView {
    return {
      mine: settings.aiPermissions(),
      admin: settings.adminRules(),
      kept: 'settings',
      ...(settings.aiPermissionsUnreadable()
        ? {
            problem:
              'Your AI permissions couldn’t be read (Lumovi’s settings were edited into something that doesn’t make sense): assistants may do nothing until you set them again.',
          }
        : {}),
    }
  }

  // Everything in this computer's audit log is its person's: they read all of it.
  const auditing = auditHandlers(auditLog, { everyone: true, may: () => true }, send)
  for (const [channel, handler] of Object.entries({
    ...shared.invoke,
    ...auditing.invoke,
    ...desktop,
  })) {
    handle(channel, handler)
  }
  const desktopSend: Record<string, Handler> = {
    [IPC.terminalInput]: (id, data) => {
      terminals.write(id, data)
      local.write(id, data)
    },
    [IPC.terminalResize]: (id, columns, rows) => {
      terminals.resize(id, columns, rows)
      local.resize(id, columns, rows)
    },
    [IPC.terminalClose]: (id) => {
      terminals.close(id)
      local.close(id)
    },
    [IPC.terminalFocus]: (focused) => terminalKeys.focus(focused),
  }
  for (const [channel, handler] of Object.entries({ ...shared.send, ...desktopSend })) {
    on(channel, handler)
  }
}

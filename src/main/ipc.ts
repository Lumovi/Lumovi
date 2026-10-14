import { opensExternally } from '@shared/external'
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
import {
  IPC,
  type AppInfo,
  type Result,
  type SavedFile,
  type WarningNoticesState,
} from '@shared/api'
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
import type { SponsorSource } from '@backend/sponsor/source'
import type { Assistants } from './assistants'
import type { AddedClusters } from './added-clusters'
import type { DesktopFiles } from './file-copies'
import type { KubeconfigFiles } from './kubeconfig-files'
import { LocalTerminals } from './local-terminal'
import { SavedFiles } from './saved-files'
import type { SettingsStore } from './settings'
import type { TerminalKeys } from './terminal-keys'
import type { PluginStore } from './plugin-store'
import type { AgreedPlugins } from './plugins-agreed'
import type { PluginsWatch } from './plugins-watch'
import { InstallError, type InstalledPlugins } from './plugins-installed'
import type { Updates } from './updates'
import type { Windows } from './windows'

interface Dependencies extends Backend {
  assistants: Assistants
  /** The kubeconfig files read: chosen here, or KUBECONFIG's. */
  kubeconfigFiles: KubeconfigFiles
  /** Clusters added in Lumovi, each a kubeconfig of its own. */
  addedClusters: AddedClusters
  settings: SettingsStore
  local: LocalTerminals
  terminalKeys: TerminalKeys
  forwards: Forwards
  /** What's saved and picked on this computer, for files copied out of and into containers. */
  localFiles: DesktopFiles
  updates: Updates
  /** What's newer in Lumovi-plugins, for the Plugins page. */
  pluginStore: PluginStore
  /** What's installed from it. */
  installed: InstalledPlugins
  /** What the person agreed to run of their own plugins' code. */
  agreed: AgreedPlugins
  /** Their plugins folder, watched in Developer mode. */
  pluginsWatch: PluginsWatch
  sponsor: SponsorSource
  /** The audit log itself, for the Audit page (everything in it is this computer's person's). */
  auditLog: AuditLog
  /** Lumovi's windows: each stream is told to the page that started it alone. */
  windows: Windows
  /** Tells every window's page of something. */
  send: (channel: string, ...args: unknown[]) => void
  /** Opens another window. */
  newWindow: () => void
  /** How a cluster's notifications of new warnings stand. */
  warningNotices: (context: string) => WarningNoticesState
  /** Opens the app's menu at a point of the page; done once it closes. */
  openMenu: (x: number, y: number) => Promise<void>
  /** Only frames showing this URL may call into the main process. */
  rendererUrl: string
  /** What couldn't be set up as Lumovi started, once the network is. */
  problems: () => Promise<string[]>
}

/** Whether it's a list of strings. */
/** What starts a stream by an id the page picked: a shell, a log, a copy out or in. */
const STARTED_BY_ID = new Set<string>([
  IPC.terminalOpen,
  IPC.logsStart,
  IPC.watchStart,
  IPC.filesDownload,
  IPC.filesUpload,
])

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

export function registerIpc(deps: Dependencies): void {
  const {
    assistants,
    kubeconfigFiles,
    addedClusters,
    helm,
    settings,
    terminals,
    local,
    terminalKeys,
    forwards,
    localFiles,
    updates,
    pluginStore,
    installed,
    agreed,
    pluginsWatch,
    sponsor,
    rendererUrl,
    problems,
    audit,
    auditLog,
    send,
    openMenu,
    newWindow,
    windows,
  } = deps
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    event.senderFrame?.url.startsWith(rendererUrl) === true
  const handle = (channel: string, handler: Handler) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!trusted(event)) throw new Error(`Blocked ${channel} from an untrusted frame`)
      // A stream is the page's that starts it (by the id the page picked): it alone hears of
      // it, from before it's started; never one another window's page is still hearing. One
      // that doesn't start owns nothing. A forward's id is the one it's given.
      const id = STARTED_BY_ID.has(channel) && typeof args[0] === 'string' ? args[0] : undefined
      if (id !== undefined && !windows.own(id, event.sender)) {
        throw new Error(`Blocked ${channel}: that stream is another window's`)
      }
      let result: unknown
      try {
        result = await handler(...args)
      } catch (error) {
        if (id !== undefined) windows.disown(id, event.sender)
        throw error
      }
      const failed = (result as { ok?: unknown } | undefined)?.ok === false
      if (id !== undefined && failed) windows.disown(id, event.sender)
      if (channel === IPC.forwardStart && !failed) {
        windows.own((result as Result<{ id: string }> & { ok: true }).data.id, event.sender)
      }
      return result
    })
  }
  /** One-way messages, for keystrokes that shouldn't wait for an answer; others are dropped. */
  const on = (channel: string, handler: Handler) => {
    ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
      if (trusted(event)) handler(...args)
    })
  }

  const shared = handlers(deps)
  const saved = new SavedFiles((path) => shell.showItemInFolder(path))
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
    [IPC.openMenu]: (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error('The menu opens at a point of the page: two numbers')
      }
      return openMenu(x as number, y as number)
    },
    [IPC.newWindow]: () => newWindow(),
    [IPC.setTheme]: (theme) => {
      if (!isTheme(theme)) throw new Error(`Unknown theme "${String(theme)}"`)
      nativeTheme.themeSource = theme
      return settings.update({ theme })
    },
    [IPC.openExternal]: async (url) => {
      // Only hand web links to the OS (plain HTTP only for forwarded ports on this machine);
      // never file:// or custom protocol handlers.
      const allowed = opensExternally(url)
      if (allowed) await shell.openExternal(url)
      return allowed
    },
    [IPC.saveFile]: async (name, text): Promise<Result<SavedFile | null>> => {
      try {
        assertString(name, 'name')
        if (typeof text !== 'string') throw invalid('text must be a string')
        // Only a file name is offered; the user picks where it goes.
        const { canceled, filePath } = await dialog.showSaveDialog({
          defaultPath: join(app.getPath('downloads'), basename(name)),
        })
        if (canceled) return { ok: true, data: null }
        await writeFile(filePath, text)
        return { ok: true, data: { name: basename(filePath), token: saved.record(filePath) } }
      } catch (error) {
        return { ok: false, error: toKubeError(error) }
      }
    },
    [IPC.showSaved]: (token) => saved.show(token),
    [IPC.setCluster]: (context, clusterSettings) => {
      assertString(context, 'context')
      try {
        return { ok: true, data: settings.setCluster(context, clusterSettings) }
      } catch (error) {
        return { ok: false, error: { code: 'invalid', message: (error as Error).message } }
      }
    },
    [IPC.warningNotices]: (context) => {
      assertString(context, 'context')
      return deps.warningNotices(context)
    },
    [IPC.kubeconfigFiles]: () => kubeconfigFiles.list(),
    [IPC.kubeconfigChoose]: (how) => {
      if (how !== 'replace' && how !== 'add') throw invalid('how must be replace or add')
      return kubeconfigFiles.choose(how)
    },
    [IPC.kubeconfigRemove]: (path) => {
      assertString(path, 'path')
      return kubeconfigFiles.remove(path)
    },
    [IPC.kubeconfigUseDefault]: () => kubeconfigFiles.useDefault(),
    [IPC.kubeconfigShow]: (path) => {
      assertString(path, 'path')
      kubeconfigFiles.show(path)
    },
    [IPC.kubeconfigChooseAgain]: (path) => {
      assertString(path, 'path')
      return kubeconfigFiles.chooseAgain(path)
    },
    [IPC.kubeconfigAddFolder]: () => kubeconfigFiles.addFolder(),
    [IPC.kubeconfigAsks]: (context) => {
      assertString(context, 'context')
      return kubeconfigFiles.asks(context)
    },
    [IPC.kubeconfigAgree]: (context, consents) => {
      assertString(context, 'context')
      if (!isStrings(consents)) throw invalid('consents must be strings')
      return kubeconfigFiles.agree(context, consents)
    },
    [IPC.addedImport]: () => addedClusters.import(),
    [IPC.addedInspect]: (text, editing) => {
      assertString(text, 'text')
      if (editing !== undefined) assertString(editing, 'editing')
      return addedClusters.inspect(text, editing)
    },
    [IPC.addedCheck]: (text, context, agreed, editing) => {
      assertString(text, 'text')
      assertString(context, 'context')
      if (!isStrings(agreed)) throw invalid('agreed must be what was agreed to')
      if (editing !== undefined) assertString(editing, 'editing')
      return addedClusters.check(text, context, agreed, editing)
    },
    [IPC.addedAdd]: (text, options) => {
      assertString(text, 'text')
      const { contexts, names, agreed } = (options ?? {}) as Record<string, unknown>
      if (contexts !== undefined && !isStrings(contexts)) throw invalid('contexts must be names')
      if (
        names !== undefined &&
        (typeof names !== 'object' || names === null || !isStrings(Object.values(names)))
      ) {
        throw invalid('names must map names to names')
      }
      if (!isStrings(agreed)) throw invalid('agreed must be what was agreed to')
      return addedClusters.add(text, {
        ...(contexts ? { contexts } : {}),
        ...(names ? { names: names as Record<string, string> } : {}),
        agreed,
      })
    },
    [IPC.addedRead]: (path) => {
      assertString(path, 'path')
      return addedClusters.read(path)
    },
    [IPC.addedEdit]: (path, text, agreed) => {
      assertString(path, 'path')
      assertString(text, 'text')
      if (!isStrings(agreed)) throw invalid('agreed must be what was agreed to')
      return addedClusters.edit(path, text, agreed)
    },
    [IPC.addedRemove]: (path) => {
      assertString(path, 'path')
      return addedClusters.remove(path)
    },
    [IPC.addedForKubectl]: (path) => {
      if (path !== undefined) assertString(path, 'path')
      return addedClusters.forKubectl(path)
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
    [IPC.pluginStore]: (now) => pluginStore.check(now === true),
    // Installed, updated, taken back or removed: each only on the person's press, and checked here.
    [IPC.pluginInstall]: (name, version, agreed) =>
      typeof name === 'string' && typeof version === 'string' && typeof agreed === 'string'
        ? installed.install(name, version, agreed)
        : Promise.reject(new InstallError('Lumovi didn’t understand what to install.')),
    // (Back to the copy kept only with what it asks that the person was shown: the main holds it.)
    [IPC.pluginGoBack]: (name, to, agreed) =>
      typeof name !== 'string'
        ? Promise.reject(new InstallError('Lumovi didn’t understand what to go back to.'))
        : to === 'lumovi'
          ? installed.goBack(name, 'lumovi')
          : to === 'kept'
            ? installed.goBack(name, 'kept', typeof agreed === 'string' ? agreed : undefined)
            : Promise.reject(new InstallError('Lumovi didn’t understand what to go back to.')),
    [IPC.pluginRemove]: (name) =>
      typeof name === 'string'
        ? installed.remove(name)
        : Promise.reject(new InstallError('Lumovi didn’t understand what to remove.')),
    // Developer mode, and agreeing to run a person's own plugin's code: checked here, as the main
    // process reads that plugin now.
    [IPC.pluginDeveloperMode]: (on) => {
      if (typeof on !== 'boolean')
        return Promise.reject(new Error('Lumovi didn’t understand that.'))
      const updated = settings.setPluginDeveloperMode(on)
      // (Their folder watched while it's on, as the page reads them again.)
      pluginsWatch.set(settings.pluginDeveloperMode())
      return updated
    },
    [IPC.pluginOwnCode]: (name) => agreed.ownCode(name),
    [IPC.pluginAgree]: (name, asks, code) => agreed.agree(name, asks, code),
    [IPC.sponsorCard]: () => sponsor.card(),
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
    [IPC.filesPick]: (what) => localFiles.pick(what),
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

  // Everything in this computer's audit log is its person's: they read all of it. Its events are
  // told as they're recorded while a page of any window watches (each says when it stops).
  const auditing = auditHandlers(auditLog, { everyone: true, may: () => true }, send)
  const { [IPC.auditWatch]: watch, ...audited } = auditing.invoke
  const watching = new Map<number, () => void>()
  const watchNow = (on: boolean) => void watch!(on)
  ipcMain.handle(IPC.auditWatch, (event: IpcMainInvokeEvent, on: unknown) => {
    if (!trusted(event)) throw new Error(`Blocked ${IPC.auditWatch} from an untrusted frame`)
    const page = event.sender
    const before = watching.size > 0
    if (on === true && !watching.has(page.id)) {
      // (A page that goes, reloaded or closed, watches no more: a move within it is no going.)
      const gone = () => stop()
      const left = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) stop()
      }
      const stop = () => {
        page.off('destroyed', gone)
        page.off('did-start-navigation', left)
        watching.delete(page.id)
        if (watching.size === 0) watchNow(false)
      }
      page.once('destroyed', gone)
      page.on('did-start-navigation', left)
      watching.set(page.id, stop)
    } else if (on !== true) {
      watching.get(page.id)?.()
    }
    if (!before && watching.size > 0) watchNow(true)
  })
  for (const [channel, handler] of Object.entries({ ...shared.invoke, ...audited, ...desktop })) {
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
    [IPC.filesShow]: (saved) => localFiles.show(saved),
  }
  for (const [channel, handler] of Object.entries({ ...shared.send, ...desktopSend })) {
    on(channel, handler)
  }
  // What a page has below is its window's: kept as it says, and given back to it once (with where
  // it was) as Lumovi opens that window again.
  ipcMain.on(IPC.keepBelow, (event: IpcMainEvent, below: unknown) => {
    if (trusted(event)) windows.keepBelow(event.sender, below)
  })
  ipcMain.handle(IPC.restored, (event: IpcMainInvokeEvent) => {
    if (!trusted(event)) throw new Error(`Blocked ${IPC.restored} from an untrusted frame`)
    return windows.takeRestored(event.sender) ?? {}
  })
  // Whether a page's terminal has focus is that page's own: its window's ⌘ keys follow it.
  const focusing = new Set<number>()
  ipcMain.on(IPC.terminalFocus, (event: IpcMainEvent, focused: unknown) => {
    if (!trusted(event)) return
    const page = event.sender
    terminalKeys.focus(page.id, focused)
    if (focusing.has(page.id)) return
    focusing.add(page.id)
    page.once('destroyed', () => {
      focusing.delete(page.id)
      terminalKeys.focus(page.id, false)
    })
  })
}

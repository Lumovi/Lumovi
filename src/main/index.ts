import { existsSync, readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { app, dialog, Menu, nativeTheme, Notification, session, shell } from 'electron'
import { IPC, type ShellExit } from '@shared/api'
import { AUDIT_EXPORT_LIMIT } from '@shared/audit'
import icon from '../../build/icon.png?asset'
import { AuditLog } from '@backend/audit/log'
import { recorder } from '@backend/audit/recorder'
import { FileStore, MemoryStore, type AuditStore } from '@backend/audit/store'
import { HelmService } from '@backend/helm/service'
import { KubeConfigStore } from '@backend/kube/kubeconfig'
import { LogStreams } from '@backend/kube/logs'
import { KubeService } from '@backend/kube/service'
import { Forwards, Terminals } from '@backend/kube/streams'
import { UsageHistory } from '@backend/kube/usage'
import { setUpNetwork } from '@backend/network'
import { SponsorSource, sponsorSource } from '@backend/sponsor/source'
import { viewsDirectory } from '@backend/views'
import { Assistants } from './assistants'
import { registerIpc } from './ipc'
import { KubeconfigFiles } from './kubeconfig-files'
import { AddedClusters, ownKubeconfigs } from './added-clusters'
import { runStdio, STDIO } from './mcp-stdio'
import { KUBECTL_MIRROR, Kubectls } from './kubectl'
import type { TrustRoot } from './kubectl-signature'
import SIGSTORE_ROOT from './sigstore-root.json'
import { LocalTerminals } from './local-terminal'
import { TerminalKeys } from './terminal-keys'
import { chromiumProxy, proxyCredentials } from './chromium-proxy'
import { buildMenu } from './menu'
import { readPolicy } from './policy'
import { SettingsStore } from './settings'
import { loadLoginShellEnv } from './shell-env'
import { Updates } from './updates'
import { createMainWindow, rendererUrl } from './window'

// Started by an assistant that talks to Lumovi over stdio (Claude Desktop): no window, nor the
// single instance, which the app's (if it's running) is.
const stdio = process.argv.find((arg) => arg.startsWith(STDIO))
if (stdio) {
  // Storage of its own: the app's is the app's.
  app.setPath('userData', join(app.getPath('temp'), 'lumovi-mcp-stdio'))
  app.dock?.hide()
  void runStdio({
    settings: stdio.slice(STDIO.length),
    waitMs: Number(process.env.LUMOVI_MCP_WAIT_MS) || 30_000,
    input: process.stdin,
    output: process.stdout,
  }).finally(() => app.quit())
} else if (!app.requestSingleInstanceLock()) {
  // Another Lumovi window is already open; it will be focused instead.
  app.quit()
} else {
  const shellReady = loadLoginShellEnv()

  app.on('window-all-closed', () => app.quit())

  void app.whenReady().then(async () => {
    // The app's own icon in the Dock, also when it runs as plain Electron (npm run dev).
    app.dock?.setIcon(icon)
    // What the organization's policy sets on this computer: locked, whatever was kept.
    const policy = readPolicy()
    // What couldn't be set up, for the page to say as well.
    const problems: string[] = []
    const problem = (message: string) => {
      console.warn(message)
      problems.push(message)
    }
    if (policy.managed?.problem) problem(policy.managed.problem)
    const settings = new SettingsStore(app.getPath('userData'), process.env, policy)
    nativeTheme.themeSource = settings.get().theme
    // The page needs none of the browser's permissions (camera, notifications…), only to copy.
    const allowed = (permission: string) => permission === 'clipboard-sanitized-write'
    session.defaultSession.setPermissionRequestHandler((_contents, permission, grant) =>
      grant(allowed(permission)),
    )
    session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed(permission))

    const url = rendererUrl()
    // The kubeconfig files chosen in Lumovi, or else KUBECONFIG's, or ~/.kube/config; then those
    // added; then the clusters added in Lumovi, each a file of its own.
    const kubeconfigs = join(app.getPath('userData'), 'clusters')
    const store = new KubeConfigStore(process.env, () => ({
      ...settings.kubeconfigFiles(),
      own: ownKubeconfigs(kubeconfigs, policy.managed),
    }))
    const kubeconfigFiles = new KubeconfigFiles({
      settings,
      store,
      managed: policy.managed,
      pick: async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog({
          title: 'Choose a kubeconfig',
          defaultPath: join(homedir(), '.kube'),
          // A kubeconfig's often a dotfile, or has no extension.
          properties: ['openFile', 'multiSelections', 'showHiddenFiles'],
        })
        return canceled ? null : filePaths
      },
      reveal: (path) => shell.showItemInFolder(path),
      ownFolder: kubeconfigs,
    })
    const addedClusters = new AddedClusters({
      folder: kubeconfigs,
      store,
      files: kubeconfigFiles,
      managed: policy.managed,
      pick: async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog({
          title: 'Import a kubeconfig',
          defaultPath: join(homedir(), '.kube'),
          properties: ['openFile', 'showHiddenFiles'],
        })
        return canceled ? null : (filePaths[0] ?? null)
      },
    })
    // Once the login shell's PATH and proxy are known: the network set up (the system's
    // certificate authorities trusted, the proxy gone through), and the kubeconfig read again
    // with it, before anything waiting for it connects.
    const envReady = shellReady.then(() => {
      // The organization's network, over what the login shell says.
      const { proxy, noProxy, caFiles } = policy.network
      if (proxy) {
        for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
          process.env[name] = proxy
        }
      }
      if (noProxy !== undefined) process.env.NO_PROXY = process.env.no_proxy = noProxy
      // What can't be used (a certificate authority's file, say) is said, and the rest set up.
      const network = setUpNetwork(process.env, { caFiles, problem })
      for (const said of network.said) console.warn(said)
      store.load()
    })
    const isReadOnly = (context: string) => settings.isReadOnly(context)
    const kube = new KubeService(store, envReady, isReadOnly)
    // What's done through Lumovi on this computer: kept in its folder, for the Audit page.
    const auditLog = new AuditLog({
      store: await auditStore(join(app.getPath('userData'), 'audit')),
      sinks: [],
      level: 'access',
      scanLimit: 200_000,
      exportLimit: AUDIT_EXPORT_LIMIT,
      // Its own history failing is said where the app says what goes wrong.
      warn: console.warn,
    })
    const user = userInfo().username
    /** This computer's person, as each cluster knows them: its kubeconfig's user. */
    const actor =
      (via: 'ui' | 'assistant', assistant?: string) => (cluster: string | undefined) => ({
        user,
        via,
        ...(assistant ? { assistant } : {}),
        ...(cluster === undefined
          ? {}
          : { kubeUser: kube.contexts().contexts.find((c) => c.name === cluster)?.user }),
      })
    const audit = recorder(auditLog, actor('ui'))
    const usage = new UsageHistory(kube, (context) => settings.metricsSource(context))
    // The helm Lumovi ships with, next to it (a build from source has none: helm on the PATH).
    const shipped = join(
      process.resourcesPath,
      'helm',
      process.platform === 'win32' ? 'helm.exe' : 'helm',
    )
    const helm = new HelmService(kube, {
      envReady,
      isReadOnly,
      localCharts: true,
      command: existsSync(shipped) ? shipped : undefined,
    })
    // The page loads asynchronously, so the handlers below are in place before it can call them.
    const win = createMainWindow(url, settings.get().window, (window) =>
      settings.update({ window }),
    )
    // Streams can end after the window is gone, as the app quits.
    const send = (channel: string, ...args: unknown[]) => {
      if (!win.isDestroyed()) win.webContents.send(channel, ...args)
    }
    const deps = { store, envReady, isReadOnly, audit }
    const shellEvents = {
      data: (id: string, data: string) => send(IPC.terminalData, id, data),
      exit: (id: string, exit: ShellExit) => send(IPC.terminalExit, id, exit),
    }
    const terminals = new Terminals(
      { ...deps, nodeShell: (context) => settings.nodeShell(context), timeoutMs: kube.timeoutMs },
      shellEvents,
    )
    // Terminals' kubectl, matching each cluster's version, from the policy's mirror if it says.
    const kubectls = new Kubectls({
      dir: join(app.getPath('userData'), 'kubectl'),
      mirror: () =>
        // (An empty one is as good as none.)
        policy.managed?.kubectlMirror || process.env.LUMOVI_KUBECTL_MIRROR || KUBECTL_MIRROR,
      // A mirror's kubectl too only with Kubernetes' signature, where the policy says.
      signaturesRequired: () => policy.managed?.kubectlSignatures === 'required',
      // The e2e tests' stand-ins for dl.k8s.io and Sigstore's trust root: never a packaged app's.
      official: (!app.isPackaged && process.env.LUMOVI_KUBECTL_OFFICIAL) || KUBECTL_MIRROR,
      trust:
        !app.isPackaged && process.env.LUMOVI_SIGSTORE_ROOT
          ? (JSON.parse(readFileSync(process.env.LUMOVI_SIGSTORE_ROOT, 'utf8')) as TrustRoot)
          : SIGSTORE_ROOT,
      clusterVersion: async (context) => {
        const version = await kube.version(context)
        if (!version.ok) throw new Error(version.error.message)
        return version.data.gitVersion
      },
    })
    const local = new LocalTerminals(
      {
        store,
        envReady,
        kubectl: (context, getting) =>
          settings.get().matchingKubectl ? kubectls.for(context, getting) : undefined,
        env: process.env,
        isReadOnly,
        version: app.getVersion(),
        helm: () => helm.command,
      },
      shellEvents,
    )
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
      // The organization's, as its policy says; the Store's, for the copy it installed.
      settings.get().managed?.updatesOff
        ? 'organization'
        : process.windowsStore
          ? 'store'
          : undefined,
    )
    // The sidebar's sponsor card, from Lumovi/main-sponsor: what was read last time at once, read
    // again soon after starting (once the network is set up, as the updater does) and every hour.
    const { base, everyMs } = sponsorSource(process.env)
    const sponsor = new SponsorSource({
      base,
      dir: join(app.getPath('userData'), 'sponsor'),
      ready: envReady,
      firstMs: Math.min(SPONSOR_FIRST_MS, everyMs),
      everyMs,
    })
    sponsor.onChange((card) => send(IPC.sponsorChanged, card))
    sponsor.start()
    // What Chromium fetches (the updater, in its own session) goes through the policy's proxy
    // too, not the shell's; its credentials only for it.
    const { proxy, noProxy } = policy.network
    if (proxy) {
      app.on('login', (event, _contents, _details, auth, callback) => {
        const credentials = proxyCredentials(proxy, auth)
        if (!credentials) return
        event.preventDefault()
        callback(...credentials)
      })
      updates.onLogin((auth) => proxyCredentials(proxy, auth))
      // At once: it's the policy's alone, not waiting on the shell, before the first check.
      void chromiumProxy(proxy, noProxy ?? '', [session.defaultSession, updates.session])
    }
    // A focused terminal's ⌘ keys are its own, before the menu's.
    const terminalKeys = new TerminalKeys()
    win.webContents.on('before-input-event', (event, input) => {
      const command = terminalKeys.command(input)
      if (!command) return
      event.preventDefault()
      send(IPC.command, command)
    })
    win.on('enter-full-screen', () => send(IPC.fullScreen, true))
    win.on('leave-full-screen', () => send(IPC.fullScreen, false))
    // A page that (re)loads learns how the window is now.
    win.webContents.on('did-finish-load', () => send(IPC.fullScreen, win.isFullScreen()))
    // AI assistants on this computer, over MCP. How the app is started again, should
    // Claude Desktop's bridge find it isn't running: as it was this time.
    settings.update({ assistants: { ...settings.get().assistants!, launch: process.argv } })
    const reveal = () => {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    // Notifications of changes waiting, kept (one let go can't be clicked) until the person
    // comes to Lumovi, when they've done their job.
    const notices = new Set<Notification>()
    win.on('focus', () => {
      for (const notice of notices) notice.close()
      notices.clear()
    })
    const assistants = new Assistants({
      settings,
      kube,
      // As this computer's person, through the assistant (named once it says who it is).
      audit: (name) => recorder(auditLog, (cluster) => actor('assistant', name())(cluster)),
      version: app.getVersion(),
      send,
      // A change waiting for an answer, while the person is elsewhere (in their assistant).
      attention: (proposal) => {
        if (win.isFocused()) return
        const notice = new Notification({
          title: `${proposal.client} asks to change ${proposal.context}`,
          body: `${proposal.title}. Review it in Lumovi.`,
        })
        notice.on('click', reveal)
        notices.add(notice)
        notice.show()
        app.dock?.bounce('informational')
      },
      open: (url) => shell.openExternal(url),
      // Windows' main process can't read stdin: there, Lumovi runs its bridge as Node.
      stdio:
        process.platform === 'win32'
          ? {
              command: process.execPath,
              args: [
                join(
                  app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'),
                  'out',
                  'mcp-stdio',
                  'bridge.cjs',
                ),
                app.getPath('userData'),
              ],
              env: { ELECTRON_RUN_AS_NODE: '1' },
            }
          : {
              command: process.execPath,
              args: [...process.argv.slice(1), `${STDIO}${app.getPath('userData')}`],
            },
      claudeDesktopConfig: process.env.LUMOVI_CLAUDE_DESKTOP_CONFIG ?? claudeDesktopConfig(),
    })
    void assistants.start()
    registerIpc({
      problems: () => envReady.then(() => problems),
      kubeconfigFiles,
      addedClusters,
      assistants,
      kube,
      helm,
      usage,
      settings,
      terminals,
      local,
      terminalKeys,
      forwards,
      logs,
      updates,
      sponsor,
      viewsDirectory: viewsDirectory(homedir()),
      rendererUrl: url,
      audit,
      auditLog,
      send,
    })
    // Shells, forwards and log streams belong to the page that started them.
    const closeStreams = () => {
      void terminals.closeAll()
      local.closeAll()
      forwards.stopAll()
      logs.stopAll()
    }
    win.webContents.on('did-start-navigation', (details) => {
      if (!details.isSameDocument) closeStreams()
    })
    // Node shells' pods are deleted as their shells end: quitting waits for that (a few
    // seconds at most; their deadline ends any that are left).
    let waited = false
    app.on('will-quit', (event) => {
      closeStreams()
      void assistants.stop()
      void auditLog.close()
      if (waited || !terminals.cleaning) return
      waited = true
      event.preventDefault()
      void Promise.race([
        terminals.closeAll(),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]).then(() => app.quit())
    })
    Menu.setApplicationMenu(buildMenu(win, { updates, settings }))
    app.on('second-instance', reveal)
  })
}

/** After starting, so the sponsor card's first read doesn't compete with loading a cluster. */
const SPONSOR_FIRST_MS = 3_000

/** How long the desktop app keeps what was done through it. */
const AUDIT_RETENTION_DAYS = 90

/**
 * Where Claude Desktop keeps its settings, on macOS and Windows (it isn't made
 * for Linux). Not app.getPath('appData'): on Windows it fails, stopping the
 * app as it starts, when the folder it names (from the user's profile) isn't
 * there.
 */
function claudeDesktopConfig(): string | undefined {
  const folders: Partial<Record<NodeJS.Platform, string | undefined>> = {
    darwin: join(homedir(), 'Library', 'Application Support'),
    win32: process.env.APPDATA,
  }
  const folder = folders[process.platform]
  return folder && join(folder, 'Claude', 'claude_desktop_config.json')
}

/**
 * The audit history's folder; or, if it can't be kept there (made, or written: another Lumovi
 * keeping it, say), memory until the app quits. The Audit page says which.
 */
async function auditStore(dir: string): Promise<AuditStore> {
  try {
    // (One app at a time: one holding it isn't waited for.)
    return await FileStore.open(dir, AUDIT_RETENTION_DAYS, { wait: false, say: console.warn })
  } catch (error) {
    const why = `${dir} can’t be used: ${(error as Error).message}`
    console.warn(`The audit history is kept in memory until Lumovi quits: ${why}`)
    return new MemoryStore(10_000, why)
  }
}

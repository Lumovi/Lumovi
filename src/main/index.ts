import { existsSync, readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  app,
  dialog,
  Menu,
  nativeTheme,
  Notification,
  safeStorage,
  session,
  shell,
  type BrowserWindow,
  type WebContents,
} from 'electron'
import {
  developerModeLocked,
  IPC,
  type MovedTab,
  type ShellExit,
  type WindowState,
} from '@shared/api'
import { movedTabOf } from '@shared/moved-tab'
import { handedLink, LINK_SCHEME } from '@shared/links'
import { folderOf } from '@shared/plugin-loading'
import { parsePlugin } from '@shared/plugins'
import { AUDIT_EXPORT_LIMIT } from '@shared/audit'
import icon from '../../build/icon.png?asset'
import { AuditLog } from '@backend/audit/log'
import { recorder } from '@backend/audit/recorder'
import { pluginHistory } from '@backend/plugin-history'
import { FileStore, MemoryStore, type AuditStore } from '@backend/audit/store'
import { MetricsStackService } from '@backend/helm/metrics-stack'
import { ChartRepositories, recordOf } from '@backend/helm/repositories'
import { HelmService } from '@backend/helm/service'
import { FileCopies, fileCopyLimits } from '@backend/kube/files'
import { KubeConfigStore } from '@backend/kube/kubeconfig'
import { OidcRenewal } from '@backend/kube/oidc-refresh'
import { KubeconfigWatcher } from '@backend/kube/watch'
import { LogStreams } from '@backend/kube/logs'
import { ListWatches } from '@backend/kube/watches'
import { KubeService } from '@backend/kube/service'
import { Forwards, Terminals } from '@backend/kube/streams'
import { UsageHistory } from '@backend/kube/usage'
import { setUpNetwork } from '@backend/network'
import { SponsorSource, sponsorSource } from '@backend/sponsor/source'
import { pluginsDirectory, readFiles } from '@backend/plugins'
import { plugins, pluginsAllowedBy, withholding } from '@backend/plugins-known'
import { withholdFrom } from '@backend/withholding'
import { Assistants } from './assistants'
import { DesktopFiles } from './file-copies'
import { registerIpc } from './ipc'
import { DesktopRepositories } from './helm-repositories'
import { KubeconfigFiles } from './kubeconfig-files'
import { KEYS_QUIET_MS, linkIn, Links } from './links'
import { AddedClusters, ownKubeconfigs } from './added-clusters'
import { AwsClusters } from './aws-clusters'
import { useConsentKey } from './consent'
import { refusalOf } from './folder-consents'
import { runStdio, STDIO } from './mcp-stdio'
import { KUBECTL_MIRROR, Kubectls } from './kubectl'
import type { TrustRoot } from './kubectl-signature'
import SIGSTORE_ROOT from './sigstore-root.json'
import { LocalTerminals } from './local-terminal'
import { TerminalKeys } from './terminal-keys'
import { chromiumProxy, proxyCredentials } from './chromium-proxy'
import { buildMenu, popupMenu } from './menu'
import { effectiveKeys } from '@shared/shortcuts'
import { readPolicy } from './policy'
import { SettingsStore } from './settings'
import { loadLoginShellEnv } from './shell-env'
import { Updates } from './updates'
import {
  filterRequests,
  noNamesAhead,
  registerBoxScheme,
  serveBoxes,
  watchBoxes,
} from './plugin-box'
import { PluginStore } from './plugin-store'
import { AgreedPlugins } from './plugins-agreed'
import { PluginsWatch } from './plugins-watch'
import { InstalledPlugins } from './plugins-installed'
import { PLUGINS_REPOSITORY, PLUGINS_SIGNER } from './plugins-release'
import BUILT_WITH from 'virtual:lumovi-plugins/release'
import SHIPPED from 'virtual:lumovi-plugins'
import { WarningNotices } from './warning-notices'
import { asMainWindow, cascaded, createMainWindow, rendererUrl, windowState } from './window'
import { Windows, withoutShell } from './windows'

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
} else if (!app.requestSingleInstanceLock({ link: linkIn(process.argv) ?? null })) {
  // Another Lumovi is already open: it's focused instead, and handed the link this one was started
  // with, as read here from its own command line (after `--`). The other is told this one's
  // arguments too, but as Chromium read them: without the `--`, and with switches of its own.
  app.quit()
} else {
  // lumovi:// links. macOS hands them over, before Lumovi is ready when one starts it; Windows
  // and Linux start it with one, after `--`. Kept until the links are, below (the last alone).
  let links: Links | undefined
  let early = linkIn(process.argv)
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (links) links.arrive(url)
    else early = url
  })
  const shellReady = loadLoginShellEnv()
  // Where a plugin's code will run: its protocol has to be named before the app is ready.
  registerBoxScheme()
  // And no page looks a name up ahead of a request: said before it's ready too.
  noNamesAhead()

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
    // A plugin's sealed box: its one document, and nothing a box asks the network for let through.
    serveBoxes(url)
    // (On the session the window's page is in. Lumovi's own requests elsewhere don't pass it:
    // the updater has a session of its own, and the clusters are reached from Node.)
    filterRequests(session.defaultSession)
    // What a kubeconfig's credentials do here, agreed to by the person: known again after a restart.
    useConsentKey(app.getPath('userData'))
    // The kubeconfig files chosen in Lumovi, or else KUBECONFIG's, or ~/.kube/config; then those
    // added; then the clusters added in Lumovi, each a file of its own; then the folders'
    // kubeconfigs. A folder's context is used once what its credentials do is agreed to. Each
    // time they're read, what's watched is too (a file chosen, a folder added).
    const kubeconfigs = join(app.getPath('userData'), 'clusters')
    const watching: { watcher?: KubeconfigWatcher } = {}
    // What Lumovi has to say as it goes, to every window, once they're there.
    const notes: { send?: (title: string, description: string) => void } = {}
    // `auth-provider: oidc` users' tokens, renewed as kubectl renews them, and written back where
    // kubectl keeps them (said once where they can't be).
    const oidc = new OidcRenewal({
      writes: true,
      note: (description) => notes.send?.('A renewed token wasn’t saved', description),
    })
    const store = new KubeConfigStore(
      process.env,
      () => ({
        ...settings.kubeconfigFiles(),
        own: ownKubeconfigs(kubeconfigs, policy.managed),
      }),
      {
        refuse: (parts) => refusalOf(parts, settings.kubeconfigConsents(parts.context.file)),
        loaded: () => watching.watcher?.refresh(),
        oidc,
      },
    )
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
      pickFolder: async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog({
          title: 'Add a folder of kubeconfigs',
          buttonLabel: 'Add',
          defaultPath: join(homedir(), '.kube'),
          properties: ['openDirectory', 'showHiddenFiles'],
        })
        return canceled ? null : (filePaths[0] ?? null)
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
    // EKS clusters found with the person's own `aws` (on the login shell's PATH), as they ask.
    const awsClusters = new AwsClusters({ env: process.env, managed: policy.managed })
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
    // What plugins' pages add to the history, counted: said as Lumovi quits.
    const pluginsListed = pluginHistory(audit)
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
      repositories: new ChartRepositories({
        keeper: new DesktopRepositories(
          join(app.getPath('userData'), 'helm-repositories.json'),
          () => safeStorage,
        ),
        person: { mayChange: () => true, record: (change) => audit.record(recordOf(change)) },
      }),
    })
    const metricsStack = new MetricsStackService(kube, helm, {
      isReadOnly,
      chartFile: process.env.LUMOVI_TEST_STACK_CHART,
      off: () =>
        settings.get().managed?.metricsStackOff
          ? {
              reason: 'policy',
              message: 'Your organization has turned off installing a metrics stack from Lumovi.',
            }
          : undefined,
    })
    // Lumovi's windows: each where it was when Lumovi last closed, or one where a new one goes.
    // Their pages load asynchronously, so the handlers below are in place before one can call
    // them; each window's own events are listened to once all there is to tell them is (wire).
    // (A shell held for a window that closed before its page took it ends: see closeStreams.)
    const windows = new Windows((ids) => closeStreams(ids))
    notes.send = (title, description) => {
      for (const win of windows.all()) win.webContents.send(IPC.appNote, { title, description })
    }
    /**
     * Pages raised for a link from another app, by the time of the last key they were given: their
     * keys are nothing until they stop for a while (the person may still be typing there).
     */
    const keysHeld = new Map<number, number>()
    // (A link is never a window of one tab's. Where there are only those, it's a new window's.)
    links = new Links({
      front: () => windows.ownFront(),
      // (Made as New Window makes one: wired, so what it starts ends with it.)
      newWindow: () => newWindow(),
      anyWindow: () => windows.all().length > 0,
      holdKeys: (win) => keysHeld.set(win.webContents.id, Date.now()),
      showing: (context) => windows.showing(context),
      tabWindow: (win) => windows.tabOf(win) !== undefined,
      off: () => policy.managed?.linksOff === true,
      here: () => store.addresses(),
    })
    // Windows has no installer's say (its installer writes no scheme): the app's own, with `--`
    // before the link, so nothing in one is a switch. Only as installed: never a test's or dev's.
    if (app.isPackaged && process.platform === 'win32') {
      if (policy.managed?.linksOff)
        app.removeAsDefaultProtocolClient(LINK_SCHEME, process.execPath, ['--'])
      else app.setAsDefaultProtocolClient(LINK_SCHEME, process.execPath, ['--'])
    }
    if (early) links.arrive(early)
    let quitting = false
    /**
     * Where a window is and what it shows: its place, its page's address, what it has below; or,
     * a window of one tab, that tab as its page last said it (its shell's never kept).
     */
    const keptOf = (win: BrowserWindow): WindowState => {
      const held = windows.tabOf(win)
      if (held) {
        const said = (windows.belowOf(win) as { tabs?: unknown[] } | undefined)?.tabs?.[0]
        return { ...windowState(win), tab: movedTabOf(said, false) ?? withoutShell(held.tab) }
      }
      const page = new URL(win.webContents.getURL()).hash
      const below = windows.belowOf(win)
      return {
        ...windowState(win),
        ...(page.startsWith('#/') ? { page } : {}),
        ...(below !== undefined ? { below } : {}),
      }
    }
    /**
     * The windows, as they're kept: windows of one tab alone open again as Lumovi's own, each on
     * its tab's cluster with the tab below (there's no start screen, else, to go anywhere from).
     * (Its page goes there as any window's does: not to a cluster that signs in through a program.)
     */
    const keptAll = (open: BrowserWindow[]): WindowState[] => {
      const states = open.map(keptOf)
      if (states.some((state) => state.tab === undefined)) return states
      return states.map(({ tab, ...state }) => {
        const context = (tab as MovedTab).context
        return {
          ...state,
          page: `#/cluster/${encodeURIComponent(context)}`,
          below: { open: true, maximized: false, shown: 0, tabs: [tab] },
        }
      })
    }
    /** As a window closes: quitting, every window is kept, below; else the last keeps itself. */
    const keepLast = (win: BrowserWindow) => {
      if (!quitting && windows.all().length === 1) settings.update({ windows: keptAll([win]) })
    }
    // Text size (Settings, or the View menu's zoom): each window as it opens; then changed by it.
    const zoomed = (win: BrowserWindow) => {
      const size = settings.get().preferences?.textSize ?? 100
      if (size === 100) return
      win.webContents.once('did-finish-load', () => win.webContents.setZoomFactor(size / 100))
    }
    const makeWindow = (saved?: WindowState, opens?: { address: string; tab?: string }) => {
      const tab = movedTabOf(saved?.tab, false)
      if (saved && tab) return makeTabWindow(tab, 'restored', saved)
      // (Where its page was, an address of the app's own, never another page, is handed to the
      // page: it opens on the start screen and goes there itself, unless that would read a
      // cluster that signs in through a program before anyone asks.)
      // (Or a link's view, where its card was answered New window: asked for, with its tab.)
      const wanted = opens ? `#${opens.address}` : saved?.page
      const page =
        typeof wanted === 'string' && /^#\/[^#]{0,2047}$/.test(wanted) ? wanted : undefined
      const win = createMainWindow(url, saved, () => keepLast(win))
      zoomed(win)
      windows.add(win)
      windows.restore(win, {
        page,
        below: saved?.below,
        ...(opens ? { asked: true as const, ...(opens.tab ? { tab: opens.tab } : {}) } : {}),
      })
      return win
    }
    /**
     * A window of one tab below: over the window it came from, a little smaller; or where it was,
     * opened again as Lumovi did.
     */
    const makeTabWindow = (
      tab: MovedTab,
      from: BrowserWindow | 'restored',
      saved?: WindowState,
    ) => {
      const win = createMainWindow(`${url}#/tab`, saved, () => keepLast(win), {
        ...TAB_WINDOW,
        ...(from === 'restored' ? {} : { over: from.getBounds() }),
      })
      zoomed(win)
      windows.add(win)
      windows.holdTab(win, tab, from)
      return win
    }
    const saved = settings.get().windows ?? []
    for (const state of saved.length ? saved : [undefined]) makeWindow(state)
    // Quitting stops helm, mid-change: asked first, while one runs (here alone: on a server it
    // runs in the server, which a browser closing never stops).
    let quitAnyway = false
    app.on('before-quit', (event) => {
      const running = helm.changing()
      if (running.length > 0 && !quitAnyway) {
        event.preventDefault()
        const [first] = running
        const choice = dialog.showMessageBoxSync({
          type: 'warning',
          message:
            running.length === 1
              ? `${first!.name} is still ${first!.doing}.`
              : `${running.length} Helm changes are still running.`,
          detail: `Quitting stops Helm, and can leave ${running.length === 1 ? 'the release' : 'their releases'} pending.`,
          buttons: ['Keep it open', 'Quit anyway'],
          defaultId: 0,
          cancelId: 0,
        })
        if (choice === 1) {
          quitAnyway = true
          app.quit()
        } else if (windows.all().length === 0) {
          // (Its last window was closed: one's opened again, to see how it ends.)
          newWindow()
        }
        return
      }
      quitting = true
      const open = windows.all()
      if (open.length) settings.update({ windows: keptAll(open) })
    })
    /** What every window hears: what's the app's own, not one page's stream. */
    const send = (channel: string, ...args: unknown[]) => windows.toAll(channel, ...args)
    /** What the page a stream belongs to hears, alone. */
    const toOwner = (channel: string, id: string, ...args: unknown[]) =>
      windows.toOwner(channel, id, ...args)
    // The plugins this Lumovi has, as its backend reads them: read each time they're asked.
    /** What's installed from Lumovi-plugins: there once the store is set up, below. */
    // eslint-disable-next-line prefer-const -- set once, below, after knownPlugins (which reads it) is made
    let installedPlugins: InstalledPlugins | undefined
    const knownPlugins = () =>
      plugins(
        pluginsDirectory(homedir()),
        'desktop',
        app.getVersion(),
        process.env,
        pluginsAllowedBy(policy.managed),
        async () => {
          const read = await installedPlugins?.read()
          return {
            files: Object.fromEntries(
              (read?.plugins ?? []).map(({ name, file }) => [`${name}.yaml`, file]),
            ),
            codes: Object.fromEntries(
              Object.entries(read?.codes ?? {}).map(([name, code]) => [`${name}.js`, code]),
            ),
          }
        },
        // (A person's own plugins' code is read in Developer mode alone.)
        () => settings.pluginDeveloperMode(),
      )
    // What the person agreed to run of their own plugins' code: let go of, under a policy that
    // keeps Developer mode off (and agreed to again from the start once it's allowed).
    const agreed = new AgreedPlugins({
      records: () => settings.pluginsAgreed(),
      keep: (records) => settings.setPluginsAgreed(records),
      known: knownPlugins,
      shown: (file) => join(pluginsDirectory(homedir()).shown, file),
      audit,
      byLumovi: (input) =>
        void auditLog.record({ ...input, actor: { user: 'lumovi', via: 'server' } }),
    })
    agreed.clearUnder(policy.managed)
    // In Developer mode, their folder watched: the page reads its plugins again as it changes.
    const pluginsWatch = new PluginsWatch(pluginsDirectory(homedir()).path, () =>
      send(IPC.pluginsChanged),
    )
    pluginsWatch.set(settings.pluginDeveloperMode())
    // A kubeconfig changed elsewhere (a context a cloud's tool added, a file in a folder): read
    // again, and the page told, without Reload.
    watching.watcher = new KubeconfigWatcher(
      () => {
        const { paths, folders } = store.paths()
        return { files: paths, folders: folders.map(({ folder }) => folder) }
      },
      () => {
        store.load()
        send(IPC.kubeconfigChanged)
      },
    )
    const deps = {
      store,
      envReady,
      isReadOnly,
      audit,
      // (Which plugin a link that brought the person came from, for the history: the backend's own.)
      plugin: async (name: string) => (await knownPlugins()).find((each) => each.name === name),
      // (Read each time: the organization's policy, as it stands.)
      pluginLogsOff: () => policy.managed?.pluginLogsOff === true,
    }
    const shellEvents = {
      data: (id: string, data: string) => toOwner(IPC.terminalData, id, data),
      exit: (id: string, exit: ShellExit) => toOwner(IPC.terminalExit, id, exit),
    }
    const terminals = new Terminals(
      { ...deps, nodeShell: (context) => settings.nodeShell(context), timeoutMs: kube.timeoutMs },
      shellEvents,
    )
    // The e2e tests' stand-in for Sigstore's trust root: never a packaged app's.
    const sigstoreRoot =
      !app.isPackaged && process.env.LUMOVI_SIGSTORE_ROOT
        ? (JSON.parse(readFileSync(process.env.LUMOVI_SIGSTORE_ROOT, 'utf8')) as TrustRoot)
        : (SIGSTORE_ROOT as TrustRoot)
    // Terminals' kubectl, matching each cluster's version, from the policy's mirror if it says.
    const kubectls = new Kubectls({
      dir: join(app.getPath('userData'), 'kubectl'),
      mirror: () =>
        // (An empty one is as good as none.)
        policy.managed?.kubectlMirror || process.env.LUMOVI_KUBECTL_MIRROR || KUBECTL_MIRROR,
      // A mirror's kubectl too only with Kubernetes' signature, where the policy says.
      signaturesRequired: () => policy.managed?.kubectlSignatures === 'required',
      // The e2e tests' stand-in for dl.k8s.io: never a packaged app's.
      official: (!app.isPackaged && process.env.LUMOVI_KUBECTL_OFFICIAL) || KUBECTL_MIRROR,
      trust: sigstoreRoot,
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
        shell: () => settings.get().preferences?.shell ?? '',
      },
      shellEvents,
    )
    const forwards = new Forwards(deps, (list) => send(IPC.forwardsChanged, list))
    // Files copied out of containers and into them: saved where their person says, in the
    // system's dialogs, and picked there too.
    const localFiles = new DesktopFiles({
      save: async (options) => {
        const { canceled, filePath } = await dialog.showSaveDialog(windows.front()!, options)
        return canceled ? undefined : filePath
      },
      open: async ({ title, folder }) => {
        const { canceled, filePaths } = await dialog.showOpenDialog(windows.front()!, {
          title,
          properties: [folder ? 'openDirectory' : 'openFile', 'showHiddenFiles'],
        })
        return canceled ? undefined : filePaths[0]
      },
      downloads: () => app.getPath('downloads'),
      show: (path) => shell.showItemInFolder(path),
    })
    const files = new FileCopies(
      deps,
      fileCopyLimits(process.env, {
        off: policy.managed?.fileCopyOff,
        maxBytes: policy.managed?.fileCopyMaxBytes,
      }),
      localFiles,
      {
        progress: (id, progress) => toOwner(IPC.filesProgress, id, progress),
        end: (id, end) => toOwner(IPC.filesEnd, id, end),
      },
    )
    const logs = new LogStreams(
      { ...deps, timeoutMs: kube.timeoutMs },
      {
        lines: (id, lines) => toOwner(IPC.logsLines, id, lines),
        end: (id, error) => toOwner(IPC.logsEnd, id, error),
      },
    )
    // The lists a window's page shows, watched: it's told when one changed, and reads it again.
    const watches = new ListWatches(kube, {
      changed: (id) => toOwner(IPC.watchChanged, id),
      ended: (id, error) => toOwner(IPC.watchEnded, id, error),
    })
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
    // What's newer in Lumovi-plugins, for the Plugins page: asked only when it's opened, or on
    // Check now. None where the policy turns it off, or allows no plugins but Lumovi's own.
    const pluginStore = new PluginStore({
      trust: { root: sigstoreRoot, signer: PLUGINS_SIGNER, repository: PLUGINS_REPOSITORY },
      // The e2e tests' stand-in for GitHub: never a packaged app's.
      ...(!app.isPackaged && process.env.LUMOVI_PLUGIN_STORE
        ? { github: process.env.LUMOVI_PLUGIN_STORE }
        : {}),
      ready: envReady,
      off: () =>
        Boolean(
          policy.managed?.pluginStoreOff ||
          policy.managed?.pluginsOff ||
          policy.managed?.pluginsBundledOnly,
        ),
      allowed: () => policy.managed?.pluginsAllowed,
      builtWith: BUILT_WITH,
      serial: () => settings.pluginStoreSerial(),
      accept: (serial) => settings.acceptPluginStoreSerial(serial),
      warn: console.warn,
    })
    // What's installed from it, on the person's press: written to the app's folder, each copy
    // checked against what was agreed to every time it's read.
    const installed = new InstalledPlugins({
      dir: join(app.getPath('userData'), 'plugins', 'installed'),
      records: () => settings.pluginsInstalled(),
      keep: (records) => settings.setPluginsInstalled(records),
      store: pluginStore,
      lumovi: app.getVersion(),
      managed: () => policy.managed,
      // Lumovi's own (and in the tests' build, their stand-ins): what an installed one goes back to.
      builtIn: async () =>
        new Map(
          [
            ...Object.entries(SHIPPED),
            ...((await readFiles(pluginsDirectory(homedir()))).included ?? []).map(
              ({ name, text }) => [name, text] as const,
            ),
          ].flatMap(([file, text]) => {
            const { plugin } = parsePlugin(text, file, { carriesCode: true })
            return plugin ? [[plugin.name, plugin.version] as const] : []
          }),
        ),
      audit,
    })
    installedPlugins = installed
    // What Lumovi withholds of each kind: what every plugin file it has says, whatever's in use.
    withholdFrom(
      withholding(pluginsDirectory(homedir()), {
        folders: true,
        installed: () => installed.files(),
      }),
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
    // A focused terminal's ⌘ keys are its own, before the menu's (each window's: see wire).
    const terminalKeys = new TerminalKeys(() =>
      effectiveKeys(settings.get().preferences?.shortcuts, process.platform === 'darwin'),
    )
    // AI assistants on this computer, over MCP. How the app is started again, should
    // Claude Desktop's bridge find it isn't running: as it was this time.
    settings.update({ assistants: { ...settings.get().assistants!, launch: process.argv } })
    /** The window in front, brought there. */
    const reveal = () => {
      const win = windows.front()
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    // Notifications of changes waiting, kept (one let go can't be clicked) until the person
    // comes to Lumovi, when they've done their job (each window, as it's focused: see wire).
    const notices = new Set<Notification>()
    // New warnings in the clusters whose settings ask for them, while Lumovi runs: a click
    // brings Lumovi to the object, or to the namespace's warnings.
    const warnings = new WarningNotices({
      kube,
      clusters: () => settings.get().clusters ?? {},
      name: (context) => settings.get().clusters?.[context]?.name ?? context,
      tell: ({ title, body, cluster, opens }) => {
        const notice = new Notification({ title, body: `${body}\n${cluster}` })
        notice.on('click', () => {
          reveal()
          // (The window in front opens it: the others stay where they are.)
          windows.front()?.webContents.send(IPC.command, `open:${opens}`)
        })
        notices.add(notice)
        notice.show()
      },
    })
    warnings.start()
    const assistants = new Assistants({
      settings,
      kube,
      // As this computer's person, through the assistant (named once it says who it is).
      audit: (name) => recorder(auditLog, (cluster) => actor('assistant', name())(cluster)),
      version: app.getVersion(),
      send,
      // A change waiting for an answer, while the person is elsewhere (in their assistant).
      attention: (proposal) => {
        if (windows.all().some((win) => win.isFocused())) return
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
    // Shells, forwards, log streams and copies belong to the page that started them: they end
    // as it does (reloaded, or its window closed), whatever the other windows' pages do.
    const closeStreams = (ids: string[]) => {
      for (const id of ids) {
        terminals.close(id)
        local.close(id)
        forwards.stop(id)
        logs.stop(id)
        watches.stop(id)
        files.cancel(id)
      }
    }
    /** A window's own: what it's told of itself, and what ends with its page. */
    const wire = (win: BrowserWindow) => {
      const page = win.webContents
      page.on('before-input-event', (event, input) => {
        // (Before anything of the page's hears it: a terminal's, a dialog's form, a card.)
        const held = keysHeld.get(page.id)
        if (held !== undefined && Date.now() - held < KEYS_QUIET_MS) {
          if (input.type === 'keyDown') keysHeld.set(page.id, Date.now())
          event.preventDefault()
          return
        }
        keysHeld.delete(page.id)
        // Settings recording a command's keys has them all, the menu's too.
        if (terminalKeys.recording(page.id)) {
          if (input.type !== 'keyDown') return
          event.preventDefault()
          page.send(IPC.keyRecorded, {
            key: input.key,
            code: input.code,
            ctrlKey: input.control,
            altKey: input.alt,
            shiftKey: input.shift,
            metaKey: input.meta,
          })
          return
        }
        const command = terminalKeys.command(page.id, input)
        if (!command) return
        event.preventDefault()
        page.send(IPC.command, command)
      })
      win.on('enter-full-screen', () => page.send(IPC.fullScreen, true))
      win.on('leave-full-screen', () => page.send(IPC.fullScreen, false))
      // A page that (re)loads learns how the window is now.
      page.on('did-finish-load', () => page.send(IPC.fullScreen, win.isFullScreen()))
      win.on('focus', () => {
        for (const notice of notices) notice.close()
        notices.clear()
      })
      // A page that goes (loads anew, or its renderer is gone) neither records keys nor has a
      // terminal with focus any more: the window's keys are its own again.
      const keysLetGo = () => {
        terminalKeys.record(page.id, false)
        terminalKeys.focus(page.id, false)
      }
      page.on('did-start-navigation', (details) => {
        // (The page's own: a plugin's box arriving in a frame of it ends nothing.)
        if (details.isMainFrame && !details.isSameDocument) {
          keysLetGo()
          closeStreams(windows.release(page))
        }
      })
      page.on('render-process-gone', keysLetGo)
      // (And a window that's left, for another or another app, records no keys either.)
      win.on('blur', () => terminalKeys.record(page.id, false))
      // (Its page gone with it: what it started ends.)
      win.on('closed', () => closeStreams(windows.release(page)))
    }
    for (const win of windows.all()) wire(win)
    // A plugin's process is measured while it runs, and ended when it's over its limits: one
    // watch over every window's boxes, since a process is a process whichever window's frame is
    // in it. The window whose box it was is told.
    watchBoxes(
      () => windows.all(),
      (win, plugin, over) => {
        console.warn(
          over === 'shared'
            ? `Lumovi ended the plugin ${plugin}: it wasn’t in a process of its own`
            : `Lumovi ended the plugin ${plugin}: it was over its ${over === 'memory' ? 'memory' : 'time on the processor'}`,
        )
        // (The page says so where the plugin's page was: `plugins/page.ts`.)
        if (!win.isDestroyed()) win.webContents.send(IPC.pluginEnded, plugin, over)
      },
      (_win, plugin, why) =>
        console.warn(
          `Lumovi couldn’t take the plugin ${plugin} off its page, where it isn’t in a process of its own: ${why}`,
        ),
    )
    /** Another window, the size of the one in front and just below it, on the start screen. */
    const newWindow = (opens?: { address: string; tab?: string }) => {
      const front = windows.front()
      const at = front && windowState(front)
      const win = makeWindow(at && cascaded(at, NEW_WINDOW_OFFSET), opens)
      wire(win)
      return win
    }
    /** A tab below moved into a window of its own, over the window it was in. */
    const moveTab = (page: WebContents, given: unknown) => {
      const from = windows.windowOf(page)
      const tab = movedTabOf(given)
      if (!from || windows.tabOf(from) || !tab) {
        throw new Error('A tab below moves to a window of its own: a kept object or a terminal')
      }
      wire(makeTabWindow(tab, from))
    }
    /**
     * A window's one tab put back below: in the window it came from, else the one in front on its
     * cluster, else the one in front; its shell handed there, still running. With no other of
     * Lumovi's own windows, this one becomes one (`here`), its tab below in it.
     */
    const putBack = (page: WebContents, given: unknown): { here?: true } => {
      const win = windows.windowOf(page)
      const held = win && windows.tabOf(win)
      const tab = movedTabOf(given)
      if (!win || !held || !tab) throw new Error('A window of one tab puts its tab back below')
      const others = windows.byRecency().filter((each) => each !== win && !windows.tabOf(each))
      if (others.length === 0) {
        // (Its terminal's taken on again here, as it was let go of: what it says meanwhile kept.)
        if (tab.kind === 'terminal' && tab.shell) windows.hold(tab.shell.id, page)
        windows.untab(win)
        asMainWindow(win)
        return { here: true }
      }
      const to =
        (held.from && others.includes(held.from) ? held.from : undefined) ??
        others.find((each) => clusterOf(each.webContents.getURL()) === tab.context) ??
        others[0]!
      const handed =
        tab.kind !== 'terminal' || !tab.shell || windows.hand(tab.shell.id, page, to.webContents)
      to.webContents.send(IPC.tabReturned, handed ? tab : withoutShell(tab))
      to.focus()
      // (Once its page has its answer: it's gone with its window.)
      setImmediate(() => win.close())
      return {}
    }
    // The native menu: its keys are the person's, so it's built again as they change.
    const setMenu = () =>
      Menu.setApplicationMenu(
        buildMenu({ front: () => windows.front(), newWindow, updates, settings }),
      )
    registerIpc({
      setMenu,
      problems: () => envReady.then(() => problems),
      links,
      kubeconfigFiles,
      addedClusters,
      awsClusters,
      assistants,
      kube,
      helm,
      metricsStack,
      usage,
      settings,
      terminals,
      local,
      terminalKeys,
      forwards,
      logs,
      watches,
      files,
      localFiles,
      updates,
      pluginStore,
      installed,
      agreed,
      pluginsWatch,
      installedPlugins: () => installed.read(),
      sponsor,
      pluginsDirectory: pluginsDirectory(homedir()),
      knownPlugins,
      // (A window of the desktop app's: its box is a process of its own, kept apart by Electron.)
      // What turns code off: the organization's policy, and the person's own switch, read each time.
      handOverTo: () => ({
        host: 'desktop',
        switches: {
          ...(policy.managed?.pluginCodeOff ? { policyOff: true as const } : {}),
          ...(policy.managed?.pluginProposalsOff ? { proposalsOff: true as const } : {}),
          ...(policy.managed?.pluginSecretsOff ? { secretsOff: true as const } : {}),
          ...(policy.managed?.pluginLogsOff ? { logsOff: true as const } : {}),
          ...(policy.managed?.pluginServersOff ? { serversOff: true as const } : {}),
          chosen: settings.pluginCode(),
        },
        // One of the person's own: a folder's, in Developer mode, as they agreed to it.
        own: (plugin) => {
          if (folderOf(plugin.file) === undefined) return 'not-in-use'
          if (!settings.pluginDeveloperMode()) {
            return developerModeLocked(policy.managed)
              ? 'developer-mode-locked'
              : 'developer-mode-off'
          }
          if (plugin.asks === undefined) return 'no-code'
          const standing = agreed.standing(plugin)
          return standing === 'agreed' ? true : (`waiting-${standing}` as const)
        },
      }),
      rendererUrl: url,
      audit,
      pluginHistory: pluginsListed,
      auditLog,
      send,
      windows,
      newWindow,
      moveTab,
      putBack,
      warningNotices: (context) => warnings.state(context),
      openMenu: (x, y) => popupMenu(windows.front()!, x, y),
    })
    // Node shells' pods are deleted as their shells end: quitting waits for that (a few
    // seconds at most; their deadline ends any that are left).
    let waited = false
    app.on('will-quit', (event) => {
      closeStreams(windows.releaseAll())
      void terminals.closeAll()
      local.closeAll()
      forwards.stopAll()
      logs.stopAll()
      watches.stopAll()
      void files.cancelAll()
      pluginsWatch.set(false)
      void assistants.stop()
      warnings.stop()
      pluginsListed.stop()
      void auditLog.close()
      // And a download stopped by quitting has what was saved of it removed first.
      if (waited || (!terminals.cleaning && !files.active)) return
      waited = true
      event.preventDefault()
      void Promise.race([
        Promise.all([terminals.closeAll(), files.cancelAll()]),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]).then(() => app.quit())
    })
    setMenu()
    // Started again: with a link, it's the link's (which raises the window it asks in).
    app.on('second-instance', (_event, _argv, _directory, handed) => {
      const link = handedLink(handed)
      if (link) links!.arrive(link)
      else reveal()
    })
  })
}

/** How far a new window opens from the one in front, down and to the right. */
const NEW_WINDOW_OFFSET = 24
/** A window of one tab below: smaller than Lumovi's own, and as small as a tab below goes. */
const TAB_WINDOW = { width: 980, height: 560, minWidth: 560, minHeight: 360 }

/** The cluster a window's page is on, by its address; none on the start screen and the like. */
function clusterOf(address: string): string | undefined {
  const at = /#\/cluster\/([^/?#]+)/.exec(address)?.[1]
  try {
    return at && decodeURIComponent(at)
  } catch {
    return undefined
  }
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

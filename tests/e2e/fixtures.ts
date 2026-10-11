/**
 * Test fixtures: every worker gets its own mock clusters and kubeconfig, every
 * test gets a fresh Lumovi window with an isolated user-data directory.
 * When the build is instrumented, coverage from the main, preload and
 * renderer processes is written to `.nyc_output/` for `nyc report`.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { cpus, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { CONTEXTS, startTestClusters, type TestClusters } from '../mock-cluster/kubeconfig.ts'
import { startMockDownloads, type MockDownloads } from '../mock-downloads/server.ts'

export { CONTEXTS, expect }
export { DEMO, LARGE, SANDBOX, DEMO_TOKEN, MISSING_PLUGIN } from '../mock-cluster/kubeconfig.ts'

export const COVERAGE_DIR = resolve('.nyc_output')

export interface LaunchOptions {
  /** Extra or overridden environment variables; `undefined` removes a variable. */
  env?: Record<string, string | undefined>
  /** Reuse a user-data directory, e.g. to test persistence across restarts. */
  userDataDir?: string
  /** Theme to seed into settings.json before launch. */
  theme?: 'system' | 'light' | 'dark'
  args?: string[]
  /**
   * Lay the app out at the default window size even on a smaller screen, by
   * zooming out (true unless a test is about narrow windows). Off for a
   * picture at another size: on, a smaller window shows the 1440 layout
   * zoomed out, not that size's own.
   */
  fullLayout?: boolean
}

/** Whether the suite runs against a packaged app (LUMOVI_E2E_EXECUTABLE), not the build in out/. */
export const PACKAGED = Boolean(process.env.LUMOVI_E2E_EXECUTABLE)

/** The app's default content size; tests are written against this layout. */
const REFERENCE_SIZE = { width: 1440, height: 920 }

export interface Lumovi {
  app: ElectronApplication
  page: Page
  userDataDir: string
  /** Where the stand-in helm records its calls and reads scripted answers (tests/e2e/helm). */
  helmDir?: string
  close(): Promise<void>
}

/** Keeps test windows and copies out of your way (see the file). */
const HARNESS = ['-r', resolve('tests/e2e/harness.cjs')]

/** The stand-in for helm the e2e tests run, instead of a real one. */
const FAKE_HELM = resolve('tests/e2e/helm', process.platform === 'win32' ? 'helm.cmd' : 'helm')

/**
 * A step of closing the app, given at most `ms`: past that, it's said (with what it was) and
 * given up on, so a test that passed isn't failed by an app that's slow to go.
 */
async function within(what: string, ms: number, step: () => Promise<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    const done = await Promise.race([step().then(() => true as const), late])
    if (!done) console.warn(`Closing the app: ${what} took more than ${ms / 1000} s.`)
    return done
  } finally {
    clearTimeout(timer)
  }
}

async function collectCoverage(app: ElectronApplication): Promise<void> {
  for (const window of app.windows()) {
    try {
      const coverage = await window.evaluate(() => {
        const w = window as unknown as {
          __coverage__?: object
          __lumoviCoverage__?: () => object | undefined
        }
        return [w.__coverage__, w.__lumoviCoverage__?.()]
      })
      for (const data of coverage.filter(Boolean)) {
        mkdirSync(COVERAGE_DIR, { recursive: true })
        writeFileSync(join(COVERAGE_DIR, `${randomUUID()}.json`), JSON.stringify(data))
      }
    } catch {
      // The window may already be gone (e.g. a test closed it).
    }
  }
}

export async function launchApp(
  /** The kubeconfig the app sees: the mock clusters', or a test cluster's. */
  kubeconfig: string,
  options: LaunchOptions = {},
): Promise<Lumovi> {
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  if (options.theme) {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ theme: options.theme }))
  }
  const env: Record<string, string> = {}
  const merged = {
    ...process.env,
    KUBECONFIG: kubeconfig,
    LUMOVI_COVERAGE_DIR: COVERAGE_DIR,
    // Never the developer's own plugins.
    LUMOVI_PLUGINS_DIR: join(userDataDir, 'plugins'),
    // Never GitHub's sponsor.json: a closed port, so Lumovi's own card (sponsor.spec.ts serves one).
    LUMOVI_SPONSOR_URL: 'http://127.0.0.1:9/',
    // Keep tests independent of the developer's login shell, and their proxy.
    SHELL: undefined,
    ELECTRON_RENDERER_URL: undefined,
    HTTPS_PROXY: undefined,
    https_proxy: undefined,
    HTTP_PROXY: undefined,
    http_proxy: undefined,
    NO_PROXY: undefined,
    no_proxy: undefined,
    ...options.env,
  }
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) env[key] = value
  }
  // LUMOVI_E2E_EXECUTABLE runs the suite against a packaged app instead of the build in out/.
  const executablePath = process.env.LUMOVI_E2E_EXECUTABLE
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [
      ...HARNESS,
      ...(executablePath ? [] : ['.']),
      `--user-data-dir=${userDataDir}`,
      // Parallel test windows cover each other. Like Playwright does for browsers,
      // keep covered windows rendering at full speed: otherwise animation frames
      // stop (dialogs never finish closing, clicks wait for stability) and timers slow.
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling',
      '--disable-features=CalculateNativeWinOcclusion',
      // Numbers and dates as the tests expect them, whatever this computer's language is.
      '--lang=en-US',
      ...(options.args ?? []),
    ],
    env,
    // Let the app's own theme (nativeTheme) drive prefers-color-scheme.
    colorScheme: null,
  })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.webContents.setBackgroundThrottling(false)
  })
  // Transitions are shortened under reduced motion, which keeps the tests quick and stable.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // Reproduce a smaller screen (e.g. LUMOVI_E2E_WINDOW=1024x768, like CI runners).
  const size = (
    'LUMOVI_E2E_WINDOW' in (options.env ?? {})
      ? options.env!.LUMOVI_E2E_WINDOW
      : process.env.LUMOVI_E2E_WINDOW
  )
    ?.split('x')
    .map(Number)
  if (size) {
    await app.evaluate(({ BrowserWindow }, [width, height]) => {
      BrowserWindow.getAllWindows()[0]!.setSize(width!, height!)
    }, size)
  }
  if (options.fullLayout ?? true) {
    // Small screens (CI runners have 1024x768) would otherwise show fewer
    // table columns than the tests expect. macOS shrinks the window to the
    // screen only when it is shown, so fit again whenever the size changes.
    await app.evaluate(({ BrowserWindow }, reference) => {
      const win = BrowserWindow.getAllWindows()[0]!
      const fit = () => {
        const [width, height] = win.getContentSize()
        win.webContents.setZoomFactor(
          Math.min(1, width! / reference.width, height! / reference.height),
        )
      }
      fit()
      win.on('show', fit)
      win.on('resize', fit)
    }, REFERENCE_SIZE)
  }
  let closed = false
  return {
    app,
    page,
    userDataDir,
    async close() {
      if (closed) return
      closed = true
      await within('collecting coverage', 15_000, () => collectCoverage(app))
      // What its main process has running as it's asked to quit, to say if it doesn't (once
      // it's asked, it can't be asked anything else).
      let running = '(it doesn’t answer)'
      await within('asking what it has running', 5_000, async () => {
        running = (await app.evaluate(() => process.getActiveResourcesInfo())).join(', ')
      }).catch(() => undefined)
      // The app may already have quit on its own (e.g. a test closed its window).
      const quit = await within('quitting', 15_000, () => app.close().catch(() => undefined))
      if (!quit) {
        console.warn(`The app didn’t quit: it had ${running}. It’s stopped.`)
        app.process().kill('SIGKILL')
      }
    },
  }
}

interface Fixtures {
  clusters: TestClusters
  /** The stand-in for dl.k8s.io terminals get kubectl from (LUMOVI_KUBECTL_MIRROR). */
  downloads: MockDownloads
  launch: (options?: LaunchOptions) => Promise<Lumovi>
  lumovi: Lumovi
  page: Page
}

/**
 * Starts CPU profiles of the app's main process and page; the returned
 * function saves them next to the test's other output.
 */
async function profile({ app, page }: Lumovi, testInfo: TestInfo, i: number) {
  await app.evaluate(() => {
    const { Session } = process.getBuiltinModule('node:inspector')
    const session = new Session()
    session.connect()
    session.post('Profiler.enable')
    session.post('Profiler.start')
    Object.assign(globalThis, { __lumoviProfiler__: session })
  })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.start')
  return async () => {
    const main = await app.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const { __lumoviProfiler__: session } = globalThis as unknown as {
            __lumoviProfiler__: import('node:inspector').Session
          }
          session.post('Profiler.stop', (_error, result) => resolve(JSON.stringify(result.profile)))
        }),
    )
    writeFileSync(testInfo.outputPath(`main-${i}.cpuprofile`), main)
    const { profile } = await cdp.send('Profiler.stop')
    writeFileSync(testInfo.outputPath(`page-${i}.cpuprofile`), JSON.stringify(profile))
  }
}

/**
 * Writes what a failed CI test left behind: the windows' state and the mock
 * clusters' last requests with their timing, to tell a slow cluster from a stuck app.
 */
async function diagnose(path: string, clusters: TestClusters, launched: Lumovi[]) {
  const within = <T>(promise: Promise<T>) =>
    Promise.race([
      promise,
      new Promise<string>((r) => setTimeout(() => r('(no answer in 3s)'), 3_000)),
    ])
  const lines: string[] = [`at ${new Date().toISOString()}`]
  for (const [i, { app, page }] of launched.entries()) {
    const started = Date.now()
    const window = await within(
      app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        return win
          ? JSON.stringify({
              visible: win.isVisible(),
              minimized: win.isMinimized(),
              focused: win.isFocused(),
              bounds: win.getBounds(),
              throttling: win.webContents.getBackgroundThrottling(),
            })
          : 'no window'
      }),
    ).catch((error: Error) => error.message)
    const mainMs = Date.now() - started
    const state = await within(
      page.evaluate(() =>
        JSON.stringify({ visibility: document.visibilityState, focus: document.hasFocus() }),
      ),
    ).catch((error: Error) => error.message)
    lines.push(`app ${i}: main answered in ${mainMs}ms ${window}; page ${state}`)
    // Its terminals: what each pty gave the main process, what the page was handed of it (and
    // how it began), how much of it is drawn, and what the page sent back. (Where a terminal's
    // output stopped, if it did; and whether its shell asked something and was answered.)
    const ptys = await within(
      app.evaluate(() =>
        JSON.stringify((globalThis as { __ptys?: unknown }).__ptys ?? 'not counted'),
      ),
    ).catch((error: Error) => error.message)
    const heard = await within(
      page.evaluate(() =>
        JSON.stringify({
          handed: (window as { __terminalHeard?: unknown }).__terminalHeard ?? 'not counted',
          drawn: [...document.querySelectorAll<HTMLElement>('.xterm-rows')].map(
            (rows) => rows.innerText.trim().length,
          ),
        }),
      ),
    ).catch((error: Error) => error.message)
    const sent = await within(
      app.evaluate(() =>
        JSON.stringify(
          (globalThis as { __terminalSent?: unknown }).__terminalSent ?? 'not counted',
        ),
      ),
    ).catch((error: Error) => error.message)
    lines.push(`app ${i} terminals: ptys ${ptys}; page ${heard}; sent back ${sent}`)
  }
  for (const [i, { app }] of launched.entries()) {
    const metrics = await within(
      app.evaluate(({ app }) =>
        app
          .getAppMetrics()
          .map((m) => `${m.type} ${m.pid}: ${(m.cpu.cumulativeCPUUsage ?? 0).toFixed(1)}s of CPU`)
          .join(', '),
      ),
    ).catch((error: Error) => error.message)
    lines.push(`app ${i} processes: ${metrics}`)
  }
  for (const name of ['demo', 'sandbox', 'large'] as const) {
    const { requests } = clusters[name]
    lines.push(`${name}: ${requests.length} requests`)
    for (const r of requests.slice(-80)) {
      const at = r.at ? new Date(r.at).toISOString().slice(11, 23) : '?'
      lines.push(
        `  ${at} ${r.status ?? '…'} ${r.ms ?? '…'}ms ${r.method} ${r.path}${r.search ? '?' + r.search : ''}`,
      )
    }
  }
  writeFileSync(path, lines.join('\n'))
}

/**
 * Adds to a failed test's diagnostics, on Windows, what only PowerShell can say: what keeps the
 * machine busy, every shell there is, and how long one takes to start. Asked last of all that's
 * kept of a failure and while Lumovi still runs (its terminals' shells with it): PowerShell is
 * slow to start in the very failure this is most wanted for, so each answer is written as it
 * comes, and a teardown that runs out of time has lost only what wasn't asked yet.
 */
function diagnoseShells(path: string) {
  if (process.platform !== 'win32') return
  const SHELL_MS = 20_000
  /** What PowerShell says of `command`, added to the file as soon as it's known. */
  const ask = (title: string, command: string) => {
    let said: string
    try {
      said = execFileSync('powershell', ['-NoProfile', '-Command', command], {
        encoding: 'utf8',
        timeout: SHELL_MS,
      })
    } catch (error) {
      said = (error as Error).message
    }
    appendFileSync(path, `\n${title}:\n${said}`)
  }
  // What else keeps the machine busy (total CPU seconds so far).
  ask(
    `busiest processes (of ${cpus().length} cpus)`,
    'Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name,Id,CPU,WorkingSet | Format-Table -AutoSize | Out-String -Width 200',
  )
  // Every shell and console host there is: when each started, from what, and as what. (Whether
  // a terminal's shell exists, how long it has been starting, and whose the others are.)
  ask(
    'shells and console hosts',
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(powershell|pwsh|conhost|OpenConsole)' } | Sort-Object CreationDate | ForEach-Object { $line = [string]$_.CommandLine; $since = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('HH:mm:ss.fff') } else { '?' }; '{0} {1} from {2}, started {3}, {4:n1}s of CPU: {5}' -f $_.Name, $_.ProcessId, $_.ParentProcessId, $since, (($_.KernelModeTime + $_.UserModeTime) / 1e7), $line.Substring(0, [Math]::Min(160, $line.Length)) }",
  )
  // How long Windows PowerShell takes to start just now, as a terminal's does (with the
  // profile) and without: a terminal's first line can't come sooner than that. (Twenty
  // seconds says as much as a longer wait would.)
  for (const profile of [[], ['-NoProfile']]) {
    const from = Date.now()
    let took: string
    try {
      execFileSync('powershell', ['-NoLogo', ...profile, '-Command', 'exit'], { timeout: SHELL_MS })
      took = `starts and ends in ${Date.now() - from}ms`
    } catch {
      took = `hadn’t started and ended in ${Date.now() - from}ms`
    }
    appendFileSync(path, `\npowershell ${profile.join(' ')} ${took}`)
  }
}

export const test = base.extend<
  Fixtures,
  { workerClusters: TestClusters; workerDownloads: MockDownloads }
>({
  workerClusters: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const dir = mkdtempSync(join(tmpdir(), 'lumovi-clusters-'))
      const clusters = await startTestClusters(dir)
      await use(clusters)
      await clusters.close()
      rmSync(dir, { recursive: true, force: true })
    },
    { scope: 'worker' },
  ],
  workerDownloads: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const downloads = await startMockDownloads()
      // A packaged app takes no stand-in for Sigstore: what it downloads from the tests' dl.k8s.io
      // is as from a mirror that keeps no signatures (the tests of signatures don't run there).
      if (PACKAGED) {
        downloads.defaultSigning = 'unsigned'
        downloads.reset()
      }
      await use(downloads)
      await downloads.close()
    },
    { scope: 'worker' },
  ],
  downloads: async ({ workerDownloads }, use) => {
    await use(workerDownloads)
    workerDownloads.reset()
  },
  clusters: async ({ workerClusters }, use) => {
    await use(workerClusters)
    // Undo faults and object changes a test made.
    workerClusters.demo.reset()
    workerClusters.sandbox.reset()
    workerClusters.large.reset()
  },
  launch: async ({ clusters, downloads }, use, testInfo) => {
    const launched: Lumovi[] = []
    // On CI, failures keep a trace (DOM snapshots, actions, console) to see what happened.
    const trace = Boolean(process.env.CI)
    const profiles: (() => Promise<void>)[] = []
    await use(async (options = {}) => {
      const helmDir = mkdtempSync(join(tmpdir(), 'lumovi-helm-'))
      const instance = await launchApp(clusters.kubeconfigPath, {
        ...options,
        env: {
          LUMOVI_HELM: FAKE_HELM,
          FAKE_HELM_DIR: helmDir,
          // What Lumovi's metrics stack is made of, which the stand-in makes in the cluster.
          FAKE_HELM_STACK: resolve('tests/e2e/helm/metrics-stack.yaml'),
          // Never dl.k8s.io itself, nor Sigstore's trust root: their stand-ins.
          LUMOVI_KUBECTL_MIRROR: downloads.url,
          LUMOVI_KUBECTL_OFFICIAL: downloads.url,
          LUMOVI_SIGSTORE_ROOT: downloads.sigstoreRoot,
          ...options.env,
        },
      })
      instance.helmDir = helmDir
      if (trace) {
        await instance.app.context().tracing.start({ screenshots: true, snapshots: true })
        profiles.push(await profile(instance, testInfo, launched.length))
      }
      launched.push(instance)
      return instance
    })
    const failed = testInfo.status !== testInfo.expectedStatus
    if (trace && failed) {
      await diagnose(testInfo.outputPath('diagnostics.txt'), clusters, launched)
      for (const save of profiles) await save().catch(() => undefined)
    }
    for (const [i, instance] of launched.entries()) {
      if (trace) {
        const path = failed ? testInfo.outputPath(`trace-${i}.zip`) : undefined
        // The app may have quit already, taking its trace with it.
        await within('stopping the trace', 10_000, () =>
          instance.app
            .context()
            .tracing.stop({ path })
            .catch(() => undefined),
        )
      }
    }
    // (After the traces, which a failure is read from too; before Lumovi closes its terminals.)
    if (trace && failed) diagnoseShells(testInfo.outputPath('diagnostics.txt'))
    for (const instance of launched) await instance.close()
  },
  lumovi: async ({ launch }, use) => {
    await use(await launch())
  },
  page: async ({ lumovi }, use) => {
    await use(lumovi.page)
  },
})

/** Opens a cluster from the welcome screen and waits for the overview. */
export async function openCluster(page: Page, context: string = CONTEXTS.demo): Promise<void> {
  await clusterOption(page, context).click()
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toContainText(context)
}

/** A cluster on the start screen, in the list (Recent has some again). */
export function clusterOption(page: Page, context: string) {
  return page
    .getByRole('group', { name: /^(?!Recent$)/ })
    .getByRole('option', { name: new RegExp(`^${context}\\b`) })
}

/** The kinds of workload, each a tab of Workloads. */
const WORKLOAD_TABS = ['Deployments', 'StatefulSets', 'DaemonSets', 'Jobs', 'CronJobs']
/** Lists the sidebar doesn't show, found with ⌘K. */
const PALETTE_ONLY = ['ReplicaSets', 'Autoscalers']

/** Navigates as a user would: with the sidebar, Workloads' tabs, or ⌘K. */
export async function goTo(page: Page, label: string): Promise<void> {
  const sidebar = page.getByRole('navigation', { name: 'Resources' })
  if (WORKLOAD_TABS.includes(label)) {
    await sidebar.getByRole('link', { name: 'Workloads', exact: true }).click()
    await page
      .getByRole('navigation', { name: 'Workload types' })
      .getByRole('link', { name: new RegExp(`^${label}\\b`) })
      .click()
  } else if (PALETTE_ONLY.includes(label)) {
    await page.keyboard.press('ControlOrMeta+k')
    // Options are named with their hint ("Autoscalers Workloads").
    await page.getByRole('option', { name: new RegExp(`^${label}\\b`) }).click()
  } else {
    await sidebar.getByRole('link', { name: label, exact: true }).click()
  }
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(label)
}

/** What the app last copied (to its own clipboard: see harness.cjs). */
export function clipboardText(page: Page): Promise<string> {
  return page.evaluate(() => (window as { __clipboard?: string }).__clipboard ?? '')
}

/**
 * Hovers `target` until its tooltip says `text`. A page that's still settling (data
 * arriving, fonts) can move what's under the pointer, and the tooltip closes with it.
 */
export async function hoverForTooltip(target: Locator, text: string | RegExp): Promise<void> {
  const tooltip = target.page().getByRole('tooltip')
  await expect(async () => {
    await target.hover()
    await expect(tooltip).toContainText(text, { timeout: 1000 })
  }).toPass()
}

/** The detail panel for an object. */
export function panel(page: Page, kind: string, name: string) {
  return page.getByRole('complementary', { name: `${kind} ${name}` })
}

/** Replaces shell.openExternal in the main process; returns a reader for the URLs it received. */
export async function mockOpenExternal(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { __opened?: string[] }).__opened = opened
    shell.openExternal = async (url: string) => {
      opened.push(url)
    }
  })
  return () => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])
}

/** A data row of the resource table labelled `label`, found by its text. */
export function row(page: Page, label: string, text: string | RegExp) {
  return page
    .getByRole('grid', { name: label })
    .getByRole('row')
    .filter({ has: page.getByRole('gridcell') })
    .filter({ hasText: text })
}

/** All data rows of the resource table labelled `label`. */
export function rows(page: Page, label: string) {
  return page
    .getByRole('grid', { name: label })
    .getByRole('row')
    .filter({ has: page.getByRole('gridcell') })
}

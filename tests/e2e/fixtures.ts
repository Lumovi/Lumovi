/**
 * Test fixtures: every worker gets its own mock clusters and kubeconfig, every
 * test gets a fresh KubeStacks window with an isolated user-data directory.
 * When the build is instrumented, coverage from the main, preload and
 * renderer processes is written to `.nyc_output/` for `nyc report`.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { cpus, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { CONTEXTS, startTestClusters, type TestClusters } from '../mock-cluster/kubeconfig.ts'

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
   * zooming out (true unless a test is about narrow windows).
   */
  fullLayout?: boolean
}

/** The app's default content size; tests are written against this layout. */
const REFERENCE_SIZE = { width: 1440, height: 920 }

export interface KubeStacks {
  app: ElectronApplication
  page: Page
  userDataDir: string
  /** Where the stand-in helm records its calls and reads scripted answers (tests/e2e/helm). */
  helmDir?: string
  close(): Promise<void>
}

/** Keeps test windows out of the way (see the file); KUBESTACKS_E2E_FOREGROUND=1 shows them. */
const BACKGROUND = process.env.KUBESTACKS_E2E_FOREGROUND
  ? []
  : ['-r', resolve('tests/e2e/background.cjs')]

/** The stand-in for helm the e2e tests run, instead of a real one. */
const FAKE_HELM = resolve('tests/e2e/helm', process.platform === 'win32' ? 'helm.cmd' : 'helm')

async function collectCoverage(app: ElectronApplication): Promise<void> {
  for (const window of app.windows()) {
    try {
      const coverage = await window.evaluate(() => {
        const w = window as unknown as {
          __coverage__?: object
          __kubestacksCoverage__?: () => object | undefined
        }
        return [w.__coverage__, w.__kubestacksCoverage__?.()]
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
): Promise<KubeStacks> {
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'kubestacks-user-'))
  if (options.theme) {
    mkdirSync(userDataDir, { recursive: true })
    writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ theme: options.theme }))
  }
  const env: Record<string, string> = {}
  const merged = {
    ...process.env,
    KUBECONFIG: kubeconfig,
    KUBESTACKS_COVERAGE_DIR: COVERAGE_DIR,
    // Never the developer's own views.
    KUBESTACKS_VIEWS_DIR: join(userDataDir, 'views'),
    // Keep tests independent of the developer's login shell.
    SHELL: undefined,
    ELECTRON_RENDERER_URL: undefined,
    ...options.env,
  }
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) env[key] = value
  }
  // KUBESTACKS_E2E_EXECUTABLE runs the suite against a packaged app instead of the build in out/.
  const executablePath = process.env.KUBESTACKS_E2E_EXECUTABLE
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: [
      ...BACKGROUND,
      ...(executablePath ? [] : ['.']),
      `--user-data-dir=${userDataDir}`,
      // Parallel test windows cover each other. Like Playwright does for browsers,
      // keep covered windows rendering at full speed: otherwise animation frames
      // stop (dialogs never finish closing, clicks wait for stability) and timers slow.
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling',
      '--disable-features=CalculateNativeWinOcclusion',
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
  // Reproduce a smaller screen (e.g. KUBESTACKS_E2E_WINDOW=1024x768, like CI runners).
  const size = (
    'KUBESTACKS_E2E_WINDOW' in (options.env ?? {})
      ? options.env!.KUBESTACKS_E2E_WINDOW
      : process.env.KUBESTACKS_E2E_WINDOW
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
      await collectCoverage(app)
      // The app may already have quit on its own (e.g. a test closed its window).
      await app.close().catch(() => undefined)
    },
  }
}

interface Fixtures {
  clusters: TestClusters
  launch: (options?: LaunchOptions) => Promise<KubeStacks>
  kubestacks: KubeStacks
  page: Page
}

/**
 * Starts CPU profiles of the app's main process and page; the returned
 * function saves them next to the test's other output.
 */
async function profile({ app, page }: KubeStacks, testInfo: TestInfo, i: number) {
  await app.evaluate(() => {
    const { Session } = process.getBuiltinModule('node:inspector')
    const session = new Session()
    session.connect()
    session.post('Profiler.enable')
    session.post('Profiler.start')
    Object.assign(globalThis, { __kubestacksProfiler__: session })
  })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.start')
  return async () => {
    const main = await app.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const { __kubestacksProfiler__: session } = globalThis as unknown as {
            __kubestacksProfiler__: import('node:inspector').Session
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
async function diagnose(path: string, clusters: TestClusters, launched: KubeStacks[]) {
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
  if (process.platform === 'win32') {
    // What else keeps the machine busy (total CPU seconds so far).
    const top = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Name,Id,CPU,WorkingSet | Format-Table -AutoSize | Out-String -Width 200',
      ],
      { encoding: 'utf8' },
    )
    lines.push(`busiest processes:${top}`, `cpus: ${cpus().length}`)
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

export const test = base.extend<Fixtures, { workerClusters: TestClusters }>({
  workerClusters: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const dir = mkdtempSync(join(tmpdir(), 'kubestacks-clusters-'))
      const clusters = await startTestClusters(dir)
      await use(clusters)
      await clusters.close()
      rmSync(dir, { recursive: true, force: true })
    },
    { scope: 'worker' },
  ],
  clusters: async ({ workerClusters }, use) => {
    await use(workerClusters)
    // Undo faults and object changes a test made.
    workerClusters.demo.reset()
    workerClusters.sandbox.reset()
    workerClusters.large.reset()
  },
  launch: async ({ clusters }, use, testInfo) => {
    const launched: KubeStacks[] = []
    // On CI, failures keep a trace (DOM snapshots, actions, console) to see what happened.
    const trace = Boolean(process.env.CI)
    const profiles: (() => Promise<void>)[] = []
    await use(async (options = {}) => {
      const helmDir = mkdtempSync(join(tmpdir(), 'kubestacks-helm-'))
      const instance = await launchApp(clusters.kubeconfigPath, {
        ...options,
        env: { KUBESTACKS_HELM: FAKE_HELM, FAKE_HELM_DIR: helmDir, ...options.env },
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
        await instance.app
          .context()
          .tracing.stop({ path })
          .catch(() => undefined)
      }
      await instance.close()
    }
  },
  kubestacks: async ({ launch }, use) => {
    await use(await launch())
  },
  page: async ({ kubestacks }, use) => {
    await use(kubestacks.page)
  },
})

/** Opens a cluster from the welcome screen and waits for the overview. */
export async function openCluster(page: Page, context: string = CONTEXTS.demo): Promise<void> {
  await clusterOption(page, context).click()
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toContainText(context)
}

/** A cluster on the start screen. */
export function clusterOption(page: Page, context: string) {
  return page.getByRole('option', { name: new RegExp(`^${context}\\b`) })
}

/** Navigates with the sidebar. */
export async function goTo(page: Page, label: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: label, exact: true })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(label)
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

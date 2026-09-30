/**
 * Test fixtures: every worker gets its own mock clusters and kubeconfig, every
 * test gets a fresh KubeStacks window with an isolated user-data directory.
 * When the build is instrumented, coverage from the main, preload and
 * renderer processes is written to `.nyc_output/` for `nyc report`.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page,
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
}

export interface KubeStacks {
  app: ElectronApplication
  page: Page
  userDataDir: string
  close(): Promise<void>
}

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
  clusters: TestClusters,
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
    KUBECONFIG: clusters.kubeconfigPath,
    KUBESTACKS_COVERAGE_DIR: COVERAGE_DIR,
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
      ...(executablePath ? [] : ['.']),
      `--user-data-dir=${userDataDir}`,
      ...(options.args ?? []),
    ],
    env,
    // Let the app's own theme (nativeTheme) drive prefers-color-scheme.
    colorScheme: null,
  })
  const page = await app.firstWindow()
  // Reproduce a smaller screen (e.g. KUBESTACKS_E2E_WINDOW=1024x768, like Windows CI runners).
  const size = process.env.KUBESTACKS_E2E_WINDOW?.split('x').map(Number)
  if (size) {
    await app.evaluate(({ BrowserWindow }, [width, height]) => {
      BrowserWindow.getAllWindows()[0]!.setSize(width!, height!)
    }, size)
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
  launch: async ({ clusters }, use) => {
    const launched: KubeStacks[] = []
    await use(async (options) => {
      const instance = await launchApp(clusters, options)
      launched.push(instance)
      return instance
    })
    for (const instance of launched) await instance.close()
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
  await page
    .getByRole('list', { name: 'Clusters' })
    .getByRole('button', { name: new RegExp(`^${context}\\b`) })
    .click()
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toContainText(context)
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
    .getByRole('table', { name: label })
    .getByRole('row')
    .filter({ has: page.getByRole('cell') })
    .filter({ hasText: text })
}

/** All data rows of the resource table labelled `label`. */
export function rows(page: Page, label: string) {
  return page
    .getByRole('table', { name: label })
    .getByRole('row')
    .filter({ has: page.getByRole('cell') })
}

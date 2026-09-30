import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import electronPath from 'electron'
import { writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import {
  COVERAGE_DIR,
  CONTEXTS,
  DEMO,
  DEMO_TOKEN,
  expect,
  goTo,
  mockOpenExternal,
  openCluster,
  panel,
  row,
  test,
} from './fixtures.ts'

const posixOnly = process.platform === 'win32'

test('a second launch focuses the running window instead', async ({ kubestacks, clusters }) => {
  const { app } = kubestacks
  // The window is revealed on ready-to-show; minimizing before that would be undone.
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()))
    .toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.minimize())
  // Without a window manager (Linux CI under Xvfb) windows cannot be minimized.
  if (process.platform !== 'linux') {
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized()),
      )
      .toBe(true)
  }
  const packaged = process.env.KUBESTACKS_E2E_EXECUTABLE
  const second = spawn(
    packaged ?? (electronPath as unknown as string),
    [...(packaged ? [] : ['.']), `--user-data-dir=${kubestacks.userDataDir}`],
    {
      env: {
        ...process.env,
        KUBECONFIG: clusters.kubeconfigPath,
        KUBESTACKS_COVERAGE_DIR: COVERAGE_DIR,
      },
      stdio: 'ignore',
    },
  )
  const code = await new Promise<number | null>((done) => second.once('exit', done))
  expect(code).toBe(0)
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized()),
    )
    .toBe(false)
  expect(app.windows()).toHaveLength(1)

  // macOS re-activates the app on its own before the event arrives, so also
  // deliver the event in-process to check that a minimized window is restored.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.minimize())
  if (process.platform !== 'linux') {
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized()),
      )
      .toBe(true)
  }
  await app.evaluate(({ app }) => app.emit('second-instance'))
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized()),
    )
    .toBe(false)
  // A window that is already open just gets focused.
  await app.evaluate(({ app }) => app.emit('second-instance'))
  expect(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized()),
  ).toBe(false)
})

test('closing the window quits the app', async ({ kubestacks }) => {
  const exited = new Promise((done) => kubestacks.app.process().once('exit', done))
  await kubestacks.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
  await exited
})

test('never navigates away or opens pop-ups', async ({ kubestacks }) => {
  const { page, app } = kubestacks
  const url = page.url()
  expect(await page.evaluate(() => window.open('https://example.com'))).toBeNull()
  await page.evaluate(() => {
    window.location.href = 'https://example.com/'
  })
  await page.waitForTimeout(300)
  expect(page.url()).toBe(url)
  expect(app.windows()).toHaveLength(1)
})

test('only hands https links to the operating system', async ({ kubestacks }) => {
  const opened = await mockOpenExternal(kubestacks.app)
  const results = await kubestacks.page.evaluate(() =>
    Promise.all([
      window.kubestacks.app.openExternal('file:///etc/passwd'),
      window.kubestacks.app.openExternal(42 as unknown as string),
      window.kubestacks.app.openExternal('https://kubernetes.io/docs/'),
    ]),
  )
  expect(results).toEqual([false, false, true])
  expect(await opened()).toEqual(['https://kubernetes.io/docs/'])
})

test('rejects malformed requests from the renderer', async ({ page }) => {
  const errors = await page.evaluate(async () => {
    const kube = window.kubestacks.kube
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = async (promise: Promise<any>) => {
      const result = await promise
      return result.ok ? 'ok' : `${result.error.code}: ${result.error.message}`
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loose = (value: unknown) => value as any
    return Promise.all([
      call(kube.list(loose(null))),
      call(kube.list(loose('pods'))),
      call(kube.list(loose({ context: 'demo', kind: 'Widget' }))),
      call(kube.list(loose({ context: 'demo', kind: 'Pod', namespace: 5 }))),
      call(kube.list(loose({ context: '', kind: 'Pod' }))),
      call(kube.get(loose({ context: 'demo', kind: 'Pod', namespace: 'default' }))),
      call(kube.metrics(loose({ context: 'demo', target: 'services' }))),
      call(
        kube.logs(
          loose({
            context: 'demo',
            namespace: 'default',
            pod: 'debug-shell',
            container: 'shell',
            tailLines: 0,
          }),
        ),
      ),
      call(
        kube.logs(
          loose({
            context: 'demo',
            namespace: 'default',
            pod: 'debug-shell',
            container: 'shell',
            tailLines: 2.5,
          }),
        ),
      ),
      call(kube.version('no-such-context')),
      window.kubestacks.app.setTheme(loose('neon')).then(
        () => 'ok',
        (error: Error) => error.message,
      ),
    ])
  })
  expect(errors).toEqual([
    'invalid: Expected a query object',
    'invalid: Expected a query object',
    'invalid: Unknown resource kind "Widget"',
    'invalid: namespace must be a non-empty string',
    'invalid: context must be a non-empty string',
    'invalid: name must be a non-empty string',
    'invalid: target must be "nodes" or "pods"',
    'invalid: tailLines must be an integer between 1 and 10000',
    'invalid: tailLines must be an integer between 1 and 10000',
    'invalid: Unknown context "no-such-context"',
    expect.stringContaining('Unknown theme "neon"'),
  ])
})

test('ignores calls from frames that are not the app', async ({ kubestacks }) => {
  const outcome = await kubestacks.app.evaluate(async ({ BrowserWindow }, preload) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true },
    })
    await win.loadURL('data:text/html,<p>untrusted</p>')
    const result: string = await win.webContents.executeJavaScript(
      'window.kubestacks.app.info().then(() => "allowed", (error) => error.message)',
    )
    win.destroy()
    return result
  }, resolve('out/preload/index.cjs'))
  expect(outcome).toContain('Blocked app:info from an untrusted frame')
})

test('reports app and runtime versions', async ({ page }) => {
  const info = await page.evaluate(() => window.kubestacks.app.info())
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
  expect(info).toMatchObject({
    name: 'KubeStacks',
    version: pkg.version,
    platform: process.platform,
  })
  expect(info.electron).toMatch(/^\d+\./)
  expect(info.chrome).toMatch(/^\d+\./)
  expect(info.node).toMatch(/^\d+\./)
})

test('loads the page from ELECTRON_RENDERER_URL when set (dev server)', async ({ launch }) => {
  const url = pathToFileURL(resolve('out/renderer/index.html')).href
  const { page } = await launch({ env: { ELECTRON_RENDERER_URL: url } })
  await openCluster(page)
  expect(page.url()).toContain(url)
})

test('window chrome follows the theme', async ({ launch }) => {
  const light = await launch({ theme: 'light' })
  expect(
    await light.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.getBackgroundColor(),
    ),
  ).toBe('#F5F5F6')
  await light.page.getByRole('button', { name: 'Theme' }).click()
  await light.page.getByRole('menuitemradio', { name: 'Dark' }).click()
  await expect
    .poll(() => light.app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors))
    .toBe(true)
  await light.close()

  const dark = await launch({ theme: 'dark' })
  expect(
    await dark.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.getBackgroundColor(),
    ),
  ).toBe('#0C0C0E')
})

test('recovers from unreadable settings', async ({ launch }) => {
  const corrupt = mkdtempSync(join(tmpdir(), 'kubestacks-user-'))
  writeFileSync(join(corrupt, 'settings.json'), '{ not json')
  const first = await launch({ userDataDir: corrupt })
  expect(await first.page.evaluate(() => window.kubestacks.app.settings())).toEqual({
    theme: 'system',
  })

  const unknown = mkdtempSync(join(tmpdir(), 'kubestacks-user-'))
  writeFileSync(join(unknown, 'settings.json'), JSON.stringify({ theme: 'neon' }))
  const second = await launch({ userDataDir: unknown })
  expect(await second.page.evaluate(() => window.kubestacks.app.settings())).toEqual({
    theme: 'system',
  })
})

test('gives up on API servers that stop answering', async ({ launch, clusters }) => {
  clusters.demo.fail('/version', { hang: true })
  const { page } = await launch({ env: { KUBESTACKS_REQUEST_TIMEOUT_MS: '500' } })
  const demo = page
    .getByRole('list', { name: 'Clusters' })
    .getByRole('listitem')
    .filter({ hasText: /^demo/ })
  await expect(demo).toContainText('Timed out')
})

test('explains API server errors', async ({ page, clusters }) => {
  clusters.demo.fail('/api/v1/configmaps', {
    status: 502,
    contentType: 'text/html',
    body: '<h1>Bad gateway</h1>',
  })
  clusters.demo.fail('/api/v1/secrets', {
    status: 500,
    contentType: 'application/json',
    body: '{}',
  })
  await openCluster(page)
  await goTo(page, 'ConfigMaps')
  await expect(page.getByRole('alert')).toContainText('The API server returned an error')
  await expect(page.getByRole('alert')).toContainText('HTTP 502')
  await goTo(page, 'Secrets')
  await expect(page.getByRole('alert')).toContainText('HTTP 500')
})

test('treats an unavailable metrics API as "no metrics"', async ({ page, clusters }) => {
  clusters.demo.fail('/apis/metrics.k8s.io/v1beta1/nodes', {
    status: 503,
    body: 'service unavailable',
  })
  clusters.demo.fail(/^\/apis\/metrics\.k8s\.io\/v1beta1\/(namespaces\/[^/]+\/)?pods$/, {
    status: 403,
    body: 'forbidden',
  })
  await openCluster(page)
  await expect(page.getByRole('region', { name: 'CPU', exact: true })).toContainText(
    'Live usage needs metrics-server',
  )
  await expect(page.getByRole('list', { name: 'Top CPU' })).toHaveCount(0)

  // Pod lists still work without usage numbers.
  await goTo(page, 'Deployments')
  await row(page, 'Deployments', DEMO.deployments.cart).click()
  await panel(page, 'Deployment', DEMO.deployments.cart).getByRole('tab', { name: 'Pods' }).click()
  await expect(
    panel(page, 'Deployment', DEMO.deployments.cart).getByRole('table', { name: 'Pods' }),
  ).toContainText('Running')
})

test.describe('login shell PATH', () => {
  test.skip(posixOnly, 'Windows apps inherit the full user PATH')

  function fakeShell(dir: string, body: string): string {
    const path = join(dir, 'fake-shell')
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
    return path
  }

  test('credential plugins are found on the PATH from the login shell', async ({
    launch,
    clusters,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), 'kubestacks-shell-'))
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const plugin = join(bin, 'kubestacks-test-credential')
    const credential = {
      apiVersion: 'client.authentication.k8s.io/v1',
      kind: 'ExecCredential',
      status: { token: DEMO_TOKEN },
    }
    writeFileSync(plugin, `#!/bin/sh\necho '${JSON.stringify(credential)}'\n`)
    chmodSync(plugin, 0o755)
    const kubeconfig = writeKubeconfig(dir, {
      clusters: [{ name: 'demo', server: clusters.demo.url, caPem: clusters.demo.caPem }],
      users: [{ name: 'plugin-user', exec: { command: 'kubestacks-test-credential' } }],
      contexts: [{ name: 'via-plugin', cluster: 'demo', user: 'plugin-user' }],
    })
    const shell = fakeShell(dir, `printf '__KUBESTACKS_PATH__%s__KUBESTACKS_PATH__' "${bin}:$PATH"`)
    const { page, app } = await launch({ env: { SHELL: shell, KUBECONFIG: kubeconfig } })
    await expect(page.getByRole('list', { name: 'Clusters' })).toContainText(DEMO.gitVersion)
    expect(await app.evaluate(() => process.env.PATH)).toContain(bin)
  })

  test('keeps the inherited PATH when the shell prints nothing or fails', async ({ launch }) => {
    const dir = mkdtempSync(join(tmpdir(), 'kubestacks-shell-'))
    for (const body of ['exit 0', 'exit 3']) {
      const { app, close } = await launch({ env: { SHELL: fakeShell(dir, body) } })
      await app.evaluate(() => new Promise((done) => setTimeout(done, 200)))
      expect(await app.evaluate(() => process.env.PATH)).toBe(process.env.PATH)
      await close()
    }
  })
})

test('connects to plain HTTP clusters only when allowed', async ({ page }) => {
  await openCluster(page, CONTEXTS.plainHttp)
  await expect(page.getByRole('alert')).toContainText('Plain HTTP is not allowed')
  await expect(page.getByRole('alert')).toContainText('insecure-skip-tls-verify')
})

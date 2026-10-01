import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import electronPath from 'electron'
import { writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import {
  clusterOption,
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

test('the page gets none of the browser’s permissions', async ({ page }) => {
  expect(await page.evaluate(() => Notification.requestPermission())).toBe('denied')
  expect(
    await page.evaluate(
      async () => (await navigator.permissions.query({ name: 'geolocation' })).state,
    ),
  ).toBe('denied')
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
      call(kube.list(loose({ context: 'demo', kind: '../secrets' }))),
      call(kube.list(loose({ context: 'demo', kind: 'Widget' }))),
      call(kube.list(loose({ context: 'demo', kind: 'Pod', namespace: 5 }))),
      call(kube.list(loose({ context: '', kind: 'Pod' }))),
      call(kube.get(loose({ context: 'demo', kind: 'Pod', namespace: 'default' }))),
      call(kube.metrics(loose({ context: 'demo', target: 'services' }))),
      ...[
        { id: 'short', tailLines: 10 },
        { id: 'stream-0001', tailLines: 0 },
        { id: 'stream-0002', sinceSeconds: 2.5 },
        { id: 'stream-0003', sinceTime: 'yesterday' },
        { id: 'stream-0004', container: '' },
      ].map(({ id, ...request }) =>
        call(
          window.kubestacks.logs.start(
            id,
            loose({
              context: 'demo',
              namespace: 'default',
              pod: 'debug-shell',
              container: 'shell',
              previous: false,
              follow: true,
              ...request,
            }),
          ),
        ),
      ),
      call(window.kubestacks.app.saveFile(loose(5), 'text')),
      call(window.kubestacks.app.saveFile('logs.log', loose(5))),
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
    'invalid: Unknown resource kind "../secrets"',
    // The cluster serves Widget.example.com, not a Widget in the core group.
    'not-found: demo doesn’t serve Widget resources.',
    'invalid: namespace must be a non-empty string',
    'invalid: context must be a non-empty string',
    'invalid: name must be a non-empty string',
    'invalid: target must be "nodes" or "pods"',
    'invalid: A new stream needs a new id',
    'invalid: tailLines must be an integer between 1 and 10000',
    'invalid: sinceSeconds must be an integer between 1 and 2592000',
    'invalid: sinceTime must be a time',
    'invalid: container must be a non-empty string',
    'invalid: name must be a non-empty string',
    'invalid: text must be a string',
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
    // One-way messages from it are dropped silently.
    await win.webContents.executeJavaScript('window.kubestacks.terminal.close("anything")')
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
    readOnly: [],
    metricsSource: {},
    autoUpdate: true,
  })

  const unknown = mkdtempSync(join(tmpdir(), 'kubestacks-user-'))
  writeFileSync(
    join(unknown, 'settings.json'),
    JSON.stringify({
      theme: 'neon',
      readOnly: ['prod', 5, null],
      // Metrics sources that don't make sense fall back to detection.
      metricsSource: {
        demo: { mode: 'off' },
        sandbox: {
          mode: 'service',
          service: { namespace: 'monitoring', service: 'prom', port: 'web', path: 'no-slash' },
        },
        large: { mode: 'service', service: null },
        offline: 'prometheus',
        expired: null,
        other: { mode: 'sometimes' },
      },
      autoUpdate: false,
    }),
  )
  const second = await launch({ userDataDir: unknown })
  expect(await second.page.evaluate(() => window.kubestacks.app.settings())).toEqual({
    theme: 'system',
    readOnly: ['prod'],
    metricsSource: { demo: { mode: 'off' } },
    autoUpdate: false,
  })

  const odd = mkdtempSync(join(tmpdir(), 'kubestacks-user-'))
  writeFileSync(
    join(odd, 'settings.json'),
    // Only false turns update checks off.
    JSON.stringify({ theme: 'dark', readOnly: 'all', metricsSource: 'none', autoUpdate: 'no' }),
  )
  const third = await launch({ userDataDir: odd })
  expect(await third.page.evaluate(() => window.kubestacks.app.settings())).toEqual({
    theme: 'dark',
    readOnly: [],
    metricsSource: {},
    autoUpdate: true,
  })
})

test('gives up on API servers that stop answering', async ({ launch, clusters }) => {
  clusters.demo.fail('/version', { hang: true })
  const { page } = await launch({ env: { KUBESTACKS_REQUEST_TIMEOUT_MS: '500' } })
  const demo = clusterOption(page, CONTEXTS.demo)
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
    panel(page, 'Deployment', DEMO.deployments.cart).getByRole('grid', { name: 'Pods' }),
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
    await expect(clusterOption(page, 'via-plugin')).toContainText(DEMO.gitVersion)
    expect(await app.evaluate(() => process.env.PATH)).toContain(bin)
  })

  test('keeps the inherited PATH when the shell prints nothing or fails', async ({ launch }) => {
    const dir = mkdtempSync(join(tmpdir(), 'kubestacks-shell-'))
    for (const body of ['exit 0', 'exit 3']) {
      const { app, page, close } = await launch({ env: { SHELL: fakeShell(dir, body) } })
      // Cluster requests wait for the shell, so a connected cluster means it has answered.
      await expect(clusterOption(page, CONTEXTS.demo)).toContainText(DEMO.gitVersion)
      expect(await app.evaluate(() => process.env.PATH)).toBe(process.env.PATH)
      await close()
    }
  })
})

test('connects to plain HTTP clusters only when allowed', async ({ page }) => {
  await openCluster(page, CONTEXTS.plainHttp)
  await expect(page.getByRole('alert')).toContainText('Plain HTTP isn’t allowed')
  await expect(page.getByRole('alert')).toContainText('insecure-skip-tls-verify')
})

test('rejects malformed changes from the renderer', async ({ page, clusters }) => {
  const errors = await page.evaluate(async () => {
    const kube = window.kubestacks.kube
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = async (promise: Promise<any>) => {
      const result = await promise
      return result.ok ? 'ok' : `${result.error.code}: ${result.error.message}`
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loose = (value: unknown) => value as any
    const pod = { context: 'demo', kind: 'Pod', namespace: 'default', name: 'debug-shell' }
    const change = (c: unknown, extra: object = {}) =>
      call(kube.change(loose({ ...pod, ...extra, change: c })))
    return Promise.all([
      call(
        kube.change(
          loose({ context: 'demo', kind: 'Pod', name: 'x', change: { action: 'delete' } }),
        ),
      ),
      call(
        kube.change(
          loose({ context: 'demo', kind: 'Node', namespace: 'x', name: 'x', change: {} }),
        ),
      ),
      change(null),
      change({ action: 'delete' }, { name: undefined }),
      change({ action: 'patch', patchType: 'xml', patch: {} }),
      change({ action: 'patch', patchType: 'json', patch: {} }),
      change({ action: 'patch', patchType: 'merge', patch: [] }),
      change({ action: 'replace', object: { metadata: { name: 'other' } } }),
      change({ action: 'replace', object: 'yaml' }),
      change({ action: 'create', object: null }),
      change({ action: 'delete', propagation: 'Sideways' }),
      change({ action: 'delete', gracePeriodSeconds: -1 }),
      call(
        kube.change(
          loose({
            ...pod,
            kind: 'Service',
            name: 'grafana',
            namespace: 'monitoring',
            change: { action: 'evict' },
          }),
        ),
      ),
      change({ action: 'explode' }),
      // Dry runs are checked by the cluster but change nothing.
      change({ action: 'delete', gracePeriodSeconds: 0 }, { dryRun: true }),
      change({ action: 'evict' }, { dryRun: true }),
      change(
        {
          action: 'create',
          object: {
            metadata: { name: 'probe' },
            spec: { containers: [{ name: 'c', image: 'busybox' }] },
          },
        },
        { name: undefined, dryRun: true },
      ),
      call(kube.can('demo', loose('everything'))),
      call(kube.can('demo', loose(Array.from({ length: 51 }, () => ({}))))),
      call(kube.can('demo', loose([{ verb: 'impersonate', kind: 'Pod' }]))),
      call(
        kube.can('demo', [
          { verb: 'delete', kind: 'Pod', namespace: 'default', name: 'debug-shell' },
        ]),
      ),
      call(kube.history(loose({ context: 'demo', kind: 'Pod', namespace: 'default', name: 'x' }))),
      call(kube.history(loose({ context: 'demo', kind: 'Deployment', name: 'x' }))),
      call(kube.history(loose({ context: 'demo', kind: 'Deployment', namespace: 'shop' }))),
      window.kubestacks.app.setReadOnly(loose(''), loose('yes')).then(
        () => 'ok',
        (error: Error) => error.message,
      ),
    ])
  })
  expect(errors).toEqual([
    'invalid: namespace must be a non-empty string',
    'invalid: Node objects have no namespace',
    'invalid: Expected a query object',
    'invalid: name must be a non-empty string',
    'invalid: patchType must be one of merge, strategic, json',
    'invalid: A JSON patch must be a list',
    'invalid: patch must be an object',
    'invalid: The object’s name doesn’t match the one being replaced',
    'invalid: object must be an object',
    'invalid: object must be an object',
    'invalid: propagation must be one of Background, Foreground, Orphan',
    'invalid: gracePeriodSeconds must be an integer between 0 and 86400',
    'invalid: Only pods can be evicted',
    'invalid: Unknown change "explode"',
    'ok',
    'ok',
    'ok',
    'invalid: checks must be a list of at most 50 access checks',
    'invalid: checks must be a list of at most 50 access checks',
    'invalid: verb must be one of get, list, create, update, patch, delete',
    'ok',
    'invalid: kind must be one of Deployment, StatefulSet, DaemonSet',
    'invalid: namespace must be a non-empty string',
    'invalid: name must be a non-empty string',
    expect.stringContaining('Expected a context name and whether it is read-only'),
  ])
  // Dry runs left everything in place.
  expect(clusters.demo.object('Pod', 'default', 'debug-shell')).toBeDefined()
  expect(clusters.demo.object('Pod', 'default', 'probe')).toBeUndefined()
})

test('actions stay available when the cluster can’t answer access checks', async ({
  page,
  clusters,
}) => {
  clusters.demo.fail('/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', { status: 404 })
  await openCluster(page)
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'Nodes', exact: true })
    .click()
  await page
    .getByRole('grid', { name: 'Nodes' })
    .getByRole('row')
    .filter({ hasText: DEMO.nodes.worker1 })
    .first()
    .getByRole('gridcell')
    .nth(1)
    .click()
  await expect(
    page
      .getByRole('complementary', { name: `Node ${DEMO.nodes.worker1}` })
      .getByRole('button', { name: 'Cordon' }),
  ).toBeEnabled()
})

test('rejects malformed shell and port-forward requests', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { terminal, forwards, kube } = window.kubestacks
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = async (promise: Promise<any>) => {
      const result = await promise
      return result.ok ? 'ok' : `${result.error.code}: ${result.error.message}`
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loose = (value: unknown) => value as any
    // Messages for sessions that don't exist are ignored.
    terminal.write('no-such-session', 'ls\r')
    terminal.write('no-such-session', loose(5))
    terminal.resize('no-such-session', 80, 24)
    terminal.resize('no-such-session', loose('wide'), 24)
    terminal.close('no-such-session')
    await forwards.stop('no-such-forward')
    const shell = { context: 'demo', namespace: 'shop', pod: 'x', container: 'app' }
    const forward = {
      context: 'demo',
      namespace: 'shop',
      kind: 'Pod' as const,
      name: 'x',
      port: 80,
    }
    return Promise.all([
      call(terminal.open('not a valid id!', shell)),
      call(terminal.open('session-1234', loose(null))),
      call(terminal.open('session-1235', loose({ ...shell, container: undefined }))),
      call(terminal.open('session-1236', { ...shell, context: 'no-such-context' })),
      call(forwards.start(loose({ ...forward, kind: 'Deployment' }))),
      call(forwards.start({ ...forward, port: 0 })),
      call(forwards.start({ ...forward, localPort: 70_000 })),
      call(forwards.start({ ...forward, name: 'no-such-pod' })),
      call(forwards.start({ ...forward, kind: 'Service', name: 'storefront', port: 1234 })),
      call(
        forwards.start({
          ...forward,
          kind: 'Service',
          namespace: 'default',
          name: 'kubernetes',
          port: 443,
        }),
      ),
      call(
        kube.change(
          loose({
            context: 'demo',
            kind: 'Service',
            namespace: 'shop',
            name: 'storefront',
            change: { action: 'debug', container: 'd', image: 'busybox' },
          }),
        ),
      ),
      call(
        kube.change(
          loose({
            context: 'demo',
            kind: 'Pod',
            namespace: 'shop',
            name: 'x',
            change: { action: 'debug', image: 'busybox' },
          }),
        ),
      ),
      call(
        kube.change(
          loose({
            context: 'demo',
            kind: 'Pod',
            namespace: 'shop',
            name: 'x',
            change: { action: 'debug', container: 'd' },
          }),
        ),
      ),
      call(
        kube.change(
          loose({
            context: 'demo',
            kind: 'Pod',
            namespace: 'shop',
            name: 'x',
            change: { action: 'debug', container: 'd', image: 'busybox', target: 5 },
          }),
        ),
      ),
    ])
  })
  // Without a local port, a free one is picked.
  const picked = await page.evaluate(async () => {
    const result = await window.kubestacks.forwards.start({
      context: 'demo',
      namespace: 'shop',
      kind: 'Service',
      name: 'storefront',
      port: 80,
    })
    if (result.ok) await window.kubestacks.forwards.stop(result.data.id)
    return result.ok && result.data.localPort
  })
  expect(picked).toBeGreaterThan(1024)
  expect(results).toEqual([
    'invalid: A new session needs a new id',
    'invalid: Expected a query object',
    'invalid: container must be a non-empty string',
    'invalid: Unknown context "no-such-context"',
    'invalid: kind must be one of Pod, Service',
    'invalid: port must be an integer between 1 and 65535',
    'invalid: localPort must be an integer between 1 and 65535',
    'not-found: pods "no-such-pod" not found',
    'invalid: storefront has no port 1234',
    'invalid: kubernetes has no selector, so no pods to forward to',
    'invalid: Only pods can be debugged',
    'invalid: container must be a non-empty string',
    'invalid: image must be a non-empty string',
    'invalid: target must be a non-empty string',
  ])
})

test('opens local forwarded ports in the browser, but no other plain HTTP', async ({
  kubestacks,
}) => {
  const opened = await mockOpenExternal(kubestacks.app)
  const results = await kubestacks.page.evaluate(() =>
    Promise.all(
      [
        'http://localhost:8080/app',
        'http://localhost:3000',
        'http://localhost.example.com:80',
        'http://example.com',
      ].map((url) => window.kubestacks.app.openExternal(url)),
    ),
  )
  expect(results).toEqual([true, true, false, false])
  expect(await opened()).toEqual(['http://localhost:8080/app', 'http://localhost:3000'])
})

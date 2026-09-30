import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { demoCluster } from '../mock-cluster/fixtures/demo.ts'
import { writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import {
  CONTEXTS,
  DEMO,
  expect,
  goTo,
  mockOpenExternal,
  openCluster,
  panel,
  row,
  rows,
  test,
} from './fixtures.ts'

const heading = (page: Page) => page.getByRole('heading', { level: 1 })
const clipboard = (app: ElectronApplication) =>
  app.evaluate(({ clipboard }) => clipboard.readText())

/** Clicks an item of the native menu, like a user choosing it. */
const menu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, id) => {
    Menu.getApplicationMenu()!.getMenuItemById(id)!.click()
  }, id)

test.describe('keyboard shortcuts', () => {
  test('jump between views', async ({ page }) => {
    await openCluster(page)
    await page.keyboard.press('Meta+2')
    await expect(heading(page)).toHaveText('Pods')
    await page.keyboard.press('Control+4')
    await expect(heading(page)).toHaveText('Services')
    await page.keyboard.press('g')
    await page.keyboard.press('n')
    await expect(heading(page)).toHaveText('Nodes')
    await page.keyboard.press('g')
    await page.keyboard.press('o')
    await expect(heading(page)).toHaveText('Overview')

    // An unknown second key cancels the sequence; so does waiting too long.
    await page.keyboard.press('g')
    await page.keyboard.press('z')
    await page.keyboard.press('p')
    await expect(heading(page)).toHaveText('Overview')
    await page.keyboard.press('g')
    await page.waitForTimeout(1500)
    await page.keyboard.press('p')
    await expect(heading(page)).toHaveText('Overview')

    // Back and forward, with either shortcut.
    await page.keyboard.press('Meta+[')
    await expect(heading(page)).toHaveText('Nodes')
    await page.keyboard.press('Meta+]')
    await expect(heading(page)).toHaveText('Overview')
    await page.keyboard.press('Alt+ArrowLeft')
    await expect(heading(page)).toHaveText('Nodes')
    await page.keyboard.press('Alt+ArrowRight')
    await expect(heading(page)).toHaveText('Overview')

    // Typing in a field never triggers single-key shortcuts.
    await page.keyboard.press('Meta+2')
    await page.getByPlaceholder('Filter pods').fill('')
    await page.keyboard.press('g')
    await page.keyboard.press('n')
    await expect(heading(page)).toHaveText('Pods')
    await expect(page.getByPlaceholder('Filter pods')).toHaveValue('gn')
  })

  test('refresh, filter and the shortcut sheet', async ({ page, clusters }) => {
    await openCluster(page)
    await goTo(page, 'Services')
    const before = clusters.demo.requests.filter((r) => r.path === '/api/v1/services').length
    await page.keyboard.press('Meta+r')
    await expect
      .poll(() => clusters.demo.requests.filter((r) => r.path === '/api/v1/services').length)
      .toBeGreaterThan(before)

    await page.keyboard.press('/')
    await expect(page.getByPlaceholder('Filter services')).toBeFocused()
    await page.keyboard.press('Escape')
    // Modified keys that aren't shortcuts do nothing.
    await page.keyboard.press('Meta+j')

    await page.keyboard.press('?')
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(sheet).toContainText('Command palette')
    await expect(sheet).toContainText('Deployments')
    // Shortcuts don't reach past the open sheet.
    await page.keyboard.press('g')
    await page.keyboard.press('p')
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(heading(page)).toHaveText('Services')
  })

  test('on the start screen', async ({ page }) => {
    const search = page.getByPlaceholder('Search clusters…')
    await search.blur()
    await page.keyboard.press('Meta+k')
    await expect(search).toBeFocused()
    await search.blur()
    // "Go to" needs a cluster.
    await page.keyboard.press('g')
    await page.keyboard.press('p')
    await expect(search).toBeVisible()
    await page.keyboard.press('?')
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  })
})

test('keys typed while a view opens reach it', async ({ kubestacks }) => {
  const { page, app } = kubestacks
  await openCluster(page)
  // Both commands arrive before the next view has rendered.
  await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()!
    menu.getMenuItemById('go:Deployment')!.click()
    menu.getMenuItemById('filter')!.click()
  })
  const filter = page.getByPlaceholder('Filter deployments')
  await expect(filter).toBeFocused()
  // Fast typing keeps every key, even while the URL catches up.
  await page.keyboard.type('storefront')
  await expect(filter).toHaveValue('storefront')
  await expect(page).toHaveURL(/q=storefront/)

  // Without a filter to focus, "/" gives up quietly.
  await page.keyboard.press('Meta+1')
  await expect(heading(page)).toHaveText('Overview')
  await page.keyboard.press('/')
  await page.waitForTimeout(1200)
  await expect(page.locator('input:focus')).toHaveCount(0)
})

test('the native menu runs the same commands', async ({ kubestacks, clusters }) => {
  const { page, app } = kubestacks
  const opened = await mockOpenExternal(app)
  await openCluster(page)

  await menu(app, 'go:Pod')
  await expect(heading(page)).toHaveText('Pods')
  await menu(app, 'filter')
  await expect(page.getByPlaceholder('Filter pods')).toBeFocused()
  await menu(app, 'go:Node')
  await expect(heading(page)).toHaveText('Nodes')
  await menu(app, 'back')
  await expect(heading(page)).toHaveText('Pods')
  await menu(app, 'forward')
  await expect(heading(page)).toHaveText('Nodes')

  const before = clusters.demo.requests.length
  await menu(app, 'refresh')
  await expect.poll(() => clusters.demo.requests.length).toBeGreaterThan(before)

  await menu(app, 'palette')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  await menu(app, 'palette')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)
  await menu(app, 'shortcuts')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  await page.keyboard.press('Escape')

  await menu(app, 'github')
  await menu(app, 'issue')
  await expect
    .poll(opened)
    .toEqual([
      'https://github.com/kotapeter/kubestacks',
      'https://github.com/kotapeter/kubestacks/issues/new/choose',
    ])

  await menu(app, 'clusters')
  await expect(page.getByPlaceholder('Search clusters…')).toBeVisible()
  // The start screen has no views to go to.
  await menu(app, 'go:Pod')
  await expect(page.getByPlaceholder('Search clusters…')).toBeVisible()
})

test('the header navigates back and forward', async ({ page }) => {
  await openCluster(page)
  await goTo(page, 'Jobs')
  await page.getByRole('button', { name: /^Back/ }).click()
  await expect(heading(page)).toHaveText('Overview')
  await page.getByRole('button', { name: /^Forward/ }).click()
  await expect(heading(page)).toHaveText('Jobs')
  await expect(page).toHaveTitle(`Jobs · ${CONTEXTS.demo} — KubeStacks`)
})

test.describe('when things go wrong', () => {
  test('a page that fails to render shows a way out', async ({ kubestacks, clusters }) => {
    const { page, app } = kubestacks
    const opened = await mockOpenExternal(app)
    const broken = demoCluster().objects.find((o) => o.kind === 'Deployment')!
    clusters.demo.upsert({ ...broken, spec: { ...broken.spec, template: undefined } })
    await openCluster(page)
    await goTo(page, 'Deployments')
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('Something went wrong')
    await expect(alert).toContainText('Your clusters were not changed.')
    // The sidebar keeps working.
    await expect(page.getByRole('navigation', { name: 'Resources' })).toBeVisible()

    await alert.getByRole('button', { name: 'Copy details' }).click()
    await expect.poll(() => clipboard(app)).toContain('TypeError')
    await alert.getByRole('button', { name: 'Report issue' }).click()
    await expect.poll(opened).toEqual([expect.stringContaining('/issues/new?title=Crash')])

    await alert.getByRole('button', { name: 'Reload' }).click()
    await expect(page.getByRole('alert')).toContainText('Something went wrong')
    await page.getByRole('button', { name: 'Back to clusters' }).click()
    await expect(page.getByPlaceholder('Search clusters…')).toBeVisible()
  })

  test('an object that fails to render keeps the rest of the app usable', async ({
    page,
    clusters,
  }) => {
    const hpa = demoCluster().objects.find((o) => o.kind === 'HorizontalPodAutoscaler')!
    clusters.demo.upsert({ ...hpa, spec: { ...hpa.spec, metrics: undefined } })
    await openCluster(page)
    await goTo(page, 'Autoscalers')
    await row(page, 'Autoscalers', hpa.metadata.name).first().getByRole('gridcell').first().click()
    await expect(page.getByRole('alert')).toContainText('This object couldn’t be displayed')
    await expect(page.getByRole('grid', { name: 'Autoscalers' })).toBeVisible()
  })

  test('unknown pages say so', async ({ page }) => {
    await page.evaluate(() => {
      window.location.hash = '#/nowhere'
    })
    await expect(page.getByText('/nowhere')).toBeVisible()
    await page.getByRole('button', { name: 'Back to clusters' }).click()
    await openCluster(page)
    await page.evaluate(() => {
      window.location.hash = '#/cluster/demo/widgets'
    })
    await expect(page.getByRole('heading', { name: 'This page doesn’t exist' })).toBeVisible()
    await page.getByRole('button', { name: 'Go to the overview' }).click()
    await expect(heading(page)).toHaveText('Overview')
  })

  test('a lost connection is announced and retried', async ({ page }) => {
    await openCluster(page, CONTEXTS.offline)
    const banner = page.getByRole('status').filter({ hasText: 'Can’t reach offline.' })
    await expect(banner).toBeVisible()
    await banner.getByRole('button', { name: 'Retry now' }).click()
    await expect(banner).toBeVisible()
    await page.getByRole('alert').getByRole('button', { name: 'Choose another cluster' }).click()
    await expect(page.getByPlaceholder('Search clusters…')).toBeVisible()

    await openCluster(page, CONTEXTS.offline)
    await page.getByRole('status').getByRole('button', { name: 'All clusters' }).click()
    await expect(page.getByPlaceholder('Search clusters…')).toBeVisible()
  })

  test('the window recovers when its page crashes', async ({ kubestacks }) => {
    const { app, page } = kubestacks
    await openCluster(page)
    const contents = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript('document.body.innerText'),
      )
    const reloadedAt = await app.evaluate(
      ({ BrowserWindow }) =>
        new Promise<string>((resolve) => {
          const { webContents } = BrowserWindow.getAllWindows()[0]!
          webContents.once('did-finish-load', () => resolve(webContents.getURL()))
          webContents.forcefullyCrashRenderer()
        }),
    )
    // The window reloads where it was.
    expect(reloadedAt).toContain('#/cluster/demo')
    await expect.poll(contents).toContain('Pods running')
  })

  test('failing credential plugins are explained', async ({ launch, clusters }) => {
    test.skip(process.platform === 'win32', 'Needs a POSIX shell script as the plugin')
    const dir = mkdtempSync(join(tmpdir(), 'kubestacks-plugin-'))
    const plugin = join(dir, 'failing-plugin')
    writeFileSync(plugin, '#!/bin/sh\necho "token expired, run login" >&2\nexit 1\n')
    chmodSync(plugin, 0o755)
    const kubeconfig = writeKubeconfig(dir, {
      clusters: [{ name: 'demo', server: clusters.demo.url, caPem: clusters.demo.caPem }],
      users: [{ name: 'u', exec: { command: plugin } }],
      contexts: [{ name: 'failing-plugin', cluster: 'demo', user: 'u' }],
    })
    const { page } = await launch({ env: { KUBECONFIG: kubeconfig } })
    await expect(
      page.getByRole('option', { name: /^failing-plugin/ }).getByTitle(/Could not get credentials/),
    ).toBeAttached()
  })
})

test('the detail panel resizes, expands and remembers its width', async ({ page }) => {
  await openCluster(page)
  await goTo(page, 'Services')
  await row(page, 'Services', DEMO.services.storefront).first().click()
  const detail = panel(page, 'Service', DEMO.services.storefront)
  const handle = detail.getByRole('separator', { name: 'Resize panel' })
  await expect(handle).toHaveAttribute('aria-valuenow', '600')

  await handle.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(handle).toHaveAttribute('aria-valuenow', '632')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', '568')
  await page.keyboard.press('Enter')

  // Wait for the panel to finish sliding in before measuring.
  await handle.hover()
  const box = (await handle.boundingBox())!
  const x = box.x + box.width / 2
  await page.mouse.move(x, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(x - 100, box.y + 200, { steps: 4 })
  await page.mouse.up()
  await expect(handle).toHaveAttribute('aria-valuenow', '668')

  const width = async () => Math.round((await detail.boundingBox())!.width)
  await detail.getByRole('button', { name: 'Expand panel' }).click()
  await expect.poll(width).toBeGreaterThan(900)
  await detail.getByRole('button', { name: 'Restore panel' }).click()
  await expect.poll(width).toBe(668)

  // Closing returns focus to where it was, and the width is kept for next time.
  await detail.getByRole('button', { name: /^Close/ }).click()
  await expect(detail).toHaveCount(0)
  await page.reload()
  await row(page, 'Services', DEMO.services.storefront).first().click()
  await expect(
    panel(page, 'Service', DEMO.services.storefront).getByRole('separator'),
  ).toHaveAttribute('aria-valuenow', '668')
})

test('an object that cannot be loaded explains why', async ({ page, clusters }) => {
  clusters.demo.fail(`/api/v1/namespaces/shop/services/${DEMO.services.storefront}`, {
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ kind: 'Status', message: 'apiserver is restarting' }),
  })
  await openCluster(page)
  await goTo(page, 'Services')
  await row(page, 'Services', DEMO.services.storefront).first().click()
  const detail = panel(page, 'Service', DEMO.services.storefront)
  await expect(detail.getByRole('alert')).toContainText('apiserver is restarting')
  await detail.getByRole('button', { name: 'Try again' }).click()
  await expect(detail.getByRole('alert')).toBeVisible()
})

test('logs can be searched and followed', async ({ page, clusters }) => {
  await openCluster(page)
  await goTo(page, 'Pods')
  await page.getByPlaceholder('Filter pods').fill(DEMO.pods.storefront[0]!)
  await row(page, 'Pods', DEMO.pods.storefront[0]!).first().click()
  const detail = panel(page, 'Pod', DEMO.pods.storefront[0]!)
  await detail.getByRole('tab', { name: 'Logs' }).click()
  await detail.getByLabel('Lines', { exact: true }).selectOption('2000')
  const log = detail.getByRole('log')
  await expect(log).toContainText('starting storefront')
  // JSON lines show their level and message first; other shapes are kept as text.
  await expect(log.getByText('cache warmed')).toBeVisible()
  await expect(log).toContainText('heartbeat')
  await expect(log).toContainText('{"level":"info","msg":"request completed","path":"/api/cart"')

  const search = detail.getByLabel('Search logs')
  await search.pressSequentially('cache')
  await expect(log.locator('mark').first()).toHaveText('cache')
  await expect(detail).toContainText(/\d+\/\d+/)
  await search.fill('no-such-text')
  await expect(log).toContainText('No lines match “no-such-text”.')
  await search.press('Escape')
  await expect(search).toHaveValue('')
  await expect(detail).toBeVisible()

  await detail.getByRole('button', { name: 'Timestamps' }).click()
  await expect(log.locator('[data-level] > span').first()).not.toHaveText(/^\d\d:\d\d/)

  // Scrolling up pauses following; "Jump to latest" resumes it.
  await log.evaluate((element) => element.scrollTo({ top: 0 }))
  await detail.getByRole('button', { name: 'Jump to latest' }).click()
  await expect(detail.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0)

  // A failed refresh keeps the lines on screen.
  clusters.demo.fail(`/api/v1/namespaces/shop/pods/${DEMO.pods.storefront[0]}/log`, {
    status: 502,
    body: 'kubelet unavailable',
  })
  const stale = detail.getByRole('status').filter({ hasText: 'Couldn’t refresh' })
  await expect(stale).toBeVisible({ timeout: 10_000 })
  await expect(log).toContainText('starting storefront')
  await stale.getByRole('button', { name: 'Retry' }).click()
})

test('secret values can be revealed all at once', async ({ page }) => {
  await openCluster(page)
  await goTo(page, 'Secrets')
  await page.getByPlaceholder('Filter secrets').fill(DEMO.secrets.postgresCredentials)
  await row(page, 'Secrets', DEMO.secrets.postgresCredentials).first().click()
  const detail = panel(page, 'Secret', DEMO.secrets.postgresCredentials)
  await expect(detail).toContainText('15 B')
  await detail.getByRole('button', { name: 'Reveal all' }).click()
  await expect(detail).toContainText(DEMO.postgresPassword)
  await detail.getByRole('button', { name: 'Hide all' }).click()
  await expect(detail).not.toContainText(DEMO.postgresPassword)
})

test.describe('overview', () => {
  test('tiles open the lists behind them', async ({ page }) => {
    await openCluster(page)
    await page.getByRole('region', { name: 'Pods running' }).getByRole('button').click()
    await expect(heading(page)).toHaveText('Pods')
    await expect(page.getByRole('button', { name: /^Failing/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.getByRole('button', { name: /^Warning/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await page.keyboard.press('Meta+1')
    await page.getByRole('region', { name: 'Warnings', exact: true }).getByRole('button').click()
    await expect(heading(page)).toHaveText('Events')
    await page.keyboard.press('Meta+1')
    await page.getByRole('region', { name: 'Nodes ready' }).getByRole('button').click()
    await expect(heading(page)).toHaveText('Nodes')
    await page.keyboard.press('Meta+1')
    await page.getByRole('region', { name: 'Workloads healthy' }).getByRole('button').click()
    await expect(heading(page)).toHaveText('Deployments')
  })

  test('needs attention can show everything', async ({ page }) => {
    await openCluster(page)
    const list = page.getByRole('list', { name: 'Needs attention' })
    await expect(list.getByRole('listitem')).toHaveCount(6)
    await page.getByRole('button', { name: /^Show all \d+/ }).click()
    await expect(list.getByRole('listitem')).toHaveCount(12)
    await page.getByRole('button', { name: 'Show fewer' }).click()
    await expect(list.getByRole('listitem')).toHaveCount(6)
  })

  test('a healthy namespace looks healthy', async ({ page }) => {
    await openCluster(page)
    await page
      .getByRole('list', { name: 'Pods by namespace' })
      .getByRole('button', { name: /^kube-system/ })
      .click()
    await expect(page.getByRole('region', { name: 'Workloads healthy' })).toContainText(
      'All healthy',
    )
    await page.getByRole('region', { name: 'Nodes ready' }).getByRole('button').click()
    await expect(page.getByRole('button', { name: /^Failing/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  test('says when part of it is stale', async ({ page, clusters }) => {
    await openCluster(page)
    await expect(page.getByRole('region', { name: 'Pods running' })).toContainText('28')
    const clear = clusters.demo.fail('/api/v1/pods', { status: 500, body: 'etcd leader changed' })
    await page.getByRole('button', { name: /^Refresh/ }).click()
    const stale = page.getByRole('status').filter({ hasText: 'Couldn’t refresh' })
    await expect(stale).toContainText('HTTP 500')
    await expect(page.getByRole('region', { name: 'Pods running' })).toContainText('28')
    clear()
    await stale.getByRole('button', { name: 'Retry' }).click()
    await expect(stale).toHaveCount(0)
  })
})

test('autoscalers at their limit and unreadable schedules', async ({ page, clusters }) => {
  const objects = demoCluster().objects
  const hpa = objects.find((o) => o.kind === 'HorizontalPodAutoscaler')!
  clusters.demo.upsert({
    ...hpa,
    status: {
      ...hpa.status,
      conditions: [
        {
          type: 'ScalingLimited',
          status: 'True',
          reason: 'TooManyReplicas',
          message: 'the desired replica count is more than the maximum replica count',
        },
      ],
    },
  })
  const cron = objects.find((o) => o.kind === 'CronJob')!
  const { timeZone: _timeZone, ...spec } = cron.spec
  clusters.demo.upsert({
    ...cron,
    metadata: { ...cron.metadata, name: 'odd-schedule' },
    spec: { ...spec, schedule: 'bogus' },
  })
  await openCluster(page)
  await goTo(page, 'Autoscalers')
  await expect(row(page, 'Autoscalers', hpa.metadata.name)).toContainText('At limit')
  await expect(row(page, 'Autoscalers', 'checkout')).toContainText('Not scaling')
  await goTo(page, 'CronJobs')
  await expect(row(page, 'CronJobs', 'odd-schedule')).toContainText('bogus')
})

test('the skip link jumps past the sidebar', async ({ page }) => {
  await openCluster(page)
  const skip = page.getByRole('button', { name: 'Skip to content' })
  await skip.focus()
  await skip.press('Enter')
  await expect(page.locator('#content')).toBeFocused()
})

test('the cluster switcher filters clusters', async ({ page }) => {
  await openCluster(page, CONTEXTS.brokenRef)
  await page.getByRole('button', { name: 'Switch cluster' }).click()
  await page.getByPlaceholder('Switch to…').fill('zzz')
  await expect(page.getByText('No clusters match.')).toBeVisible()
  await page.getByPlaceholder('Switch to…').fill('')
  await expect(page.getByRole('option', { name: /^demo/ })).toBeVisible()
})

test('the sidebar logo returns to all clusters', async ({ page }) => {
  await openCluster(page)
  await page
    .getByRole('complementary', { name: 'Sidebar' })
    .getByRole('button', { name: 'All clusters' })
    .click()
  await expect(page.getByPlaceholder('Search clusters…')).toBeVisible()
})

test('the window remembers its size and position', async ({ launch }) => {
  // Keep the size the app chose, and pick one that fits 1024x768 CI screens
  // (Windows shrinks new windows to the screen).
  const env = { KUBESTACKS_E2E_WINDOW: undefined }
  const size = { width: 1024, height: 660 }
  const first = await launch({ env })
  await first.app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]!.setBounds({ x: 0, y: 60, ...size })
  }, size)
  const userDataDir = first.userDataDir
  await first.close()
  const settings = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8'))
  expect(settings.window).toMatchObject({ ...size, maximized: false })

  const second = await launch({ env, userDataDir })
  const bounds = await second.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.getBounds(),
  )
  expect(bounds).toMatchObject(size)
  await second.close()

  // A window saved maximized opens maximized; bounds on a missing monitor are ignored.
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({
      theme: 'system',
      window: { x: 50, y: 50, width: 1100, height: 700, maximized: true },
    }),
  )
  const third = await launch({ env, userDataDir })
  await expect
    .poll(() =>
      third.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()),
    )
    .toBe(true)
  await third.close()

  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({
      theme: 'system',
      window: { x: 90000, y: 90000, width: 900, height: 700, maximized: false },
    }),
  )
  const fourth = await launch({ env, userDataDir })
  const restored = await fourth.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.getBounds(),
  )
  expect(restored.x).toBeLessThan(90000)
})

test('lists fall back to their defaults', async ({ page }) => {
  await openCluster(page)
  await goTo(page, 'Pods')
  // Sorting by the default column again leaves it out of the URL.
  await page.getByRole('columnheader', { name: 'Status', exact: true }).getByRole('button').click()
  await expect(page).toHaveURL(/desc=1/)
  await expect(page).not.toHaveURL(/sort=/)
  const size = page.getByRole('navigation', { name: 'Pagination' }).getByLabel('Rows per page')
  await size.selectOption('50')
  await expect(page).toHaveURL(/size=50/)
  await size.selectOption('100')
  await expect(page).not.toHaveURL(/size=/)

  // An unknown sort column sorts by the first column, the name.
  await page.evaluate(() => {
    window.location.hash = '#/cluster/demo/pods?sort=bogus'
  })
  await expect(rows(page, 'Pods').first()).toContainText(/^cart-/)

  // Label selectors apply on Enter; the filter clears with its button.
  const labels = page.getByLabel('Label selector')
  await labels.pressSequentially('app=web')
  await labels.press('Enter')
  await expect(page).toHaveURL(/labels=app%3Dweb/)
  const filter = page.getByPlaceholder('Filter pods')
  await filter.fill('storefront')
  await page.getByRole('button', { name: 'Clear filter' }).click()
  await expect(filter).toHaveValue('')
  await expect(page).not.toHaveURL(/q=/)
})

test('the palette opens shortcuts and all clusters, even while clusters load', async ({
  kubestacks,
}) => {
  const { page, app } = kubestacks
  await openCluster(page)
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const input = page.getByPlaceholder('Jump to a view, object, namespace or cluster…')

  await page.keyboard.press('Meta+k')
  await input.fill('keyboard')
  await input.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  await page.keyboard.press('Escape')

  // Hold back the cluster list, as a slow kubeconfig would.
  await app.evaluate(({ ipcMain }) => {
    type Handler = (...args: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers
    const original = handlers.get('kube:contexts')!
    handlers.set('kube:contexts', async (...args: unknown[]) => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return original(...args)
    })
  })
  await page.reload()
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toBeVisible()
  await page.keyboard.press('Meta+k')
  await expect(palette.getByRole('option', { name: 'All clusters' })).toBeVisible()
  await expect(palette.getByRole('option', { name: /^sandbox/ })).toBeVisible()
  await input.fill('all clusters')
  await palette.getByRole('option', { name: 'All clusters' }).click()
  await expect(page.getByPlaceholder('Search clusters…')).toBeVisible()
})

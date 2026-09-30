import {
  CONTEXTS,
  DEMO,
  expect,
  goTo,
  mockOpenExternal,
  openCluster,
  row,
  rows,
  test,
} from './fixtures.ts'

const isDark = (page: import('@playwright/test').Page) =>
  page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)

test('the command palette jumps anywhere', async ({ page }) => {
  await openCluster(page)
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const input = palette.getByRole('combobox')

  await page.keyboard.press('Meta+k')
  await input.fill('stateful')
  await page.keyboard.press('Enter')
  await expect(palette).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('StatefulSets')

  await page.keyboard.press('Control+k')
  await input.fill('overview')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview')

  await page.getByRole('button', { name: /^Search/ }).click()
  await input.fill('monitoring')
  await palette
    .getByRole('group', { name: 'Namespace' })
    .getByRole('option', { name: 'monitoring' })
    .click()
  await expect(page.getByRole('button', { name: 'Namespace' })).toHaveText('monitoring')

  // Objects already loaded can be opened straight from the palette.
  await page.keyboard.press('Meta+k')
  await input.fill('checkout-')
  await palette.getByRole('group', { name: 'Objects' }).getByRole('option').first().click()
  await expect(page.getByRole('complementary', { name: /^Pod checkout-/ })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')

  await page.keyboard.press('Meta+k')
  await input.fill('all namespaces')
  await palette.getByRole('option', { name: 'All namespaces' }).click()
  await expect(page.getByRole('button', { name: 'Namespace' })).toHaveText('All namespaces')

  await page.keyboard.press('Meta+k')
  await input.fill('nothing-is-called-this')
  await expect(palette.getByText('No matches.')).toBeVisible()
  // The shortcut toggles the palette closed again.
  await page.keyboard.press('Meta+k')
  await expect(palette).toHaveCount(0)

  await page.keyboard.press('Meta+k')
  await input.fill('dark theme')
  await page.keyboard.press('Enter')
  await expect.poll(() => isDark(page)).toBe(true)

  await page.keyboard.press('Meta+k')
  await input.fill(CONTEXTS.sandbox)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toContainText(CONTEXTS.sandbox)
})

test('the namespace picker scopes lists', async ({ page }) => {
  await openCluster(page)
  await goTo(page, 'Pods')
  const picker = page.getByRole('button', { name: 'Namespace' })
  await picker.click()
  await page.getByPlaceholder('Find a namespace…').fill('sho')
  await page.keyboard.press('Enter')
  await expect(picker).toHaveText('shop')
  await expect(rows(page, 'Pods').first()).not.toContainText('kube-system')
  await expect(row(page, 'Pods', DEMO.pods.coredns[0]!)).toHaveCount(0)

  // The choice is remembered per cluster.
  await goTo(page, 'Deployments')
  await expect(picker).toHaveText('shop')
  await picker.click()
  await page.getByRole('option', { name: 'All namespaces' }).click()
  await expect(picker).toHaveText('All namespaces')
})

test('a namespace can be typed when namespaces cannot be listed', async ({ page, clusters }) => {
  clusters.demo.fail('/api/v1/namespaces', {
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({ kind: 'Status', message: 'namespaces is forbidden' }),
  })
  await openCluster(page)
  await page.getByRole('button', { name: 'Namespace' }).click()
  await expect(
    page.getByText('Namespaces could not be listed. Type a name to use it.'),
  ).toBeVisible()
  await page.getByPlaceholder('Find a namespace…').fill('data')
  await page.getByRole('option', { name: 'Use namespace “data”' }).click()
  await expect(page.getByRole('button', { name: 'Namespace' })).toHaveText('data')

  await page.keyboard.press('Meta+k')
  await expect(
    page
      .getByRole('dialog', { name: 'Command palette' })
      .getByRole('option', { name: 'All namespaces' }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
})

test('switches clusters from the sidebar', async ({ page }) => {
  await openCluster(page)
  await page.getByRole('button', { name: 'Switch cluster' }).click()
  await page.getByRole('option', { name: new RegExp(`^${CONTEXTS.sandbox}`) }).click()
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toContainText(CONTEXTS.sandbox)
  await expect(page.getByRole('region', { name: 'Nodes ready' })).toContainText('1/1')

  await page.getByRole('button', { name: 'Switch cluster' }).click()
  await page.getByRole('option', { name: 'All clusters' }).click()
  await expect(page.getByRole('heading', { name: 'KubeStacks' })).toBeVisible()
})

test('the sidebar links to the project on GitHub', async ({ kubestacks }) => {
  const opened = await mockOpenExternal(kubestacks.app)
  await openCluster(kubestacks.page)
  await kubestacks.page
    .getByRole('complementary', { name: 'Sidebar' })
    .getByRole('button', { name: 'KubeStacks on GitHub' })
    .click()
  await expect.poll(opened).toEqual(['https://github.com/kotapeter/kubestacks'])
})

test('refresh reloads everything on screen', async ({ page, clusters }) => {
  await openCluster(page)
  await goTo(page, 'Services')
  const before = clusters.demo.requests.filter((r) => r.path === '/api/v1/services').length
  await page.getByRole('button', { name: /^Refresh/ }).click()
  await expect
    .poll(() => clusters.demo.requests.filter((r) => r.path === '/api/v1/services').length)
    .toBeGreaterThan(before)
})

test('the theme is remembered across restarts', async ({ launch }) => {
  const first = await launch({ theme: 'dark' })
  expect(await isDark(first.page)).toBe(true)
  await first.page.getByRole('button', { name: 'Theme' }).click()
  await first.page.getByRole('menuitemradio', { name: 'Light' }).click()
  await expect.poll(() => isDark(first.page)).toBe(false)
  await first.close()

  const second = await launch({ userDataDir: first.userDataDir })
  expect(await isDark(second.page)).toBe(false)
  await second.page.getByRole('button', { name: 'Theme' }).click()
  await expect(second.page.getByRole('menuitemradio', { name: 'Light' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await second.page.getByRole('menuitemradio', { name: 'System' }).click()
  await expect
    .poll(() => second.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
    .toBe('system')
})

test('reloading the window keeps the current view', async ({ page }) => {
  await openCluster(page)
  await goTo(page, 'Jobs')
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Jobs')
  await expect(row(page, 'Jobs', DEMO.jobs.reindex)).toContainText('Running')
})

/** The app as a KubeStacks server serves it: one cluster, at addresses that can be shared. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { DEMO_TOKEN, expect, signIn, test } from './fixtures.ts'

const heading = (page: Page) => page.getByRole('heading', { level: 1 })
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Resources' })

test('one cluster, at addresses below the base path that can be shared', async ({
  page,
  serve,
}) => {
  const served = await serve({
    env: { KUBESTACKS_BASE_PATH: '/kubestacks/', KUBESTACKS_CLUSTER_NAME: 'production' },
  })
  expect(served.url).toMatch(/\/kubestacks\/$/)
  const origin = served.url.replace('/kubestacks/', '')
  // The base path as people type it.
  await page.goto(`${origin}/kubestacks`)
  await page.getByPlaceholder('Paste a token').fill(DEMO_TOKEN)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  // The start is the cluster's overview.
  await expect(heading(page)).toHaveText('Overview')
  await expect(page).toHaveURL(`${served.url}cluster/production`)

  // An object's address opens it.
  await page.goto(`${served.url}cluster/production/pods?open=Pod/shop/checkout-jzhdh6j29h-hqnnn`)
  await expect(
    page.getByRole('complementary', { name: 'Pod checkout-jzhdh6j29h-hqnnn' }),
  ).toBeVisible()
  await sidebar(page).getByRole('link', { name: 'Nodes' }).click()
  await expect(page).toHaveURL(`${served.url}cluster/production/nodes`)
  await page.goBack()
  await expect(heading(page)).toHaveText('Pods')
  // Typing into a filter keeps it in the address.
  await page.getByPlaceholder('Filter pods').fill('checkout')
  await expect(page).toHaveURL(/[?&]q=checkout/)
  await page.reload()
  await expect(page.getByPlaceholder('Filter pods')).toHaveValue('checkout')

  // Another cluster's address (from before it was renamed, say) is this one's.
  await page.goto(`${served.url}cluster/demo/services`)
  await expect(page).toHaveURL(`${served.url}cluster/production`)
  await expect(heading(page)).toHaveText('Overview')
  // Outside the base path, nothing is KubeStacks'.
  const outside = await page.request.get(`${origin}/elsewhere`)
  expect(outside.status()).toBe(404)
  expect(await outside.json()).toEqual({ error: 'KubeStacks is at /kubestacks/' })
})

test('what only the desktop app does isn’t there', async ({ page, serve }) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo/pods`, DEMO_TOKEN)

  // The cluster, without others to switch to.
  await page.getByRole('button', { name: 'Cluster', exact: true }).click()
  const card = page.getByRole('dialog')
  await expect(card).toContainText(/demo\s*https:\/\/127\.0\.0\.1:\d+/)
  await expect(card.getByRole('listbox', { name: 'Clusters' })).toHaveCount(0)
  await expect(card.getByRole('switch', { name: 'Read-only' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toHaveCount(0)

  // No port forwards: there's no computer of the user's to forward to.
  await page.getByPlaceholder('Filter pods').fill('cart-')
  await page
    .getByRole('grid', { name: 'Pods' })
    .getByRole('row')
    .nth(1)
    .getByRole('gridcell')
    .nth(1)
    .click()
  const pod = page.getByRole('complementary', { name: /^Pod cart-/ })
  await pod.getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Debug…' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Forward a port…' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Port forwards' })).toHaveCount(0)

  // Browsers keep ⌘N and ⌘1…6 for themselves.
  await expect(page.getByRole('button', { name: 'Create from YAML', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+?')
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(shortcuts).toContainText('Command palette')
  await expect(shortcuts).not.toContainText('Create from YAML')
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog').filter({ has: page.getByRole('combobox') })
  await palette.getByRole('combobox').fill('clusters')
  await expect(palette.getByRole('option', { name: /All clusters/ })).toHaveCount(0)
  await palette.getByRole('combobox').fill('create from yaml')
  await expect(palette.getByRole('option', { name: /^Create from YAML/ })).toHaveText(
    'Create from YAML',
  )
  await page.keyboard.press('Escape')

  // Charts come from repositories and registries, not this computer's files.
  await sidebar(page).getByRole('link', { name: 'Helm releases' }).click()
  await page.getByRole('button', { name: 'Install chart' }).click()
  const install = page.getByRole('dialog')
  await expect(install.getByRole('radio', { name: /A chart from a repository/ })).toBeChecked()
  await expect(install.getByRole('radio', { name: /A chart on this computer/ })).toHaveCount(0)
  await expect(install.getByLabel('Chart name or reference')).toHaveAttribute(
    'placeholder',
    'nginx, oci://…, https://…/chart.tgz',
  )
})

test('the theme a browser chose, from the first paint', async ({ page, serve }) => {
  const served = await serve()
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? 'system')
  // On the sign-in page, too.
  await page.goto(served.url)
  await page.getByRole('button', { name: 'Theme' }).click()
  await page.getByRole('menuitemradio', { name: 'Dark' }).click()
  expect(await theme()).toBe('dark')
  // The server starts the next page in it.
  const html = await (await page.request.get(served.url)).text()
  expect(html).toContain('<html lang="en" data-theme="dark">')

  await page.getByPlaceholder('Paste a token').fill(DEMO_TOKEN)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(heading(page)).toHaveText('Overview')
  expect(await theme()).toBe('dark')
  await page.getByRole('button', { name: 'Theme' }).click()
  await page.getByRole('menuitemradio', { name: 'Light' }).click()
  expect(await theme()).toBe('light')
  await page.reload()
  await expect(heading(page)).toHaveText('Overview')
  expect(await theme()).toBe('light')
  await page.getByRole('button', { name: 'Theme' }).click()
  await page.getByRole('menuitemradio', { name: 'System' }).click()
  expect(await theme()).toBe('system')
  await expect(page.getByRole('button', { name: 'Theme' })).toBeVisible()
})

test('read-only, as each browser chooses, and for everyone', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo/workloads`, DEMO_TOKEN)
  const other = await context.newPage()
  await other.goto(`${served.url}cluster/demo/workloads`)
  await expect(heading(other)).toHaveText('Workloads')

  await page.getByRole('button', { name: 'Cluster', exact: true }).click()
  await page.getByRole('switch', { name: 'Read-only' }).click()
  await expect(page.getByLabel('Read-only', { exact: true }).first()).toBeVisible()
  await page.keyboard.press('Escape')
  // The other tab knows at once.
  await expect(
    other.getByRole('button', { name: 'Cluster', exact: true }).getByLabel('Read-only'),
  ).toBeVisible()
  // The server refuses changes from both.
  const writes = clusters.demo.requests.filter((r) => r.method !== 'GET').length
  await page.getByRole('button', { name: 'Create from YAML', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Changes are turned off for this cluster.')
  await page.keyboard.press('Escape')
  expect(clusters.demo.requests.filter((r) => r.method !== 'GET').length).toBe(writes)

  // Kept by the browser for its next pages; corrupted, it's forgotten.
  await page.reload()
  await expect(
    page.getByRole('button', { name: 'Cluster', exact: true }).getByLabel('Read-only'),
  ).toBeVisible()
  // What the server is asked is checked there.
  expect(
    await page.evaluate(() =>
      window.kubestacks!.app.setReadOnly('', true).then(
        () => 'changed',
        (error: Error) => error.message,
      ),
    ),
  ).toBe('Expected a context name and whether it is read-only')
  // Off again, then on for good measure.
  await page.getByRole('button', { name: 'Cluster', exact: true }).click()
  await page.getByRole('switch', { name: 'Read-only' }).click()
  await page.getByRole('switch', { name: 'Read-only' }).click()
  await page.keyboard.press('Escape')
  await page.evaluate(() => localStorage.setItem('kubestacks:settings', '{'))
  await page.reload()
  await expect(heading(page)).toHaveText('Workloads')
  await expect(
    page.getByRole('button', { name: 'Cluster', exact: true }).getByLabel('Read-only'),
  ).toHaveCount(0)

  // For everyone, when the server says so.
  const locked = await serve({ env: { KUBESTACKS_READ_ONLY: '1' } })
  await signIn(page, `${locked.url}cluster/demo`, DEMO_TOKEN)
  await page.getByRole('button', { name: 'Cluster', exact: true }).click()
  await expect(page.getByRole('switch', { name: 'Read-only' })).toBeDisabled()
  await expect(page.getByRole('dialog')).toContainText('For everyone, on this server')
})

test('views this server has, and where its metrics come from', async ({ page, serve }) => {
  const views = await serve()
  mkdirSync(join(views.helmDir, 'views'))
  writeFileSync(
    join(views.helmDir, 'views', 'team.yaml'),
    [
      'apiVersion: kubestacks.dev/v1alpha1',
      'kind: View',
      'metadata: { name: team-certificates }',
      'spec:',
      '  kinds: [{ group: cert-manager.io, kind: Certificate }]',
      '  columns: [{ name: Issuer, path: .spec.issuerRef.name }]',
    ].join('\n'),
  )
  await signIn(page, `${views.url}cluster/demo/api-resources`, DEMO_TOKEN)
  await expect(
    page.getByText(/views from KubeStacks, 1 from this server\. This server’s are in/),
  ).toBeVisible()

  // Each browser can choose for itself, and keeps its choice.
  await page.goto(`${views.url}cluster/demo/metrics`)
  await page.getByRole('button', { name: /^Prometheus 3\.5\.0/ }).click()
  await page.getByRole('radio', { name: /Don’t use history/ }).check()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    'Metrics source saved',
  )
  await page.reload()
  await expect(page.getByText(/history is off/i).first()).toBeVisible()

  const off = await serve({ env: { KUBESTACKS_METRICS_SOURCE: 'off' } })
  await signIn(page, `${off.url}cluster/demo/metrics`, DEMO_TOKEN)
  await expect(page.getByText(/history is off/i).first()).toBeVisible()

  const chosen = await serve({
    env: {
      KUBESTACKS_METRICS_SOURCE: 'data/prometheus-archive:9090',
      KUBESTACKS_VIEWS_DIR: undefined,
    },
  })
  await signIn(page, `${chosen.url}cluster/demo/metrics`, DEMO_TOKEN)
  await expect(page.getByText(/prometheus-archive/).first()).toBeVisible()
  await page.goto(`${chosen.url}cluster/demo/api-resources`)
  await expect(page.getByText(/This server’s are in \/etc\/kubestacks\/views/)).toBeVisible()
})

test('links open in a tab of their own', async ({ page, context, serve }) => {
  // On every interface, showing the kubeconfig's current context.
  const served = await serve({
    env: { KUBESTACKS_ADDRESS: undefined, KUBESTACKS_CONTEXT: undefined },
  })
  expect(served.url).toMatch(/^http:\/\/localhost:\d+\/$/)
  await context.route('https://github.com/**', (route) => route.fulfill({ body: 'GitHub' }))
  await page.goto(served.url)
  const fromSignIn = context.waitForEvent('page')
  await page.getByRole('button', { name: 'KubeStacks on GitHub' }).click()
  expect((await fromSignIn).url()).toBe('https://github.com/KubeStacks/KubeStacks')
  await signIn(page, served.url, DEMO_TOKEN)
  const opened = context.waitForEvent('page')
  await page.getByRole('button', { name: 'KubeStacks on GitHub' }).click()
  expect((await opened).url()).toBe('https://github.com/KubeStacks/KubeStacks')
})

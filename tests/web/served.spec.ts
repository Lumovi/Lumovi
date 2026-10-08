/** The app as a Lumovi server serves it: one cluster, at addresses that can be shared. */
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { audited, DEMO, DEMO_TOKEN, expect, PEOPLE, signIn, test } from './fixtures.ts'

const heading = (page: Page) => page.getByRole('heading', { level: 1 })
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Resources' })

test('one cluster, at addresses below the base path that can be shared', async ({
  page,
  serve,
}) => {
  const served = await serve({
    env: { LUMOVI_BASE_PATH: '/lumovi/', LUMOVI_CLUSTER_NAME: 'production' },
  })
  expect(served.url).toMatch(/\/lumovi\/$/)
  const origin = served.url.replace('/lumovi/', '')
  // The base path as people type it.
  await page.goto(`${origin}/lumovi`)
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
  // Outside the base path, nothing is Lumovi's.
  const outside = await page.request.get(`${origin}/elsewhere`)
  expect(outside.status()).toBe(404)
  expect(await outside.json()).toEqual({ error: 'Lumovi is at /lumovi/' })
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
  // Nor terminals on this computer: no button, no dock, and ⌃` does nothing.
  await expect(page.getByRole('button', { name: /terminal/i })).toHaveCount(0)
  await page.keyboard.press('Control+Backquote')
  await page.keyboard.press('Control+Shift+Backquote')
  await expect(page.getByRole('region', { name: 'Terminal', exact: true })).toHaveCount(0)

  // Browsers keep ⌘N and ⌘1…6 for themselves.
  await expect(page.getByRole('button', { name: 'Create from YAML', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+?')
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(shortcuts).toContainText('Command palette')
  await expect(shortcuts).not.toContainText('Create from YAML')
  await expect(shortcuts).not.toContainText('New terminal')
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

test('read-only for everyone on the server: one turns it on, and another sees why', async ({
  page,
  browser,
  serve,
  clusters,
}) => {
  const data = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const env = { LUMOVI_DATA_DIR: data }
  const served = await serve({ env })
  await signIn(page, `${served.url}cluster/demo/workloads`, PEOPLE.alice.token)
  // Bob, in a browser of his own.
  const elsewhere = await browser.newContext()
  const bob = await elsewhere.newPage()
  await signIn(bob, `${served.url}cluster/demo/workloads`, PEOPLE.bob.token)

  // Alice makes demo read-only, for everyone: with no admins named, anyone may.
  await page.getByRole('button', { name: 'Cluster', exact: true }).click()
  const switcher = page.getByRole('dialog')
  await expect(switcher).toContainText('Lumovi won’t change demo for anyone on this server')
  await page.getByRole('switch', { name: 'Read-only' }).click()
  await expect(switcher).toContainText('Turned on by alice@example.com')
  await page.keyboard.press('Escape')

  // Bob's page knows at once, and says who.
  await expect(
    bob.getByRole('button', { name: 'Cluster', exact: true }).getByLabel('Read-only'),
  ).toBeVisible()
  const writes = clusters.demo.requests.filter((r) => r.method !== 'GET').length
  await bob.getByRole('button', { name: 'Create from YAML', exact: true }).click()
  await expect(bob.getByRole('dialog')).toContainText(
    'Changes are turned off for this cluster: alice@example.com made it read-only for everyone.',
  )
  await bob.keyboard.press('Escape')
  // And the server refuses him, whatever his page asks.
  expect(
    await bob.evaluate(async (name) => {
      const result = await window.lumovi!.kube.change({
        context: 'demo',
        kind: 'Deployment',
        namespace: 'shop',
        name,
        change: { action: 'patch', patchType: 'merge', patch: { spec: { replicas: 3 } } },
      })
      return result.ok ? 'changed' : result.error.message
    }, DEMO.deployments.cart),
  ).toMatch(/^demo is read-only for everyone on this server: alice@example\.com made it so\./)
  expect(clusters.demo.requests.filter((r) => r.method !== 'GET').length).toBe(writes)
  await bob.goto(
    `${served.url}cluster/demo/deployments?open=Deployment/shop/${DEMO.deployments.cart}`,
  )
  await bob.getByRole('button', { name: 'Read-only' }).first().click()
  await expect(bob.getByRole('dialog')).toContainText(
    'alice@example.com made it read-only for everyone on this server on',
  )
  await expect(bob.getByRole('button', { name: 'Allow changes' })).toBeVisible()
  await bob.keyboard.press('Escape')

  // What the server is asked is checked there.
  expect(
    await page.evaluate(() =>
      window.lumovi!.app.setReadOnly('', true).then(
        () => 'changed',
        (error: Error) => error.message,
      ),
    ),
  ).toBe('Expected a context name and whether it is read-only')

  // A restart changes nothing, and the audit log says who made it so.
  await expect.poll(() => readdirSync(data)).toContain('state.json')
  await served.stop()
  const again = await serve({ env, port: served.port })
  await page.reload()
  await expect(
    page.getByRole('button', { name: 'Cluster', exact: true }).getByLabel('Read-only'),
  ).toBeVisible()
  expect(audited(served, 'read-only.changed')).toEqual([
    expect.objectContaining({
      outcome: 'success',
      actor: expect.objectContaining({ user: 'alice@example.com' }),
      cluster: 'demo',
      summary: 'Made demo read-only for everyone on this server',
    }),
  ])
  // Allowed again, for everyone.
  await page.getByRole('button', { name: 'Cluster', exact: true }).click()
  await page.getByRole('switch', { name: 'Read-only' }).click()
  await page.keyboard.press('Escape')
  await bob.reload()
  await expect(bob.getByRole('heading', { level: 1 })).toHaveText('Deployments')
  await expect(
    bob.getByRole('button', { name: 'Cluster', exact: true }).getByLabel('Read-only'),
  ).toHaveCount(0)
  expect(audited(again, 'read-only.changed')).toEqual([
    expect.objectContaining({ summary: 'Made demo changeable for everyone on this server' }),
  ])
  await elsewhere.close()

  // For everyone, when the server says so.
  const locked = await serve({ env: { LUMOVI_READ_ONLY: '1' } })
  await signIn(page, `${locked.url}cluster/demo`, DEMO_TOKEN)
  await page.getByRole('button', { name: 'Cluster', exact: true }).click()
  await expect(page.getByRole('switch', { name: 'Read-only' })).toBeDisabled()
  await expect(page.getByRole('dialog')).toContainText('For everyone, on this server')
})

test('where Lumovi has admins, only they change what’s set for everyone', async ({
  page,
  browser,
  serve,
}) => {
  const data = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const served = await serve({
    env: { LUMOVI_ADMINS: 'user:alice@example.com', LUMOVI_DATA_DIR: data },
  })
  const elsewhere = await browser.newContext()
  const bob = await elsewhere.newPage()
  await signIn(bob, `${served.url}cluster/demo/workloads`, PEOPLE.bob.token)
  await bob.getByRole('button', { name: 'Cluster', exact: true }).click()
  await expect(bob.getByRole('switch', { name: 'Read-only' })).toBeDisabled()
  await expect(bob.getByRole('dialog')).toContainText('Only Lumovi’s admins change it')
  await bob.keyboard.press('Escape')
  // His page can't do it for him: it's refused, and recorded.
  expect(
    await bob.evaluate(() =>
      window.lumovi!.app.setReadOnly('demo', true).then(
        () => 'changed',
        (error: Error) => error.message,
      ),
    ),
  ).toBe('Only Lumovi’s admins change what’s set for everyone on this server.')
  await expect
    .poll(() => audited(served, 'read-only.changed'))
    .toEqual([
      expect.objectContaining({
        outcome: 'refused',
        actor: expect.objectContaining({ user: 'bob@example.com' }),
        error: 'Only Lumovi’s admins change what’s set for everyone on this server.',
      }),
    ])
  // Nor where node shells run, or where metrics come from.
  await bob.goto(`${served.url}cluster/demo/metrics`)
  await bob.getByRole('button', { name: /^Prometheus 3\.5\.0/ }).click()
  await expect(bob.getByRole('dialog')).toContainText('The same for everyone on this server.')
  await expect(bob.getByRole('dialog')).toContainText(
    'Only Lumovi’s admins change what’s set for everyone on this server.',
  )
  await expect(bob.getByRole('button', { name: 'Save' })).toBeDisabled()
  await bob.keyboard.press('Escape')

  // Alice, an admin, may; Bob's page shows it.
  await signIn(page, `${served.url}cluster/demo/workloads`, PEOPLE.alice.token)
  await page.getByRole('button', { name: 'Cluster', exact: true }).click()
  await page.getByRole('switch', { name: 'Read-only' }).click()
  await expect(page.getByRole('dialog')).toContainText('Turned on by alice@example.com')
  await expect(
    bob.getByRole('button', { name: 'Cluster', exact: true }).getByLabel('Read-only'),
  ).toBeVisible()
  await bob.goto(
    `${served.url}cluster/demo/deployments?open=Deployment/shop/${DEMO.deployments.cart}`,
  )
  await bob.getByRole('button', { name: 'Read-only' }).first().click()
  await expect(bob.getByRole('dialog')).toContainText(
    'alice@example.com made it read-only for everyone on this server on',
  )
  await expect(bob.getByRole('button', { name: 'Allow changes' })).toHaveCount(0)
  await expect(bob.getByRole('dialog')).toContainText(
    'Only Lumovi’s admins change what’s set for everyone on this server.',
  )
  await elsewhere.close()
})

test('views this server has, and where its metrics come from', async ({ page, serve }) => {
  const views = await serve()
  mkdirSync(join(views.helmDir, 'views'))
  writeFileSync(
    join(views.helmDir, 'views', 'team.yaml'),
    [
      'apiVersion: lumovi.dev/v1alpha1',
      'kind: View',
      'metadata: { name: team-certificates }',
      'spec:',
      '  kinds: [{ group: cert-manager.io, kind: Certificate }]',
      '  columns: [{ name: Issuer, path: .spec.issuerRef.name }]',
    ].join('\n'),
  )
  await signIn(page, `${views.url}cluster/demo/api-resources`, DEMO_TOKEN)
  await expect(
    page.getByText(/views from Lumovi, 1 from this server\. This server’s are in/),
  ).toBeVisible()

  // Chosen for everyone on the server, and kept.
  await page.goto(`${views.url}cluster/demo/metrics`)
  await page.getByRole('button', { name: /^Prometheus 3\.5\.0/ }).click()
  await page.getByRole('radio', { name: /Don’t use history/ }).check()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    'Metrics source saved',
  )
  await page.reload()
  await expect(page.getByText(/history is off/i).first()).toBeVisible()

  const off = await serve({ env: { LUMOVI_METRICS_SOURCE: 'off' } })
  await signIn(page, `${off.url}cluster/demo/metrics`, DEMO_TOKEN)
  await expect(page.getByText(/history is off/i).first()).toBeVisible()

  const chosen = await serve({
    env: {
      LUMOVI_METRICS_SOURCE: 'data/prometheus-archive:9090',
      LUMOVI_VIEWS_DIR: undefined,
    },
  })
  await signIn(page, `${chosen.url}cluster/demo/metrics`, DEMO_TOKEN)
  await expect(page.getByText(/prometheus-archive/).first()).toBeVisible()
  await page.goto(`${chosen.url}cluster/demo/api-resources`)
  await expect(page.getByText(/This server’s are in \/etc\/lumovi\/views/)).toBeVisible()
})

test('links open in a tab of their own', async ({ page, context, serve }) => {
  // On every interface, showing the kubeconfig's current context.
  const served = await serve({
    env: { LUMOVI_ADDRESS: undefined, LUMOVI_CONTEXT: undefined },
  })
  expect(served.url).toMatch(/^http:\/\/localhost:\d+\/$/)
  await context.route('https://github.com/**', (route) => route.fulfill({ body: 'GitHub' }))
  await page.goto(served.url)
  const fromSignIn = context.waitForEvent('page')
  await page.getByRole('button', { name: 'Lumovi on GitHub' }).click()
  expect((await fromSignIn).url()).toBe('https://github.com/Lumovi/Lumovi')
  await signIn(page, served.url, DEMO_TOKEN)
  const opened = context.waitForEvent('page')
  await page.getByRole('button', { name: 'Lumovi on GitHub' }).click()
  expect((await opened).url()).toBe('https://github.com/Lumovi/Lumovi')
})

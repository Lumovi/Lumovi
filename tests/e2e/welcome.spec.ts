import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { CONTEXTS, DEMO, DEMO_TOKEN, expect, mockOpenExternal, test } from './fixtures.ts'

function clusterRow(page: import('@playwright/test').Page, name: string) {
  return page
    .getByRole('list', { name: 'Clusters' })
    .getByRole('listitem')
    .filter({ hasText: new RegExp(`^${name}`) })
}

test('lists every context with its connection status', async ({ page, clusters }) => {
  await expect(clusterRow(page, CONTEXTS.demo)).toContainText(DEMO.gitVersion)
  await expect(clusterRow(page, CONTEXTS.demo)).toContainText('current')
  await expect(clusterRow(page, CONTEXTS.sandbox)).toContainText('v1.33.4')
  await expect(clusterRow(page, CONTEXTS.offline)).toContainText('Unreachable')
  await expect(clusterRow(page, CONTEXTS.expired)).toContainText('Unauthorized')
  await expect(clusterRow(page, CONTEXTS.untrusted)).toContainText('Certificate error')
  await expect(clusterRow(page, CONTEXTS.execMissing)).toContainText('Credentials failed')
  await expect(clusterRow(page, CONTEXTS.brokenRef)).toContainText('No cluster defined')
  await expect(clusterRow(page, CONTEXTS.brokenRef)).toContainText('Misconfigured')
  await expect(clusterRow(page, CONTEXTS.plainHttp)).toContainText('Plain HTTP blocked')
  await expect(page.getByText(`Loaded from ${clusters.kubeconfigPath}`)).toBeVisible()
})

test('filters the cluster list', async ({ page }) => {
  const filter = page.getByPlaceholder('Filter clusters')
  await filter.fill('EXPIRED')
  await expect(page.getByRole('list', { name: 'Clusters' }).getByRole('listitem')).toHaveCount(1)
  await expect(page.getByText('1 of 9')).toBeVisible()

  await filter.fill('no-such-cluster')
  await expect(page.getByText('No clusters match “no-such-cluster”.')).toBeVisible()

  await page.getByRole('button', { name: 'Clear filter' }).click()
  await expect(page.getByText('9 of 9')).toBeVisible()
  // Escape leaves the field.
  await filter.focus()
  await filter.press('Escape')
  await expect(filter).not.toBeFocused()
})

test('reload picks up kubeconfig changes', async ({ launch, clusters }) => {
  const dir = mkdtempSync(join(tmpdir(), 'kubestacks-kc-'))
  const path = join(dir, 'config')
  writeFileSync(path, readFileSync(clusters.kubeconfigPath))
  const { page } = await launch({ env: { KUBECONFIG: path } })
  await expect(clusterRow(page, CONTEXTS.demo)).toBeVisible()

  writeKubeconfig(dir, {
    clusters: [{ name: 'c', server: clusters.demo.url, caPem: clusters.demo.caPem }],
    users: [{ name: 'u', token: DEMO_TOKEN }],
    contexts: [{ name: 'renamed', cluster: 'c', user: 'u' }],
  })
  await page.getByRole('button', { name: 'Reload' }).click()
  await expect(clusterRow(page, 'renamed')).toContainText(DEMO.gitVersion)
  await expect(clusterRow(page, CONTEXTS.demo)).toHaveCount(0)
})

test('explains how to add clusters when there is no kubeconfig', async ({ launch }) => {
  const { page } = await launch({
    env: { KUBECONFIG: join(tmpdir(), 'kubestacks-does-not-exist', 'config') },
  })
  await expect(page.getByRole('heading', { name: 'No clusters found' })).toBeVisible()
})

test('treats an empty kubeconfig file as having no clusters', async ({ launch }) => {
  const path = join(mkdtempSync(join(tmpdir(), 'kubestacks-kc-')), 'config')
  writeFileSync(path, '\n')
  const { page } = await launch({ env: { KUBECONFIG: path } })
  await expect(page.getByRole('heading', { name: 'No clusters found' })).toBeVisible()
})

test('reports a kubeconfig that cannot be parsed', async ({ launch }) => {
  const path = join(mkdtempSync(join(tmpdir(), 'kubestacks-kc-')), 'config')
  writeFileSync(path, 'clusters: [unterminated\n')
  const { page } = await launch({ env: { KUBECONFIG: path } })
  await expect(
    page.getByRole('heading', { name: 'Your kubeconfig could not be read' }),
  ).toBeVisible()
  await expect(page.getByText(`Could not read ${path}`)).toBeVisible()
})

test('falls back to ~/.kube/config when KUBECONFIG is not set', async ({ launch, clusters }) => {
  const home = mkdtempSync(join(tmpdir(), 'kubestacks-home-'))
  mkdirSync(join(home, '.kube'))
  writeFileSync(join(home, '.kube', 'config'), readFileSync(clusters.kubeconfigPath))
  const { page } = await launch({ env: { KUBECONFIG: undefined, HOME: home, USERPROFILE: home } })
  await expect(clusterRow(page, CONTEXTS.demo)).toContainText(DEMO.gitVersion)
  await expect(page.getByText(join(home, '.kube', 'config'))).toBeVisible()
})

test('merges several kubeconfig files the way kubectl does', async ({ launch, clusters }) => {
  const dir = mkdtempSync(join(tmpdir(), 'kubestacks-kc-'))
  const first = writeKubeconfig(
    dir,
    {
      clusters: [{ name: 'demo', server: clusters.demo.url, caPem: clusters.demo.caPem }],
      users: [{ name: 'admin', token: DEMO_TOKEN }],
      contexts: [
        { name: 'first', cluster: 'demo', user: 'admin' },
        { name: 'shared', cluster: 'demo', user: 'admin' },
      ],
    },
    'first',
  )
  const second = writeKubeconfig(
    dir,
    {
      currentContext: 'second',
      clusters: [
        { name: 'demo', server: 'https://ignored.invalid' },
        { name: 'sandbox', server: clusters.sandbox.url, insecure: true },
      ],
      users: [{ name: 'admin' }],
      contexts: [
        { name: 'second', cluster: 'sandbox', user: 'admin' },
        { name: 'shared', cluster: 'sandbox', user: 'admin' },
      ],
    },
    'second',
  )
  const third = writeKubeconfig(
    dir,
    {
      currentContext: 'third',
      clusters: [],
      users: [],
      contexts: [{ name: 'third', cluster: 'demo', user: 'admin' }],
    },
    'third',
  )
  const missing = join(dir, 'missing')
  const { page } = await launch({
    env: { KUBECONFIG: [first, missing, second, third].join(delimiter) },
  })

  const list = page.getByRole('list', { name: 'Clusters' })
  await expect(list.getByRole('listitem')).toHaveCount(4)
  // The first definition of a name wins: "shared" and "third" use the first file's demo cluster.
  await expect(clusterRow(page, 'shared')).toContainText(DEMO.gitVersion)
  await expect(clusterRow(page, 'third')).toContainText(DEMO.gitVersion)
  await expect(clusterRow(page, 'second')).toContainText('v1.33.4')
  // The first current-context wins too.
  await expect(clusterRow(page, 'second')).toContainText('current')
})

test('links to the project on GitHub', async ({ kubestacks }) => {
  const opened = await mockOpenExternal(kubestacks.app)
  await kubestacks.page.getByRole('button', { name: 'KubeStacks on GitHub' }).click()
  await expect.poll(opened).toEqual(['https://github.com/kotapeter/kubestacks'])
})

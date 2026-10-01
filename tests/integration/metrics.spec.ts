/**
 * Usage against the real thing: live usage from metrics-server, and history
 * from kube-prometheus-stack's Prometheus, with real cAdvisor and
 * kube-state-metrics series. Every query the app makes has to work here.
 */
import type { Page } from '@playwright/test'
import { open } from '../e2e/action-helpers.ts'
import { goTo, panel, row } from '../e2e/fixtures.ts'
import { expect, freshNamespace, get, inNamespace, test } from './fixtures.ts'
import { crash, web } from './workloads.ts'

const NS = 'it-metrics'

test.beforeAll(() => freshNamespace(NS, [web(2), crash()], ['deployment.apps/crash']))

async function openMetrics(page: Page) {
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'Metrics' })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Metrics')
}

const ranked = (page: Page, plural: string) =>
  page.getByRole('region', { name: `Ranked ${plural}` }).getByRole('row')

test('live usage from metrics-server', async ({ page }) => {
  await expect(page.getByRole('region', { name: 'CPU', exact: true })).toContainText(
    'cores in use',
    {
      timeout: 120_000,
    },
  )
  await inNamespace(page, NS)
  await goTo(page, 'Pods')
  // New pods show up in the metrics API after a scrape or two.
  await expect(row(page, 'Pods', /^web-/).first()).toContainText(/\d+(\.\d+)? MiB/, {
    timeout: 120_000,
  })
})

test('finds Prometheus, and every metric charts, grouped every way', async ({ page }) => {
  await openMetrics(page)
  await expect(page.getByRole('button', { name: /^Prometheus [\d.]+ monitoring\// })).toBeVisible()
  const metric = page.getByRole('group', { name: 'Metric' })
  const by = page.getByRole('combobox', { name: 'Group by' })
  // The pods are new (the namespace may have history from earlier runs): they
  // rank once Prometheus has scraped them twice.
  const pod = get('pods', '-n', NS, '-l', 'app=web').items[0].metadata.name
  await by.selectOption('pod')
  await expect(page.getByRole('region', { name: 'Ranked pods' })).toContainText(pod, {
    timeout: 120_000,
  })

  const plurals = { namespace: 'namespaces', workload: 'workloads', pod: 'pods', node: 'nodes' }
  for (const name of ['CPU', 'Memory', 'Network in', 'Network out', 'Restarts']) {
    await metric.getByRole('button', { name }).click()
    for (const [group, plural] of Object.entries(plurals)) {
      if (name === 'Restarts' && group === 'node') continue
      await by.selectOption(group)
      // Restarts take the crashing container a minute to add up.
      await expect(ranked(page, plural).nth(1), `${name} by ${group}`).toBeVisible({
        timeout: name === 'Restarts' ? 120_000 : 30_000,
      })
      await expect(page.getByRole('alert'), `${name} by ${group}`).toHaveCount(0)
    }
  }

  // Nodes are named by cAdvisor's node label; workloads by their pods' owners.
  await metric.getByRole('button', { name: 'CPU' }).click()
  await by.selectOption('node')
  await expect(page.getByRole('region', { name: 'Ranked nodes' })).toContainText(
    'kubestacks-worker',
  )
  await inNamespace(page, NS)
  await by.selectOption('workload')
  const workloads = page.getByRole('region', { name: 'Ranked workloads' })
  await expect(workloads.getByRole('button', { name: 'web' })).toBeEnabled()
  await metric.getByRole('button', { name: 'Restarts' }).click()
  await expect(workloads).toContainText('crash')
})

test('the Metrics tab of a pod, a workload and a node', async ({ page }) => {
  await inNamespace(page, NS)
  await open(page, 'Pods', 'web-')
  const pod = page.getByRole('complementary', { name: /^Pod web-/ })
  await pod.getByRole('tab', { name: 'Metrics' }).click()
  const cpu = pod.getByRole('region', { name: 'CPU', exact: true })
  await expect(cpu).toContainText('Requests', { timeout: 120_000 })
  await expect(cpu).toContainText(/Now \d/)
  await expect(pod.getByRole('region', { name: 'Memory', exact: true })).toContainText(/Now \d/)
  await expect(pod.getByRole('region', { name: 'Network', exact: true })).toContainText('Received')

  await goTo(page, 'Deployments')
  await open(page, 'Deployments', 'web')
  const deployment = panel(page, 'Deployment', 'web')
  await deployment.getByRole('tab', { name: 'Metrics' }).click()
  // Both pods, and any it replaced within the hour.
  await expect
    .poll(() =>
      deployment
        .getByRole('region', { name: 'CPU per pod' })
        .getByRole('group', { name: 'Series' })
        .getByRole('button')
        .count(),
    )
    .toBeGreaterThanOrEqual(2)

  await open(page, 'Deployments', 'crash')
  const crashing = panel(page, 'Deployment', 'crash')
  await crashing.getByRole('tab', { name: 'Metrics' }).click()
  await expect(crashing.getByRole('region', { name: 'Restarts' })).toContainText(/Now \d/, {
    timeout: 120_000,
  })

  await open(page, 'Nodes', 'kubestacks-worker')
  const node = panel(page, 'Node', 'kubestacks-worker')
  await node.getByRole('tab', { name: 'Metrics' }).click()
  await expect(node.getByRole('region', { name: 'CPU by namespace' })).toContainText('Allocatable')
  await expect(
    node.getByRole('region', { name: 'CPU by namespace' }).getByRole('group', { name: 'Series' }),
  ).toContainText(NS)
})

test('the overview shows the last hour', async ({ page }) => {
  const cpu = page.getByRole('region', { name: 'CPU', exact: true })
  await expect(cpu).toContainText('Last hour', { timeout: 60_000 })
  await expect(cpu.getByRole('button', { name: 'History' })).toBeVisible()
})

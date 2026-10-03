/**
 * Usage against the real thing: live usage from metrics-server, and history
 * from kube-prometheus-stack's Prometheus, with real cAdvisor and
 * kube-state-metrics series. Every query the app makes has to work here,
 * right-sizing's too (whose answers are checked against a week of known
 * series by hand: a fresh cluster has minutes of history).
 */
import type { Page } from '@playwright/test'
import { open } from '../e2e/action-helpers.ts'
import { goTo, panel, row } from '../e2e/fixtures.ts'
import { rightsizingQueries } from '../../src/renderer/src/lib/rightsizing.ts'
import { CONTEXT, expect, freshNamespace, get, inNamespace, test } from './fixtures.ts'
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

test('right-sizing asks a real Prometheus for a week, a namespace at a time', async ({ page }) => {
  // Subqueries step every five minutes: new pods are in them from the next step.
  test.setTimeout(8 * 60_000)
  // Every query answers, with the new pods' CPU and memory in them. (Their first sample is
  // looked for hour by hour, so minutes-old pods aren't in that one yet.)
  const queries = rightsizingQueries(NS)
  await expect
    .poll(
      async () => {
        const answer = await page.evaluate(
          ({ context, queries }) =>
            window.kubestacks!.usage.instant({ context, queries, time: Date.now() }),
          { context: CONTEXT, queries },
        )
        if (!answer.ok) return answer.error.message
        return answer.data.results
          .filter((r) => r.series.some((s) => s.labels.pod?.startsWith('web-')))
          .map((r) => r.id)
          .sort()
      },
      { timeout: 6 * 60_000 },
    )
    .toEqual(expect.arrayContaining(['cpuMax', 'cpuP95', 'memoryMax']))

  await openMetrics(page)
  await page
    .getByRole('navigation', { name: 'Metrics views' })
    .getByRole('link', { name: 'Right-sizing' })
    .click()
  await inNamespace(page, NS)
  // A fresh cluster has minutes of history: too little to recommend anything. (Other
  // namespaces' rows can show for a moment, until this namespace's list loads.)
  const web = page.getByRole('row', { name: 'Deployment web', exact: true }).filter({ hasText: NS })
  await expect(web).toContainText('Too new', { timeout: 60_000 })
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('the overview shows the last hour', async ({ page }) => {
  const cpu = page.getByRole('region', { name: 'CPU', exact: true })
  await expect(cpu).toContainText('Last hour', { timeout: 60_000 })
  await expect(cpu.getByRole('button', { name: 'History' })).toBeVisible()
})

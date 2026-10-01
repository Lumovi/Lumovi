import { CONTEXTS, DEMO, expect, goTo, openCluster, panel, test } from './fixtures.ts'

test.describe('demo cluster', () => {
  test.beforeEach(async ({ page }) => {
    await openCluster(page)
  })

  test('summarises cluster health', async ({ page }) => {
    await expect(page.getByText(`· Kubernetes ${DEMO.gitVersion}`)).toContainText('127.0.0.1:')
    await expect(page).toHaveTitle(`Overview · ${CONTEXTS.demo} — KubeStacks`)
    const nodes = page.getByRole('region', { name: 'Nodes ready' })
    await expect(nodes).toContainText('3/4')
    await expect(nodes).toContainText('1 not ready')
    const pods = page.getByRole('region', { name: 'Pods running' })
    await expect(pods).toContainText('28')
    await expect(pods).toContainText('8 unhealthy')
    const workloads = page.getByRole('region', { name: 'Workloads healthy' })
    await expect(workloads).toContainText('8/12')
    await expect(workloads).toContainText('4 degraded')
    await expect(page.getByRole('region', { name: 'Warnings', exact: true })).toContainText(
      'In the last hour',
    )
  })

  test('shows CPU and memory against capacity', async ({ page }) => {
    const cpu = page.getByRole('region', { name: 'CPU', exact: true })
    await expect(cpu.getByRole('meter', { name: 'CPU usage' })).toHaveAttribute(
      'aria-valuenow',
      /\d+/,
    )
    await expect(cpu).toContainText('cores in use')
    await expect(cpu.getByLabel(/^Requests: \d+%$/)).toBeAttached()
    await expect(cpu).toContainText('Limits')
    const memory = page.getByRole('region', { name: 'Memory', exact: true })
    await expect(memory).toContainText('GiB in use')
    // With Prometheus, the trend covers the last hour, and leads to the history.
    await expect(memory).toContainText('Last hour')
    await memory.getByRole('button', { name: 'History' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Metrics')
    await expect(
      page.getByRole('group', { name: 'Metric' }).getByRole('button', { name: 'Memory' }),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  test('without history, the trend is what this session saw', async ({ launch }) => {
    const { page } = await launch()
    await page.evaluate(() => window.kubestacks.app.setMetricsSource('demo', { mode: 'off' }))
    await openCluster(page)
    const cpu = page.getByRole('region', { name: 'CPU', exact: true })
    await expect(cpu).toContainText('Collecting usage…')
    await expect(cpu).toContainText('Since you opened it', { timeout: 15_000 })
    await expect(cpu.getByRole('button', { name: 'History' })).toHaveCount(0)
  })

  test('draws usage trends with a hover readout', async ({ page }) => {
    // The hour of history replaces the live trend once Prometheus answers; hover that one.
    await expect(page.getByRole('region', { name: 'CPU', exact: true })).toContainText(
      'Last hour',
      { timeout: 15_000 },
    )
    const trend = page.getByRole('img', { name: /^CPU usage trend, now \d+%$/ })
    await expect(trend).toBeVisible({ timeout: 15_000 })
    // Hovered where the trend is now: on a slow machine the page can still settle (fonts…),
    // and a shift moves the trend out from under a pointer placed earlier.
    await expect(async () => {
      await trend.hover({ position: { x: 4, y: 24 } })
      await expect(page.getByRole('tooltip').filter({ hasText: '%' })).toBeVisible({
        timeout: 1000,
      })
    }).toPass()
    const { width } = (await trend.boundingBox())!
    await trend.hover({ position: { x: width - 2, y: 24 } })
    await page.mouse.move(0, 0)
    await expect(page.getByRole('tooltip')).toHaveCount(0)
  })

  test('a namespace without running pods, picked on another page', async ({ page, clusters }) => {
    await expect(page.getByRole('list', { name: 'Top CPU' })).toBeVisible()
    await goTo(page, 'Pods')
    await page.getByRole('button', { name: 'Namespace' }).click()
    await page.getByRole('option', { name: DEMO.terminatingNamespace }).click()
    await page
      .getByRole('navigation', { name: 'Resources' })
      .getByRole('link', { name: 'Overview' })
      .click()
    // Once its usage is in: nothing to rank, and nothing breaks.
    await expect
      .poll(() =>
        clusters.demo.requests.some(
          (r) =>
            r.path === `/apis/metrics.k8s.io/v1beta1/namespaces/${DEMO.terminatingNamespace}/pods`,
        ),
      )
      .toBe(true)
    await expect(page.getByRole('region', { name: 'CPU', exact: true })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Top CPU' })).toHaveCount(0)
    await expect(page.getByRole('list', { name: 'Top memory' })).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('breaks pods down by status and namespace', async ({ page }) => {
    const bar = page.getByRole('list', { name: 'Pods by status' })
    await expect(bar.getByRole('listitem', { name: 'Running: 28' })).toBeVisible()
    await expect(bar.getByRole('listitem', { name: 'Failing: 5' })).toBeVisible()
    await bar.getByRole('listitem', { name: 'Failing: 5' }).hover()
    await expect(page.getByRole('tooltip', { name: 'Failing: 5' })).toBeVisible()

    const namespaces = page.getByRole('list', { name: 'Pods by namespace' })
    await expect(namespaces.getByRole('button', { name: /shop/ })).toContainText('issues')
    await namespaces.getByRole('button', { name: /^data/ }).click()
    await expect(page.getByRole('button', { name: 'Namespace' })).toHaveText('data')
    await expect(page.getByText('Workloads, pods and events in data')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Pods running' })).toContainText('1 unhealthy')
  })

  test('lists nodes and opens one', async ({ page }) => {
    const card = page.getByRole('region', { name: 'Nodes', exact: true })
    await expect(page.getByRole('meter', { name: `${DEMO.nodes.worker2} Mem` })).toHaveAttribute(
      'data-severity',
      'critical',
    )
    await expect(page.getByRole('meter', { name: `${DEMO.nodes.worker1} CPU` })).toHaveAttribute(
      'data-severity',
      'warn',
    )
    await expect(card.getByRole('button', { name: new RegExp(DEMO.nodes.worker3) })).toContainText(
      'cores',
    )
    await page.getByRole('button', { name: new RegExp(`^${DEMO.nodes.worker2}`) }).click()
    await expect(panel(page, 'Node', DEMO.nodes.worker2)).toBeVisible()
  })

  test('points at what needs attention', async ({ page }) => {
    const attention = page.getByRole('list', { name: 'Needs attention' })
    await expect(attention.getByRole('button').first()).toContainText('Unavailable')
    await attention.getByRole('button', { name: /recommendations\s*Deployment/ }).click()
    await expect(panel(page, 'Deployment', DEMO.deployments.recommendations)).toBeVisible()
  })

  test('shows recent warnings', async ({ page }) => {
    const warnings = page.getByRole('list', { name: 'Recent warnings' })
    await expect(warnings.getByRole('listitem')).toHaveCount(6)
    await warnings.getByRole('button', { name: /FailedScheduling/ }).click()
    await expect(panel(page, 'Pod', 'redis-1')).toBeVisible()
  })

  test('ranks the busiest pods', async ({ page }) => {
    const top = page.getByRole('list', { name: 'Top memory' })
    await expect(top.getByRole('listitem')).toHaveCount(5)
    await expect(page.getByRole('list', { name: 'Top CPU' }).getByRole('listitem')).toHaveCount(5)
    const first = top.getByRole('button').first()
    const name = (await first.locator('span').first().locator('span').first().textContent())!
    await first.click()
    await expect(panel(page, 'Pod', name)).toBeVisible()
  })
})

test('explains missing metrics and a calm cluster', async ({ page }) => {
  await openCluster(page, CONTEXTS.sandbox)
  await expect(page.getByRole('region', { name: 'Nodes ready' })).toContainText('All ready')
  await expect(page.getByRole('region', { name: 'Pods running' })).toContainText('No pods yet')
  await expect(page.getByRole('region', { name: 'Workloads healthy' })).toContainText(
    'No workloads yet',
  )
  await expect(page.getByRole('region', { name: 'Warnings', exact: true })).toContainText('0')
  const cpu = page.getByRole('region', { name: 'CPU', exact: true })
  await expect(cpu).toContainText('Live usage needs metrics-server')
  await expect(cpu).toContainText('requested')
  await expect(cpu.getByRole('meter', { name: 'CPU requested' })).toBeVisible()
  await expect(page.getByText('Everything looks healthy.')).toBeVisible()
  await expect(page.getByText('No warnings. Nice.')).toBeVisible()
  await expect(page.getByRole('list', { name: 'Top CPU' })).toHaveCount(0)
})

test('shows an error when the cluster is unreachable', async ({ page }) => {
  // Windows takes about two seconds to give up on each refused connection.
  const timeout = 20_000
  await openCluster(page, CONTEXTS.offline)
  await expect(page.getByRole('alert')).toContainText('Can’t reach the cluster', { timeout })
  await expect(page.getByRole('button', { name: 'Switch cluster' })).toContainText('Unavailable')
  await page.getByRole('button', { name: 'Try again' }).click()
  // Each card may say so too, while the cluster stays unreachable.
  await expect(page.getByRole('alert').filter({ hasText: 'ECONNREFUSED' }).first()).toBeVisible({
    timeout,
  })
})

test('keeps working when one resource is forbidden', async ({ page, clusters }) => {
  const clear = clusters.demo.fail('/api/v1/events', {
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({
      kind: 'Status',
      message: 'events is forbidden: User "demo" cannot list resource "events"',
    }),
  })
  await openCluster(page)
  const warnings = page.getByRole('region', { name: 'Recent warnings' })
  await expect(warnings.getByRole('alert')).toContainText('Access denied')
  await expect(warnings.getByRole('alert')).toContainText('events is forbidden')
  await expect(page.getByRole('region', { name: 'Warnings', exact: true })).toContainText('—')
  await expect(page.getByRole('region', { name: 'Nodes ready' })).toContainText('3/4')

  clear()
  await warnings.getByRole('button', { name: 'Try again' }).click()
  await expect(warnings.getByRole('list', { name: 'Recent warnings' })).toBeVisible()
})

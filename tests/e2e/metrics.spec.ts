import type { Locator, Page } from '@playwright/test'
import { open, toasts } from './action-helpers.ts'
import { CONTEXTS, DEMO, expect, goTo, openCluster, panel, row, test } from './fixtures.ts'

const METRICS = '/api/v1/namespaces/monitoring/services/prometheus:web/proxy'

async function openMetrics(page: Page) {
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'Metrics' })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Metrics')
}

const chartOf = (page: Page, title: string) =>
  page.getByRole('region', { name: title, exact: true })
const plot = (scope: Locator) => scope.getByRole('group', { name: /Arrow keys read values/ })
const legend = (scope: Locator) => scope.getByRole('group', { name: 'Series' })
const table = (page: Page, plural: string) => page.getByRole('region', { name: `Ranked ${plural}` })
const filter = (page: Page) => page.getByPlaceholder(/^Filter .*\(a, b\)$/)

/** Where a chart's plot is on screen, scrolled into view first. */
async function plotBox(scope: Locator) {
  const svg = plot(scope).locator('svg')
  await svg.scrollIntoViewIfNeeded()
  return (await svg.boundingBox())!
}

/** Drags across a chart's plot, from one fraction of its width to another. */
async function drag(page: Page, scope: Locator, from: number, to: number) {
  const box = await plotBox(scope)
  await page.mouse.move(box.x + box.width * from, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * ((from + to) / 2), box.y + box.height / 2)
  await page.mouse.move(box.x + box.width * to, box.y + box.height / 2)
  await page.mouse.up()
}

test.describe('the metrics page', () => {
  test.beforeEach(async ({ page }) => {
    await openCluster(page)
    await openMetrics(page)
  })

  test('shows what the cluster uses, by namespace, against what it can allocate', async ({
    page,
  }) => {
    await expect(page).toHaveTitle(`Metrics · ${CONTEXTS.demo} — KubeStacks`)
    await expect(
      page.getByRole('button', { name: /^Prometheus 3\.5\.0 monitoring\/prometheus$/ }),
    ).toBeVisible()
    const summary = page.getByRole('group', { name: 'Summary' })
    for (const tile of ['Now', 'Average', 'Peak', 'Of allocatable, on average']) {
      await expect(summary).toContainText(tile)
    }
    await expect(summary.getByText(/^\d+(\.\d+)? cores$/).first()).toBeVisible()

    const chart = chartOf(page, 'CPU by namespace')
    await expect(chart).toContainText('All 6 namespaces')
    // Allocatable capacity is far above what's used, so it's noted rather than drawn.
    await expect(chart).toContainText('↑ Allocatable')
    await expect(chart).toContainText('above the chart')
    // The legend is in the ranking's order, busiest first. (The mock's usage moves with
    // the clock, so the middle of the order does too.)
    const byRank = table(page, 'namespaces').getByRole('row').locator('td:first-child')
    await expect(byRank).toHaveCount(6)
    const order = await byRank.allTextContents()
    expect(order.toSorted()).toEqual([
      'batch',
      'data',
      'default',
      'kube-system',
      'monitoring',
      'shop',
    ])
    await expect(legend(chart).getByRole('button')).toHaveText(order)

    // Hovering reads every namespace at that time, with the total.
    const box = await plotBox(chart)
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2)
    const tooltip = page.getByRole('tooltip')
    await expect(tooltip).toContainText('Total')
    await expect(tooltip).toContainText('shop')
    // …on the left of the line near the right edge, on the right of it elsewhere.
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2)
    await expect(tooltip).toContainText('Total')
    await page.mouse.move(box.x - 40, box.y - 40)
    await expect(tooltip).toHaveCount(0)

    // The keyboard reads it too.
    await plot(chart).focus()
    await page.keyboard.press('ArrowLeft')
    await expect(tooltip).toContainText('Total')
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('End')
    await page.keyboard.press('a')
    await expect(tooltip).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
    await page.keyboard.press('Escape')

    // The legend hides, isolates and highlights series.
    const shop = legend(chart).getByRole('button', { name: 'shop' })
    await shop.click()
    await expect(shop).toHaveAttribute('aria-pressed', 'false')
    await shop.click()
    await expect(shop).toHaveAttribute('aria-pressed', 'true')
    await shop.click({ modifiers: ['Alt'] })
    await expect(legend(chart).getByRole('button', { name: 'data' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await shop.click({ modifiers: ['Alt'] })
    await expect(legend(chart).getByRole('button', { name: 'data' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    // Hiding every series leaves an empty plot, and a way back.
    await shop.click({ modifiers: ['Alt'] })
    await shop.click()
    await expect(plot(chart).locator('svg path')).toHaveCount(0)
    await legend(chart).getByRole('button', { name: 'Show all' }).click()
    await legend(chart).getByRole('button', { name: 'batch' }).click()
    await legend(chart).getByRole('button', { name: 'Show all' }).click()
    await expect(legend(chart).getByRole('button', { name: 'batch' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await shop.hover()
    await shop.focus()
    await shop.blur()

    // Lines instead of stacked areas: no capacity to compare with then.
    await page.getByRole('group', { name: 'Chart' }).getByRole('button', { name: 'Lines' }).click()
    await expect(chart).not.toContainText('Allocatable')
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2)
    await expect(tooltip).not.toContainText('Total')
    await page
      .getByRole('group', { name: 'Chart' })
      .getByRole('button', { name: 'Stacked' })
      .click()

    // The ranked table: sortable, with each namespace's share.
    const ranked = table(page, 'namespaces')
    const names = ranked.getByRole('row').locator('td:first-child')
    // Busiest first, as the legend has it.
    await expect(names.first()).toHaveText(order[0]!)
    await ranked.getByRole('button', { name: 'Namespace' }).click()
    await expect(names.first()).toHaveText('batch')
    await ranked.getByRole('button', { name: 'Namespace' }).click()
    await expect(names.first()).toHaveText('shop')
    await ranked.getByRole('button', { name: 'Peak' }).click()
    await ranked.getByRole('button', { name: 'Now' }).click()
    await ranked.getByRole('button', { name: 'Now' }).click()
    await expect(ranked.getByRole('columnheader', { name: 'Now' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
    // The rest add up to Other.
    await page.getByRole('combobox', { name: 'Series shown' }).selectOption('3')
    await expect(legend(chart).getByRole('button', { name: 'Other' })).toBeVisible()
    await page.getByRole('combobox', { name: 'Series shown' }).selectOption('7')
    await expect(names.first()).toHaveText('default')
    // A namespace opens on its overview.
    await ranked.getByRole('button', { name: 'shop' }).click()
    await expect(
      panel(page, 'Namespace', 'shop').getByRole('tab', { name: 'Overview' }),
    ).toHaveAttribute('aria-selected', 'true')
  })

  test('the histogram shows the spread, and filters the table', async ({ page }) => {
    await page.getByRole('combobox', { name: 'Group by' }).selectOption('pod')
    const spread = page.getByRole('group', { name: 'How pods spread by CPU' })
    const bands = spread.getByRole('button', { disabled: false })
    await expect(bands.first()).toHaveAccessibleName(/^\d+ pods from 0 to /)
    await bands.first().hover()
    await expect(page.getByRole('tooltip')).toContainText('pods ·')
    await bands.first().focus()
    await bands.first().blur()
    const before = await table(page, 'pods').getByRole('row').count()
    await bands.last().click()
    await expect(bands.last()).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('Showing one band below')).toBeVisible()
    await expect.poll(() => table(page, 'pods').getByRole('row').count()).toBeLessThan(before)
    await bands.last().click()
    await expect(page.getByText('Click a band to filter')).toBeVisible()
    await bands.last().click()
    await table(page, 'pods').getByRole('button', { name: 'Show all' }).click()
    await expect.poll(() => table(page, 'pods').getByRole('row').count()).toBe(before)

    // Pods open on their own metrics.
    await table(page, 'pods').getByRole('row').nth(1).getByRole('button').first().click()
    await expect(
      page.getByRole('complementary', { name: /^Pod / }).getByRole('tab', { name: 'Metrics' }),
    ).toHaveAttribute('aria-selected', 'true')
  })

  test('every metric, grouped every way, narrowed by name and top', async ({ page }) => {
    const metric = page.getByRole('group', { name: 'Metric' })
    const by = page.getByRole('combobox', { name: 'Group by' })

    await by.selectOption('pod')
    await expect(chartOf(page, 'CPU by pod')).toContainText(
      /The top 7 of \d+ pods, the rest as Other/,
    )
    await expect(
      legend(chartOf(page, 'CPU by pod')).getByRole('button', { name: 'Other' }),
    ).toBeVisible()
    // Other pods top the memory chart; each gets a color of its own.
    await metric.getByRole('button', { name: 'Memory' }).click()
    await expect(legend(chartOf(page, 'Memory by pod')).getByRole('button')).toHaveCount(8)
    await metric.getByRole('button', { name: 'CPU' }).click()
    await page.getByRole('combobox', { name: 'Series shown' }).selectOption('3')
    await expect(chartOf(page, 'CPU by pod')).toContainText(/The top 3 of/)
    await expect(legend(chartOf(page, 'CPU by pod')).getByRole('button')).toHaveCount(4)

    // Workloads add up their pods; a workload's peak can't be told from its pods'.
    await by.selectOption('workload')
    const workloads = table(page, 'workloads')
    await expect(workloads).toContainText('storefront')
    await expect(workloads).toContainText('—')
    await workloads.getByRole('button', { name: 'Peak' }).click()
    await workloads.getByRole('button', { name: 'storefront' }).click()
    await expect(
      panel(page, 'Deployment', 'storefront').getByRole('tab', { name: 'Metrics' }),
    ).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Escape')

    await by.selectOption('node')
    await expect(table(page, 'nodes')).toContainText(DEMO.nodes.worker1)
    await table(page, 'nodes').getByRole('button', { name: DEMO.nodes.worker1 }).click()
    await expect(panel(page, 'Node', DEMO.nodes.worker1)).toBeVisible()
    await page.keyboard.press('Escape')

    await metric.getByRole('button', { name: 'Memory' }).click()
    await expect(chartOf(page, 'Memory by node')).toBeVisible()
    await expect(page.getByText(/ GiB$/).first()).toBeVisible()
    await metric.getByRole('button', { name: 'Network in' }).click()
    await expect(page.getByText(/\/s$/).first()).toBeVisible()
    await metric.getByRole('button', { name: 'Network out' }).click()
    await expect(chartOf(page, 'Network out by node')).toBeVisible()

    // Restarts aren't labeled with nodes: grouping falls back to namespaces, as columns.
    await metric.getByRole('button', { name: 'Restarts' }).click()
    await expect(by).toHaveValue('namespace')
    await expect(by.getByRole('option', { name: 'Node' })).toHaveCount(0)
    await expect(page.getByRole('group', { name: 'Chart' })).toHaveCount(0)
    await expect(page.getByText('Namespaces restarting')).toBeVisible()
    await expect(page.getByText('Most', { exact: true })).toBeVisible()
    await expect(table(page, 'namespaces')).toContainText('shop')
    const restarts = chartOf(page, 'Restarts by namespace')
    const box = await plotBox(restarts)
    await page.mouse.move(box.x + box.width * 0.97, box.y + box.height / 2)
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2)
    await by.selectOption('pod')
    await expect(table(page, 'pods')).toContainText(DEMO.pods.checkout[0]!)
    // Only what restarted ranks.
    await expect(table(page, 'pods').getByRole('row')).toHaveCount(3)
    await filter(page).fill('storefront')
    await expect(
      page.getByText('No pods named like “storefront” have restarts in this time.'),
    ).toBeVisible()
    await filter(page).fill('')

    // A filter by name: several words match any of them; nothing matching says so.
    await metric.getByRole('button', { name: 'CPU' }).click()
    await filter(page).press('ArrowDown')
    await filter(page).fill('storefront, POSTGRES')
    await expect(chartOf(page, 'CPU by pod')).toContainText('The top 3 of 6 pods')
    await expect(page.getByText('Busiest pod')).toBeVisible()
    await filter(page).fill('nothing-like-this')
    await expect(page.getByText('Nothing matches')).toBeVisible()
    await expect(
      page.getByText('No pods named like “nothing-like-this” have CPU in this time.'),
    ).toBeVisible()
    await filter(page).fill('')
    await expect(chartOf(page, 'CPU by pod')).toContainText('The top 3')

    // The header's namespace narrows everything too.
    const picker = page.getByRole('button', { name: 'Namespace' })
    await picker.click()
    await page.getByRole('option', { name: 'legacy' }).click()
    await expect(page.getByText('No data for this time')).toBeVisible()
    await expect(
      page.getByText('Prometheus has no CPU samples in legacy for this time.'),
    ).toBeVisible()
    await picker.click()
    await page.getByRole('option', { name: 'default' }).click()
    await expect(page.getByText(/millicores$/).first()).toBeVisible()
    await metric.getByRole('button', { name: 'Restarts' }).click()
    await expect(page.getByText('No restarts', { exact: true })).toBeVisible()
    await expect(page.getByText('Nothing restarted in default in this time.')).toBeVisible()
  })

  test('zoom in by dragging, and back out', async ({ page }) => {
    const range = page.getByRole('group', { name: 'Time range' })
    await range.getByRole('button', { name: '6h' }).click()
    await expect(range.getByRole('button', { name: '6h' })).toHaveAttribute('aria-pressed', 'true')
    const chart = chartOf(page, 'CPU by namespace')
    await expect(plot(chart)).toBeVisible()
    // A click isn't a zoom, nor is a right-button drag.
    const box = await plotBox(chart)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
    await expect(page.getByRole('button', { name: 'Reset zoom' })).toHaveCount(0)
    await drag(page, chart, 0.3, 0.6)
    await expect(page.getByRole('button', { name: 'Reset zoom' })).toBeVisible()
    await expect(range.getByRole('button', { name: '6h' })).toHaveAttribute('aria-pressed', 'false')
    // Zooming again zooms within; resetting goes back to the preset it came from.
    await drag(page, chart, 0.2, 0.8)
    await expect(page).toHaveURL(/back=6h/)
    await page.getByRole('button', { name: 'Reset zoom' }).click()
    await expect(range.getByRole('button', { name: '6h' })).toHaveAttribute('aria-pressed', 'true')
    for (const preset of ['15m', '24h', '7d']) {
      await range.getByRole('button', { name: preset }).click()
      await expect(plot(chart)).toBeVisible()
    }
    // Over days, the tooltip says which day.
    const week = await plotBox(chart)
    await page.mouse.move(week.x + week.width * 0.5, week.y + week.height / 2)
    await expect(page.getByRole('tooltip')).toContainText(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/)
  })

  test('the URL keeps the filters, and odd values fall back', async ({ page }) => {
    await page.evaluate(() => {
      window.location.hash =
        window.location.hash.replace(/\?.*$/, '') +
        '?metric=restarts&by=node&top=9&range=2w&view=bars'
    })
    await expect(page.getByRole('combobox', { name: 'Group by' })).toHaveValue('namespace')
    await expect(page.getByRole('combobox', { name: 'Series shown' })).toHaveValue('7')
    await page.evaluate(() => {
      window.location.hash =
        window.location.hash.replace(/\?.*$/, '') + '?metric=nope&by=nope&from=5&to=1&back=1h'
    })
    await expect(
      page.getByRole('group', { name: 'Metric' }).getByRole('button', { name: 'CPU' }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(
      page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '1h' }),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  test('is a shortcut and a palette entry away', async ({ page }) => {
    await goTo(page, 'Pods')
    await page.keyboard.press('g')
    await page.keyboard.press('u')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Metrics')
    await goTo(page, 'Pods')
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('metrics usage')
    await page
      .getByRole('option', { name: /^Metrics/ })
      .first()
      .click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Metrics')
  })
})

test('VictoriaMetrics, and thousands of pods', async ({ page }) => {
  await openCluster(page, CONTEXTS.large)
  await openMetrics(page)
  // Ranking 2,500 pods over the hour takes the mock a moment on slow runners.
  await expect(
    page.getByRole('button', { name: /^VictoriaMetrics monitoring\/vmsingle-vm$/ }),
  ).toBeVisible({ timeout: 40_000 })
  await page.getByRole('combobox', { name: 'Group by' }).selectOption('pod')
  const ranked = table(page, 'pods')
  await expect(ranked.getByRole('button', { name: /^Show 50 more of 2,500$/ })).toBeVisible({
    timeout: 40_000,
  })
  await ranked.getByRole('button', { name: /^Show 50 more/ }).click()
  await expect(ranked.getByRole('row')).toHaveCount(101)
  await expect(chartOf(page, 'CPU by pod')).toContainText('The top 7 of 2,500 pods')
})

test.describe('where history comes from', () => {
  test('nothing found: look again, or choose a service', async ({ page }) => {
    await openCluster(page, CONTEXTS.sandbox)
    await openMetrics(page)
    await expect(page.getByText('No Prometheus found')).toBeVisible()
    await page.getByRole('button', { name: 'Look again' }).click()
    await expect(page.getByText('No Prometheus found')).toBeVisible()
    await page.getByRole('button', { name: 'Choose a service' }).click()
    const dialog = page.getByRole('dialog', { name: /Metrics source/ })
    await expect(dialog).toContainText('kubectl get services --all-namespaces --context sandbox')
    await expect(dialog.getByRole('radio', { name: /Find it automatically/ })).toBeChecked()
    await expect(dialog).toContainText(
      'Looks for Prometheus and VictoriaMetrics among the cluster’s services.',
    )
    await dialog.getByRole('radio', { name: /Use a service/ }).check()
    // There's no monitoring namespace here, so nothing to pick from yet.
    await expect(dialog.getByRole('combobox', { name: 'Service' })).toHaveValue('')
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
    await dialog.getByRole('combobox', { name: 'Namespace' }).selectOption('default')
    await dialog.getByRole('combobox', { name: 'Service' }).selectOption('docs')
    // An alias for an outside host has no ports.
    await expect(dialog.getByRole('combobox', { name: 'Port' })).toHaveValue('')
    await expect(dialog.getByRole('combobox', { name: 'Port' }).getByRole('option')).toHaveCount(1)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    // The node says so on its Metrics tab too, more compactly.
    await goTo(page, 'Nodes')
    await row(page, 'Nodes', /./).first().getByRole('gridcell').nth(1).click()
    const node = page.getByRole('complementary', { name: /^Node / })
    await node.getByRole('tab', { name: 'Metrics' }).click()
    await expect(node).toContainText('No Prometheus found')
  })

  test('the first that answers wins; refusals are explained', async ({ launch, clusters }) => {
    // The usual Prometheus doesn't answer, so the older one is used.
    const clear = clusters.demo.fail(`${METRICS}/api/v1/query`, { status: 503, body: '{}' })
    const first = await launch()
    await openCluster(first.page)
    await openMetrics(first.page)
    await expect(
      first.page.getByRole('button', { name: /data\/prometheus-archive$/ }),
    ).toBeVisible()
    clear()

    // An account that may not use the service proxy.
    clusters.demo.deny({ verb: 'get', resource: 'services', subresource: 'proxy' })
    const second = await launch()
    await openCluster(second.page)
    await openMetrics(second.page)
    const alert = second.page.getByRole('alert')
    await expect(alert).toContainText('Can’t read usage history')
    await expect(alert).toContainText(
      'Your account can’t reach monitoring/prometheus through the API server (it needs get on services/proxy).',
    )
  })

  test('services that can’t be listed', async ({ launch, clusters }) => {
    clusters.demo.fail('/api/v1/services', {
      status: 403,
      body: '{"kind":"Status","message":"forbidden"}',
    })
    const first = await launch()
    await openCluster(first.page)
    await openMetrics(first.page)
    await expect(first.page.getByRole('alert')).toContainText('Your account can’t list services')
    clusters.demo.reset()
    clusters.demo.fail('/api/v1/services', {
      status: 500,
      body: '{"kind":"Status","message":"etcd is down"}',
    })
    const second = await launch()
    await openCluster(second.page)
    await openMetrics(second.page)
    await expect(second.page.getByRole('alert')).toContainText('etcd is down')
  })

  test('choose a service, test it, turn history off, and back to detection', async ({ page }) => {
    await openCluster(page)
    await openMetrics(page)
    await page.getByRole('button', { name: /^Prometheus 3\.5\.0/ }).click()
    const dialog = page.getByRole('dialog', { name: /Metrics source/ })
    await expect(dialog).toContainText('Found Prometheus at monitoring/prometheus.')
    await expect(dialog).toContainText(
      `kubectl get --raw '/api/v1/namespaces/monitoring/services/prometheus:web/proxy/api/v1/query?query=up' --context ${CONTEXTS.demo}`,
    )
    await dialog.getByRole('radio', { name: /Use a service/ }).check()
    const namespace = dialog.getByRole('combobox', { name: 'Namespace' })
    const service = dialog.getByRole('combobox', { name: 'Service' })
    const port = dialog.getByRole('combobox', { name: 'Port' })
    // It starts from what was detected.
    await expect(namespace).toHaveValue('monitoring')
    await expect(service).toHaveValue('prometheus')
    await expect(port).toHaveValue('web')
    await expect(port.getByRole('option', { name: 'web · 9090' })).toBeAttached()

    // Grafana answers, but not PromQL.
    await service.selectOption('grafana')
    await dialog.getByRole('button', { name: 'Test' }).click()
    await expect(dialog.getByRole('status')).toContainText(
      'monitoring/grafana didn’t answer PromQL: It answered, but not like Prometheus.',
    )
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeVisible()

    // A path must start with a slash.
    await service.selectOption('prometheus')
    await dialog.getByRole('textbox', { name: 'Path' }).fill('api')
    await dialog.getByRole('button', { name: 'Test' }).click()
    await expect(dialog.getByRole('status')).toContainText('path must be empty or start with /')
    await dialog.getByRole('textbox', { name: 'Path' }).fill('')

    // A port without a name is picked by number.
    await namespace.selectOption('data')
    await expect(service).toHaveValue('')
    await service.selectOption('prometheus-archive')
    await expect(port).toHaveValue('9090')
    await dialog.getByRole('button', { name: 'Test' }).click()
    await expect(dialog.getByRole('status')).toContainText('Answered: Prometheus 3.5.0')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(toasts(page)).toContainText('Metrics source saved')
    await expect(page.getByRole('button', { name: /data\/prometheus-archive$/ })).toBeVisible()

    // Turned off: only live usage, everywhere.
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('metrics source')
    await page.getByRole('option', { name: 'Metrics source…' }).click()
    await expect(dialog.getByRole('radio', { name: /Use a service/ })).toBeChecked()
    await expect(dialog.getByRole('combobox', { name: 'Service' })).toHaveValue(
      'prometheus-archive',
    )
    await dialog.getByRole('radio', { name: /Don’t use history/ }).check()
    await expect(dialog).toContainText(
      `kubectl top pods --all-namespaces --context ${CONTEXTS.demo}`,
    )
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Usage history is off')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Look again' })).toHaveCount(0)

    // Back to detection.
    await page.getByRole('button', { name: 'Change' }).click()
    await dialog.getByRole('radio', { name: /Find it automatically/ }).check()
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('button', { name: /monitoring\/prometheus$/ })).toBeVisible()
    expect(
      await page.evaluate(() => window.kubestacks.app.settings().then((s) => s.metricsSource)),
    ).toEqual({})
  })

  test('typed in when the cluster won’t list them', async ({ page, clusters }) => {
    clusters.demo.fail('/api/v1/namespaces', {
      status: 403,
      body: '{"kind":"Status","message":"no"}',
    })
    clusters.demo.fail('/api/v1/namespaces/monitoring/services', {
      status: 403,
      body: '{"kind":"Status","message":"no"}',
    })
    await openCluster(page)
    await openMetrics(page)
    await page.getByRole('button', { name: /^Prometheus/ }).click()
    const dialog = page.getByRole('dialog', { name: /Metrics source/ })
    await dialog.getByRole('radio', { name: /Use a service/ }).check()
    await expect(dialog.getByRole('textbox', { name: 'Namespace' })).toHaveValue('monitoring')
    await dialog.getByRole('textbox', { name: 'Service' }).fill('prometheus')
    // A port the service doesn't have.
    await dialog.getByRole('textbox', { name: 'Port' }).fill('8080')
    await dialog.getByRole('button', { name: 'Test' }).click()
    await expect(dialog.getByRole('status')).toContainText(
      'no endpoints available for service "prometheus:8080"',
    )
    await dialog.getByRole('textbox', { name: 'Port' }).fill('web')
    await expect(dialog).toContainText('/services/prometheus:web/proxy/api/v1/query?query=up')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(toasts(page)).toContainText('Metrics source saved')
  })
})

test.describe('the Metrics tab', () => {
  test.beforeEach(async ({ page }) => {
    await openCluster(page)
  })

  test('a pod: its containers against requests and limits, network and restarts', async ({
    page,
  }) => {
    await open(page, 'Pods', DEMO.pods.storefront[0]!)
    const detail = panel(page, 'Pod', DEMO.pods.storefront[0]!)
    await detail.getByRole('tab', { name: 'Metrics' }).click()
    const cpu = detail.getByRole('region', { name: 'CPU', exact: true })
    await expect(legend(cpu).getByRole('button')).toHaveText(['app', 'envoy'])
    await expect(cpu).toContainText('Requests')
    await expect(cpu).toContainText('↑ Limit')
    await expect(cpu).toContainText(/Now \d+m/)
    const memory = detail.getByRole('region', { name: 'Memory', exact: true })
    await expect(memory).toContainText('Limit')
    await expect(memory).toContainText('Requests')
    const network = detail.getByRole('region', { name: 'Network', exact: true })
    await expect(legend(network).getByRole('button')).toHaveText(['Received', 'Sent'])
    await expect(network).not.toContainText('Now')
    await expect(detail.getByRole('region', { name: 'Restarts' })).toContainText(
      'None in this time',
    )
    await expect(detail.getByRole('region', { name: 'Restarts' })).toContainText(
      'Restarts come from kube-state-metrics.',
    )

    // The table twin.
    await cpu.getByRole('button', { name: 'Show as table' }).click()
    await expect(cpu.getByRole('table')).toContainText('envoy')
    await cpu.getByRole('button', { name: 'Show as chart' }).click()
    await expect(plot(cpu)).toBeVisible()

    // The range is remembered for the next object.
    await detail
      .getByRole('group', { name: 'Time range' })
      .getByRole('button', { name: '24h' })
      .click()
    await drag(page, cpu, 0.4, 0.7)
    await expect(detail.getByRole('button', { name: 'Reset zoom' })).toBeVisible()
    await detail.getByRole('button', { name: 'Reset zoom' }).click()
    await open(page, 'Pods', DEMO.pods.debugShell)
    const shell = panel(page, 'Pod', DEMO.pods.debugShell)
    await shell.getByRole('tab', { name: 'Metrics' }).click()
    await expect(
      shell.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '24h' }),
    ).toHaveAttribute('aria-pressed', 'true')
    // It has only run for a few hours: before that, there's nothing to read.
    const young = shell.getByRole('region', { name: 'CPU', exact: true })
    await plot(young).focus()
    await page.keyboard.press('Home')
    await expect(page.getByRole('tooltip')).toContainText('No data')
    await page.keyboard.press('Escape')
  })

  test('a crashing pod: no usage, but its restarts', async ({ page }) => {
    await open(page, 'Pods', DEMO.pods.checkout[0]!)
    const detail = panel(page, 'Pod', DEMO.pods.checkout[0]!)
    await detail.getByRole('tab', { name: 'Metrics' }).click()
    await expect(detail.getByRole('region', { name: 'CPU', exact: true })).toContainText(
      'No data for this time',
    )
    const restarts = detail.getByRole('region', { name: 'Restarts' })
    await expect(restarts).toContainText(/Now \d+/)
    const box = await plotBox(restarts)
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2)
    await expect(page.getByRole('tooltip')).toBeVisible()
  })

  test('workloads: their pods, one line each', async ({ page }) => {
    const cases: [string, string, string][] = [
      ['Deployments', 'Deployment', DEMO.deployments.storefront],
      ['StatefulSets', 'StatefulSet', DEMO.statefulSets.postgres],
      ['DaemonSets', 'DaemonSet', DEMO.daemonSets.nodeExporter],
      ['Jobs', 'Job', DEMO.jobs.reindex],
      ['CronJobs', 'CronJob', DEMO.cronJobs.nightlyReport],
      ['ReplicaSets', 'ReplicaSet', DEMO.replicaSets.cart],
    ]
    for (const [label, kind, name] of cases) {
      await open(page, label, name)
      const detail = panel(page, kind, name)
      await detail.getByRole('tab', { name: 'Metrics' }).click()
      const cpu = detail.getByRole('region', { name: 'CPU per pod' })
      await expect(cpu.or(detail.getByText('No data for this time')).first()).toBeVisible()
      await expect(detail.getByRole('region', { name: 'Memory per pod' })).toBeVisible()
    }
    await open(page, 'Deployments', DEMO.deployments.checkout)
    const checkout = panel(page, 'Deployment', DEMO.deployments.checkout)
    await checkout.getByRole('tab', { name: 'Metrics' }).click()
    await expect(checkout.getByRole('region', { name: 'Restarts' })).toContainText(/Now \d+/)
    const restarts = legend(checkout.getByRole('region', { name: 'Restarts' }))
    await expect(restarts.getByRole('button')).toHaveCount(2)
    // Pointing at a series in the legend brings it forward, in columns and lines alike.
    await restarts.getByRole('button').first().hover()
    await open(page, 'Deployments', DEMO.deployments.storefront)
    const storefront = panel(page, 'Deployment', DEMO.deployments.storefront)
    await storefront.getByRole('tab', { name: 'Metrics' }).click()
    await legend(storefront.getByRole('region', { name: 'CPU per pod' }))
      .getByRole('button')
      .first()
      .hover()
  })

  test('a node: what runs on it, by namespace, against what it can allocate', async ({ page }) => {
    await open(page, 'Nodes', DEMO.nodes.worker1)
    const detail = panel(page, 'Node', DEMO.nodes.worker1)
    await detail.getByRole('tab', { name: 'Metrics' }).click()
    const cpu = detail.getByRole('region', { name: 'CPU by namespace' })
    await expect(cpu).toContainText('Allocatable')
    await expect(legend(cpu).getByRole('button').first()).toBeVisible()
    // The same namespace has the same color in every chart.
    const memory = detail.getByRole('region', { name: 'Memory by namespace' })
    const colorOf = (scope: Locator, name: string) =>
      legend(scope).getByRole('button', { name }).locator('span').first().getAttribute('style')
    expect(await colorOf(cpu, 'shop')).toBe(await colorOf(memory, 'shop'))
    await expect(detail.getByRole('region', { name: 'Network', exact: true })).toBeVisible()
    await expect(detail.getByRole('region', { name: 'Restarts' })).toHaveCount(0)
  })

  test('a query that fails, and one that stops answering', async ({ page, clusters }) => {
    await open(page, 'Pods', DEMO.pods.storefront[1]!)
    const detail = panel(page, 'Pod', DEMO.pods.storefront[1]!)
    const clear = clusters.demo.fail(`${METRICS}/api/v1/query_range`, {
      status: 422,
      body: JSON.stringify({
        status: 'error',
        errorType: 'execution',
        error: 'query processing would load too many samples',
      }),
    })
    await detail.getByRole('tab', { name: 'Metrics' }).click()
    const cpu = detail.getByRole('region', { name: 'CPU', exact: true })
    await expect(cpu.getByRole('alert')).toContainText(
      'query processing would load too many samples',
    )
    clear()
    await cpu.getByRole('button', { name: 'Try again' }).click()
    await expect(plot(cpu)).toBeVisible()
    // Series without a usable sample, and all-zero ones, still chart.
    const now = Math.floor(Date.now() / 1000)
    const odd = clusters.demo.fail(`${METRICS}/api/v1/query_range`, {
      status: 200,
      body: JSON.stringify({
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            { metric: { container: 'app' }, values: [[now - 600, 'NaN']] },
            {
              metric: { container: 'envoy' },
              values: [
                [now - 600, '0'],
                [now - 300, '0'],
              ],
            },
          ],
        },
      }),
    })
    await detail
      .getByRole('group', { name: 'Time range' })
      .getByRole('button', { name: '6h' })
      .click()
    await expect(cpu).toContainText('Now 0')
    odd()
    await detail
      .getByRole('group', { name: 'Time range' })
      .getByRole('button', { name: '1h' })
      .click()
    await expect(cpu).not.toContainText('Now 0')
    // Later refreshes that fail keep the chart, and say so.
    clusters.demo.fail(`${METRICS}/api/v1/query_range`, { status: 500, body: '{}' })
    await page.getByRole('button', { name: 'Refresh' }).first().click()
    await expect(cpu).toContainText('Couldn’t refresh — showing the last data.')
    await expect(plot(cpu)).toBeVisible()
  })
})

test.describe('when Prometheus answers oddly, or not at all', () => {
  test.beforeEach(async ({ page }) => {
    await openCluster(page)
    await openMetrics(page)
    await expect(chartOf(page, 'CPU by namespace')).toBeVisible()
  })

  test('NaN, infinities and samples outside the time asked for', async ({ page, clusters }) => {
    const now = Math.floor(Date.now() / 1000)
    clusters.demo.fail(`${METRICS}/api/v1/query`, {
      status: 200,
      body: JSON.stringify({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            { metric: { namespace: 'shop' }, value: [now, 'NaN'] },
            { metric: { namespace: 'data' }, value: [now, '0'] },
          ],
        },
      }),
    })
    const values = [
      [now - 30_000, '1'],
      [now + 7200, '1'],
      [now - 1800, 'NaN'],
      [now - 1200, '+Inf'],
      [now - 600, '0.5'],
      [now - 300, '0.25'],
    ]
    clusters.demo.fail(`${METRICS}/api/v1/query_range`, {
      status: 200,
      body: JSON.stringify({
        status: 'success',
        data: { resultType: 'matrix', result: [{ metric: { namespace: 'shop' }, values }] },
      }),
    })
    await page.getByRole('combobox', { name: 'Series shown' }).selectOption('3')
    await page
      .getByRole('group', { name: 'Time range' })
      .getByRole('button', { name: '6h' })
      .click()
    const ranked = table(page, 'namespaces')
    await expect(ranked).toContainText('data')
    // Nothing adds up to anything, so nobody has a share.
    await expect(ranked.getByRole('row').nth(1)).toContainText('0%')
  })

  test('the ranking or the chart fail, then recover', async ({ page, clusters }) => {
    const clear = clusters.demo.fail(`${METRICS}/api/v1/query`, {
      status: 503,
      body: JSON.stringify({
        status: 'error',
        errorType: 'unavailable',
        error: 'too many queries',
      }),
    })
    await page
      .getByRole('group', { name: 'Time range' })
      .getByRole('button', { name: '15m' })
      .click()
    await expect(page.getByRole('alert')).toContainText('too many queries')
    clear()
    await page.getByRole('alert').getByRole('button', { name: 'Try again' }).click()
    await expect(chartOf(page, 'CPU by namespace')).toBeVisible()

    const broken = clusters.demo.fail(`${METRICS}/api/v1/query_range`, {
      status: 500,
      body: JSON.stringify({ status: 'error', errorType: 'internal', error: 'storage is busy' }),
    })
    await page
      .getByRole('group', { name: 'Time range' })
      .getByRole('button', { name: '6h' })
      .click()
    await expect(chartOf(page, 'CPU by namespace').getByRole('alert')).toContainText(
      'storage is busy',
    )
    broken()
    await chartOf(page, 'CPU by namespace').getByRole('button', { name: 'Try again' }).click()
    await expect(plot(chartOf(page, 'CPU by namespace'))).toBeVisible()
  })

  test('no samples at all', async ({ page, clusters }) => {
    clusters.demo.fail(`${METRICS}/api/v1/query`, {
      status: 200,
      body: JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } }),
    })
    await page
      .getByRole('group', { name: 'Time range' })
      .getByRole('button', { name: '24h' })
      .click()
    await expect(page.getByText('Prometheus has no CPU samples for this time.')).toBeVisible()
    await page
      .getByRole('group', { name: 'Metric' })
      .getByRole('button', { name: 'Restarts' })
      .click()
    await expect(page.getByText('Nothing restarted in this time.')).toBeVisible()
  })
})

test('without pods or nodes to look at, workloads are named by their pods', async ({
  page,
  clusters,
}) => {
  clusters.demo.fail('/api/v1/pods', { status: 403, body: '{"kind":"Status","message":"no"}' })
  clusters.demo.fail('/api/v1/nodes', { status: 403, body: '{"kind":"Status","message":"no"}' })
  await openCluster(page)
  await openMetrics(page)
  // Without nodes there's no allocatable capacity to compare with.
  await expect(page.getByText('Busiest namespace')).toBeVisible()
  await page.getByRole('combobox', { name: 'Group by' }).selectOption('workload')
  const workloads = table(page, 'workloads')
  await expect(workloads.getByRole('button', { name: 'storefront' })).toBeDisabled()
  await expect(workloads.getByRole('button', { name: 'storefront' })).toHaveAttribute(
    'title',
    'storefront has no running pods to open',
  )
})

test('looking for Prometheus takes a moment', async ({ page, clusters }) => {
  clusters.demo.fail('/api/v1/services', { hang: true })
  await openCluster(page)
  await openMetrics(page)
  await expect(page.getByText('Looking for Prometheus…')).toBeVisible()
})

test('the main process checks what it is asked', async ({ page }) => {
  await openCluster(page)
  const now = Date.now()
  const bad = await page.evaluate(
    async ([now]) => {
      const { usage, app } = window.kubestacks
      const query = { id: 'q', expr: 'up' }
      const results = await Promise.all([
        usage.source(''),
        usage.test('demo', null as never),
        usage.test('demo', { namespace: 'a', service: 'b', port: 'c', path: 5 } as never),
        usage.range(null as never),
        usage.range({ context: 'demo', queries: [], start: 0, end: 1000, step: 1000 }),
        usage.range({ context: 'demo', queries: 'up' as never, start: 0, end: 1000, step: 1000 }),
        usage.range({
          context: 'demo',
          queries: Array(17).fill(query),
          start: 0,
          end: 1000,
          step: 1000,
        }),
        usage.range({
          context: 'demo',
          queries: [{ id: '', expr: 'up' }],
          start: 0,
          end: 1000,
          step: 1000,
        }),
        usage.range({
          context: 'demo',
          queries: [{ id: 'q', expr: 'x'.repeat(4001) }],
          start: 0,
          end: 1000,
          step: 1000,
        }),
        usage.range({ context: 'demo', queries: [query], start: 1000, end: 1000, step: 1000 }),
        usage.range({ context: 'demo', queries: [query], start: 0, end: 1000, step: 10 }),
        usage.range({ context: 'demo', queries: [query], start: 0, end: 20_000_000, step: 1000 }),
        usage.instant({ context: 'demo', queries: [query], time: -1 }),
        usage.instant({ context: 'sandbox', queries: [query], time: now! }),
        usage.range({
          context: 'sandbox',
          queries: [query],
          start: now! - 60_000,
          end: now!,
          step: 15_000,
        }),
      ])
      const setting = await app.setMetricsSource('demo', { mode: 'service' } as never).then(
        () => 'saved',
        (error: Error) => error.message,
      )
      return { results: results.map((r) => (r.ok ? 'ok' : r.error.message)), setting }
    },
    [now],
  )
  expect(bad.results).toEqual([
    'context must be a non-empty string',
    'service must be an object',
    'path must be empty or start with / (like /select/0/prometheus)',
    'Expected a query object',
    'queries must be a list of 1 to 16',
    'queries must be a list of 1 to 16',
    'queries must be a list of 1 to 16',
    'id must be a non-empty string',
    'expr must be at most 4000 characters',
    'end must be an integer between 1001 and 9007199254740991',
    'step must be an integer between 1000 and 86400000',
    'A range can have at most 11000 steps',
    'time must be an integer between 0 and 9007199254740991',
    'sandbox has no metrics history to query.',
    'sandbox has no metrics history to query.',
  ])
  expect(bad.setting).toContain('Expected a context name and a metrics source')
  // A query Prometheus can't parse says why.
  const parse = await page.evaluate(
    (now) =>
      window.kubestacks.usage.instant({
        context: 'demo',
        queries: [{ id: 'q', expr: 'nonsense(' }],
        time: now,
      }),
    now,
  )
  expect(parse).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('parse error') },
  })
})

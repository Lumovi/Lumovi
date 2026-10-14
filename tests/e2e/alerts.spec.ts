/**
 * The Alerts page: the alerts the cluster's Prometheus holds, read through the cluster as the
 * person, from the source the Metrics page uses. Drawn from the demo cluster's monitoring stack:
 * an incident in shop, a claim filling up in data, and Watchdog, which always fires.
 */
import type { Page } from '@playwright/test'
import { CONTEXTS, expect, goTo, openCluster, test } from './fixtures.ts'

const RULES = '/api/v1/namespaces/monitoring/services/prometheus:web/proxy/api/v1/rules'
const grid = (page: Page) => page.getByRole('grid', { name: 'Alerts' })
const place = (page: Page) => page.getByRole('main')

async function openAlerts(page: Page) {
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'Alerts' })
    .click()
  await expect(page.getByRole('heading', { name: 'Alerts', level: 1 })).toBeVisible()
}

/** An answer of Prometheus's alerting rules: the rules given, each with the alerts given. */
const rules = (
  list: {
    name: string
    severity: string
    alerts?: { state: string; labels?: object }[]
    runbook?: string
  }[],
) =>
  JSON.stringify({
    status: 'success',
    data: {
      groups: [
        {
          name: 'general.rules',
          rules: list.map((rule) => ({
            name: rule.name,
            type: 'alerting',
            duration: 0,
            labels: { severity: rule.severity },
            annotations: {},
            alerts: (rule.alerts ?? []).map((alert) => ({
              labels: { alertname: rule.name, severity: rule.severity, ...alert.labels },
              annotations: rule.runbook ? { runbook_url: rule.runbook } : {},
              state: alert.state,
              activeAt: new Date(Date.now() - 60_000).toISOString(),
              value: '1e+00',
            })),
          })),
        },
      ],
    },
  })

test('the alerts Prometheus holds: worst first, each with its state and object, filtered and opened', async ({
  page,
}) => {
  await openCluster(page)
  await openAlerts(page)
  // Where they come from, and how many: none of severity none counted, firing or quiet.
  await expect(place(page)).toContainText(
    'From prometheus in monitoring, the Metrics page’s source · 31 alerting rules',
  )
  await expect(place(page)).toContainText('4 firing · 24 quiet')
  // Worst first, firing before pending, then the oldest.
  await expect(grid(page).getByRole('row').locator('[role=gridcell]:first-child')).toHaveText([
    /^KubePersistentVolumeFillingUp/,
    /^KubePodCrashLooping/,
    /^KubePodCrashLooping/,
    /^KubeContainerWaiting/,
    /^KubeDeploymentReplicasMismatch/,
    /^CPUThrottlingHigh/,
    /^Watchdog/,
  ])
  const row = (name: RegExp) => grid(page).getByRole('row').filter({ hasText: name })
  // Firing for how long; pending, when it fires if it holds; the object its labels name.
  await expect(row(/^KubePersistentVolumeFillingUp/)).toContainText(/Critical\s*Firing\s*for \d+m/)
  await expect(row(/^KubeContainerWaiting/)).toContainText(/Pending\s*fires in \d+m/)
  await expect(row(/^KubeContainerWaiting/)).toContainText('Pod shop/recommendations-')
  await expect(row(/^KubePersistentVolumeFillingUp/)).toContainText(
    'PersistentVolumeClaim data/data-redis-0',
  )
  await expect(row(/^Watchdog/)).toContainText('—')
  // The chips say how many each would show, and show those.
  const bar = page.getByRole('main')
  await expect(bar.getByRole('button', { name: /^Critical\s*1$/ })).toBeVisible()
  await expect(bar.getByRole('button', { name: /^Warning\s*4$/ })).toBeVisible()
  await expect(bar.getByRole('button', { name: /^Pending\s*2$/ })).toBeVisible()
  await bar.getByRole('button', { name: /^Pending/ }).click()
  await expect(grid(page).getByRole('row')).toHaveCount(3)
  await bar.getByRole('button', { name: /^Pending/ }).click()
  // The filter matches names, summaries and labels' values.
  await page.getByPlaceholder('Filter alerts').fill('data-redis')
  await expect(grid(page).getByRole('row')).toHaveCount(2)
  await page.getByPlaceholder('Filter alerts').fill('nothing like it')
  await expect(place(page)).toContainText('No alerts match.')
  await page.getByPlaceholder('Filter alerts').fill('')

  // Opened: what it says, its object, every label, its rule and its runbook.
  await row(/^KubePodCrashLooping/)
    .first()
    .click()
  const panel = page.getByRole('complementary', { name: /^Alert KubePodCrashLooping/ })
  await expect(panel).toContainText(/Alert · active \d+m, firing \d+m · since/)
  await expect(panel).toContainText('Pod is crash looping.')
  await expect(panel).toContainText('(reason: "CrashLoopBackOff")')
  await expect(panel).toContainText('alertname=KubePodCrashLooping')
  await expect(panel).toContainText('severity=warning')
  await expect(panel).toContainText('15m pending before it fires')
  await expect(panel).toContainText('kubernetes-apps')
  // Its runbook says where it goes before it's opened: the host beside its last part.
  await expect(
    panel.getByRole('button', {
      name: 'runbooks.prometheus-operator.dev › kubepodcrashlooping',
    }),
  ).toBeVisible()
  // Its object opens in its place.
  await panel.getByRole('button', { name: /^Pod shop\/checkout-/ }).click()
  await expect(page.getByRole('complementary', { name: /^Pod checkout-/ })).toBeVisible()
  await expect(panel).toHaveCount(0)

  // The header's namespaces: one with no namespace only under all of them.
  await page.getByRole('button', { name: 'Namespace' }).first().click()
  await page.getByRole('option', { name: 'shop', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(grid(page).getByRole('row').locator('[role=gridcell]:first-child')).toHaveText([
    /^KubePodCrashLooping/,
    /^KubePodCrashLooping/,
    /^KubeContainerWaiting/,
    /^KubeDeploymentReplicasMismatch/,
    /^CPUThrottlingHigh/,
  ])
})

test('alerts are a g z, the palette and a link away; the Overview’s Warnings say how many fire', async ({
  page,
}) => {
  await openCluster(page)
  // The Overview: the demo's warnings, and its four alerts firing, the worst level of the two.
  const warnings = page.getByRole('region', { name: 'Warnings', exact: true })
  await expect(warnings).toContainText('4 alerts firing')
  await warnings.getByRole('button', { name: '4 alerts firing' }).click()
  await expect(page.getByRole('heading', { name: 'Alerts', level: 1 })).toBeVisible()
  await goTo(page, 'Pods')
  await page.keyboard.press('g')
  await page.keyboard.press('z')
  await expect(page.getByRole('heading', { name: 'Alerts', level: 1 })).toBeVisible()
  await goTo(page, 'Pods')
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: /^Alerts/ }).click()
  await expect(page.getByRole('heading', { name: 'Alerts', level: 1 })).toBeVisible()
})

test('a cluster with no Prometheus says so, and where to choose one', async ({ page }) => {
  await openCluster(page, CONTEXTS.sandbox)
  await openAlerts(page)
  await expect(place(page)).toContainText('Lumovi found no Prometheus in this cluster.')
  await expect(place(page).getByRole('button', { name: 'Metrics source…' })).toBeVisible()
})

test('what the page says where nothing fires, there are no rules, or the alerts can’t be read', async ({
  page,
  clusters,
}) => {
  // Rules, none firing but Watchdog's kind, which fire on purpose.
  const clear = clusters.demo.fail(RULES, {
    status: 200,
    body: rules([
      { name: 'Watchdog', severity: 'none', alerts: [{ state: 'firing' }] },
      { name: 'KubeNodeNotReady', severity: 'warning' },
      { name: 'KubeletDown', severity: 'critical' },
    ]),
    contentType: 'application/json',
  })
  await openCluster(page)
  await openAlerts(page)
  await expect(place(page)).toContainText('No alerts are firing. 2 alerting rules are quiet.')
  await expect(place(page)).toContainText(
    'Not counted: 1 with severity none, like Watchdog, which fire all the time on purpose.',
  )
  await place(page).getByRole('button', { name: 'Show None' }).click()
  await expect(grid(page).getByRole('row')).toHaveCount(2)
  clear()

  // No alerting rules at all.
  const none = clusters.demo.fail(RULES, {
    status: 200,
    body: rules([]),
    contentType: 'application/json',
  })
  await page.getByRole('button', { name: /^Refresh/ }).click()
  await expect(place(page)).toContainText('Prometheus has no alerting rules, so nothing can fire.')
  none()

  // An answer that isn't alerts, and one the cluster refuses, each in their words.
  const odd = clusters.demo.fail(RULES, { status: 502, body: 'Bad Gateway' })
  await page.getByRole('button', { name: /^Refresh/ }).click()
  await expect(place(page)).toContainText('Prometheus answered, but not with alerts:')
  odd()
  clusters.demo.deny({ verb: 'get', resource: 'services', subresource: 'proxy' })
  await page.getByRole('button', { name: /^Refresh/ }).click()
  await expect(place(page)).toContainText('Lumovi couldn’t read Prometheus’s alerts:')
  await expect(place(page)).toContainText('forbidden')
})

test('a rule’s runbook says where it goes, and is offered only where Lumovi would open it', async ({
  page,
  clusters,
}) => {
  clusters.demo.fail(RULES, {
    status: 200,
    contentType: 'application/json',
    body: rules([
      {
        name: 'NodeDown',
        severity: 'critical',
        alerts: [{ state: 'firing', labels: { node: 'worker-3' } }],
        runbook: 'https://elsewhere.example/runbooks/node-down',
      },
      {
        name: 'DiskFull',
        severity: 'warning',
        alerts: [{ state: 'firing', labels: { node: 'worker-2' } }],
        runbook: 'http://wiki.internal/disk-full',
      },
    ]),
  })
  await openCluster(page)
  await openAlerts(page)
  // Its host beside its last part, before it's opened; and a rule that waits for nothing.
  await grid(page)
    .getByRole('row')
    .filter({ hasText: /^NodeDown/ })
    .click()
  const node = page.getByRole('complementary', { name: /^Alert NodeDown/ })
  await expect(node.getByRole('button', { name: 'elsewhere.example › node-down' })).toBeVisible()
  await expect(node).toContainText('Fires at once')
  // One Lumovi wouldn't open (plain http): its text, nothing to press.
  await grid(page)
    .getByRole('row')
    .filter({ hasText: /^DiskFull/ })
    .click()
  const disk = page.getByRole('complementary', { name: /^Alert DiskFull/ })
  await expect(disk).toContainText('http://wiki.internal/disk-full')
  await expect(disk.getByRole('button', { name: /disk-full/ })).toHaveCount(0)
})

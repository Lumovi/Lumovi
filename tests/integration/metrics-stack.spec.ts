/**
 * Lumovi's metrics stack on a real cluster, installed by real helm from the chart Lumovi
 * ships: where there's no Prometheus, one reviewed install gives the Metrics page and the
 * objects' charts their history; its accounts read no more than they're said to; and removing
 * it leaves nothing in the cluster, in any namespace or outside them.
 *
 * The cluster's own Prometheus is taken away while this runs, and put back after.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { METRICS_STACK } from '../../src/shared/metrics-stack.ts'
import { open, toasts } from '../e2e/action-helpers.ts'
import { openCluster } from '../e2e/fixtures.ts'
import { installPrometheus } from './cluster.ts'
import { expect, freshNamespace, get, inNamespace, kubectl, KUBECONFIG, test } from './fixtures.ts'
import { web } from './workloads.ts'

const { namespace: NAMESPACE, release: RELEASE } = METRICS_STACK
const NS = 'it-stack'
const SERVICE = `${RELEASE}-prometheus-server`
const VIEWER = 'kind-stack-viewer'
/** What Lumovi reads, and so all that's kept: anything else would be more than was said. */
const SERIES = [
  'container_cpu_cfs_periods_total',
  'container_cpu_cfs_throttled_periods_total',
  'container_cpu_usage_seconds_total',
  'container_memory_working_set_bytes',
  'container_network_receive_bytes_total',
  'container_network_transmit_bytes_total',
  'kube_pod_container_status_restarts_total',
  'kube_pod_info',
]
let viewer: string

/** Every object outside namespaces, and every namespace: `kind/name`, as the cluster lists them. */
function clusterWide(): string[] {
  const kinds = kubectl(['api-resources', '--namespaced=false', '--verbs=list', '-o', 'name'])
    .split('\n')
    // Reviews and their like aren't kept; nodes' own leases and requests come and go.
    .filter((kind) => kind && !/review|certificatesigningrequests|componentstatuses/.test(kind))
  return kinds
    .flatMap((kind) => kubectl(['get', kind, '-o', 'name', '--ignore-not-found']).split('\n'))
    .filter(Boolean)
    .sort()
}

/** Everything in a namespace, of every kind that's listed: none, once it's gone. */
function inNamespaceOf(namespace: string): string[] {
  const kinds = kubectl(['api-resources', '--namespaced=true', '--verbs=list', '-o', 'name'])
    .split('\n')
    .filter((kind) => kind && !/review|^events/.test(kind))
  return kubectl(['get', kinds.join(','), '-n', namespace, '-o', 'name', '--ignore-not-found'])
    .split('\n')
    .filter(Boolean)
}

const canI = (account: string, ...what: string[]) => {
  try {
    return kubectl([
      'auth',
      'can-i',
      ...what,
      `--as=system:serviceaccount:${NAMESPACE}:${account}`,
    ]).trim()
  } catch (error) {
    // "no" comes with a failing exit code.
    return (error as { stdout: string }).stdout.trim()
  }
}

/** A PromQL query's result, asked of the stack's Prometheus through the API server. */
function query(expr: string): { metric: Record<string, string> }[] {
  const path = `/api/v1/namespaces/${NAMESPACE}/services/${SERVICE}:http/proxy/api/v1/query?query=${encodeURIComponent(expr)}`
  return JSON.parse(kubectl(['get', '--raw', path])).data.result
}

async function openMetrics(page: Page) {
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'Metrics' })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Metrics')
}

test.beforeAll(() => {
  test.setTimeout(600_000)
  // No Prometheus, and nothing of an earlier run's.
  execFileSync(
    'helm',
    ['uninstall', 'kps', '-n', 'monitoring', '--ignore-not-found', '--wait', '--timeout', '5m'],
    { env: { ...process.env, KUBECONFIG }, stdio: 'inherit' },
  )
  try {
    execFileSync('helm', ['uninstall', RELEASE, '-n', NAMESPACE, '--ignore-not-found', '--wait'], {
      env: { ...process.env, KUBECONFIG },
      stdio: 'inherit',
    })
  } catch {
    // No such namespace: nothing to uninstall.
  }
  kubectl(['delete', 'namespace', NAMESPACE, '--ignore-not-found', '--wait', '--timeout=180s'])
  freshNamespace(NS, [web(2)])
  // The same cluster, as an account that may only look.
  kubectl(['create', 'serviceaccount', 'viewer', '-n', NS])
  kubectl(['delete', 'clusterrolebinding', 'it-stack-viewer', '--ignore-not-found'])
  kubectl([
    'create',
    'clusterrolebinding',
    'it-stack-viewer',
    '--clusterrole=view',
    `--serviceaccount=${NS}:viewer`,
  ])
  const token = kubectl(['create', 'token', 'viewer', '-n', NS, '--duration=2h']).trim()
  const admin = JSON.parse(kubectl(['config', 'view', '--raw', '--minify', '-o', 'json']))
  const cluster = admin.clusters[0]
  viewer = join(mkdtempSync(join(tmpdir(), 'lumovi-stack-viewer-')), 'config')
  writeFileSync(
    viewer,
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [cluster],
      users: [{ name: 'viewer', user: { token } }],
      contexts: [{ name: VIEWER, context: { cluster: cluster.name, user: 'viewer' } }],
      'current-context': VIEWER,
    }),
  )
})

test.afterAll(() => {
  test.setTimeout(900_000)
  kubectl(['delete', 'clusterrolebinding', 'it-stack-viewer', '--ignore-not-found'])
  installPrometheus()
})

test('an account that may only look is told what installing takes, and nothing is made', async ({
  launch,
}) => {
  const { page } = await launch({ kubeconfig: viewer })
  await openCluster(page, VIEWER)
  await openMetrics(page)
  await expect(page.getByText('No Prometheus found')).toBeVisible()
  await page.getByRole('button', { name: 'Install a metrics stack…' }).click()
  const dialog = page.getByRole('dialog', { name: /Install a metrics stack/ })
  await expect(dialog.getByRole('alert')).toContainText(
    'The cluster doesn’t let you create namespaces, cluster roles, cluster role bindings, deployments, services, service accounts, config maps and secrets, which installing it takes.',
  )
  await expect(dialog.getByRole('button', { name: 'Review' })).toBeDisabled()
  const refused = await page.evaluate(
    (context) => window.lumovi!.metricsStack.install({ context }),
    VIEWER,
  )
  expect(refused).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(kubectl(['get', 'namespace', NAMESPACE, '--ignore-not-found', '-o', 'name'])).toBe('')
})

test('one reviewed install charts the cluster; removing it leaves nothing', async ({ page }) => {
  test.setTimeout(900_000)
  const before = clusterWide()
  await openMetrics(page)
  await expect(page.getByText('No Prometheus found')).toBeVisible()
  await page.getByRole('button', { name: 'Install a metrics stack…' }).click()
  const dialog = page.getByRole('dialog', { name: /Install a metrics stack/ })

  // The review asks the cluster, and makes nothing.
  await dialog.getByRole('button', { name: 'Review' }).click()
  await expect(dialog).toContainText('The cluster accepts it · 12 objects', { timeout: 60_000 })
  expect(clusterWide()).toEqual(before)
  await dialog.getByRole('button', { name: 'Install' }).click()
  await expect(toasts(page)).toContainText('Installed the metrics stack', { timeout: 120_000 })
  await expect(page.getByText('The metrics stack is starting…')).toBeVisible()

  // Its images pulled and its Prometheus up, history is found without being looked for.
  await expect(
    page.getByRole('button', { name: new RegExp(`^Prometheus [\\d.]+ ${NAMESPACE}/${SERVICE}$`) }),
  ).toBeVisible({ timeout: 420_000 })
  expect(get('namespace', NAMESPACE).metadata.labels).toMatchObject({
    'app.kubernetes.io/managed-by': 'lumovi',
  })
  // The images it said, by their digests.
  const images = get('pods', '-n', NAMESPACE).items.flatMap(
    (pod: { spec: { containers: { image: string }[] } }) => pod.spec.containers.map((c) => c.image),
  )
  expect(images.sort()).toEqual([
    expect.stringMatching(/^quay\.io\/prometheus\/prometheus@sha256:[0-9a-f]{64}$/),
    expect.stringMatching(
      /^registry\.k8s\.io\/kube-state-metrics\/kube-state-metrics:v[\d.]+@sha256:[0-9a-f]{64}$/,
    ),
  ])

  // CPU, memory and network history, on the Metrics page and on a pod's own tab.
  const metric = page.getByRole('group', { name: 'Metric' })
  await page.getByRole('combobox', { name: 'Group by' }).selectOption('pod')
  const pod = get('pods', '-n', NS, '-l', 'app=web').items[0].metadata.name
  await expect(page.getByRole('region', { name: 'Ranked pods' })).toContainText(pod, {
    timeout: 240_000,
  })
  for (const name of ['CPU', 'Memory', 'Network in', 'Network out']) {
    await metric.getByRole('button', { name }).click()
    await expect(page.getByRole('region', { name: 'Ranked pods' }), name).toContainText(pod, {
      timeout: 120_000,
    })
    await expect(page.getByRole('alert'), name).toHaveCount(0)
  }
  // By node too: its series carry no node, so kube-state-metrics says where each pod runs.
  await metric.getByRole('button', { name: 'CPU' }).click()
  await page.getByRole('combobox', { name: 'Group by' }).selectOption('node')
  await expect(page.getByRole('region', { name: 'Ranked nodes' })).toContainText('lumovi-worker', {
    timeout: 120_000,
  })
  await inNamespace(page, NS)
  await open(page, 'Pods', 'web-')
  const panel = page.getByRole('complementary', { name: /^Pod web-/ })
  await panel.getByRole('tab', { name: 'Metrics' }).click()
  await expect(panel.getByRole('region', { name: 'CPU', exact: true })).toContainText(/Now \d/, {
    timeout: 120_000,
  })
  await expect(panel.getByRole('region', { name: 'Memory', exact: true })).toContainText(/Now \d/)
  await expect(panel.getByRole('region', { name: 'Network', exact: true })).toContainText(
    'Received',
  )

  // It keeps what Lumovi reads and no more, and its accounts read what was said and no more.
  const kept = query('count by (__name__) ({__name__=~".+"})').map((s) => s.metric.__name__)
  expect(kept.filter((name) => !/^(up|scrape_)/.test(name!)).sort()).toEqual(SERIES)
  expect(canI(`${RELEASE}-kube-state-metrics`, 'list', 'pods', '-A')).toBe('yes')
  expect(canI(`${RELEASE}-prometheus-server`, 'get', 'nodes/metrics')).toBe('yes')
  for (const account of [`${RELEASE}-kube-state-metrics`, `${RELEASE}-prometheus-server`]) {
    for (const what of ['secrets', 'configmaps', 'services']) {
      expect(canI(account, 'list', what, '-A'), `${account} lists ${what}`).toBe('no')
    }
    expect(canI(account, 'create', 'pods', '-n', NS), `${account} creates pods`).toBe('no')
  }

  // Removed, from where the source is set: nothing in its namespace, nor outside namespaces.
  await page.keyboard.press('Escape')
  await openMetrics(page)
  await page
    .getByRole('button', { name: new RegExp(`^Prometheus [\\d.]+ ${NAMESPACE}/${SERVICE}$`) })
    .click()
  const settings = page.getByRole('dialog', { name: /Metrics source/ })
  await settings
    .getByRole('region', { name: 'Lumovi’s metrics stack' })
    .getByRole('button', { name: 'Remove…' })
    .click()
  const removing = page.getByRole('dialog', { name: /Remove the metrics stack/ })
  await removing.getByRole('textbox').fill(NAMESPACE)
  await removing.getByRole('button', { name: 'Remove' }).click()
  await expect(toasts(page)).toContainText('Removed the metrics stack', { timeout: 180_000 })
  await expect(page.getByText('No Prometheus found')).toBeVisible()
  expect(kubectl(['get', 'namespace', NAMESPACE, '--ignore-not-found', '-o', 'name'])).toBe('')
  expect(inNamespaceOf(NAMESPACE)).toEqual([])
  expect(clusterWide()).toEqual(before)
  expect(clusterWide().filter((name) => name.includes(RELEASE))).toEqual([])
})

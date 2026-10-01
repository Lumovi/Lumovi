import type { Page } from '@playwright/test'
import { demoCluster } from '../mock-cluster/fixtures/demo.ts'
import {
  panel,
  clipboardText,
  DEMO,
  goTo,
  openCluster,
  row,
  rows,
  test,
  expect,
} from './fixtures.ts'

/** Narrows the (virtualized) list so the row is rendered. */
async function findObject(page: Page, label: string, name: string) {
  await goTo(page, label)
  await page.getByPlaceholder(`Filter ${label.toLowerCase()}`).fill(name)
}

async function openRow(page: Page, label: string, name: string) {
  // Click the first cell: the middle of an event row holds a link to the involved object.
  await row(page, label, name).first().getByRole('gridcell').nth(1).click()
}

async function openObject(page: Page, label: string, name: string) {
  await findObject(page, label, name)
  await openRow(page, label, name)
}

test.beforeEach(async ({ page }) => {
  await openCluster(page)
})

test('pod overview shows containers, usage and links', async ({ page }) => {
  const pod = DEMO.pods.storefront[0]!
  await openObject(page, 'Pods', pod)
  const detail = panel(page, 'Pod', pod)
  const migrate = detail.getByRole('article', { name: 'Container migrate' })
  await expect(migrate).toContainText('init')
  await expect(migrate).toContainText('Completed (exit code 0)')
  const app = detail.getByRole('article', { name: 'Container app' })
  await expect(app).toContainText(/Running for \d+/)
  await expect(app).toContainText('req 250m')
  await expect(app).toContainText('MiB')
  await expect(detail.getByRole('article', { name: 'Container envoy' })).toBeVisible()
  await expect(detail).toContainText('Conditions')
  await expect(detail).toContainText('Annotations')

  await detail.getByRole('button', { name: /^Node\// }).click()
  await expect(page.getByRole('complementary', { name: /^Node / })).toBeVisible()
})

test('pod containers explain failures', async ({ page }) => {
  const crashing = DEMO.pods.checkout[0]!
  await openObject(page, 'Pods', crashing)
  const app = panel(page, 'Pod', crashing).getByRole('article', { name: 'Container app' })
  await expect(app).toContainText('CrashLoopBackOff')
  await expect(app).toContainText('back-off')
  await expect(app).toContainText('Last terminated: Error (exit code 1)')

  await panel(page, 'Pod', crashing)
    .getByRole('button', { name: /^ReplicaSet\// })
    .click()
  await expect(panel(page, 'ReplicaSet', DEMO.replicaSets.checkout)).toBeVisible()
  await panel(page, 'ReplicaSet', DEMO.replicaSets.checkout)
    .getByRole('button', { name: /^Deployment\// })
    .click()
  await expect(panel(page, 'Deployment', DEMO.deployments.checkout)).toBeVisible()
})

test('pending and failed pods', async ({ page }) => {
  await openObject(page, 'Pods', 'redis-1')
  const redis = panel(page, 'Pod', 'redis-1')
  await expect(redis.getByRole('article', { name: /^Container / }).first()).toContainText(
    'Not started',
  )
  await expect(redis).toContainText('Insufficient memory')

  await openObject(page, 'Pods', DEMO.pods.dbMigrate[0]!)
  await expect(
    panel(page, 'Pod', DEMO.pods.dbMigrate[0]!).getByRole('article').first(),
  ).toContainText('exit code 2')

  await openObject(page, 'Pods', DEMO.pods.recommendations[0]!)
  await expect(
    panel(page, 'Pod', DEMO.pods.recommendations[0]!).getByRole('article').first(),
  ).toContainText('ImagePullBackOff')
})

test('logs: container, lines, previous, follow, wrap and copy', async ({
  page,
  kubestacks,
  clusters,
}) => {
  const pod = DEMO.pods.checkout[0]!
  const logRequest = (check: (query: Record<string, string>) => boolean) => () =>
    clusters.demo.requests.some((r) => r.path.endsWith(`/pods/${pod}/log`) && check(r.query))
  await openObject(page, 'Pods', pod)
  const detail = panel(page, 'Pod', pod)
  await detail.getByRole('tab', { name: 'Logs' }).click()
  const log = detail.getByRole('log', { name: 'Logs for app' })
  await expect(log).toContainText('starting checkout service')
  await expect(log.locator('[data-level="error"]').first()).toContainText(
    'payments client not initialised',
  )
  await expect(log.locator('[data-level="error"]').last()).toContainText('panic:')
  await expect(log.locator('[data-level="warn"]').first()).toContainText(
    'database connection failed',
  )
  await expect(log.locator('[data-level="info"]').first()).toContainText(
    'starting checkout service',
  )

  await detail.getByRole('button', { name: 'Previous container' }).click()
  await expect(detail.getByRole('button', { name: 'Previous container' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect.poll(logRequest((q) => q.previous === 'true')).toBe(true)
  await expect(log).toContainText('panic:')

  await detail.getByRole('combobox', { name: 'Show' }).selectOption('100')
  await expect.poll(logRequest((q) => q.tailLines === '100')).toBe(true)
  await detail.getByRole('button', { name: 'Follow' }).click()
  await expect(detail.getByRole('button', { name: 'Follow' })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await detail.getByRole('button', { name: 'Wrap lines' }).click()
  await expect(log.locator('.whitespace-pre-wrap').first()).toBeVisible()

  await detail.getByRole('button', { name: 'Copy logs' }).click()
  await expect.poll(() => clipboardText(kubestacks.page)).toContain('starting checkout service')
  await expect(detail.getByRole('button', { name: 'Copied' })).toBeVisible()
  await expect(detail.getByRole('button', { name: 'Copy logs' })).toBeVisible({ timeout: 5_000 })
})

test('logs: init containers, empty output and errors', async ({ page }) => {
  const pod = DEMO.pods.storefront[1]!
  await openObject(page, 'Pods', pod)
  const detail = panel(page, 'Pod', pod)
  await detail.getByRole('tab', { name: 'Logs' }).click()
  await detail.getByRole('combobox', { name: 'Container' }).selectOption('migrate')
  await expect(detail.getByRole('log', { name: 'Logs for migrate' })).toContainText(
    'schema is up to date',
  )

  await detail.getByRole('button', { name: 'Previous container' }).click()
  await expect(detail.getByRole('alert')).toContainText('previous terminated container')

  await openObject(page, 'Pods', DEMO.pods.debugShell)
  const shell = panel(page, 'Pod', DEMO.pods.debugShell)
  await shell.getByRole('tab', { name: 'Logs' }).click()
  await expect(shell.getByRole('heading', { name: 'No output' })).toBeVisible()
})

test('events tab lists what happened to an object', async ({ page }) => {
  const pod = DEMO.pods.checkout[0]!
  await openObject(page, 'Pods', pod)
  const detail = panel(page, 'Pod', pod)
  await detail.getByRole('tab', { name: 'Events' }).click()
  const events = detail.getByRole('list', { name: 'Events' })
  await expect(events).toContainText('BackOff')
  await expect(events).toContainText(/×\d+/)
  await expect(events).toContainText('kubelet')

  await openObject(page, 'ConfigMaps', 'storefront-config')
  const config = panel(page, 'ConfigMap', 'storefront-config')
  await config.getByRole('tab', { name: 'Events' }).click()
  await expect(config.getByRole('heading', { name: 'No recent events' })).toBeVisible()

  await openObject(page, 'Nodes', DEMO.nodes.worker3)
  const node = panel(page, 'Node', DEMO.nodes.worker3)
  await node.getByRole('tab', { name: 'Events' }).click()
  await expect(node.getByRole('list', { name: 'Events' })).toContainText('NodeNotReady')
})

test('secrets stay hidden until revealed', async ({ page, kubestacks }) => {
  const name = DEMO.secrets.postgresCredentials
  await openObject(page, 'Secrets', name)
  const detail = panel(page, 'Secret', name)
  await expect(detail).toContainText('Hidden: it holds the secret’s values')
  await expect(detail).not.toContainText(DEMO.postgresPassword)
  await detail.getByRole('button', { name: 'Reveal password' }).click()
  await expect(detail).toContainText(DEMO.postgresPassword)
  await detail.getByRole('button', { name: 'Hide password' }).click()
  await expect(detail).not.toContainText(DEMO.postgresPassword)
  await detail.getByRole('button', { name: 'Copy password' }).click()
  await expect.poll(() => clipboardText(kubestacks.page)).toBe(DEMO.postgresPassword)

  await detail.getByRole('tab', { name: 'YAML' }).click()
  const yaml = detail.getByRole('tabpanel', { name: 'YAML' })
  await expect(yaml).toContainText('password: ••••••••')
  // `kubectl apply` kept the values in an annotation: hidden too.
  await expect(yaml).toContainText('kubectl.kubernetes.io/last-applied-configuration: ••••••••')
  await expect(yaml).not.toContainText(DEMO.postgresPassword)
  await detail.getByRole('button', { name: 'Reveal values' }).click()
  await expect(yaml).toContainText(
    `password: ${Buffer.from(DEMO.postgresPassword).toString('base64')}`,
  )
  await expect(yaml).toContainText(`"password":"${DEMO.postgresPassword}"`)
  await detail.getByRole('button', { name: 'Hide values' }).click()
  await expect(yaml).toContainText('password: ••••••••')
  await detail.getByRole('button', { name: 'Copy YAML' }).click()
  await expect.poll(() => clipboardText(kubestacks.page)).toContain('kind: Secret')
})

test('config maps show their data', async ({ page }) => {
  await openObject(page, 'ConfigMaps', 'storefront-config')
  const detail = panel(page, 'ConfigMap', 'storefront-config')
  await expect(detail.getByRole('button', { name: /^Copy / }).first()).toBeVisible()
  await expect(detail.getByRole('button', { name: /^Reveal / })).toHaveCount(0)
  await detail.getByRole('tab', { name: 'YAML' }).click()
  await expect(detail.getByRole('tabpanel', { name: 'YAML' })).toContainText('|')
})

test('workloads list their pods', async ({ page }) => {
  await openObject(page, 'Deployments', DEMO.deployments.checkout)
  const detail = panel(page, 'Deployment', DEMO.deployments.checkout)
  await detail.getByRole('tab', { name: 'Pods' }).click()
  await expect(rows(page, 'Pods')).toHaveCount(3)
  await expect(rows(page, 'Pods').first()).toContainText('CrashLoopBackOff')
  await detail.getByRole('columnheader', { name: 'Name' }).getByRole('button').click()
  await detail.getByRole('columnheader', { name: 'Name' }).getByRole('button').click()
  await expect(detail.getByRole('columnheader', { name: 'Name' })).toHaveAttribute(
    'aria-sort',
    'descending',
  )
  await rows(page, 'Pods').first().click()
  await expect(page.getByRole('complementary', { name: /^Pod checkout-/ })).toBeVisible()

  await openObject(page, 'Services', DEMO.services.storefront)
  const service = panel(page, 'Service', DEMO.services.storefront)
  await expect(service.getByRole('table')).toContainText('TCP')
  await service.getByRole('tab', { name: 'Pods' }).click()
  await expect(service.getByRole('grid', { name: 'Pods' })).toContainText('storefront-')

  // The default kubernetes Service has no selector, so it has no Pods tab.
  await page.getByRole('button', { name: 'Namespace' }).click()
  await page.getByRole('option', { name: 'default' }).click()
  await openObject(page, 'Services', DEMO.services.kubernetes)
  const kubernetes = panel(page, 'Service', DEMO.services.kubernetes)
  await expect(kubernetes.getByRole('tab', { name: 'Overview' })).toBeVisible()
  await expect(kubernetes.getByRole('tab', { name: 'Pods' })).toHaveCount(0)
})

test('a workload with no pods says so', async ({ page, clusters }) => {
  for (const name of DEMO.pods.cart) clusters.demo.remove('Pod', 'shop', name)
  await openObject(page, 'Deployments', DEMO.deployments.cart)
  const detail = panel(page, 'Deployment', DEMO.deployments.cart)
  await detail.getByRole('tab', { name: 'Pods' }).click()
  await expect(detail.getByRole('heading', { name: 'No pods' })).toBeVisible()
})

test('nodes show capacity, taints and their pods', async ({ page }) => {
  await openObject(page, 'Nodes', DEMO.nodes.worker2)
  const detail = panel(page, 'Node', DEMO.nodes.worker2)
  await expect(detail.getByRole('meter', { name: 'Memory usage' })).toHaveAttribute(
    'data-severity',
    'critical',
  )
  await expect(detail).toContainText(/\d+% · .* of /)
  await expect(detail).toContainText('Taints')
  await expect(detail).toContainText('MemoryPressure')
  await detail.getByRole('tab', { name: 'Pods' }).click()
  await expect(detail.getByRole('grid', { name: 'Pods' })).toContainText(DEMO.pods.checkout[0]!)
  // Pods on a node come from every namespace.
  await expect(detail.getByRole('grid', { name: 'Pods' })).toContainText('shop')

  await openObject(page, 'Nodes', DEMO.nodes.controlPlane)
  await expect(panel(page, 'Node', DEMO.nodes.controlPlane)).toContainText(
    'node-role.kubernetes.io/control-plane:NoSchedule',
  )
})

test('ingresses show their routing rules', async ({ page }) => {
  await openObject(page, 'Ingresses', 'storefront')
  const detail = panel(page, 'Ingress', 'storefront')
  await expect(detail.getByRole('table')).toContainText('shop.example.com')
  await expect(detail.getByRole('table')).toContainText('storefront:80')
})

test('the panel closes with Escape or the close button', async ({ page }) => {
  await openObject(page, 'Pods', DEMO.pods.debugShell)
  const detail = panel(page, 'Pod', DEMO.pods.debugShell)
  await detail.getByRole('button', { name: 'Copy name' }).click()
  await page.keyboard.press('a')
  await page.keyboard.press('Escape')
  await expect(detail).toHaveCount(0)

  await row(page, 'Pods', DEMO.pods.debugShell).click()
  await detail.getByRole('button', { name: /^Close/ }).click()
  await expect(detail).toHaveCount(0)
})

test('shows when an open object is deleted', async ({ page, clusters }) => {
  await openObject(page, 'Pods', DEMO.pods.oldTask)
  const detail = panel(page, 'Pod', DEMO.pods.oldTask)
  await expect(detail.getByRole('tab', { name: 'Overview' })).toBeVisible()
  clusters.demo.remove('Pod', 'default', DEMO.pods.oldTask)
  await page.getByRole('button', { name: /^Refresh/ }).click()
  await expect(detail.getByRole('alert')).toContainText('Not found')
})

test('tabs show errors and recover on retry', async ({ page, clusters }) => {
  const name = DEMO.deployments.storefront
  await openObject(page, 'Deployments', name)
  const detail = panel(page, 'Deployment', name)
  await expect(detail.getByRole('tab', { name: 'Overview' })).toBeVisible()
  const status = (message: string) => ({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ kind: 'Status', message }),
  })

  const clearEvents = clusters.demo.fail(
    '/api/v1/namespaces/shop/events',
    status('events unavailable'),
  )
  await detail.getByRole('tab', { name: 'Events' }).click()
  await expect(detail.getByRole('alert')).toContainText('events unavailable')
  clearEvents()
  await detail.getByRole('button', { name: 'Try again' }).click()
  await expect(detail.getByRole('list', { name: 'Events' })).toBeVisible()

  const clearPods = clusters.demo.fail('/api/v1/namespaces/shop/pods', status('pods unavailable'))
  await detail.getByRole('tab', { name: 'Pods' }).click()
  await expect(detail.getByRole('alert')).toContainText('pods unavailable')
  clearPods()
  await detail.getByRole('button', { name: 'Try again' }).click()
  await expect(detail.getByRole('grid', { name: 'Pods' })).toBeVisible()

  const clearObject = clusters.demo.fail(
    `/apis/apps/v1/namespaces/shop/deployments/${name}`,
    status('etcd timeout'),
  )
  // A failed refresh keeps what was loaded and says so.
  await page.getByRole('button', { name: /^Refresh/ }).click()
  const stale = detail.getByRole('status').filter({ hasText: 'Couldn’t refresh' })
  await expect(stale).toContainText('etcd timeout')
  await expect(detail.getByRole('tab', { name: 'Overview' })).toBeVisible()
  clearObject()
  await stale.getByRole('button', { name: 'Retry' }).click()
  await expect(stale).toHaveCount(0)

  const pod = DEMO.pods.storefront[0]!
  await openObject(page, 'Pods', pod)
  const podPanel = panel(page, 'Pod', pod)
  const clearLogs = clusters.demo.fail(
    `/api/v1/namespaces/shop/pods/${pod}/log`,
    status('kubelet unreachable'),
  )
  await podPanel.getByRole('tab', { name: 'Logs' }).click()
  await expect(podPanel.getByRole('alert')).toContainText('kubelet unreachable')
  clearLogs()
  await podPanel.getByRole('button', { name: 'Try again' }).click()
  await expect(podPanel.getByRole('log')).toBeVisible()
})

test('less common shapes of common objects', async ({ page }) => {
  await goTo(page, 'Services')
  await expect(row(page, 'Services', 'edge')).toContainText('443→8443:31443/TCP')
  await openObject(page, 'Services', 'edge')
  const edge = panel(page, 'Service', 'edge')
  await expect(edge).toContainText('k8s-shop-edge-4f1c2a.elb.eu-west-1.amazonaws.com')
  await expect(edge.getByRole('table')).toContainText('8443')

  // Check columns before opening the panel, which leaves room for fewer of them.
  await findObject(page, 'Services', 'payments-gateway')
  await expect(row(page, 'Services', 'payments-gateway')).toContainText('ExternalName')
  await openRow(page, 'Services', 'payments-gateway')
  await expect(panel(page, 'Service', 'payments-gateway')).toContainText('ExternalName')

  await findObject(page, 'Ingresses', 'status-page')
  await expect(row(page, 'Ingresses', 'status-page')).toContainText('—')
  await openRow(page, 'Ingresses', 'status-page')
  const ingress = panel(page, 'Ingress', 'status-page')
  await expect(ingress.getByRole('table')).toContainText('grafana:http')
  await expect(ingress.getByRole('table')).toContainText('*')

  await openObject(page, 'Autoscalers', 'checkout')
  await expect(panel(page, 'HorizontalPodAutoscaler', 'checkout')).toContainText('cpu ?% / 80%')

  await goTo(page, 'CronJobs')
  await expect(row(page, 'CronJobs', 'nightly-report')).toContainText('At 02:00 AM')
  // kubectl-style, so it depends on the time of day: "in 45s", "in 147m", "in 5h12m", "in 20h".
  await expect(row(page, 'CronJobs', 'nightly-report')).toContainText(/in \d+[hms]/)
  await expect(row(page, 'CronJobs', 'quarterly-audit')).toContainText('—')
  await openObject(page, 'CronJobs', 'nightly-report')
  await expect(panel(page, 'CronJob', 'nightly-report')).toContainText('No')

  await openObject(page, 'Volume Claims', 'data-postgres-0')
  await panel(page, 'PersistentVolumeClaim', 'data-postgres-0')
    .getByRole('button', { name: /^PersistentVolume\// })
    .click()
  await expect(page.getByRole('complementary', { name: /^PersistentVolume / })).toBeVisible()
  await expect(row(page, 'Volumes', 'pv-spare')).toBeHidden()
  await findObject(page, 'Volumes', 'pv-spare')
  await expect(row(page, 'Volumes', 'pv-spare')).toContainText('Available')
  await expect(row(page, 'Volumes', 'pv-spare')).toContainText('—')
  await openRow(page, 'Volumes', 'pv-spare')

  await openObject(page, 'Storage Classes', 'fast-ssd')
  const ssd = panel(page, 'StorageClass', 'fast-ssd')
  await expect(ssd).toContainText('Allowed')
  await expect(ssd).toContainText('iops=6000')

  await openObject(page, 'Secrets', 'feature-flags')
  const flags = panel(page, 'Secret', 'feature-flags')
  await expect(flags).toContainText('No data.')
  await flags.getByRole('tab', { name: 'YAML' }).click()
  await expect(flags.getByRole('tabpanel', { name: 'YAML' })).toContainText('data: {}')

  await goTo(page, 'Nodes')
  // Ages past two years read like kubectl: "2y69d".
  await expect(row(page, 'Nodes', DEMO.nodes.worker1)).toContainText(/2y\d+d/)
  await openObject(page, 'Nodes', DEMO.nodes.worker1)
  await expect(panel(page, 'Node', DEMO.nodes.worker1)).toContainText(
    'dedicated=shop:PreferNoSchedule',
  )

  await openObject(page, 'Pods', DEMO.pods.nodeExporter[3]!)
  await expect(
    panel(page, 'Pod', DEMO.pods.nodeExporter[3]!).getByRole('article').first(),
  ).toContainText('not ready')

  await findObject(page, 'Events', 'from 2 to 3')
  await expect(row(page, 'Events', 'from 2 to 3')).toContainText('1')
  await openRow(page, 'Events', 'from 2 to 3')
  await openObject(page, 'Events', 'NamespaceFinalizersRemaining')
  await expect(page.getByRole('complementary', { name: /^Event / })).toContainText(
    'Namespace/legacy',
  )
})

test('unusual pod and node states', async ({ page, clusters }) => {
  const created = new Date(Date.now() - 20_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const pod = (name: string, status: object, metadata: object = {}) => ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: 'default',
      uid: `uid-${name}`,
      creationTimestamp: created,
      ...metadata,
    },
    spec: {
      containers: [{ name: 'main', image: 'busybox:1.36', resources: {} }],
      restartPolicy: 'Never',
    },
    status,
  })
  clusters.demo.upsert(
    pod('evicted-worker', {
      phase: 'Failed',
      reason: 'Evicted',
      message: 'The node was low on resource: memory.',
    }),
  )
  clusters.demo.upsert(pod('never-started', { phase: 'Failed', message: 'Pod was rejected' }))
  clusters.demo.upsert(
    pod('image-builder', {
      phase: 'Pending',
      containerStatuses: [
        {
          name: 'main',
          ready: false,
          restartCount: 0,
          image: 'busybox:1.36',
          state: { waiting: { reason: 'ContainerCreating' } },
        },
      ],
    }),
  )
  clusters.demo.upsert(pod('just-created', { phase: 'Pending' }))
  clusters.demo.upsert(
    pod(
      'lost-on-node',
      { phase: 'Unknown' },
      {
        ownerReferences: [
          {
            apiVersion: 'argoproj.io/v1alpha1',
            kind: 'Workflow',
            name: 'nightly-etl',
            uid: 'wf-1',
            controller: true,
          },
        ],
      },
    ),
  )
  const worker1 = demoCluster().objects.find(
    (o) => o.kind === 'Node' && o.metadata.name === DEMO.nodes.worker1,
  )!
  clusters.demo.upsert({ ...worker1, spec: { ...worker1.spec, unschedulable: true } })

  await goTo(page, 'Pods')
  await page.getByRole('button', { name: 'Namespace' }).click()
  await page.getByRole('option', { name: 'default' }).click()
  await expect(row(page, 'Pods', 'evicted-worker')).toContainText('Evicted')
  await expect(row(page, 'Pods', 'never-started')).toContainText('Failed')
  await expect(row(page, 'Pods', 'image-builder')).toContainText('ContainerCreating')
  await expect(row(page, 'Pods', 'image-builder')).toContainText(/\d+s/)
  await expect(row(page, 'Pods', 'just-created')).toContainText('Pending')
  await expect(row(page, 'Pods', 'lost-on-node')).toContainText('Unknown')

  await row(page, 'Pods', 'lost-on-node').click()
  const lost = panel(page, 'Pod', 'lost-on-node')
  await expect(lost).toContainText('Workflow/nightly-etl')
  await expect(lost.getByRole('button', { name: 'Workflow/nightly-etl' })).toHaveCount(0)

  await goTo(page, 'Nodes')
  await expect(row(page, 'Nodes', DEMO.nodes.worker1)).toContainText('Cordoned')
})

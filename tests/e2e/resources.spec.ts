import {
  CONTEXTS,
  DEMO,
  LARGE,
  expect,
  goTo,
  openCluster,
  panel,
  row,
  rows,
  test,
} from './fixtures.ts'

interface KindCase {
  kind: string
  label: string
  /** Text identifying the row to open. */
  open: string | RegExp
  /** The object name shown in the detail panel. */
  name?: string
  /** Text expected in the table row. */
  cells: string[]
  /** Text expected on the detail panel's Overview tab. */
  details: string[]
}

const KINDS: KindCase[] = [
  {
    kind: 'Node',
    label: 'Nodes',
    open: DEMO.nodes.worker3,
    cells: ['NotReady', 'worker', 'cores', 'v1.34.1'],
    details: ['No (cordoned)', 'Kubelet stopped posting node status', 'allocatable', 'Taints'],
  },
  {
    kind: 'Namespace',
    label: 'Namespaces',
    open: DEMO.terminatingNamespace,
    cells: ['Terminating'],
    details: ['Phase', 'Terminating'],
  },
  {
    kind: 'Event',
    label: 'Events',
    open: 'FailedScheduling',
    cells: ['Pod/redis-1', 'Insufficient memory'],
    details: ['FailedScheduling', 'default-scheduler', 'Last seen'],
  },
  {
    kind: 'Pod',
    label: 'Pods',
    open: DEMO.pods.debugShell,
    cells: ['Running', '1/1', DEMO.nodes.worker1],
    details: ['Pod IP', 'Containers', 'Service account'],
  },
  {
    kind: 'Deployment',
    label: 'Deployments',
    open: DEMO.deployments.checkout,
    cells: ['Degraded', '1/3', 'ghcr.io/acme/checkout'],
    details: [
      '3 desired · 1 ready',
      'RollingUpdate',
      'Pod template',
      'app.kubernetes.io/name=checkout',
    ],
  },
  {
    kind: 'StatefulSet',
    label: 'StatefulSets',
    open: DEMO.statefulSets.redis,
    cells: ['Degraded', '1/2'],
    details: ['2 desired · 1 ready', 'Pod template'],
  },
  {
    kind: 'DaemonSet',
    label: 'DaemonSets',
    open: DEMO.daemonSets.nodeExporter,
    cells: ['Degraded', '3/4'],
    details: ['4 desired · 3 ready', 'Update strategy'],
  },
  {
    kind: 'ReplicaSet',
    label: 'ReplicaSets',
    open: DEMO.replicaSets.storefrontPrevious,
    cells: ['Scaled to zero', '0/0'],
    details: ['0 desired · 0 ready', 'Deployment/storefront'],
  },
  {
    kind: 'Job',
    label: 'Jobs',
    open: DEMO.jobs.dbMigrate,
    cells: ['Failed'],
    details: ['BackoffLimitExceeded', 'Backoff limit', 'Started'],
  },
  {
    kind: 'CronJob',
    label: 'CronJobs',
    open: DEMO.cronJobs.cleanup,
    cells: ['Suspended'],
    details: ['Suspended', 'Yes', 'Concurrency'],
  },
  {
    kind: 'HorizontalPodAutoscaler',
    label: 'Autoscalers',
    open: 'storefront',
    cells: ['Deployment/storefront', '(2–10)'],
    details: ['cpu 64% / 70%', 'Deployment/storefront', '2–10'],
  },
  {
    kind: 'Service',
    label: 'Services',
    open: DEMO.services.storefront,
    cells: ['LoadBalancer', DEMO.loadBalancerIp],
    details: ['Ports', DEMO.loadBalancerIp, 'Session affinity'],
  },
  {
    kind: 'Ingress',
    label: 'Ingresses',
    open: 'storefront',
    cells: ['nginx', 'shop.example.com'],
    details: ['Rules', 'TLS hosts', 'shop.example.com'],
  },
  {
    kind: 'NetworkPolicy',
    label: 'Network Policies',
    open: 'default-deny',
    cells: ['All pods'],
    details: ['All pods in namespace', 'Policy types'],
  },
  {
    kind: 'ConfigMap',
    label: 'ConfigMaps',
    open: 'storefront-config',
    cells: ['storefront-config'],
    details: ['Data'],
  },
  {
    kind: 'Secret',
    label: 'Secrets',
    open: DEMO.secrets.postgresCredentials,
    cells: ['Opaque', '3'],
    details: ['Data', 'password', 'Opaque'],
  },
  {
    kind: 'PersistentVolumeClaim',
    label: 'Volume Claims',
    open: 'data-redis-1',
    cells: ['Pending'],
    details: ['Requested', 'Access modes'],
  },
  {
    kind: 'PersistentVolume',
    label: 'Volumes',
    open: 'pv-legacy-archive',
    cells: ['Released'],
    details: ['Reclaim policy', 'Retain'],
  },
  {
    kind: 'StorageClass',
    label: 'Storage Classes',
    open: /^standard/,
    name: 'standard',
    cells: ['Default', 'rancher.io/local-path'],
    details: ['Provisioner', 'Binding mode', 'Volume expansion'],
  },
]

for (const kindCase of KINDS) {
  test(`${kindCase.label}: lists, opens and shows YAML`, async ({ page }) => {
    await openCluster(page)
    await goTo(page, kindCase.label)
    const target = row(page, kindCase.label, kindCase.open).first()
    for (const text of kindCase.cells) await expect(target).toContainText(text)

    // Click the first cell: the middle of an event row holds a link to the involved object.
    await target.getByRole('cell').first().click()
    const detail =
      kindCase.kind === 'Event'
        ? page.getByRole('complementary', { name: /^Event / })
        : panel(page, kindCase.kind, kindCase.name ?? (kindCase.open as string))
    await expect(detail).toBeVisible()
    await expect(target).toHaveAttribute('aria-selected', 'true')
    for (const text of kindCase.details)
      await expect(detail.getByRole('tabpanel')).toContainText(text)

    await detail.getByRole('tab', { name: 'YAML' }).click()
    const yaml = detail.getByRole('tabpanel', { name: 'YAML' })
    await expect(yaml).toContainText(`kind: ${kindCase.kind}`)
    await expect(yaml).not.toContainText('managedFields')
  })
}

test('sorts by any sortable column', async ({ page }) => {
  await openCluster(page)
  await goTo(page, 'Pods')
  const header = (name: string) => page.getByRole('columnheader', { name })
  await expect(header('Status')).toHaveAttribute('aria-sort', 'ascending')
  // Problems first by default.
  await expect(rows(page, 'Pods').first()).toContainText('CrashLoopBackOff')

  await header('Name').getByRole('button').click()
  await expect(header('Name')).toHaveAttribute('aria-sort', 'ascending')
  await expect(rows(page, 'Pods').first()).toContainText('cart-')
  await header('Name').getByRole('button').click()
  await expect(header('Name')).toHaveAttribute('aria-sort', 'descending')
  await expect(rows(page, 'Pods').first()).toContainText('stuck-terminating')

  await header('Restarts').getByRole('button').click()
  await header('Restarts').getByRole('button').click()
  await expect(rows(page, 'Pods').first()).toContainText('14')

  await header('CPU').getByRole('button').click()
  await header('CPU').getByRole('button').click()
  await expect(rows(page, 'Pods').first()).toContainText(DEMO.pods.reindex)
  await header('Memory').getByRole('button').click()
  await expect(header('Memory')).toHaveAttribute('aria-sort', 'ascending')
  await header('Age').getByRole('button').click()
  await expect(header('Age')).toHaveAttribute('aria-sort', 'ascending')

  await goTo(page, 'Nodes')
  await page.getByRole('columnheader', { name: 'CPU' }).getByRole('button').click()
  await page.getByRole('columnheader', { name: 'CPU' }).getByRole('button').click()
  await expect(rows(page, 'Nodes').first()).toContainText(DEMO.nodes.worker1)
  await page.getByRole('columnheader', { name: 'Memory' }).getByRole('button').click()
  await page.getByRole('columnheader', { name: 'Memory' }).getByRole('button').click()
  await expect(rows(page, 'Nodes').first()).toContainText(DEMO.nodes.worker2)

  await goTo(page, 'Events')
  await expect(page.getByRole('columnheader', { name: 'Last seen' })).toHaveAttribute(
    'aria-sort',
    'ascending',
  )
  await page.getByRole('columnheader', { name: 'Count' }).getByRole('button').click()
  await page.getByRole('columnheader', { name: 'Count' }).getByRole('button').click()
  await expect(page.getByRole('columnheader', { name: 'Count' })).toHaveAttribute(
    'aria-sort',
    'descending',
  )

  await goTo(page, 'ConfigMaps')
  await expect(page.getByRole('columnheader', { name: 'Name' })).toHaveAttribute(
    'aria-sort',
    'ascending',
  )
})

test('filters by text and by health', async ({ page }) => {
  await openCluster(page)
  await goTo(page, 'Pods')
  const filter = page.getByPlaceholder('Filter pods')
  await filter.fill('app.kubernetes.io/name=checkout')
  await expect(rows(page, 'Pods')).toHaveCount(3)

  await filter.fill('')
  await page.getByRole('button', { name: /^Failing/ }).click()
  await expect(page.getByRole('button', { name: /^Failing/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(rows(page, 'Pods')).toHaveCount(5)
  await filter.fill('postgres')
  await expect(page.getByRole('heading', { name: 'Nothing matches' })).toBeVisible()
  await page.getByRole('button', { name: /^Failing/ }).click()
  await expect(rows(page, 'Pods')).toHaveCount(3)

  await goTo(page, 'Events')
  await page.getByPlaceholder('Filter events').fill('ImagePullBackOff')
  await expect(rows(page, 'Events').first()).toContainText('recommendations')
})

test('opens objects with the keyboard and from event links', async ({ page }) => {
  await openCluster(page)
  await goTo(page, 'Events')
  await row(page, 'Events', 'FailedScheduling').getByRole('button', { name: 'Pod/redis-1' }).click()
  await expect(panel(page, 'Pod', 'redis-1')).toBeVisible()

  await goTo(page, 'Deployments')
  const cart = row(page, 'Deployments', DEMO.deployments.cart)
  await cart.focus()
  await cart.press('ArrowDown')
  await cart.press('Enter')
  await expect(panel(page, 'Deployment', DEMO.deployments.cart)).toBeVisible()
})

test('shows empty states', async ({ page }) => {
  await openCluster(page, CONTEXTS.sandbox)
  await goTo(page, 'Pods')
  await expect(page.getByRole('heading', { name: 'No pods in this cluster' })).toBeVisible()
  await expect(page.getByText('Nothing to show yet.')).toBeVisible()
  await expect(page.getByText('0 items')).toBeVisible()

  await page.getByRole('button', { name: 'Namespace' }).click()
  await page.getByRole('option', { name: 'default' }).click()
  await expect(page.getByRole('heading', { name: 'No pods in default' })).toBeVisible()
  await expect(page.getByText('Try another namespace, or all namespaces.')).toBeVisible()

  await goTo(page, 'Volumes')
  await expect(page.getByRole('heading', { name: 'No volumes in this cluster' })).toBeVisible()

  await goTo(page, 'Nodes')
  await expect(page.getByText('Live usage needs metrics-server')).toBeVisible()
  await expect(row(page, 'Nodes', 'sandbox-node')).toContainText('cores')
})

test('shows errors and recovers on retry', async ({ page, clusters }) => {
  const clear = clusters.demo.fail('/apis/apps/v1/deployments', {
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({ kind: 'Status', message: 'deployments.apps is forbidden' }),
  })
  await openCluster(page)
  await goTo(page, 'Deployments')
  await expect(page.getByRole('alert')).toContainText('Access denied')
  clear()
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(row(page, 'Deployments', DEMO.deployments.storefront)).toBeVisible()
})

test('renders thousands of pods through a virtual list', async ({ page }) => {
  await openCluster(page, CONTEXTS.large)
  // The context's kubeconfig namespace is the starting namespace.
  await expect(page.getByRole('button', { name: 'Namespace' })).toHaveText(LARGE.namespace)
  await goTo(page, 'Pods')
  await expect(page.getByText(`${LARGE.podCount} items`)).toBeVisible()
  expect(await rows(page, 'Pods').count()).toBeLessThan(80)

  await page.getByRole('columnheader', { name: 'Name' }).getByRole('button').click()
  const table = page.getByRole('table', { name: 'Pods' })
  await table.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await expect(row(page, 'Pods', LARGE.podName(LARGE.podCount - 1))).toBeVisible()

  // A plain worker without taints.
  await goTo(page, 'Nodes')
  await row(page, 'Nodes', LARGE.node).click()
  const node = page.getByRole('complementary', { name: `Node ${LARGE.node}` })
  await expect(node).toContainText('Capacity')
  await expect(node).not.toContainText('Taints')
})

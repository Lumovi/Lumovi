import type { Page } from '@playwright/test'
import type { MockCluster } from '../mock-cluster/server.ts'
import type { KubeObject } from '../mock-cluster/types.ts'
import { focusDisabled, toasts, writes } from './action-helpers.ts'
import { CONTEXTS, DEMO, expect, openCluster, panel, test } from './fixtures.ts'

const PROMETHEUS = '/api/v1/namespaces/monitoring/services/prometheus:web/proxy'
const REDIS = '/apis/apps/v1/namespaces/data/statefulsets/redis'
const MINUTE = 60_000

async function openRightsizing(page: Page) {
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'Metrics' })
    .click()
  const tab = page
    .getByRole('navigation', { name: 'Metrics views' })
    .getByRole('link', { name: 'Right-sizing' })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Metrics')
}

const table = (page: Page) => page.getByRole('region', { name: 'Workloads' })
const tile = (page: Page, label: string) => page.getByRole('region', { name: label, exact: true })
const workload = (page: Page, kind: string, name: string) =>
  page.getByRole('row', { name: `${kind} ${name}`, exact: true })
/** The workloads in the table, in order, as "Kind name". */
const order = (page: Page) =>
  table(page)
    .locator('tbody tr[aria-label]:not([id])')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')))
const expand = (page: Page, name: string) =>
  page.getByRole('button', { name: `Show recommendation for ${name}`, exact: true }).click()
/** A workload's recommendation, unfolded. */
const advice = (page: Page, kind: string, name: string) =>
  page.getByRole('row', { name: `Recommendation for ${kind} ${name}`, exact: true })
/** One resource of one container in it. */
const details = (
  page: Page,
  [kind, name]: [string, string],
  container: string,
  resource: 'CPU' | 'Memory',
) => advice(page, kind, name).getByRole('group', { name: `${container} ${resource}`, exact: true })

async function inNamespace(page: Page, namespace: string) {
  await page.getByLabel('Namespace', { exact: true }).click()
  await page.getByRole('option', { name: namespace, exact: true }).click()
}

/** An object as the mock cluster has it, to change and put back. */
function stored(cluster: MockCluster, kind: string, namespace: string, name: string) {
  return structuredClone(cluster.object(kind, namespace, name)!) as KubeObject
}

/** Sets a container's resources in a workload's pod template, and in its pods. */
function setResources(
  cluster: MockCluster,
  kind: string,
  namespace: string,
  name: string,
  pods: readonly string[],
  resources: Record<string, Record<string, Record<string, string>>>,
) {
  const object = stored(cluster, kind, namespace, name)
  for (const c of object.spec.template.spec.containers) {
    if (resources[c.name]) c.resources = resources[c.name]
  }
  cluster.upsert(object)
  for (const podName of pods) {
    const pod = stored(cluster, 'Pod', namespace, podName)
    for (const c of pod.spec.containers) if (resources[c.name]) c.resources = resources[c.name]
    cluster.upsert(pod)
  }
}

/** Says a pod's container was last stopped by an OOM kill, `ago` ms ago. */
function oomKilled(cluster: MockCluster, namespace: string, name: string, ago: number) {
  const pod = stored(cluster, 'Pod', namespace, name)
  pod.status.containerStatuses[0].restartCount = ago < 7 * 24 * 60 * MINUTE ? 1 : 0
  pod.status.containerStatuses[0].lastState = {
    terminated: {
      exitCode: 137,
      reason: 'OOMKilled',
      startedAt: new Date(Date.now() - ago - 60 * MINUTE).toISOString(),
      finishedAt: new Date(Date.now() - ago).toISOString(),
    },
  }
  cluster.upsert(pod)
}

test.describe('right-sizing', () => {
  test.beforeEach(async ({ page }) => {
    await openCluster(page)
    await openRightsizing(page)
  })

  test('what each workload should request, what needs more first', async ({ page }) => {
    await expect(page).toHaveTitle(`Metrics · ${CONTEXTS.demo} — KubeStacks`)
    await expect(
      page.getByRole('navigation', { name: 'Metrics views' }).getByRole('link', {
        name: 'Right-sizing',
      }),
    ).toHaveAttribute('aria-current', 'page')
    await expect(
      page.getByRole('button', { name: /^Prometheus 3\.5\.0 monitoring\/prometheus$/ }),
    ).toBeVisible()

    // What's freed and what's needed, across replicas; and what needs attention.
    await expect(tile(page, 'CPU requests')).toContainText(/\d+m to free · \d+m more needed/)
    await expect(tile(page, 'Memory requests')).toContainText(/GiB to free · .+ more needed/)
    await expect(tile(page, 'Need more')).toContainText('4')
    await expect(tile(page, 'Need more')).toContainText('1 OOM-killed · 1 throttled')
    await expect(tile(page, 'Without requests')).toContainText('1')
    await expect(tile(page, 'Without requests')).toContainText('Placed as if they used nothing')

    // Those that need more first, the biggest change first; those without a recommendation last.
    expect((await order(page)).slice(0, 6)).toEqual([
      'Deployment prometheus',
      'StatefulSet postgres',
      'Deployment storefront',
      'Deployment grafana',
      'DaemonSet kube-proxy',
      'StatefulSet redis',
    ])
    expect((await order(page)).at(-1)).toBe('Deployment recommendations')
    await expect(page.getByRole('group', { name: 'Show' })).toContainText(
      'All12Needs more4Over-provisioned4No requests1Right-sized2No recommendation1',
    )

    const prometheus = workload(page, 'Deployment', 'prometheus')
    await expect(prometheus).toContainText('Needs more')
    await expect(prometheus).toContainText('2 GiB5 GiB')
    await expect(prometheus).toContainText('Limit 4 GiB5 GiB')
    await expect(prometheus).toContainText('monitoring · 1 pod')
    await expect(prometheus).toContainText('+3 GiB')
    await expect(workload(page, 'DaemonSet', 'kube-proxy')).toContainText('No requests')
    await expect(workload(page, 'DaemonSet', 'kube-proxy')).toContainText('none')
    await expect(workload(page, 'StatefulSet', 'redis')).toContainText('Over-provisioned')
    await expect(workload(page, 'StatefulSet', 'redis')).toContainText('6 GiB')
    await expect(workload(page, 'Deployment', 'cart')).toContainText('Right-sized')
    // Its limit changes, not its requests.
    await expect(workload(page, 'Deployment', 'grafana')).toContainText('Limit 100m150m')
    await expect(workload(page, 'Deployment', 'storefront')).toContainText('3 days')
    const recommendations = workload(page, 'Deployment', 'recommendations')
    await expect(recommendations).toContainText('No usage')
    await expect(recommendations.getByRole('button', { name: 'Apply…' })).toHaveCount(0)
  })

  test('a recommendation, container by container, with its week', async ({ page }) => {
    await expand(page, 'prometheus')
    const memory = details(page, ['Deployment', 'prometheus'], 'prometheus', 'Memory')
    await expect(memory).toContainText('It was OOM-killed in the last 7 days')
    await expect(memory).toContainText('a quarter more than its limit')
    await expect(memory).toContainText('Request2 GiB5 GiB')
    await expect(memory).toContainText('Limit4 GiB5 GiB')
    // The week, against the request, the limit that killed it and what they become.
    const chart = memory.getByRole('img', { name: 'prometheus Memory over the last 7 days' })
    await expect(chart).toContainText('Recommended, new limit 5 GiB')
    await expect(chart).toContainText('Limit 4 GiB')
    await expect(chart).toContainText('Request 2 GiB')
    const cpu = details(page, ['Deployment', 'prometheus'], 'prometheus', 'CPU')
    await expect(cpu).toContainText('95th percentile')
    await expect(cpu).toContainText('Limit2 cores · stays')
    await expect(cpu).toContainText('It uses more than it requests')
    // These charts don't zoom: there's only the week.
    await expect(
      cpu.getByRole('group', {
        name: /^prometheus CPU over the last 7 days\. Arrow keys read values\.$/,
      }),
    ).toBeVisible()
    await cpu.getByRole('img', { name: /over the last 7 days$/ }).click()

    // Clicking the row anywhere but its buttons folds it again.
    await workload(page, 'Deployment', 'prometheus').getByText('Needs more').click()
    await expect(memory).toHaveCount(0)

    // Throttled in bursts: its limit goes up, its request is close enough.
    await workload(page, 'Deployment', 'grafana').getByText('monitoring · 1 pod').click()
    const grafana = details(page, ['Deployment', 'grafana'], 'grafana', 'CPU')
    await expect(grafana).toContainText(
      'Its limit throttled it in 25% of its CPU periods, in bursts above its usual use: the limit goes up to 150m.',
    )
    await expect(grafana).toContainText('Request100m · stays')
    await expect(grafana).toContainText('Limit100m150m')
    await expect(grafana.getByRole('img', { name: /over the last 7 days$/ })).toContainText(
      'Request, limit 100m',
    )

    await expand(page, 'checkout')
    await expect(details(page, ['Deployment', 'checkout'], 'app', 'CPU')).toContainText(
      'Limit1 core · stays',
    )
    await expect(details(page, ['Deployment', 'checkout'], 'app', 'Memory')).toContainText(
      'Its request is within 20% of the',
    )
    await expand(page, 'recommendations')
    await expect(advice(page, 'Deployment', 'recommendations')).toContainText(
      'Prometheus has no CPU and memory use for its containers in the last 7 days.',
    )
    await page.getByRole('button', { name: 'Hide recommendation for checkout' }).click()
    await expect(
      page.getByRole('button', { name: 'Show recommendation for checkout' }),
    ).toBeVisible()

    // A name opens the workload.
    await workload(page, 'Deployment', 'storefront')
      .getByRole('button', { name: 'storefront', exact: true })
      .click()
    await expect(panel(page, 'Deployment', 'storefront')).toBeVisible()
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'How it’s worked out' }).click()
    const method = page.getByRole('dialog', { name: 'How right-sizing works' })
    await expect(method).toContainText('the 95th percentile of each container’s use')
    await expect(method).toContainText('Limits are never lowered')
  })

  test('filters, search and order, kept in the URL', async ({ page }) => {
    const show = page.getByRole('group', { name: 'Show' })
    await show.getByRole('button', { name: /^Over-provisioned/ }).click()
    expect((await order(page)).toSorted()).toEqual([
      'DaemonSet node-exporter',
      'Deployment coredns',
      'Deployment metrics-server',
      'StatefulSet redis',
    ])
    const search = page.getByPlaceholder('Filter workloads…')
    await search.fill('redis')
    await expect.poll(() => order(page)).toEqual(['StatefulSet redis'])
    await search.press('ArrowDown')
    await search.fill('')
    await expect.poll(async () => (await order(page)).length).toBe(4)
    await search.fill('redis')
    await show.getByRole('button', { name: /^Right-sized/ }).click()
    await expect(table(page)).toContainText('No workloads match.')
    await table(page).getByRole('button', { name: 'Show all' }).click()
    await expect.poll(async () => (await order(page)).length).toBe(12)

    // Most freed first, by CPU; and back.
    const cpu = table(page).getByRole('button', { name: 'CPU request' })
    await cpu.click()
    await expect(table(page).getByRole('columnheader', { name: 'CPU request' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
    expect((await order(page))[0]).toBe('Deployment coredns')
    await cpu.click()
    expect((await order(page))[0]).toBe('Deployment prometheus')

    // The tiles lead to their workloads.
    await tile(page, 'Memory requests').getByRole('button').click()
    await expect.poll(async () => (await order(page))[0]).toBe('StatefulSet redis')
    await tile(page, 'Need more').getByRole('button').click()
    await expect(show.getByRole('button', { name: /^Needs more/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect.poll(async () => (await order(page)).length).toBe(4)
    await page.reload()
    await expect.poll(async () => (await order(page)).length).toBe(4)
    await tile(page, 'Without requests').getByRole('button').click()
    await expect.poll(() => order(page)).toEqual(['DaemonSet kube-proxy'])
    await tile(page, 'CPU requests').getByRole('button').click()
    await expect(show.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true')
  })

  test('applying it: checked by the API server first, and undone', async ({ page, clusters }) => {
    await workload(page, 'StatefulSet', 'redis').getByRole('button', { name: 'Apply…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Right-size redis' })
    await expect(dialog).toContainText('Its pods are replaced with the new resources')
    await expect(dialog.getByRole('status')).toContainText('The API server accepts this change')
    await expect(dialog).toContainText(/Across its 2 pods, it frees \d+m of CPU and .+ of memory\./)
    await expect(dialog).toContainText(
      /kubectl set resources statefulset\/redis -c redis --requests=cpu=\d+m,memory=\d+Mi -n data --context demo/,
    )
    // Only the memory.
    await dialog.getByRole('checkbox', { name: /^CPU request/ }).uncheck()
    await expect(dialog).toContainText(/--requests=memory=\d+Mi -n data/)
    await expect(dialog.getByRole('status')).toContainText('The API server accepts this change')
    const checks = writes(clusters.demo, 'PATCH', REDIS)
    expect(checks.every((w) => w.query.dryRun === 'All')).toBe(true)
    expect(checks.at(-1)!.body).toMatchObject({
      spec: {
        template: { spec: { containers: [{ name: 'redis', resources: { requests: {} } }] } },
      },
    })
    await dialog.getByRole('button', { name: 'Apply' }).click()
    await expect(toasts(page)).toContainText(/Set redis’s memory request in redis to \d+Mi/)
    const saved = writes(clusters.demo, 'PATCH', REDIS).filter((w) => !w.query.dryRun)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.body.spec.template.spec.containers[0].resources).toEqual({
      requests: { memory: expect.stringMatching(/^\d+Mi$/) },
    })
    // Its memory is right-sized now; its CPU still isn't.
    await expect(workload(page, 'StatefulSet', 'redis')).not.toContainText('6 GiB')

    await toasts(page).getByRole('button', { name: 'Undo' }).click()
    await expect(toasts(page)).toContainText('Restored the resources of redis')
    const undone = writes(clusters.demo, 'PATCH', REDIS).filter((w) => !w.query.dryRun)
    expect(undone.at(-1)!.body.spec.template.spec.containers[0].resources).toEqual({
      requests: { memory: '6Gi' },
    })

    // One pod, a whole number of GiB.
    await workload(page, 'Deployment', 'prometheus').getByRole('button', { name: 'Apply…' }).click()
    const prometheus = page.getByRole('dialog', { name: 'Right-size prometheus' })
    await expect(prometheus).toContainText(
      /Across its pod, it needs \d+m more CPU and 3 GiB more memory\./,
    )
    await expect(prometheus).toContainText(/--requests=cpu=\d+m,memory=5Gi --limits=memory=5Gi/)
    await prometheus.getByRole('button', { name: 'Cancel' }).click()

    // Both, for a workload that requests nothing: undone, it requests nothing again.
    await workload(page, 'DaemonSet', 'kube-proxy').getByRole('button', { name: 'Apply…' }).click()
    const proxy = page.getByRole('dialog', { name: 'Right-size kube-proxy' })
    await expect(proxy).toContainText(
      /Across its 4 pods, it needs \d+m more CPU and \d+ MiB more memory\./,
    )
    await expect(proxy.getByRole('list', { name: 'Changes' })).toContainText('none')
    // Nothing chosen: the command shows everything, and there's nothing to apply.
    await proxy.getByRole('checkbox', { name: /^CPU request/ }).uncheck()
    await proxy.getByRole('checkbox', { name: /^Memory request/ }).uncheck()
    await expect(proxy.getByRole('button', { name: 'Apply' })).toBeDisabled()
    await expect(proxy).toContainText(/--requests=cpu=\d+m,memory=\d+Mi/)
    await proxy.getByRole('checkbox', { name: /^CPU request/ }).check()
    await proxy.getByRole('checkbox', { name: /^Memory request/ }).check()
    await expect(proxy.getByRole('status')).toContainText('The API server accepts this change')
    await proxy.getByRole('button', { name: 'Apply' }).click()
    await expect(toasts(page)).toContainText('Right-sized kube-proxy: 2 changes')
    await toasts(page).getByRole('button', { name: 'Undo' }).last().click()
    const path = '/apis/apps/v1/namespaces/kube-system/daemonsets/kube-proxy'
    await expect
      .poll(() => writes(clusters.demo, 'PATCH', path).filter((w) => !w.query.dryRun).length)
      .toBe(2)
    expect(
      writes(clusters.demo, 'PATCH', path).at(-1)!.body.spec.template.spec.containers[0].resources,
    ).toEqual({ requests: { cpu: null, memory: null } })
  })

  test('the API server can refuse it, and pods may keep their resources', async ({
    page,
    clusters,
  }) => {
    clusters.demo.fail(REDIS, {
      status: 403,
      body: JSON.stringify({
        kind: 'Status',
        apiVersion: 'v1',
        status: 'Failure',
        message:
          'statefulsets.apps "redis" is forbidden: exceeded quota: compute, requested: requests.memory=7680Mi, used: requests.memory=12Gi, limited: requests.memory=16Gi',
        reason: 'Forbidden',
        code: 403,
      }),
    })
    const redis = stored(clusters.demo, 'StatefulSet', 'data', 'redis')
    redis.spec.updateStrategy = { type: 'OnDelete' }
    clusters.demo.upsert(redis)
    await page.reload()
    await workload(page, 'StatefulSet', 'redis').getByRole('button', { name: 'Apply…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Right-size redis' })
    await expect(dialog).toContainText(
      'Its update strategy is OnDelete: pods keep their resources until they’re deleted.',
    )
    await expect(dialog.getByRole('alert')).toContainText('exceeded quota: compute')
    await expect(dialog.getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(writes(clusters.demo, 'PATCH', REDIS).every((w) => w.query.dryRun === 'All')).toBe(true)
  })

  test('only where changes are allowed', async ({ page, clusters }) => {
    clusters.demo.deny({ verb: 'patch', resource: 'statefulsets', namespace: 'data' })
    await page.reload()
    const apply = workload(page, 'StatefulSet', 'redis').getByRole('button', { name: 'Apply…' })
    await focusDisabled(apply)
    await expect(page.getByRole('tooltip')).toContainText(
      'Your account can’t change statefulsets in data.',
    )
    await expect(
      workload(page, 'Deployment', 'prometheus').getByRole('button', { name: 'Apply…' }),
    ).toBeEnabled()

    await page.getByRole('button', { name: 'Switch cluster' }).click()
    await page.getByRole('switch', { name: 'Read-only' }).click()
    await page.keyboard.press('Escape')
    const prometheus = workload(page, 'Deployment', 'prometheus').getByRole('button', {
      name: 'Apply…',
    })
    await focusDisabled(prometheus)
    await expect(page.getByRole('tooltip')).toContainText(
      'Changes are turned off for this cluster.',
    )
  })

  test('a namespace at a time', async ({ page }) => {
    await inNamespace(page, 'data')
    await expect(tile(page, 'Need more')).toContainText('Use more than they request')
    await expect(tile(page, 'Without requests')).toContainText('All request CPU and memory')
    await expect.poll(() => order(page)).toEqual(['StatefulSet postgres', 'StatefulSet redis'])
    // A filter that's chosen stays, even with nothing in it.
    await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: /^All/ }).click()
    await tile(page, 'Without requests').getByRole('button').click()
    await expect(
      page.getByRole('group', { name: 'Show' }).getByRole('button', { name: /^No requests/ }),
    ).toContainText('0')
    await expect(table(page)).toContainText('No workloads match.')

    await inNamespace(page, 'kube-system')
    await expect(tile(page, 'Need more')).toContainText('None OOM-killed or throttled')
    await inNamespace(page, 'shop')
    await expect(tile(page, 'CPU requests')).toContainText('No change')
    await expect(tile(page, 'CPU requests')).toContainText('Requests match use')
    await inNamespace(page, 'batch')
    await expect(page.getByText('Nothing to right-size')).toBeVisible()
    await expect(
      page.getByText('There are no Deployments, StatefulSets or DaemonSets in batch.'),
    ).toBeVisible()
  })

  test('when Prometheus or the cluster fail', async ({ page, clusters }) => {
    // One namespace's answers fail: the others' are there.
    const one = clusters.demo.fail(new RegExp(`${PROMETHEUS}/api/v1/query\\?.*namespace="data"`), {
      status: 503,
      body: 'overloaded',
    })
    await page.reload()
    await expect(page.getByRole('alert')).toContainText('Prometheus couldn’t answer for data')
    await expect(workload(page, 'StatefulSet', 'redis')).toContainText('No usage')
    await expand(page, 'redis')
    await expect(table(page)).toContainText('Prometheus couldn’t answer for its namespace')
    one()
    await page.getByRole('alert').getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(workload(page, 'StatefulSet', 'redis')).toContainText('Over-provisioned')

    // All of them (but not the check that Prometheus is there).
    const all = clusters.demo.fail(new RegExp(`${PROMETHEUS}/api/v1/query\\?.*namespace="`), {
      status: 503,
      body: 'down',
    })
    await page.reload()
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(table(page)).toHaveCount(0)
    all()
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(table(page)).toBeVisible()

    // The workloads themselves.
    const lists = clusters.demo.fail('/apis/apps/v1/deployments', { status: 500 })
    await page.reload()
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
    lists()
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(table(page)).toBeVisible()

    // A week the chart can't show.
    clusters.demo.fail(`${PROMETHEUS}/api/v1/query_range`, {
      status: 200,
      body: JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: [] } }),
    })
    await expand(page, 'redis')
    await expect(
      details(page, ['StatefulSet', 'redis'], 'redis', 'Memory').getByRole('img', {
        name: /over the last 7 days$/,
      }),
    ).toBeVisible()
  })
})

test('workloads it can’t say much about yet', async ({ page, clusters }) => {
  const now = Date.now()
  // New pods: minutes of history.
  for (const name of DEMO.pods.cart) {
    const pod = stored(clusters.demo, 'Pod', 'shop', name)
    pod.metadata.creationTimestamp = new Date(now - 10 * MINUTE).toISOString()
    clusters.demo.upsert(pod)
  }
  // A VerticalPodAutoscaler sets Grafana's requests; another only recommends cart's.
  clusters.demo.upsert({
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: { name: 'verticalpodautoscalers.autoscaling.k8s.io' },
    spec: {
      group: 'autoscaling.k8s.io',
      names: {
        kind: 'VerticalPodAutoscaler',
        plural: 'verticalpodautoscalers',
        singular: 'verticalpodautoscaler',
        listKind: 'VerticalPodAutoscalerList',
      },
      scope: 'Namespaced',
      versions: [
        {
          name: 'v1',
          served: true,
          storage: true,
          schema: {
            openAPIV3Schema: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
          },
        },
      ],
    },
  })
  const vpa = (namespace: string, name: string, spec: object) =>
    clusters.demo.upsert({
      apiVersion: 'autoscaling.k8s.io/v1',
      kind: 'VerticalPodAutoscaler',
      metadata: { name, namespace, creationTimestamp: new Date(now).toISOString() },
      spec,
    })
  vpa('monitoring', 'grafana', {
    targetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'grafana' },
  })
  vpa('shop', 'cart', {
    targetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'cart' },
    updatePolicy: { updateMode: 'Off' },
  })
  // Scaled to zero; its last pod OOM-killed, but without usage to go by.
  const recommendations = stored(clusters.demo, 'Deployment', 'shop', 'recommendations')
  recommendations.spec.replicas = 0
  clusters.demo.upsert(recommendations)
  oomKilled(clusters.demo, 'shop', DEMO.pods.recommendations[0]!, 30 * MINUTE)
  // New, and without a replica count or a status yet.
  clusters.demo.upsert({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: 'worker',
      namespace: 'batch',
      creationTimestamp: new Date(now).toISOString(),
    },
    spec: { template: { spec: { containers: [{ name: 'worker', image: 'worker:1' }] } } },
  })
  clusters.demo.upsert({
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: { name: 'agent', namespace: 'batch', creationTimestamp: new Date(now).toISOString() },
    spec: { template: { spec: { containers: [{ name: 'agent', image: 'agent:1' }] } } },
  })

  await openCluster(page)
  await openRightsizing(page)
  const cart = workload(page, 'Deployment', 'cart')
  await expect(cart).toContainText('Too new')
  await expect(cart).toContainText('0 hours')
  await expand(page, 'cart')
  await expect(table(page)).toContainText('It has 0 hours of history: recommendations need a day.')
  const grafana = workload(page, 'Deployment', 'grafana')
  await expect(grafana).toContainText('Autoscaled')
  await expand(page, 'grafana')
  await expect(table(page)).toContainText('The VerticalPodAutoscaler grafana sets its requests.')
  await expand(page, 'recommendations')
  await expect(table(page)).toContainText('It has no pods, and had none in the last 7 days.')
  await page
    .getByRole('group', { name: 'Show' })
    .getByRole('button', { name: /^No recommendation/ })
    .click()
  await expect.poll(async () => (await order(page)).length).toBe(5)

  await inNamespace(page, 'batch')
  await expect.poll(() => order(page)).toEqual(['DaemonSet agent', 'Deployment worker'])
  await expect(workload(page, 'Deployment', 'worker')).toContainText('1 pod')
  await expect(workload(page, 'DaemonSet', 'agent')).toContainText('0 pods')
})

test('limits that hold workloads back, and requests autoscalers scale on', async ({
  page,
  clusters,
}) => {
  // The storefront's autoscaler watches only its app's CPU now: the proxy's is free to change.
  const hpa = stored(clusters.demo, 'HorizontalPodAutoscaler', 'shop', 'storefront')
  hpa.spec.metrics = [
    {
      type: 'ContainerResource',
      containerResource: {
        name: 'cpu',
        container: 'app',
        target: { type: 'Utilization', averageUtilization: 70 },
      },
    },
    {
      type: 'Pods',
      pods: {
        metric: { name: 'requests_per_second' },
        target: { type: 'AverageValue', averageValue: '100' },
      },
    },
    {
      type: 'Resource',
      resource: { name: 'memory', target: { type: 'AverageValue', averageValue: '400Mi' } },
    },
  ]
  clusters.demo.upsert(hpa)
  // Both its containers' memory limits close to their peaks; and a container that never ran.
  const storefront = stored(clusters.demo, 'Deployment', 'shop', 'storefront')
  const [app, envoy] = storefront.spec.template.spec.containers
  app.resources.limits.memory = '380Mi'
  envoy.resources.limits.memory = '58Mi'
  storefront.spec.template.spec.containers.push({ name: 'debug', image: 'busybox' })
  clusters.demo.upsert(storefront)
  // Postgres's memory is autoscaled on.
  clusters.demo.upsert({
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: { name: 'postgres', namespace: 'data', creationTimestamp: new Date().toISOString() },
    spec: {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'StatefulSet', name: 'postgres' },
      minReplicas: 3,
      maxReplicas: 5,
      metrics: [
        {
          type: 'ContainerResource',
          containerResource: {
            name: 'memory',
            container: 'postgres',
            target: { type: 'Utilization', averageUtilization: 80 },
          },
        },
      ],
    },
  })
  // An autoscaler with no metrics of its own keeps CPU at 80% of the request.
  clusters.demo.upsert({
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: { name: 'cart', namespace: 'shop', creationTimestamp: new Date().toISOString() },
    spec: {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'cart' },
      minReplicas: 2,
      maxReplicas: 4,
    },
  })
  // Grafana's limit is lower: it's held at it.
  setResources(clusters.demo, 'Deployment', 'monitoring', 'grafana', DEMO.pods.grafana, {
    grafana: { requests: { cpu: '60m', memory: '256Mi' }, limits: { cpu: '60m', memory: '512Mi' } },
  })
  // Redis asks for exactly its limit: lowered, it's no longer Guaranteed.
  setResources(clusters.demo, 'StatefulSet', 'data', 'redis', DEMO.pods.redis, {
    redis: { requests: { cpu: '500m', memory: '6Gi' }, limits: { cpu: '500m', memory: '8Gi' } },
  })
  // CoreDNS sets only limits: they're its requests too.
  setResources(clusters.demo, 'Deployment', 'kube-system', 'coredns', DEMO.pods.coredns, {
    coredns: { limits: { cpu: '100m', memory: '170Mi' } },
  })
  // Cart's memory limit is a little above its peak: its new request is above it.
  setResources(clusters.demo, 'Deployment', 'shop', 'cart', DEMO.pods.cart, {
    app: { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '500m', memory: '124Mi' } },
  })
  // OOM kills: the node's (no limit), one a while ago, and a Job's (not a workload here).
  oomKilled(clusters.demo, 'kube-system', DEMO.pods.metricsServer[0]!, 3 * 60 * MINUTE)
  oomKilled(clusters.demo, 'kube-system', DEMO.pods.kubeProxy[0]!, 3 * 60 * MINUTE)
  oomKilled(clusters.demo, 'monitoring', DEMO.pods.nodeExporter[0]!, 10 * 24 * 60 * MINUTE)
  oomKilled(clusters.demo, 'batch', DEMO.pods.reindex, 30 * MINUTE)

  await openCluster(page)
  await openRightsizing(page)

  await expand(page, 'storefront')
  await expect(details(page, ['Deployment', 'storefront'], 'app', 'CPU')).toContainText(
    'The HorizontalPodAutoscaler storefront scales it on its CPU use relative to this request, so the request stays',
  )
  await expect(details(page, ['Deployment', 'storefront'], 'envoy', 'CPU')).toContainText(
    'a pod less than it requests',
  )
  await expect(details(page, ['Deployment', 'storefront'], 'app', 'Memory')).toContainText(
    'Its peak is within 10% of its limit, a spike away from an OOM kill',
  )
  await expect(table(page)).toContainText('No usage in the last 7 days, so left as they are: debug')
  await expect(workload(page, 'Deployment', 'storefront')).toContainText('2 limits raised')
  await workload(page, 'Deployment', 'storefront').getByRole('button', { name: 'Apply…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Right-size storefront' })
  await expect(dialog.getByRole('list', { name: 'Changes' })).toContainText('envoy · CPU request')
  await expect(dialog.getByRole('list', { name: 'Changes' })).toContainText('app · Memory limit')
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  await expand(page, 'postgres')
  await expect(details(page, ['StatefulSet', 'postgres'], 'postgres', 'Memory')).toContainText(
    'The HorizontalPodAutoscaler postgres scales it on its memory use',
  )
  await expect(workload(page, 'StatefulSet', 'postgres')).toContainText('Right-sized')

  await expand(page, 'grafana')
  await expect(details(page, ['Deployment', 'grafana'], 'grafana', 'CPU')).toContainText(
    'so it used less than it needed: the limit goes up to 90m, and the request isn’t lowered.',
  )
  // Only its limit changes: nothing to free.
  await workload(page, 'Deployment', 'grafana').getByRole('button', { name: 'Apply…' }).click()
  const limitOnly = page.getByRole('dialog', { name: 'Right-size grafana' })
  await expect(limitOnly).toContainText(/--limits=cpu=90m/)
  await expect(limitOnly).not.toContainText('Across its')
  await limitOnly.getByRole('button', { name: 'Apply' }).click()
  await expect(toasts(page)).toContainText('Set grafana’s CPU limit in grafana to 90m')

  await expand(page, 'redis')
  await expect(details(page, ['StatefulSet', 'redis'], 'redis', 'CPU')).toContainText(
    'Its request equals its limit now: below it, its pods are Burstable rather than Guaranteed.',
  )
  await expand(page, 'coredns')
  await expect(details(page, ['Deployment', 'coredns'], 'coredns', 'CPU')).toContainText(
    'It sets no request, so it requests its limit, 100m.',
  )
  await expect(details(page, ['Deployment', 'coredns'], 'coredns', 'CPU')).toContainText(
    'Its request is its limit now',
  )
  await expand(page, 'cart')
  await expect(details(page, ['Deployment', 'cart'], 'app', 'Memory')).toContainText(
    'Its limit goes up to 128 MiB, as it can’t be below the request.',
  )
  await expect(details(page, ['Deployment', 'cart'], 'app', 'CPU')).toContainText(
    'The HorizontalPodAutoscaler cart scales it on its CPU use',
  )
  await expand(page, 'metrics-server')
  await expect(
    details(page, ['Deployment', 'metrics-server'], 'metrics-server', 'Memory'),
  ).toContainText('a quarter more than its peak')
  await expect(
    details(page, ['Deployment', 'metrics-server'], 'metrics-server', 'Memory'),
  ).toContainText('Request200 MiB · stays')
  await expand(page, 'kube-proxy')
  await expect(details(page, ['DaemonSet', 'kube-proxy'], 'kube-proxy', 'Memory')).toContainText(
    'It was OOM-killed',
  )
  // An OOM kill more than a week ago is history.
  await expect(workload(page, 'DaemonSet', 'node-exporter')).toContainText('Over-provisioned')
})

test('a cluster without workloads, and the way there', async ({ page }) => {
  await openCluster(page, CONTEXTS.large)
  await inNamespace(page, 'All namespaces')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
  await page.keyboard.type('right-sizing')
  await page.getByRole('option', { name: 'Right-sizing' }).click()
  await expect(page.getByText('Nothing to right-size')).toBeVisible({ timeout: 40_000 })
  await expect(
    page.getByText('There are no Deployments, StatefulSets or DaemonSets in this cluster.'),
  ).toBeVisible()
  await page
    .getByRole('navigation', { name: 'Metrics views' })
    .getByRole('link', { name: 'Usage' })
    .click()
  await expect(page.getByRole('group', { name: 'Metric' })).toBeVisible({ timeout: 40_000 })
})

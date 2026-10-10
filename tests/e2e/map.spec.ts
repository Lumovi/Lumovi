import type { Locator, Page } from '@playwright/test'
import { layoutMap, ranks } from '../../src/renderer/src/lib/map-layout.ts'
import type { MapGraph, MapNode } from '../../src/renderer/src/lib/map.ts'
import type { MockCluster } from '../mock-cluster/server.ts'
import { open } from './action-helpers.ts'
import { CONTEXTS, DEMO, expect, goTo, LARGE, openCluster, panel, test } from './fixtures.ts'

/**
 * Opens an object's detail panel on its Map tab: `wide`, expanded so every row has room;
 * `alone`, for what's connected to nothing (and has no map).
 */
async function openMap(
  page: Page,
  list: string,
  kind: string,
  name: string,
  { wide = true, alone = false }: { wide?: boolean; alone?: boolean } = {},
) {
  if (list) await open(page, list, name)
  const detail = panel(page, kind, name)
  await detail.getByRole('tab', { name: 'Map', exact: true }).click()
  // The panel stays expanded from one object to the next.
  const expand = detail.getByRole('button', { name: 'Expand panel' })
  if (wide && (await expand.count()) > 0) await expand.click()
  await expect(alone ? detail.getByText('Nothing connected') : map(detail)).toBeVisible()
  return detail
}

const map = (scope: Locator | Page) => scope.getByRole('group', { name: 'Map', exact: true })
/** A card on the map, by its kind, name and status: "Service storefront, 3/3 ready". */
const card = (scope: Locator | Page, name: string | RegExp) =>
  map(scope).getByRole(typeof name === 'string' && name.includes('(this ') ? 'img' : 'button', {
    name,
    exact: true,
  })

/** Opens every row that ends in "+N more". */
async function openAll(scope: Locator) {
  const more = map(scope).getByRole('button', { name: /^[\d,]+ more$/ })
  // The map lays itself out again as it gains or loses room: a card may be gone by the time
  // it's clicked (opened for us), or a new one there just after the last. So until none is left.
  await expect(async () => {
    for (let tries = 0; tries < 50 && (await more.count()) > 0; tries++) {
      await more
        .first()
        .click({ timeout: 2000 })
        .catch(() => undefined)
    }
    await expect(more).toHaveCount(0, { timeout: 1000 })
  }).toPass({ timeout: 30_000 })
}

test.describe('the map', () => {
  test.beforeEach(async ({ page }) => openCluster(page))

  test('a workload: what leads to it, and what it uses and runs on', async ({ page }) => {
    const detail = await openMap(page, 'Deployments', 'Deployment', DEMO.deployments.storefront)
    await expect(detail).toContainText('Above it, what leads to it; below, what it uses.')
    const here = card(detail, 'Deployment storefront, Ready (this Deployment)')
    await expect(here).toBeVisible()
    for (const name of [
      'Gateway public, Programmed',
      'HTTPRoute storefront, Accepted',
      'Ingress storefront',
      'Service storefront, 3/3 ready',
      'Service edge, 3/3 ready',
      'Network policy allow-storefront',
      'Network policy default-deny',
      'Autoscaler storefront, Scaling',
      'Pods storefront, 3/3 ready: show each pod',
      'ConfigMap storefront-config',
      'Service account storefront',
      'Node worker-1, Ready',
      'Node worker-2, MemoryPressure',
    ]) {
      await expect(card(detail, name)).toBeVisible()
    }
    // Each card says what it's connected to, for screen readers.
    await expect(card(detail, 'Service storefront, 3/3 ready')).toHaveAccessibleDescription(
      'Selects Deployment storefront. Ingress storefront: routes to it. HTTPRoute storefront: routes to it.',
    )
    await expect(here).toHaveAccessibleDescription(
      /Owns Pods storefront\. Mounts ConfigMap storefront-config\./,
    )
    await expect(card(detail, 'Pods storefront, 3/3 ready: show each pod')).toContainText(
      'revision',
    )

    // Pointing at a card traces its chain through the map; the rest fades.
    await card(detail, 'Network policy allow-storefront').hover()
    await expect(card(detail, 'Gateway public, Programmed')).toHaveCSS('opacity', '0.35')
    await expect(card(detail, 'Node worker-2, MemoryPressure')).toHaveCSS('opacity', '1')
    await page.mouse.move(0, 0)
    await expect(card(detail, 'Gateway public, Programmed')).toHaveCSS('opacity', '1')
    // So does focusing one.
    await card(detail, 'ConfigMap storefront-config').focus()
    await expect(card(detail, 'Node worker-1, Ready')).toHaveCSS('opacity', '0.35')
    await card(detail, 'ConfigMap storefront-config').blur()
    await expect(card(detail, 'Node worker-1, Ready')).toHaveCSS('opacity', '1')

    // A group of pods opens into its pods, and closes again.
    await card(detail, 'Pods storefront, 3/3 ready: show each pod').click()
    for (const pod of DEMO.pods.storefront) {
      await expect(card(detail, new RegExp(`^Pod ${pod}, Running`))).toBeVisible()
    }
    await detail.getByRole('button', { name: 'Collapse' }).click()
    await expect(card(detail, 'Pods storefront, 3/3 ready: show each pod')).toBeVisible()

    // Narrower, rows that don't fit end in "+N more", which opens them.
    await detail.getByRole('button', { name: 'Restore panel' }).click()
    const more = map(detail).getByRole('button', { name: /^\d+ more$/ })
    await expect(more.first()).toBeVisible()
    // What shows first of a row: what's unwell, then what goes by its name.
    await expect(card(detail, 'Service storefront, 3/3 ready')).toBeVisible()
    await more.first().hover()
    await more.first().focus()
    await more.first().blur()
    await more.first().click()
    await expect(card(detail, 'Network policy default-deny')).toBeVisible()
    await detail.getByRole('button', { name: 'Collapse' }).click()
    await expect(card(detail, 'Network policy default-deny')).toHaveCount(0)

    // A card opens its object, on its own map.
    await card(detail, 'Node worker-2, MemoryPressure').click()
    const node = panel(page, 'Node', DEMO.nodes.worker2)
    await expect(node.getByRole('tab', { name: 'Map' })).toHaveAttribute('aria-selected', 'true')
    await expect(card(node, 'Node worker-2, MemoryPressure (this Node)')).toBeVisible()
  })

  test('storage, and what uses a ConfigMap', async ({ page }) => {
    const postgres = await openMap(page, 'StatefulSets', 'StatefulSet', DEMO.statefulSets.postgres)
    for (const i of [0, 1, 2]) {
      await expect(card(postgres, `Volume claim data-postgres-${i}, Bound`)).toBeVisible()
    }
    await expect(map(postgres).getByRole('button', { name: /^Volume pvc-.*, Bound$/ })).toHaveCount(
      3,
    )
    await expect(card(postgres, 'Storage class standard')).toBeVisible()
    await expect(card(postgres, 'Pods postgres, 3/3 ready: show each pod')).toBeVisible()
    await page.keyboard.press('Escape')

    const config = await openMap(page, 'ConfigMaps', 'ConfigMap', 'storefront-config', {
      wide: false,
    })
    await expect(card(config, 'ConfigMap storefront-config (this ConfigMap)')).toBeVisible()
    await expect(card(config, 'Deployment storefront, Ready')).toBeVisible()
  })

  test('a CronJob, its Jobs and their pods', async ({ page }) => {
    const cron = await openMap(page, 'CronJobs', 'CronJob', DEMO.cronJobs.nightlyReport)
    await expect(card(cron, 'CronJob nightly-report, Scheduled (this CronJob)')).toContainText(
      '0 2 * * *',
    )
    await expect(card(cron, /^Job nightly-report-29310/)).toBeVisible()
    await page.keyboard.press('Escape')
    const checkout = await openMap(page, 'Deployments', 'Deployment', DEMO.deployments.checkout)
    await expect(card(checkout, 'Service checkout, 1/3 ready')).toBeVisible()
  })

  test('a node: what runs on it, and whose it is', async ({ page }) => {
    const node = await openMap(page, 'Nodes', 'Node', DEMO.nodes.worker2)
    await openAll(node)
    await expect(card(node, 'Pods checkout, 1/3 ready: show each pod')).toBeVisible()
    await expect(card(node, 'Deployment checkout, Degraded')).toBeVisible()
    await expect(card(node, 'Pods postgres, 3/3 ready: show each pod')).toBeVisible()
    // What's further away (their Services) is the workloads' own maps'.
    await expect(map(node).getByRole('button', { name: /^Service / })).toHaveCount(0)
  })

  test('what a custom resource relates to, by its view', async ({ page }) => {
    // Karpenter's kinds are tabs of its add-on.
    await page
      .getByRole('navigation', { name: 'Resources' })
      .getByRole('link', { name: 'Karpenter', exact: true })
      .click()
    await page
      .getByRole('navigation', { name: 'Karpenter' })
      .getByRole('link', { name: /^NodePools/ })
      .click()
    await page
      .getByRole('row')
      .filter({ hasText: 'general' })
      .first()
      .getByRole('gridcell')
      .nth(1)
      .click()
    const pool = await openMap(page, '', 'NodePool', 'general')
    await openAll(pool)
    await expect(card(pool, 'NodePool general, Ready (this NodePool)')).toBeVisible()
    await expect(card(pool, 'Node worker-3, NotReady')).toBeVisible()
  })

  test('a Service that selects nothing, and other loners', async ({ page }) => {
    const service = await openMap(page, 'Services', 'Service', DEMO.services.legacyGateway, {
      wide: false,
      alone: true,
    })
    await expect(service).toContainText('Nothing connected')
    await expect(service).toContainText('It selects no pods, and nothing routes to it.')
  })
})

/** Everything an object can refer to, some of it missing, in the shop namespace. */
function kitchenSink(cluster: MockCluster) {
  const now = new Date().toISOString()
  const meta = (name: string, extra: object = {}) => ({
    name,
    namespace: 'shop',
    creationTimestamp: now,
    uid: `lab-${name}`,
    ...extra,
  })
  cluster.upsert({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: meta('lab'),
    status: {},
    spec: {
      replicas: 0,
      selector: { matchLabels: { app: 'lab' } },
      template: {
        metadata: { labels: { app: 'lab', tier: 'web' } },
        spec: {
          serviceAccountName: 'lab',
          imagePullSecrets: [{ name: 'registry-pull' }],
          initContainers: [{ name: 'init', image: 'busybox' }],
          containers: [
            {
              name: 'app',
              image: 'lab:1',
              env: [
                {
                  name: 'A',
                  valueFrom: { configMapKeyRef: { name: 'storefront-config', key: 'a' } },
                },
                { name: 'B', valueFrom: { secretKeyRef: { name: 'java-keystore', key: 'b' } } },
                { name: 'C', value: 'plain' },
                { name: 'D', valueFrom: { configMapKeyRef: { name: 'lab-one', key: 'a' } } },
              ],
              envFrom: [
                { configMapRef: { name: 'lab-env' } },
                { secretRef: { name: 'lab-secrets' } },
              ],
            },
          ],
          volumes: [
            {
              name: 'kube-api-access-lab',
              projected: { sources: [{ configMap: { name: 'kube-root-ca.crt' } }] },
            },
            { name: 'config', configMap: { name: 'lab-config' } },
            { name: 'binary', configMap: { name: 'lab-binary' } },
            { name: 'certs', secret: { secretName: 'storefront-tls' } },
            { name: 'data', persistentVolumeClaim: { claimName: 'lab-claim' } },
            { name: 'scratch', emptyDir: {} },
            {
              name: 'bundle',
              projected: {
                sources: [
                  { configMap: { name: 'storefront-config' } },
                  { secret: { name: 'java-keystore' } },
                  { serviceAccountToken: { path: 'token' } },
                ],
              },
            },
          ],
        },
      },
    },
  })
  cluster.upsert({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: meta('lab-binary'),
    data: { a: '1' },
    binaryData: { b: 'AA==' },
  })
  cluster.upsert({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: meta('lab-claim'),
    spec: { storageClassName: 'standard', resources: { requests: { storage: '5Gi' } } },
    status: { phase: 'Pending' },
  })
  cluster.upsert({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: meta('lab'),
    status: {},
    spec: { type: 'ClusterIP', selector: { app: 'lab' }, ports: [{ port: 8080 }] },
  })
  cluster.upsert({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: meta('lab-manual'),
    status: {},
    spec: { type: 'ClusterIP', selector: {} },
  })
  cluster.upsert({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: meta('lab'),
    status: {},
    spec: {
      defaultBackend: { service: { name: 'lab', port: { number: 8080 } } },
      tls: [{ secretName: 'lab-tls' }, { hosts: ['lab.example.com'] }],
      rules: [
        {
          host: 'lab.example.com',
          http: {
            paths: [
              { path: '/', backend: { service: { name: 'lab-gone', port: { name: 'http' } } } },
            ],
          },
        },
        {
          http: {
            paths: [
              { path: '/static', backend: { resource: { kind: 'StorageBucket', name: 'static' } } },
            ],
          },
        },
        { host: 'empty.example.com' },
      ],
    },
  })
  cluster.upsert({
    apiVersion: 'gateway.networking.k8s.io/v1',
    kind: 'HTTPRoute',
    metadata: meta('lab'),
    status: {},
    spec: {
      parentRefs: [
        { name: 'public' },
        { kind: 'Service', name: 'mesh' },
        // A gateway shared from a namespace of its own, as Gateway API setups often have.
        { name: 'shared', namespace: 'infra' },
      ],
      rules: [
        {
          backendRefs: [
            { name: 'lab' },
            { kind: 'ServiceImport', name: 'elsewhere' },
            { name: 'lab-elsewhere', namespace: 'staging' },
          ],
        },
        {},
      ],
    },
  })
  cluster.upsert({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: meta('lab'),
    status: {},
    spec: {
      podSelector: {
        matchExpressions: [
          { key: 'app', operator: 'In', values: ['lab'] },
          { key: 'tier', operator: 'NotIn', values: ['db'] },
          { key: 'tier', operator: 'Exists' },
          { key: 'canary', operator: 'DoesNotExist' },
        ],
      },
    },
  })
  cluster.upsert({
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: meta('lab'),
    status: {},
    spec: { minAvailable: 1, selector: { matchLabels: { app: 'lab' } } },
  })
  cluster.upsert({
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: meta('lab'),
    status: {},
    spec: {
      maxReplicas: 4,
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'lab' },
    },
  })
  // Pods without a controller: one on a node that's gone, one a custom resource adopted
  // (an owner that doesn't control it), one whose ReplicaSet is gone.
  const pod = (
    name: string,
    extra: object,
    spec: object,
    status: object = { name: 'app', ready: true, restartCount: 0, state: { running: {} } },
  ) =>
    cluster.upsert({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: meta(name, extra),
      spec: { containers: [{ name: 'app', image: 'lab:1' }], ...spec },
      status: { phase: 'Running', containerStatuses: [status] },
    })
  pod('lab-orphan', { labels: { app: 'lab-orphan' } }, { nodeName: 'worker-9' })
  pod(
    'lab-adopted',
    {
      ownerReferences: [
        { apiVersion: 'example.com/v1', kind: 'Widget', name: 'blue-widget', uid: 'w' },
      ],
    },
    { nodeName: 'worker-1' },
  )
  pod(
    'lab-stray',
    {
      ownerReferences: [
        {
          apiVersion: 'apps/v1',
          kind: 'ReplicaSet',
          name: 'lab-gone-7d9f8b6c5',
          uid: 'rs',
          controller: true,
        },
      ],
    },
    { nodeName: 'worker-1' },
  )
  // Without what they could have: claim templates, rules, parents, a selector, ports.
  cluster.upsert({
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: meta('lab-cache'),
    status: {},
    spec: {
      replicas: 0,
      selector: { matchLabels: { app: 'lab-cache' } },
      template: {
        metadata: { labels: { app: 'lab-cache' } },
        spec: { containers: [{ name: 'c', image: 'c' }] },
      },
    },
  })
  cluster.upsert({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: meta('lab-default'),
    status: {},
    spec: { defaultBackend: { service: { name: 'lab', port: { number: 8080 } } } },
  })
  cluster.upsert({
    apiVersion: 'gateway.networking.k8s.io/v1',
    kind: 'HTTPRoute',
    metadata: meta('lab-bare'),
    status: {},
    spec: {},
  })
  cluster.upsert({
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: meta('lab-all'),
    status: {},
    spec: { maxUnavailable: 1 },
  })
  cluster.upsert({
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: meta('lab-one'),
    data: { a: '1' },
  })
  pod(
    'lab-crash',
    { labels: { app: 'lab-crash' } },
    { nodeName: 'worker-1' },
    {
      name: 'app',
      ready: false,
      restartCount: 9,
      state: { waiting: { reason: 'CrashLoopBackOff' } },
    },
  )
  cluster.upsert({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: meta('lab-crash'),
    status: {},
    spec: { type: 'ClusterIP', selector: { app: 'lab-crash' } },
  })
  // Loners.
  cluster.upsert({ apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('lab-unused'), data: {} })
  cluster.upsert({ apiVersion: 'v1', kind: 'Secret', metadata: meta('lab-unused'), type: 'Opaque' })
  cluster.upsert({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: meta('lab-unclassed'),
    spec: { resources: { requests: { storage: '1Gi' } } },
    status: { phase: 'Pending' },
  })
  cluster.upsert({
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name: 'lab-pv', creationTimestamp: now, uid: 'lab-pv' },
    spec: { capacity: { storage: '1Gi' } },
    status: { phase: 'Available' },
  })
}

test('missing references, odd ones, and what refers to nothing', async ({ page, clusters }) => {
  kitchenSink(clusters.demo)
  await openCluster(page)
  const lab = await openMap(page, 'Deployments', 'Deployment', 'lab')
  await openAll(lab)
  await expect(
    map(lab).getByRole('img', { name: /^Deployment lab, .*\(this Deployment\)$/ }),
  ).toBeVisible()
  for (const name of [
    'ConfigMap lab-config, Not found',
    'ConfigMap lab-env, Not found',
    'Secret lab-secrets, Not found',
    'Service account lab, Not found',
  ]) {
    await expect(map(lab).getByRole('img', { name })).toBeVisible()
  }
  await expect(card(lab, 'ConfigMap lab-binary')).toContainText('2 keys')
  await expect(card(lab, 'ConfigMap lab-one')).toContainText('1 key')
  await expect(card(lab, 'Secret storefront-tls')).toContainText('TLS')
  await expect(card(lab, 'Secret registry-pull')).toContainText('Registry')
  await expect(card(lab, 'Secret java-keystore')).toBeVisible()
  await expect(card(lab, 'ConfigMap storefront-config')).toBeVisible()
  await expect(card(lab, 'Volume claim lab-claim, Pending')).toContainText('5Gi')
  await expect(card(lab, 'Storage class standard')).toBeVisible()
  await expect(card(lab, 'Service lab, No pods')).toContainText('ClusterIP · 8080')
  await expect(card(lab, 'Autoscaler lab, Scaling')).toContainText('1–4 replicas')
  await expect(
    map(lab).getByRole('button', { name: 'Disruption budget lab', exact: true }),
  ).toBeVisible()
  await expect(card(lab, 'Disruption budget lab-all')).toBeVisible()
  await expect(card(lab, 'Network policy lab')).toContainText('Ingress')
  await expect(card(lab, 'Ingress lab')).toBeVisible()
  await expect(card(lab, 'HTTPRoute lab, Pending')).toBeVisible()
  // What it refers to in namespaces the map didn't list is there, unknown, rather than missing.
  await card(lab, 'HTTPRoute lab, Pending').click()
  const route = panel(page, 'HTTPRoute', 'lab')
  await openAll(route)
  await expect(card(route, 'Gateway shared')).toBeVisible()
  await expect(card(route, 'Service lab-elsewhere')).toBeVisible()
  await expect(card(route, /^Service lab, /)).toBeVisible()
  await page.keyboard.press('Escape')

  // An ingress with a default backend only takes every host; one with rules lists its
  // default backend after them.
  await open(page, 'Ingresses', 'lab-default')
  await expect(panel(page, 'Ingress', 'lab-default')).toContainText('*Anything elselab:8080')
  await page.keyboard.press('Escape')
  await page.getByPlaceholder('Filter ingresses').fill('lab')
  await expect(page.getByRole('row').filter({ hasText: 'lab-default' })).toContainText('*')
  await open(page, 'Ingresses', 'lab')
  await expect(panel(page, 'Ingress', 'lab')).toContainText('/staticStorageBucket static')
  await expect(panel(page, 'Ingress', 'lab')).toContainText('lab.example.com/lab-gone:http')
  await page.keyboard.press('Escape')
  // What the ingress routes to, and the TLS secret it names, aren't there.
  const ingress = await openMap(page, 'Ingresses', 'Ingress', 'lab')
  await openAll(ingress)
  await expect(map(ingress).getByRole('img', { name: 'Service lab-gone, Not found' })).toBeVisible()
  await expect(map(ingress).getByRole('img', { name: 'Secret lab-tls, Not found' })).toBeVisible()
  await page.keyboard.press('Escape')

  // A pod on a node that's gone, and one adopted by a custom resource, which opens.
  await goTo(page, 'Pods')
  const orphan = await openMap(page, 'Pods', 'Pod', 'lab-orphan', { wide: false })
  await expect(map(orphan).getByRole('img', { name: 'Node worker-9, Not found' })).toBeVisible()
  await page.keyboard.press('Escape')
  const crash = await openMap(page, 'Pods', 'Pod', 'lab-crash', { wide: false })
  await expect(card(crash, 'Service lab-crash, 0/1 ready')).toContainText('ClusterIP')
  await page.keyboard.press('Escape')
  const stray = await openMap(page, 'Pods', 'Pod', 'lab-stray', { wide: false })
  await expect(
    map(stray).getByRole('img', { name: 'ReplicaSet lab-gone-7d9f8b6c5, Not found' }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  const adopted = await openMap(page, 'Pods', 'Pod', 'lab-adopted', { wide: false })
  await card(adopted, 'Widget blue-widget').click()
  await expect(panel(page, 'Widget', 'blue-widget')).toBeVisible()
  await page.keyboard.press('Escape')

  // What nothing refers to.
  for (const [list, kind, name, says] of [
    ['ConfigMaps', 'ConfigMap', 'lab-unused', 'No pod, workload or ingress here refers to it.'],
    ['Secrets', 'Secret', 'lab-unused', 'No pod, workload or ingress here refers to it.'],
    ['Volume Claims', 'PersistentVolumeClaim', 'lab-unclassed', 'No pod mounts it.'],
  ] as const) {
    await goTo(page, list)
    const alone = await openMap(page, list, kind, name, { wide: false, alone: true })
    await expect(alone).toContainText('Nothing connected')
    await expect(alone).toContainText(says)
    await page.keyboard.press('Escape')
  }
  await goTo(page, 'Volumes')
  const volume = await openMap(page, 'Volumes', 'PersistentVolume', 'lab-pv', {
    wide: false,
    alone: true,
  })
  await expect(volume).toContainText(
    'Nothing here refers to this PersistentVolume, and it refers to nothing.',
  )
})

/**
 * A database as CloudNativePG runs one: a Cluster that owns its pods outright, and owns the
 * Services and the disruption budget that select them, and the Secrets they and others use.
 */
function postgres(cluster: MockCluster) {
  const now = new Date().toISOString()
  const owner = {
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Cluster',
    name: 'pg',
    uid: 'pg-cluster',
    controller: true,
    blockOwnerDeletion: true,
  }
  const labels = { 'cnpg.io/cluster': 'pg' }
  const meta = (name: string, owned = true) => ({
    name,
    namespace: 'shop',
    creationTimestamp: now,
    uid: `pg-${name}`,
    labels,
    ...(owned ? { ownerReferences: [owner] } : {}),
  })
  cluster.upsert({
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: { name: 'clusters.postgresql.cnpg.io', creationTimestamp: now, uid: 'pg-crd' },
    spec: {
      group: 'postgresql.cnpg.io',
      names: { kind: 'Cluster', listKind: 'ClusterList', plural: 'clusters', singular: 'cluster' },
      scope: 'Namespaced',
      versions: [
        {
          name: 'v1',
          served: true,
          storage: true,
          schema: {
            openAPIV3Schema: {
              type: 'object',
              properties: {
                spec: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
                status: { type: 'object', 'x-kubernetes-preserve-unknown-fields': true },
              },
            },
          },
          subresources: { status: {} },
        },
      ],
    },
    status: {
      acceptedNames: { kind: 'Cluster', plural: 'clusters' },
      conditions: [{ type: 'Established', status: 'True', reason: 'InitialNamesAccepted' }],
      storedVersions: ['v1'],
    },
  })
  cluster.upsert({
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Cluster',
    metadata: { ...meta('pg', false), uid: 'pg-cluster' },
    spec: { instances: 2, storage: { size: '1Gi' } },
    status: { instances: 2, readyInstances: 2, phase: 'Cluster in healthy state' },
  })
  for (const name of ['pg-app', 'pg-superuser']) {
    cluster.upsert({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: meta(name),
      type: 'kubernetes.io/basic-auth',
      data: { username: 'YXBw', password: 'c2VjcmV0' },
    })
  }
  for (const name of ['pg-1', 'pg-2']) {
    cluster.upsert({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: meta(name),
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: 'standard',
        resources: { requests: { storage: '1Gi' } },
      },
      status: { phase: 'Pending' },
    })
    cluster.upsert({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: meta(name),
      spec: {
        nodeName: 'worker-1',
        serviceAccountName: 'pg',
        containers: [
          {
            name: 'postgres',
            image: 'ghcr.io/cloudnative-pg/postgresql:17',
            env: [
              {
                name: 'PGPASSWORD',
                valueFrom: { secretKeyRef: { name: 'pg-superuser', key: 'password' } },
              },
            ],
          },
        ],
        volumes: [{ name: 'pgdata', persistentVolumeClaim: { claimName: name } }],
      },
      status: {
        phase: 'Running',
        startTime: now,
        conditions: [{ type: 'Ready', status: 'True' }],
        containerStatuses: [
          {
            name: 'postgres',
            image: 'ghcr.io/cloudnative-pg/postgresql:17',
            ready: true,
            restartCount: 0,
            state: { running: { startedAt: now } },
          },
        ],
      },
    })
  }
  cluster.upsert({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: meta('pg') })
  for (const name of ['pg-rw', 'pg-ro']) {
    cluster.upsert({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: meta(name),
      spec: { type: 'ClusterIP', selector: labels, ports: [{ port: 5432, protocol: 'TCP' }] },
    })
  }
  cluster.upsert({
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: meta('pg'),
    spec: { minAvailable: 1, selector: { matchLabels: labels } },
    status: {},
  })
  // Autoscalers that name each other as what they scale, one of them owning the other two:
  // lines both ways with nothing that owns between them, and, once those are sorted out, two
  // that are related and would sit level. Nobody means to; the map shows it all the same.
  for (const [name, target, owned] of [
    ['loop-a', 'loop-b', false],
    ['loop-b', 'loop-a', true],
    ['loop-c', 'loop-b', true],
  ] as const) {
    const kind = { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler' }
    cluster.upsert({
      ...kind,
      metadata: {
        name,
        namespace: 'shop',
        creationTimestamp: now,
        uid: `pg-${name}`,
        ...(owned
          ? { ownerReferences: [{ ...kind, name: 'loop-a', uid: 'pg-loop-a', controller: true }] }
          : {}),
      },
      spec: {
        scaleTargetRef: { ...kind, name: target },
        minReplicas: 1,
        maxReplicas: 2,
        // (As the API server fills it in where none is given.)
        metrics: [
          {
            type: 'Resource',
            resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 80 } },
          },
        ],
      },
      status: {},
    })
  }
  // And something of somebody else's that uses the database: it isn't the Cluster's.
  cluster.upsert({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { ...meta('pg-client', false), labels: { app: 'pg-client' } },
    status: {},
    spec: {
      replicas: 0,
      selector: { matchLabels: { app: 'pg-client' } },
      template: {
        metadata: { labels: { app: 'pg-client' } },
        spec: {
          containers: [
            {
              name: 'app',
              image: 'client:1',
              envFrom: [{ secretRef: { name: 'pg-app' } }],
            },
          ],
        },
      },
    },
  })
}

test('a custom resource that owns its pods and what selects them has a map, from any of them', async ({
  page,
  clusters,
}) => {
  postgres(clusters.demo)
  await openCluster(page)
  const own = (detail: Locator, kind: string, name: string) =>
    map(detail).getByRole('img', { name: new RegExp(`^${kind} ${name}\\b.*\\(this .+\\)$`) })
  // The Cluster owns the Service, and the Service selects the Cluster's pods: lines both ways.
  for (const [list, kind, label, name] of [
    ['Secrets', 'Secret', 'Secret', 'pg-app'],
    ['Secrets', 'Secret', 'Secret', 'pg-superuser'],
    ['Services', 'Service', 'Service', 'pg-rw'],
    ['Pods', 'Pod', 'Pod', 'pg-1'],
    ['Volume Claims', 'PersistentVolumeClaim', 'Volume claim', 'pg-1'],
    ['Autoscalers', 'HorizontalPodAutoscaler', 'Autoscaler', 'loop-a'],
    ['Deployments', 'Deployment', 'Deployment', 'pg-client'],
  ] as const) {
    const detail = await openMap(page, list, kind, name).catch(async (error: unknown) => {
      // What the view said in the map's place, if it said anything.
      const alert = page.getByRole('alert')
      throw (await alert.count()) > 0
        ? new Error(`${kind} ${name}: ${await alert.first().innerText()}`)
        : error
    })
    await openAll(detail)
    await expect(own(detail, label, name), `${kind} ${name}`).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    if (name !== 'loop-a') continue
    // The three autoscalers are each on a row of their own: there's a line between each two.
    const rows = new Set<number>()
    for (const other of ['loop-a', 'loop-b', 'loop-c']) {
      const at = await map(detail)
        .getByLabel(new RegExp(`^Autoscaler ${other}\\b`))
        .boundingBox()
      rows.add(Math.round(at!.y))
    }
    expect(rows.size).toBe(3)
  }
  // And as it was found: from the Cluster's own map, to one of its Secrets.
  const client = panel(page, 'Deployment', 'pg-client')
  await card(client, 'Secret pg-app').click()
  const secret = panel(page, 'Secret', 'pg-app')
  await card(secret, 'Cluster pg').click()
  const cluster = panel(page, 'Cluster', 'pg')
  await expect(own(cluster, 'Cluster', 'pg')).toBeVisible()
  await openAll(cluster)
  // The Services that select its pods are above it, as a Deployment's are; what it owns, below.
  const y = async (name: string | RegExp) => (await card(cluster, name).boundingBox())!.y
  expect(await y('Service pg-rw, 2/2 ready')).toBeLessThan(await y(/^Pods pg, /))
  await card(cluster, 'Secret pg-superuser').click()
  await expect(own(panel(page, 'Secret', 'pg-superuser'), 'Secret', 'pg-superuser')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('whatever leads round in circles, every row has a card and every line is drawn', () => {
  // Graphs of a few nodes with lines every which way, the same ones each run.
  let seed = 207
  const random = (below: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed % below
  }
  const relations = ['owns', 'selects', 'uses'] as const
  let circled = 0
  for (let n = 0; n < 4000; n++) {
    const ids = Array.from({ length: 3 + random(5) }, (_, i) => `n${i}`)
    const nodes = new Map(ids.map((id): [string, MapNode] => [id, { id, kind: 'Pod', name: id }]))
    const edges = new Map<string, MapGraph['edges'][number]>()
    for (let e = 2 + random(ids.length * 2); e > 0; e--) {
      const from = ids[random(ids.length)]!
      const to = ids[random(ids.length)]!
      if (from !== to) edges.set(`${from}>${to}`, { from, to, relation: relations[random(3)]! })
    }
    const graph: MapGraph = { nodes, edges: [...edges.values()], focus: 'n0' }
    const said = JSON.stringify(graph.edges.map((e) => `${e.from}>${e.to}`))
    if (graph.edges.some((e) => edges.has(`${e.to}>${e.from}`))) circled += 1

    const rows = ranks(graph)
    const used = [...new Set(rows.values())].sort((a, b) => a - b)
    expect(used, said).toEqual(used.map((_, i) => i))
    const layout = layoutMap(graph, 100_000, new Set())
    expect(layout.cards, said).toHaveLength(ids.length)
    for (const { from, to } of graph.edges) {
      // Two cards with a line between them aren't side by side, where it couldn't be drawn.
      expect(rows.get(from), `${from} and ${to} of ${said}`).not.toBe(rows.get(to))
      expect(
        layout.edges.some(
          (line) =>
            (line.from === from && line.to === to) || (line.from === to && line.to === from),
        ),
        `${from} to ${to} of ${said}`,
      ).toBe(true)
    }
  }
  // Circles were among them, and not a few.
  expect(circled).toBeGreaterThan(1000)
})

test('Secrets it can’t list are there, unknown', async ({ page, clusters }) => {
  kitchenSink(clusters.demo)
  clusters.demo.fail('/api/v1/namespaces/shop/secrets', {
    status: 403,
    body: JSON.stringify({ kind: 'Status', status: 'Failure', reason: 'Forbidden', code: 403 }),
  })
  await openCluster(page)
  const lab = await openMap(page, 'Deployments', 'Deployment', 'lab')
  await openAll(lab)
  await expect(card(lab, 'Secret lab-secrets')).toBeVisible()
  await expect(map(lab).getByRole('img', { name: 'ConfigMap lab-config, Not found' })).toBeVisible()
})

test('a node with thousands of pods', async ({ page }) => {
  await openCluster(page, CONTEXTS.large)
  await goTo(page, 'Nodes')
  const node = await openMap(page, 'Nodes', 'Node', LARGE.node, { wide: false })
  await expect(map(node).getByRole('button', { name: /^2,\d{3} more$/ })).toBeVisible({
    timeout: 30_000,
  })
})

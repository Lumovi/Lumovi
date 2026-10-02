import type { Page } from '@playwright/test'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { CONTEXTS, DEMO, expect, openCluster, panel, rows, test } from './fixtures.ts'

const { nodePools, nodeClaims } = CUSTOM.karpenter
const NODE_CLAIM = 'NodeClaim.karpenter.sh'

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Resources' })
const tile = (page: Page, label: string) => page.getByRole('region', { name: label })
const list = (page: Page, label: string) => page.getByRole('list', { name: label })

async function openKarpenter(page: Page, context: string = CONTEXTS.demo) {
  await openCluster(page, context)
  await sidebar(page).getByRole('link', { name: 'Karpenter', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Karpenter')
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const condition = (type: string, status: string, reason = type, message = '') => ({
  type,
  status,
  reason,
  message,
  lastTransitionTime: ago(60_000),
})

/** What Karpenter labels its nodes and node claims with. */
const labels = (type = 'c6i.2xlarge') => ({
  'karpenter.sh/nodepool': nodePools.general,
  'karpenter.sh/capacity-type': 'spot',
  'node.kubernetes.io/instance-type': type,
  'topology.kubernetes.io/zone': 'eu-west-1b',
})

function nodeClaim(
  name: string,
  conditions: ReturnType<typeof condition>[],
  extra: { nodeName?: string; deletionTimestamp?: string } = {},
) {
  return {
    apiVersion: 'karpenter.sh/v1',
    kind: 'NodeClaim',
    metadata: {
      name,
      labels: labels(),
      creationTimestamp: ago(600_000),
      ...(extra.deletionTimestamp ? { deletionTimestamp: extra.deletionTimestamp } : {}),
    },
    spec: { nodeClassRef: { group: 'karpenter.k8s.aws', kind: 'EC2NodeClass', name: 'default' } },
    status: { ...(extra.nodeName ? { nodeName: extra.nodeName } : {}), conditions },
  }
}

function node(name: string, taints: unknown[] = []) {
  return {
    apiVersion: 'v1',
    kind: 'Node',
    metadata: { name, labels: labels(), creationTimestamp: ago(600_000) },
    spec: { taints },
    status: {
      capacity: { cpu: '8', memory: '32Gi', pods: '110' },
      allocatable: { cpu: '7910m', memory: '31Gi', pods: '110' },
      conditions: [condition('Ready', 'True', 'KubeletReady')],
    },
  }
}

function pendingPod(name: string) {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: 'batch', creationTimestamp: ago(120_000) },
    spec: { containers: [{ name: 'work', image: 'busybox' }] },
    status: {
      phase: 'Pending',
      conditions: [
        condition(
          'PodScheduled',
          'False',
          'Unschedulable',
          '0/4 nodes are available: 4 Insufficient cpu.',
        ),
      ],
    },
  }
}

test('Karpenter’s page: its node pools against their limits, its nodes, and what’s coming and going', async ({
  page,
}) => {
  await openKarpenter(page)
  const tabs = page.getByRole('navigation', { name: 'Karpenter' })
  await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
  await expect(tabs).toContainText('OverviewNodePools3NodeClaims4EC2NodeClasses2')

  await expect(tile(page, 'Node pools ready')).toContainText('2/3')
  await expect(tile(page, 'Node pools ready')).toContainText('1 not ready')
  await expect(tile(page, 'Nodes ready')).toContainText('2/3')
  await expect(tile(page, 'Launching')).toContainText('1')
  await expect(tile(page, 'Launching')).toContainText('1 pod waiting')
  await expect(tile(page, 'Being replaced')).toContainText('Drifted or terminating')

  // Each node pool: what it may launch, and how much of its limits its nodes take.
  const pools = list(page, 'Node pools').getByRole('listitem')
  await expect(pools).toHaveCount(3)
  await expect(pools.nth(0)).toContainText(
    `${nodePools.arm}NodeClassNotReady · EC2NodeClass "arm" is not ready0 nodes`,
  )
  // A node pool without limits.
  await expect(pools.nth(0)).toContainText('0 cores · no limit')
  await expect(pools.nth(0)).toContainText('0 B · no limit')
  await expect(pools.nth(1)).toContainText(`${nodePools.general}Spot, on-demand · m6i, c6i3 nodes`)
  await expect(pools.nth(1)).toContainText('24 of 64 cores')
  await expect(pools.nth(1)).toContainText('96 GiB of 256 GiB')
  await expect(page.getByRole('meter', { name: 'general CPU of its limit' })).toHaveAttribute(
    'aria-valuenow',
    '38',
  )
  // Without a capacity type, Karpenter launches on-demand nodes.
  await expect(pools.nth(2)).toContainText(`${nodePools.gpu}On-demand0 nodes`)

  // A node pool's nodes and node claims are a tab each in its panel.
  await pools.nth(1).getByRole('button').click()
  const pool = panel(page, 'NodePool', nodePools.general)
  await pool.getByRole('tab', { name: 'Nodes', exact: true }).click()
  const poolNodes = pool.getByRole('grid', { name: 'Nodes' })
  await expect(rows(page, 'Nodes')).toHaveCount(3)
  // The ones in trouble first, then by name either way.
  await expect(rows(page, 'Nodes').first()).toContainText('worker-3')
  await poolNodes.getByRole('columnheader', { name: 'Name' }).getByRole('button').click()
  await expect(rows(page, 'Nodes').first()).toContainText('worker-1')
  await poolNodes.getByRole('columnheader', { name: 'Name' }).getByRole('button').click()
  await expect(rows(page, 'Nodes').first()).toContainText('worker-3')
  await pool.getByRole('tab', { name: 'Node claims' }).click()
  await expect(rows(page, 'Node claims')).toHaveCount(4)
  await expect(rows(page, 'Node claims').first()).toContainText('Not ready')
  await rows(page, 'Node claims')
    .filter({ hasText: 'Drifted' })
    .getByRole('gridcell')
    .first()
    .click()
  await expect(panel(page, 'NodeClaim', nodeClaims.worker2)).toContainText(
    'EC2NodeClass default changed: amiSelectorTerms',
  )
  await page.keyboard.press('Escape')

  // Its nodes, with their usage, and the one on its way.
  const nodes = page.getByRole('region', { name: `Nodes of ${nodePools.general}` })
  await expect(nodes).toContainText('worker-1m6i.2xlarge · on-demand · eu-west-1a')
  await expect(nodes.getByRole('meter', { name: 'worker-1 CPU' })).toBeVisible()
  await expect(nodes).toContainText('worker-3m6i.2xlarge · spot · eu-west-1cNotReady · 7.9 cores')
  await expect(nodes).toContainText(
    `${nodeClaims.launching}c6i.2xlarge · spot · eu-west-1bLaunching`,
  )
  await nodes.getByRole('button', { name: new RegExp(nodeClaims.launching) }).click()
  await expect(panel(page, 'NodeClaim', nodeClaims.launching).locator('header')).toContainText(
    'Launching',
  )
  await page.keyboard.press('Escape')
  await nodes.getByRole('button', { name: /^worker-2/ }).click()
  await expect(panel(page, 'Node', 'worker-2')).toBeVisible()
  await page.keyboard.press('Escape')

  // What they are.
  await expect(page.getByRole('region', { name: 'Instance types' })).toContainText('m6i.2xlarge3')
  await expect(page.getByRole('region', { name: 'Capacity types' })).toContainText(
    'spot2on-demand1',
  )
  await expect(page.getByRole('region', { name: 'Zones' })).toContainText(
    'eu-west-1a1eu-west-1b1eu-west-1c1',
  )

  // What's being replaced, and why; and the pod waiting for a node.
  const replacing = list(page, 'Disruption')
  await expect(replacing).toContainText(
    'Drifted' + 'worker-2' + 'general · EC2NodeClass default changed: amiSelectorTerms',
  )
  await replacing.getByRole('button').click()
  await expect(panel(page, 'NodeClaim', nodeClaims.worker2)).toBeVisible()
  await page.keyboard.press('Escape')
  const [pending] = DEMO.pods.redis.slice(1)
  const waiting = list(page, 'Waiting for a node')
  await expect(waiting).toContainText(`${pending}data`)
  await expect(waiting).toContainText('0/4 nodes are available')
  await waiting.getByRole('button').click()
  await expect(panel(page, 'Pod', pending!)).toBeVisible()
  await page.keyboard.press('Escape')

  // The tiles lead to the lists behind them, filtered to what they count.
  await tile(page, 'Node pools ready').getByRole('button').click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('NodePools')
  await expect(rows(page, 'NodePools')).toHaveCount(1)
  await page.goBack()
  await tile(page, 'Nodes ready').getByRole('button').click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  await expect(page.getByLabel('Label selector')).toHaveValue('karpenter.sh/nodepool')
  await expect(rows(page, 'Nodes')).toHaveCount(2)
  await page.goBack()
  await tile(page, 'Launching').getByRole('button').click()
  await expect(rows(page, 'NodeClaims')).toHaveCount(1)
  await page.goBack()
  await tile(page, 'Being replaced').getByRole('button').click()
  await expect(rows(page, 'NodeClaims')).toHaveCount(4)
})

test('what Karpenter replaces, launches and waits for, as it changes', async ({
  page,
  clusters,
}) => {
  const demo = clusters.demo
  // On its way out before it ever had a node; a node it's replacing; one it could do without.
  demo.upsert(
    nodeClaim('general-gone', [condition('Launched', 'True')], { deletionTimestamp: ago(30_000) }),
  )
  demo.upsert(
    node('worker-4', [
      { key: 'karpenter.sh/disrupted', effect: 'NoSchedule', timeAdded: ago(90_000) },
    ]),
  )
  demo.upsert(
    nodeClaim('general-w4', [condition('Registered', 'True'), condition('Ready', 'True')], {
      nodeName: 'worker-4',
    }),
  )
  demo.upsert(
    nodeClaim(
      'general-cheap',
      [condition('Registered', 'True'), condition('Consolidatable', 'True')],
      {
        nodeName: 'worker-1',
      },
    ),
  )
  // A launch that failed isn't on its way.
  demo.upsert(
    nodeClaim('general-none', [
      condition('Launched', 'False', 'InsufficientCapacityError', 'no capacity in eu-west-1b'),
    ]),
  )
  await openKarpenter(page)
  await expect(tile(page, 'Launching')).toContainText('1')
  await expect(tile(page, 'Being replaced')).toContainText('3')
  const replacing = list(page, 'Disruption')
  await expect(replacing).toContainText('Terminatinggeneral-gone')
  await expect(replacing).toContainText('Being replacedworker-4')
  await expect(replacing).toContainText(
    'Consolidatableworker-1general · Its pods fit elsewhere, or on a cheaper node.',
  )

  // Nothing launching, with a pod waiting: worth a look.
  demo.remove(NODE_CLAIM, undefined, nodeClaims.launching)
  await page.getByRole('button', { name: /^Refresh/ }).click()
  await expect(tile(page, 'Launching')).toContainText('01 pod waiting')
  await expect(tile(page, 'Launching').locator('[aria-hidden].bg-warn')).toBeVisible()
  demo.remove('Pod', 'data', DEMO.pods.redis[1]!)
  await page.getByRole('button', { name: /^Refresh/ }).click()
  await expect(tile(page, 'Launching')).toContainText('No pods waiting')
  await expect(page.getByText('No pods are waiting for a node.')).toBeVisible()

  // Long lists show a few, and the rest on request.
  for (let i = 0; i < 7; i++) demo.upsert(pendingPod(`backfill-${i}`))
  for (let i = 5; i < 12; i++) demo.upsert(node(`worker-${i}`))
  await page.getByRole('button', { name: /^Refresh/ }).click()
  const waiting = list(page, 'Waiting for a node')
  await expect(waiting.getByRole('listitem')).toHaveCount(6)
  await page.getByRole('button', { name: 'Show all 7' }).click()
  await expect(waiting.getByRole('listitem')).toHaveCount(7)
  await page.getByRole('button', { name: 'Show fewer' }).click()
  await expect(waiting.getByRole('listitem')).toHaveCount(6)
  const nodes = page.getByRole('region', { name: `Nodes of ${nodePools.general}` })
  await expect(nodes.getByRole('listitem')).toHaveCount(6)
  await nodes.getByRole('button', { name: 'Show all 11' }).click()
  await expect(nodes.getByRole('listitem')).toHaveCount(11)
})

test('a cluster where Karpenter has nothing to do yet', async ({ page, clusters }) => {
  // Opened straight away, while the nodes are still on their way.
  clusters.sandbox.fail('/api/v1/nodes', { delayMs: 3000 })
  await page.evaluate(() => {
    window.location.hash = '#/cluster/sandbox/add-ons/karpenter'
  })
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Karpenter')
  await expect(tile(page, 'Node pools ready')).toContainText('0/0All ready')
  await expect(tile(page, 'Nodes ready')).toContainText('0/00 of 0 on spot')
  await expect(tile(page, 'Launching')).toContainText('0No pods waiting')
  await expect(tile(page, 'Being replaced')).toContainText('0Nothing to replace')
  await expect(page.getByText('No node pools')).toBeVisible()
  await expect(page.getByText('Karpenter launches nodes when pods need them.')).toBeVisible()
  await expect(page.getByText('No nodes yet.')).toBeVisible()
  await expect(page.getByText('Nothing is being disrupted.')).toBeVisible()
  await expect(page.getByText('No pods are waiting for a node.')).toBeVisible()
})

test('what couldn’t be refreshed, and nodes without live usage', async ({ page, clusters }) => {
  await openKarpenter(page)
  await expect(list(page, 'Node pools').getByRole('listitem')).toHaveCount(3)
  // Lists that loaded keep showing; the page says they couldn't be refreshed.
  const clear = clusters.demo.fail('/apis/karpenter.sh/v1/nodepools', { status: 503 })
  await expect(page.getByText(/Couldn’t refresh — showing the last data/)).toBeVisible({
    timeout: 20_000,
  })
  clear()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByText(/Couldn’t refresh/)).toHaveCount(0)

  // Without metrics-server, a node pool's nodes are listed without their usage.
  clusters.demo.setMetricsAvailable(false)
  await page.getByRole('button', { name: /^Refresh/ }).click()
  await list(page, 'Node pools').getByRole('listitem').nth(1).getByRole('button').click()
  const pool = panel(page, 'NodePool', nodePools.general)
  await pool.getByRole('tab', { name: 'Nodes', exact: true }).click()
  await expect(rows(page, 'Nodes')).toHaveCount(3)
  await expect(pool.getByRole('grid', { name: 'Nodes' }).getByRole('meter')).toHaveCount(0)
})

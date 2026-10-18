/**
 * The served Overview with less to read: without node metrics, its CPU and Memory settle on what's
 * requested and say why (LMV-329); without nodes, the rest of it draws, the node parts saying why
 * (LMV-328).
 */
import { mkdirSync } from 'node:fs'
import { writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { DEMO_TOKEN, expect, signIn, test } from './fixtures.ts'

test('without metrics-server, and not allowed to ask, CPU and Memory say so and show what’s requested', async ({
  serve,
  clusters,
  page,
}) => {
  clusters.demo.setMetricsAvailable(false)
  // (Without metrics-server, someone who may not read node metrics is refused, not told there are
  // none: the API server asks who may read first.)
  clusters.demo.deny({ verb: 'list', resource: 'nodes.metrics.k8s.io' })
  const server = await serve()
  await signIn(page, `${server.url}cluster/demo`, DEMO_TOKEN)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview')
  for (const title of ['CPU', 'Memory']) {
    const card = page.getByRole('region', { name: title, exact: true })
    await expect(card).toContainText('Your account isn’t allowed to read live usage')
    await expect(card).not.toContainText('Measuring…')
  }
})

test('an account that may not list nodes has the rest of the Overview, the node parts saying why', async ({
  serve,
  clusters,
  page,
}) => {
  // As Kubernetes' own `view` role: everything in the namespaces, no nodes.
  clusters.demo.deny({ verb: 'list', resource: 'nodes' })
  const server = await serve()
  await signIn(page, `${server.url}cluster/demo`, DEMO_TOKEN)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview')
  for (const title of ['Nodes', 'CPU', 'Memory']) {
    await expect(page.getByRole('region', { name: title, exact: true })).toContainText(
      'Your account isn’t allowed to list nodes.',
    )
  }
  await expect(page.getByRole('region', { name: 'Pod health', exact: true })).not.toContainText(
    'forbidden',
  )
  await expect(page.getByRole('region', { name: 'Needs attention', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose another cluster' })).toHaveCount(0)
})

test('on a server of one cluster, an Overview that fails offers no other cluster', async ({
  serve,
  clusters,
  page,
}) => {
  const dir = test.info().outputPath('kube')
  mkdirSync(dir, { recursive: true })
  const kubeconfig = writeKubeconfig(dir, {
    currentContext: 'demo',
    clusters: [{ name: 'demo', server: clusters.demo.url, caPem: clusters.demo.caPem }],
    users: [{ name: 'demo', token: DEMO_TOKEN }],
    contexts: [{ name: 'demo', cluster: 'demo', user: 'demo' }],
  })
  clusters.demo.fail('/api/v1/nodes', { status: 500, body: 'etcd is down' })
  const server = await serve({ env: { KUBECONFIG: kubeconfig, LUMOVI_CONTEXT: 'demo' } })
  await signIn(page, `${server.url}cluster/demo`, DEMO_TOKEN)
  await expect(page.getByRole('main')).toContainText('The API server returned an error')
  await expect(page.getByRole('button', { name: 'Choose another cluster' })).toHaveCount(0)
})
